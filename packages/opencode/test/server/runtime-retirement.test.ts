import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeRetirement } from "@opencode-ai/core/runtime-retirement"
import { ManagedCommand } from "@opencode-ai/core/managed-command"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { ManagedLinux } from "../../src/tool/shell/managed-linux"
import { Server } from "../../src/server/server"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node])))

const seedSession = Effect.fnUntraced(function* (database: Database.Interface, parentID?: string) {
  const id = randomUUID()
  const projectID = randomUUID()
  yield* database.db.run(sql`
    INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES (${projectID}, '/tmp', 0, 0, '[]')
  `)
  yield* database.db.run(sql`
    INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
    VALUES (${id}, ${projectID}, ${parentID ?? null}, ${id}, '/tmp', 'test', '1', 0, 0)
  `)
  return id
})

describe("durable root retirement", () => {
  it.live("foreign no-row cancellation durably denies a pending gate even after its local marker clears", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      yield* ManagedCommand.coverRoot(database, root)
      const owner = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const other = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const prepared = Promise.withResolvers<RuntimeLifecycle.ManagedAuthorization>()
      const ready = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => ready.resolve()))
      const opened = { value: false }
      const worker = yield* owner
        .runManagedCommand(root, async (authorize) => {
          prepared.resolve(authorize)
          await ready.promise
          return {
            start: async () => {
              expect(
                await authorize(() => {
                  opened.value = true
                }),
              ).toBe(false)
              return { cleanup: "confirmed" as const }
            },
            cancel: async () => ({ cleanup: "confirmed" as const }),
          }
        })
        .pipe(Effect.forkScoped)
      const authorize = yield* Effect.promise(() => prepared.promise)
      expect(yield* other.cancel(root)).toBe(true)
      yield* other.finishCancel(root)
      expect(
        yield* Effect.promise(() =>
          authorize(() => {
            opened.value = true
          }),
        ),
      ).toBe(false)
      ready.resolve()
      yield* Fiber.join(worker)
      expect(opened.value).toBe(false)
      expect(yield* owner.commandStatus(root)).toBe("unknown")
    }),
  )

  for (const revocation of ["cancel", "fence", "deleted-row", "no-row"] as const) {
    it.live(`cancels a running owned handle after foreign ${revocation} without retirement`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const root = yield* seedSession(database)
        yield* ManagedCommand.coverRoot(database, root)
        const lineage = randomUUID()
        const owner = RuntimeLifecycle.make({ lineage }, yield* Effect.scope, database)
        const other = RuntimeLifecycle.make({ lineage }, yield* Effect.scope, database)
        const lease = revocation === "no-row" ? undefined : yield* owner.admit({ sessionID: root, directory: "/tmp" })
        const started = Promise.withResolvers<void>()
        const cancelled = Promise.withResolvers<void>()
        const cleanup = Promise.withResolvers<{ cleanup: "confirmed" }>()
        yield* Effect.addFinalizer(() => Effect.sync(() => cleanup.resolve({ cleanup: "confirmed" })))
        const worker = yield* owner
          .runManagedCommand(
            root,
            async (authorize) => ({
              start: async () => {
                expect(await authorize(() => started.resolve())).toBe(true)
                return cleanup.promise
              },
              cancel: () => {
                cancelled.resolve()
                return cleanup.promise
              },
            }),
            lease?.fence,
          )
          .pipe(Effect.forkScoped)
        yield* Effect.promise(() => started.promise)
        if (revocation === "cancel" || revocation === "no-row") {
          expect(yield* other.cancel(root)).toBe(true)
          yield* other.finishCancel(root)
        }
        if (revocation === "fence")
          yield* database.db.run(sql`UPDATE runtime_execution SET fence = fence + 1 WHERE session_id = ${root}`)
        if (revocation === "deleted-row")
          yield* database.db.run(sql`DELETE FROM runtime_execution WHERE session_id = ${root}`)
        yield* awaitWithTimeout(
          Effect.promise(() => cancelled.promise),
          "managed owner ignored revoked generation",
        )
        expect(yield* owner.commandStatus(root)).toBe("draining")
        cleanup.resolve({ cleanup: "confirmed" })
        yield* Fiber.join(worker)
        if (lease) yield* owner.release(root, lease.fence)
        expect(yield* owner.commandStatus(root)).toBe("unknown")
      }),
    )
  }

  for (const ancestry of ["projected", "execution"] as const) {
    it.live(`rejects admission below an intermediate cancelling ${ancestry} ancestor`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const root = yield* seedSession(database)
        const middle = yield* seedSession(database, root)
        const leaf = yield* seedSession(database, ancestry === "projected" ? middle : root)
        const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
        const lease =
          ancestry === "execution"
            ? yield* runtime.admit({ sessionID: leaf, directory: "/tmp", parentSessionID: middle })
            : undefined
        expect(yield* runtime.cancel(middle)).toBe(true)
        expect(
          yield* runtime
            .runManagedCommand(
              leaf,
              async () => {
                throw new Error("cancelled ancestor allowed preparation")
              },
              lease?.fence,
            )
            .pipe(Effect.flip),
        ).toBeInstanceOf(ManagedCommand.AdmissionError)
        yield* runtime.finishCancel(middle)
        if (lease) yield* runtime.release(leaf, lease.fence)
      }),
    )
  }

  it.live("listener stop closes its runtime scope, cancels managed handles and rejects new admission", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const listener = yield* Effect.acquireRelease(
        Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
        (listener) => Effect.promise(() => listener.stop(true)),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => RuntimeLifecycle.setCurrent(RuntimeLifecycle.unavailable())))
      listener.lifecycle.bindDatabase(database)
      const started = Promise.withResolvers<void>()
      const cancelled = Promise.withResolvers<void>()
      const cleanup = Promise.withResolvers<{ cleanup: "confirmed" }>()
      yield* Effect.addFinalizer(() => Effect.sync(() => cleanup.resolve({ cleanup: "confirmed" })))
      const worker = yield* listener.lifecycle
        .runManagedCommand(root, async (authorize) => ({
          start: async () => {
            expect(await authorize(() => started.resolve())).toBe(true)
            return cleanup.promise
          },
          cancel: () => {
            cancelled.resolve()
            return cleanup.promise
          },
        }))
        .pipe(Effect.forkScoped)
      yield* Effect.promise(() => started.promise)
      yield* awaitWithTimeout(
        Effect.promise(() => listener.stop(true)),
        "listener stop waited for command cleanup",
      )
      yield* awaitWithTimeout(
        Effect.promise(() => cancelled.promise),
        "listener stop did not cancel the managed handle",
      )
      expect(
        yield* listener.lifecycle
          .runManagedCommand(root, async () => {
            throw new Error("stopped listener admitted work")
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(ManagedCommand.AdmissionError)
      expect((yield* listener.lifecycle.status()).active).toBe(1)
      cleanup.resolve({ cleanup: "confirmed" })
      yield* Fiber.join(worker)
      expect(yield* awaitWithTimeout(listener.lifecycle.awaitStop, "closed runtime did not finish shutdown")).toEqual({
        action: "shutdown",
      })
    }),
  )

  for (const processFree of [true, false]) {
    it.live(
      `settles rejected launcher preparation as ${processFree ? "confirmed with proof" : "unknown without proof"}`,
      () =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const root = yield* seedSession(database)
          yield* ManagedCommand.coverRoot(database, root)
          const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
          const result = yield* runtime
            .runManagedCommand(
              root,
              (authorize) => ManagedLinux.prepare({ workspace: "/", argv: ["/bin/true"], timeoutMs: 0, authorize }),
              undefined,
              processFree ? { preparation: "process-free" } : undefined,
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          expect(
            yield* database.db.get<{ state: string }>(sql`
          SELECT state FROM managed_command WHERE root_session_id = ${root}
        `),
          ).toEqual({ state: processFree ? "confirmed" : "unknown" })
          yield* runtime.retireRoot(root)
          expect(yield* runtime.commandStatus(root)).toBe(processFree ? "drained" : "unknown")
          expect((yield* runtime.status()).active).toBe(0)
        }),
    )
  }

  it.live("keeps unknown when an arbitrary preparation callback launches a process and rejects without a handle", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      yield* ManagedCommand.coverRoot(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const children: ReturnType<typeof Bun.spawn>[] = []
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all(
            children.map(async (child) => {
              child.kill()
              await child.exited
            }),
          )
        }),
      )
      const result = yield* runtime
        .runManagedCommand(root, async () => {
          children.push(
            Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "pipe",
            }),
          )
          throw new Error("Preparation lost its process handle")
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(children).toHaveLength(1)
      yield* runtime.retireRoot(root)
      expect(yield* runtime.commandStatus(root)).toBe("unknown")
      // External test cleanup is not proof supplied to the command registry.
      for (const child of children) {
        child.kill()
        yield* Effect.promise(() => child.exited)
      }
      expect(yield* runtime.commandStatus(root)).toBe("unknown")
    }),
  )

  it.live("retains interrupted process-free preparation until its late rejection proves no process was launched", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      yield* ManagedCommand.coverRoot(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const preparing = Promise.withResolvers<void>()
      const reject = Promise.withResolvers<void>()
      const worker = yield* runtime
        .runManagedCommand(
          root,
          async (authorize) => {
            preparing.resolve()
            await reject.promise
            return ManagedLinux.prepare({ workspace: "/", argv: ["/bin/true"], timeoutMs: 0, authorize })
          },
          undefined,
          { preparation: "process-free" },
        )
        .pipe(Effect.forkScoped)
      yield* Effect.promise(() => preparing.promise)
      yield* Fiber.interrupt(worker)
      yield* runtime.retireRoot(root)
      expect(yield* runtime.commandStatus(root)).toBe("draining")
      expect(yield* runtime.request("shutdown")).toMatchObject({ state: "draining", active: 1 })
      reject.resolve()
      yield* awaitWithTimeout(runtime.awaitDrain, "late preparation rejection was not settled")
      expect(yield* runtime.commandStatus(root)).toBe("drained")
    }),
  )

  it.live("does not accept process-free proof after preparation attempts gate authorization", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      yield* ManagedCommand.coverRoot(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const result = yield* runtime
        .runManagedCommand(
          root,
          async (authorize) => {
            expect(await authorize(() => {})).toBe(true)
            throw new Error("Preparation failed after a possible launch")
          },
          undefined,
          { preparation: "process-free" },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      yield* runtime.retireRoot(root)
      expect(yield* runtime.commandStatus(root)).toBe("unknown")
    }),
  )

  it.live("still requires handle cleanup proof when start fails after process-free preparation", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      yield* ManagedCommand.coverRoot(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const result = yield* runtime
        .runManagedCommand(
          root,
          async () => ({
            start: async () => {
              throw new Error("Launch failed with unknown process state")
            },
            cancel: async () => ({ cleanup: "failed" as const }),
          }),
          undefined,
          { preparation: "process-free" },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      yield* runtime.retireRoot(root)
      expect(yield* runtime.commandStatus(root)).toBe("unknown")
    }),
  )

  it.live("denies a paused command after its execution generation is revoked without retirement", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const lease = yield* runtime.admit({ sessionID: root, directory: "/tmp" })
      const ready = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      const worker = yield* runtime
        .runManagedCommand(
          root,
          async (authorize) => {
            ready.resolve()
            await proceed.promise
            const allowed = await authorize(() => {
              throw new Error("revoked execution opened its gate")
            })
            expect(allowed).toBe(false)
            return {
              start: async () => ({ cleanup: "confirmed" as const }),
              cancel: async () => ({ cleanup: "confirmed" as const }),
            }
          },
          lease.fence,
        )
        .pipe(Effect.forkScoped)
      yield* Effect.promise(() => ready.promise)
      yield* database.db.run(sql`UPDATE runtime_execution SET fence = fence + 1 WHERE session_id = ${root}`)
      proceed.resolve()
      yield* Fiber.join(worker)
      yield* runtime.release(root, lease.fence)
      expect(yield* runtime.commandStatus(root)).toBe("unknown")
    }),
  )

  it.live("ordinary cancellation owns a descendant command until its cleanup finishes", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const child = yield* seedSession(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const started = Promise.withResolvers<void>()
      const cancelled = Promise.withResolvers<void>()
      const cleanup = Promise.withResolvers<{ cleanup: "confirmed" }>()
      const worker = yield* runtime
        .runManagedCommand(child, async (authorize) => ({
          start: async () => {
            expect(await authorize(() => started.resolve())).toBe(true)
            return cleanup.promise
          },
          cancel: () => {
            cancelled.resolve()
            return cleanup.promise
          },
        }))
        .pipe(Effect.forkScoped)
      yield* Effect.promise(() => started.promise)
      expect(yield* runtime.cancel(root)).toBe(true)
      yield* Effect.promise(() => cancelled.promise)
      yield* runtime.finishCancel(root)
      expect(yield* runtime.commandStatus(root)).toBe("draining")
      expect((yield* runtime.status()).active).toBe(1)
      cleanup.resolve({ cleanup: "confirmed" })
      yield* Fiber.join(worker)
      expect(yield* runtime.commandStatus(root)).toBe("unknown")
    }),
  )

  it.live("rejects managed preparation under another runtime's execution ownership", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const owner = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const other = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const lease = yield* owner.admit({ sessionID: root, directory: "/tmp" })
      expect(
        yield* owner
          .runManagedCommand(root, async () => {
            throw new Error("missing generation prepared a command")
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(ManagedCommand.AdmissionError)
      expect(
        yield* owner
          .runManagedCommand(
            root,
            async () => {
              throw new Error("stale generation prepared a command")
            },
            lease.fence - 1,
          )
          .pipe(Effect.flip),
      ).toBeInstanceOf(ManagedCommand.AdmissionError)
      expect(
        yield* other
          .runManagedCommand(root, async () => {
            throw new Error("foreign runtime prepared a command")
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(ManagedCommand.AdmissionError)
      yield* owner.release(root, lease.fence)
    }),
  )

  it.live("observes retirement outside the local registry and joins the cancelled running handle", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      yield* ManagedCommand.coverRoot(database, root)
      const owner = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const ready = Promise.withResolvers<void>()
      const done = Promise.withResolvers<{ cleanup: "confirmed" }>()
      const worker = yield* owner
        .runManagedCommand(root, async (authorize) => ({
          start: async () => {
            expect(
              await authorize(() => {
                ready.resolve()
              }),
            ).toBe(true)
            return done.promise
          },
          cancel: () => {
            done.resolve({ cleanup: "confirmed" })
            return done.promise
          },
        }))
        .pipe(Effect.forkScoped)
      yield* Effect.promise(() => ready.promise)
      // Bypass the local registry, as another server process would.
      yield* RuntimeRetirement.retireRoot(database, root)
      expect(yield* awaitWithTimeout(Fiber.join(worker), "owner did not observe durable retirement")).toEqual({
        cleanup: "confirmed",
      })
      expect(yield* owner.commandStatus(root)).toBe("drained")
    }),
  )

  it.live("owns interrupted preparation until its handle is cancelled and cleanup is confirmed", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      yield* ManagedCommand.coverRoot(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const preparing = Promise.withResolvers<void>()
      const prepared = Promise.withResolvers<void>()
      const cancelled = Promise.withResolvers<void>()
      const cleanup = Promise.withResolvers<{ cleanup: "confirmed" }>()
      const starts: string[] = []
      const worker = yield* runtime
        .runManagedCommand(root, async () => {
          preparing.resolve()
          await prepared.promise
          return {
            start: () => {
              starts.push("started")
              return cleanup.promise
            },
            cancel: () => {
              cancelled.resolve()
              return cleanup.promise
            },
          }
        })
        .pipe(Effect.forkScoped)
      yield* Effect.promise(() => preparing.promise)
      yield* Fiber.interrupt(worker)
      yield* runtime.retireRoot(root)
      expect(yield* runtime.commandStatus(root)).toBe("draining")
      expect(yield* runtime.request("shutdown")).toMatchObject({ state: "draining", active: 1 })
      prepared.resolve()
      yield* Effect.promise(() => cancelled.promise)
      expect(starts).toEqual([])
      expect(yield* runtime.commandStatus(root)).toBe("draining")
      cleanup.resolve({ cleanup: "confirmed" })
      yield* runtime.awaitDrain
      expect(yield* runtime.commandStatus(root)).toBe("drained")
    }),
  )

  it.live("denies a delayed gate after retirement by another runtime and preserves failed cleanup uncertainty", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      yield* ManagedCommand.coverRoot(database, root)
      const owner = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const other = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const ready = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      const opens: string[] = []
      const worker = yield* owner
        .runManagedCommand(root, async (authorize) => {
          const result = (async () => {
            ready.resolve()
            await gate.promise
            expect(
              await authorize(() => {
                opens.push("opened")
              }),
            ).toBe(false)
            return { cleanup: "failed" as const }
          })()
          return { start: () => result, cancel: () => result }
        })
        .pipe(Effect.forkScoped)
      yield* Effect.promise(() => ready.promise)
      yield* other.retireRoot(root)
      gate.resolve()
      yield* Fiber.join(worker)
      expect(opens).toEqual([])
      expect(yield* owner.commandStatus(root)).toBe("unknown")
      expect(yield* other.commandStatus(root)).toBe("unknown")
    }),
  )

  it.live("never treats local runner release as proof that every tool or plugin has stopped", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      yield* ManagedCommand.coverRoot(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const admission = yield* runtime.admit({ sessionID: root, directory: "/tmp" })
      yield* runtime.retireRoot(root)
      expect(yield* runtime.commandStatus(root)).toBe("draining")
      yield* runtime.release(root, admission.fence)
      expect(yield* runtime.commandStatus(root)).toBe("unknown")
    }),
  )

  for (const retired of [false, true]) {
    it.live(
      `keeps independent shell/prepare work tracked after ${retired ? "retirement" : "ordinary cancellation"} acknowledgement`,
      () =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const root = yield* seedSession(database)
          const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
          const prepare = yield* runtime.admit({ sessionID: root, directory: "/tmp" })
          const runner = yield* runtime.admit({ sessionID: root, directory: "/tmp" })
          const started = yield* Deferred.make<void>()
          const finishPrepare = yield* Deferred.make<void>()
          const finishRunner = yield* Deferred.make<void>()
          const prepared = yield* Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finishPrepare)
          }).pipe(Effect.ensuring(runtime.release(root, prepare.fence)), Effect.forkScoped)
          const running = yield* Deferred.await(finishRunner).pipe(
            Effect.ensuring(runtime.releaseInterrupted(root, runner.fence)),
            Effect.forkScoped,
          )
          yield* Deferred.await(started)
          if (retired) yield* runtime.retireRoot(root)
          expect(yield* runtime.cancel(root)).toBe(true)
          expect(yield* runtime.cancel(root)).toBe(false)
          yield* Deferred.succeed(finishRunner, undefined)
          yield* Fiber.join(running)
          // The runner cancellation coordinator does not own the independent prepare fiber.
          yield* runtime.finishCancel(root)
          yield* runtime.waitCancel(root)
          expect((yield* runtime.status()).active).toBe(1)
          const idleDone = yield* Deferred.make<void>()
          const idle = yield* runtime
            .waitForIdle(root)
            .pipe(Effect.andThen(Deferred.succeed(idleDone, undefined)), Effect.forkScoped)
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(idleDone)).toBe(false)
          expect(yield* runtime.request("shutdown")).toMatchObject({ state: "draining", active: 1 })
          yield* Deferred.succeed(finishPrepare, undefined)
          yield* Fiber.join(prepared)
          yield* Fiber.join(idle)
          yield* runtime.awaitDrain
          expect(yield* runtime.status()).toMatchObject({ state: "stopping", active: 0 })
        }),
    )
  }

  it.live("retains shared descendants in each retired root after projection deletion", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const projectedRoot = yield* seedSession(database)
      const executionRoot = yield* seedSession(database)
      const shared = yield* seedSession(database, projectedRoot)
      const leaf = yield* seedSession(database, shared)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      yield* runtime.admit({ sessionID: shared, directory: "/tmp", parentSessionID: executionRoot })
      const first = yield* runtime.retireRoot(projectedRoot)
      expect(first.sessionIDs).toEqual([projectedRoot, shared, leaf].sort())
      const second = yield* runtime.retireRoot(executionRoot)
      expect(second.sessionIDs).toEqual([executionRoot, shared, leaf].sort())
      expect(yield* RuntimeRetirement.lookup(database, shared)).toEqual({ root_session_id: projectedRoot })
      expect((yield* runtime.status()).active).toBe(1)
      yield* database.db.run(
        sql`DELETE FROM session WHERE id IN (${projectedRoot}, ${executionRoot}, ${shared}, ${leaf})`,
      )
      expect(yield* runtime.retireRoot(projectedRoot)).toEqual(first)
      expect(yield* runtime.retireRoot(executionRoot)).toEqual(second)
      expect(yield* runtime.cancel(executionRoot)).toBe(true)
      expect(yield* runtime.cancel(shared)).toBe(false)
      expect((yield* runtime.status()).active).toBe(1)
      yield* runtime.finishCancel(executionRoot)
      expect((yield* runtime.status()).active).toBe(1)
      yield* runtime.release(shared)
      expect((yield* runtime.status()).active).toBe(0)
    }),
  )

  it.live("retirement and cancellation do not report drain completion before interruption and joining", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      // A projected root need not have an execution row to own a locally executing descendant.
      const root = yield* seedSession(database)
      const child = yield* seedSession(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      yield* runtime.admit({ sessionID: child, directory: "/tmp", parentSessionID: root })
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const allowCleanup = yield* Deferred.make<void>()
      const worker = yield* Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Effect.never
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.succeed(cleaning, undefined)
            yield* Deferred.await(allowCleanup)
            yield* runtime.release(child)
          }),
        ),
        Effect.forkScoped,
      )
      yield* Deferred.await(started)
      yield* runtime.retireRoot(root)
      expect((yield* runtime.status()).active).toBe(1)
      expect(yield* runtime.beforeTurn(child)).toBe(false)
      expect(yield* runtime.request("shutdown")).toMatchObject({ state: "draining", active: 1 })
      expect(yield* runtime.cancel(root)).toBe(true)
      expect(yield* runtime.cancel(child)).toBe(false)
      const cleanup = yield* Fiber.interrupt(worker).pipe(Effect.andThen(runtime.finishCancel(root)), Effect.forkScoped)
      yield* Deferred.await(cleaning)
      expect(yield* runtime.status()).toMatchObject({ state: "draining", active: 1 })
      yield* Deferred.succeed(allowCleanup, undefined)
      yield* Fiber.join(cleanup)
      yield* runtime.waitCancel(child)
      yield* runtime.awaitDrain
      expect(yield* runtime.status()).toMatchObject({ state: "stopping", active: 0 })
    }),
  )

  it.live("releases retired leases normally without rewriting revoked durable ownership", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const admission = yield* runtime.admit({ sessionID: root, directory: "/tmp" })
      yield* runtime.admit({ sessionID: root, directory: "/tmp" })
      yield* runtime.retireRoot(root)
      yield* runtime.release(root, admission.fence)
      expect((yield* runtime.status()).active).toBe(1)
      yield* runtime.release(root, admission.fence)
      expect((yield* runtime.status()).active).toBe(0)
      expect(
        yield* database.db.get(sql`
        SELECT state, desired_active, fence FROM runtime_execution WHERE session_id = ${root}
      `),
      ).toEqual({ state: "cancelled", desired_active: 0, fence: admission.fence + 1 })
      const retrying = yield* seedSession(database)
      const retryAdmission = yield* runtime.admit({ sessionID: retrying, directory: "/tmp" })
      yield* runtime.retry(retrying, Date.now() + 60_000)
      yield* runtime.retireRoot(retrying)
      expect(yield* runtime.request("shutdown")).toMatchObject({ state: "draining", active: 1 })
      expect(yield* runtime.releaseInterrupted(retrying, retryAdmission.fence)).toBe("absent")
      yield* runtime.awaitDrain
    }),
  )

  it.live("retires both ancestry trees, including never-admitted descendants and foreign owners", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const child = yield* seedSession(database, root)
      const grandchild = yield* seedSession(database, child)
      const executionOnly = yield* seedSession(database)
      const scope = yield* Effect.scope
      const owner = RuntimeLifecycle.make({ lineage: randomUUID() }, scope, database)
      const foreign = RuntimeLifecycle.make({ lineage: randomUUID() }, scope, database)
      yield* owner.admit({ sessionID: root, directory: "/tmp" })
      yield* foreign.admit({ sessionID: executionOnly, directory: "/tmp", parentSessionID: grandchild })
      const before = yield* foreign.ownershipFence(executionOnly)
      const result = yield* owner.retireRoot(root)
      expect(result.sessionIDs.sort()).toEqual([root, child, grandchild, executionOnly].sort())
      expect(yield* owner.beforeTurn(root)).toBe(false)
      expect(yield* foreign.beforeTurn(executionOnly)).toBe(false)
      expect(yield* foreign.checkpoint(executionOnly)).toBe(false)
      expect(yield* foreign.ownershipFence(executionOnly)).toBeUndefined()
      const row = yield* database.db.get<{ state: string; desired_active: number; fence: number }>(sql`
        SELECT state, desired_active, fence FROM runtime_execution WHERE session_id = ${executionOnly}
      `)
      expect(row).toEqual({ state: "cancelled", desired_active: 0, fence: (before ?? 0) + 1 })
      expect(
        yield* database.db.get(sql`
        UPDATE runtime_execution SET state = 'active', desired_active = 1, fence = fence + 1
        WHERE session_id = ${executionOnly} RETURNING session_id
      `),
      ).toBeUndefined()
      expect(yield* owner.retireRoot(root)).toEqual(result)
      for (const sessionID of result.sessionIDs) {
        const error = yield* foreign.admit({ sessionID, directory: "/tmp", manualRecovery: true }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "RuntimeDrainingError", reason: "retired", rootSessionID: root })
      }
    }),
  )

  it.live("keeps tombstones after deletion and across runtime replacement", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const child = yield* seedSession(database, root)
      const scope = yield* Effect.scope
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, scope, database)
      const result = yield* runtime.retireRoot(root)
      yield* database.db.run(sql`DELETE FROM session WHERE id IN (${root}, ${child})`)
      const replacement = RuntimeLifecycle.make({ lineage: randomUUID() }, scope, database)
      expect(yield* replacement.retireRoot(root)).toEqual(result)
      expect(yield* replacement.admit({ sessionID: child, directory: "/tmp" }).pipe(Effect.flip)).toMatchObject({
        reason: "retired",
        rootSessionID: root,
      })
      expect(yield* RuntimeRetirement.lookup(database, child)).toEqual({ root_session_id: root })
      const recreation = yield* database.db
        .run(
          sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        SELECT ${root}, id, 'test', '/tmp', 'test', '1', 0, 0 FROM project LIMIT 1
      `,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(recreation)).toBe(true)
    }),
  )

  it.live("rejects missing roots and children without leaving a barrier", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const child = yield* seedSession(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      expect(yield* runtime.retireRoot(randomUUID()).pipe(Effect.flip)).toMatchObject({ reason: "not_found" })
      expect(yield* runtime.retireRoot(child).pipe(Effect.flip)).toMatchObject({ reason: "not_root" })
      expect(yield* RuntimeRetirement.lookup(database, child)).toBeUndefined()
      yield* runtime.admit({ sessionID: child, directory: "/tmp" })
      const executionChild = yield* seedSession(database)
      yield* runtime.admit({ sessionID: executionChild, directory: "/tmp", parentSessionID: root })
      expect(yield* runtime.retireRoot(executionChild).pipe(Effect.flip)).toMatchObject({ reason: "not_root" })
      expect(yield* RuntimeRetirement.lookup(database, executionChild)).toBeUndefined()
      expect(yield* RuntimeLifecycle.unavailable().retireRoot(root).pipe(Effect.flip)).toMatchObject({
        reason: "unavailable",
      })
    }),
  )

  it.live("serializes retirement against child admission and creation", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const child = yield* seedSession(database, root)
      const scope = yield* Effect.scope
      const owner = RuntimeLifecycle.make({ lineage: randomUUID() }, scope, database)
      const contender = RuntimeLifecycle.make({ lineage: randomUUID() }, scope, database)
      const outcomes = yield* Effect.all(
        [
          owner.retireRoot(root),
          contender.admit({ sessionID: child, directory: "/tmp", parentSessionID: root }).pipe(Effect.exit),
          seedSession(database, child).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      if (Exit.isSuccess(outcomes[2])) {
        expect(outcomes[0].sessionIDs).toContain(outcomes[2].value)
        expect(yield* RuntimeRetirement.lookup(database, outcomes[2].value)).toEqual({ root_session_id: root })
      }
      expect(yield* contender.beforeTurn(child)).toBe(false)
      expect(yield* contender.admit({ sessionID: child, directory: "/tmp" }).pipe(Effect.flip)).toMatchObject({
        reason: "retired",
      })
      const creation = yield* seedSession(database, child).pipe(Effect.exit)
      expect(Exit.isFailure(creation)).toBe(true)
      const unrelated = yield* seedSession(database)
      expect(
        Exit.isFailure(
          yield* database.db
            .run(
              sql`
        UPDATE session SET parent_id = ${child} WHERE id = ${unrelated}
      `,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* database.db
            .run(
              sql`
        UPDATE session SET parent_id = NULL WHERE id = ${child}
      `,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* contender.admit({ sessionID: unrelated, directory: "/tmp" })
      expect(
        yield* database.db.get(sql`
        UPDATE runtime_execution SET parent_session_id = ${child}, desired_active = 0
        WHERE session_id = ${unrelated} RETURNING session_id
      `),
      ).toBeUndefined()
      expect(yield* contender.beforeTurn(unrelated)).toBe(true)
    }),
  )

  it.live("does not reopen retirement when cancellation finishes, but ordinary cancellation remains resumable", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const root = yield* seedSession(database)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      yield* runtime.admit({ sessionID: root, directory: "/tmp" })
      yield* runtime.cancel(root)
      yield* runtime.retireRoot(root)
      yield* runtime.finishCancel(root)
      expect(yield* runtime.admit({ sessionID: root, directory: "/tmp" }).pipe(Effect.flip)).toMatchObject({
        reason: "retired",
      })
      const resumable = yield* seedSession(database)
      yield* runtime.admit({ sessionID: resumable, directory: "/tmp" })
      yield* runtime.cancel(resumable)
      yield* runtime.finishCancel(resumable)
      yield* runtime.release(resumable)
      yield* runtime.admit({ sessionID: resumable, directory: "/tmp" })
      expect(yield* runtime.beforeTurn(resumable)).toBe(true)
    }),
  )

  it.live("does not execute a recovered claim retired while waiting for a recovery permit", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const lineage = randomUUID()
      const scope = yield* Effect.scope
      const previous = RuntimeLifecycle.make({ lineage }, scope, database)
      const roots = yield* Effect.forEach([0, 1, 2], () => seedSession(database))
      for (const sessionID of roots) {
        yield* previous.admit({ sessionID, directory: "/tmp" })
        yield* previous.park(sessionID)
      }
      const recoveryScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(recoveryScope, Exit.void))
      const replacement = RuntimeLifecycle.make({ lineage }, recoveryScope, database)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const ran: string[] = []
      yield* replacement.recover((record) =>
        Effect.gen(function* () {
          ran.push(record.sessionID)
          if (ran.length === 2) yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      yield* Deferred.await(started)
      const waiting = roots.find((id) => !ran.includes(id))
      const running = ran[0]
      expect(waiting).toBeDefined()
      expect(running).toBeDefined()
      if (!waiting || !running) return
      yield* replacement.retireRoot(waiting)
      yield* replacement.retireRoot(running)
      expect((yield* replacement.status()).active).toBe(3)
      const sentinel = yield* seedSession(database)
      yield* previous.admit({ sessionID: sentinel, directory: "/tmp" })
      yield* previous.park(sentinel)
      const passed = yield* Deferred.make<void>()
      yield* replacement.recover(() => Deferred.succeed(passed, undefined))
      yield* Deferred.succeed(release, undefined)
      // The sentinel queues behind the retired claim on the same FIFO recovery semaphore.
      yield* Deferred.await(passed)
      yield* Scope.close(recoveryScope, Exit.void)
      expect(ran).not.toContain(waiting)
      expect((yield* replacement.status()).active).toBe(0)
    }),
  )
})
