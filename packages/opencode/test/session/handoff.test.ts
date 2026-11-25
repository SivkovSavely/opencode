import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionHandoffEnrollment } from "@opencode-ai/core/session/handoff-enrollment"
import { SessionHandoffNotification } from "@opencode-ai/core/session/handoff-notification"
import { SessionHandoffStore } from "@opencode-ai/core/session/handoff-store"
import { SessionHandoffRecovery } from "@opencode-ai/core/session/handoff-recovery"
import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"
import { sql } from "drizzle-orm"
import { Context, Effect, Fiber, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { InstanceStore } from "../../src/project/instance-store"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionHandoff } from "../../src/session/handoff"
import { SessionCompaction } from "../../src/session/compaction"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, LayerNode.compile(CrossSpawnSpawner.node)))

const fixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const config = testProviderConfig(llm.url)
  const directory = yield* tmpdirScoped({
    git: true,
    config: {
      ...config,
      model: "test/test-model",
      agent: { audit: { description: "Synthetic audit", mode: "subagent", prompt: "Audit synthetic changes." } },
      provider: {
        test: {
          ...config.provider.test,
          models: {
            "test-model": {
              ...config.provider.test.models["test-model"],
              variants: { high: { reasoningEffort: "high" }, max: { reasoningEffort: "high" } },
            },
            "obsolete-model": { ...config.provider.test.models["test-model"], id: "obsolete-model" },
          },
        },
      },
    },
  })
  const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope)
  const context = yield* Layer.build(
    AppNodeBuilderV1.build(
      LayerNode.group([
        Session.node,
        SessionPrompt.node,
        InstanceStore.node,
        Database.node,
        SessionProjector.node,
        Provider.node,
        Agent.node,
        Plugin.node,
        SessionCompaction.node,
      ]),
      [[RuntimeFlags.node, RuntimeFlags.layer({ pure: true, experimentalBackgroundSubagents: true })]],
    ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime))),
  )
  const database = Context.get(context, Database.Service)
  runtime.bindDatabase(database)
  return {
    llm,
    directory,
    runtime,
    context,
    database,
    store: Context.get(context, InstanceStore.Service),
    sessions: Context.get(context, Session.Service),
  }
})

const enrolled = (f: Effect.Success<typeof fixture>, previous?: Session.Info) =>
  Effect.gen(function* () {
    const session = previous ?? (yield* f.sessions.create({ title: "handoff root", agent: "build" }))
    const reservation = previous ? randomUUID() : "reservation"
    const queueID = previous ? randomUUID() : session.id
    const created = previous ? Date.now() : 1
    const userMessageID = MessageID.ascending()
    yield* f.runtime.admit({ sessionID: session.id, directory: f.directory })
    yield* SessionHandoffEnrollment.reserve(f.database, session.id, reservation)
    yield* f.database.db.run(
      sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${userMessageID},${session.id},${created},${created},${JSON.stringify({ role: "user", agent: "build", model: { providerID: "test", modelID: "test-model" }, time: { created } })})`,
    )
    const payload = { kind: "prompt", parts: [] }
    yield* f.database.db.run(
      sql`INSERT INTO session_queue (id,session_id,delivery,state,position,payload,submission,message_id,time_created) VALUES (${queueID},${session.id},'queue','delivered',${previous ? 2 : 1},${JSON.stringify(payload)},${JSON.stringify({ delivery: "queue", payload })},${userMessageID},${created})`,
    )
    yield* SessionHandoffEnrollment.delivered(f.database, session.id, reservation, queueID, userMessageID)
    const candidate = yield* SessionHandoff.candidate(session.id)
    if (!candidate) throw new Error("Missing candidate")
    yield* SessionHandoff.enroll(session.id, { ...candidate, requestID: randomUUID() })
    return session
  })

for (const acknowledged of [false, true])
  it.live(
    `cancellation rolls back its fence revocation when ${acknowledged ? "acknowledged" : "accepted"} pause settlement cannot commit`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.store.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const root = yield* enrolled(f)
            const view = yield* SessionHandoff.execution(root.id)
            if (!view.identity) throw new Error("Missing identity")
            const request = {
              requestID: randomUUID(),
              expectedDirectory: f.directory,
              expected: view.identity,
              expectedRecoveryRevision: 0,
            }
            yield* SessionHandoff.cooperativePause(root.id, request)
            if (acknowledged) expect(yield* f.runtime.cooperativeBoundary(root.id)).toBe("paused")
            const pause = yield* SessionHandoff.receipt(root.id, request.requestID)
            const before = yield* f.database.db.get(
              sql`SELECT state,fence,desired_active FROM runtime_execution WHERE session_id=${root.id}`,
            )
            yield* f.database.db.run(
              sql`CREATE TRIGGER reject_pause_settlement BEFORE UPDATE ON session_cooperative_pause BEGIN SELECT RAISE(ABORT,'settlement unavailable'); END`,
            )
            const result = yield* f.runtime.cancel(root.id).pipe(Effect.exit)
            yield* f.database.db.run(sql`DROP TRIGGER reject_pause_settlement`)
            expect(result._tag).toBe("Failure")
            expect(
              yield* f.database.db.get(
                sql`SELECT state,fence,desired_active FROM runtime_execution WHERE session_id=${root.id}`,
              ),
            ).toEqual(before)
            expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toEqual(pause)
            yield* f.runtime.cancel(root.id)
            expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({
              state: acknowledged ? "paused" : "terminal",
            })
            expect(
              yield* f.database.db.get(sql`SELECT state FROM session_cooperative_pause WHERE session_id=${root.id}`),
            ).toEqual({ state: "terminal" })
          }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
        )
      }).pipe(Effect.scoped),
  )

it.live(
  "concurrent cancellation and pause admission never leave an accepted barrier behind cancellation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.store.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          for (const index of Array.from({ length: 12 }, (_, index) => index)) {
            const root = yield* enrolled(f)
            const view = yield* SessionHandoff.execution(root.id)
            if (!view.identity) throw new Error("Missing identity")
            const request = {
              requestID: randomUUID(),
              expectedDirectory: f.directory,
              expected: view.identity,
              expectedRecoveryRevision: 0,
            }
            const gate = Promise.withResolvers<void>()
            const pause = Effect.promise(() => gate.promise).pipe(
              Effect.andThen(SessionHandoff.cooperativePause(root.id, request)),
            )
            const cancel = Effect.promise(() => gate.promise).pipe(Effect.andThen(f.runtime.cancel(root.id)))
            const first = yield* (index % 2 ? pause : cancel).pipe(Effect.forkChild)
            const second = yield* (index % 2 ? cancel : pause).pipe(Effect.forkChild)
            gate.resolve()
            yield* Fiber.join(first)
            yield* Fiber.join(second)
            expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({
              state: expect.stringMatching(/^(terminal|refused)$/),
            })
            expect(
              yield* f.database.db.get(
                sql`SELECT state,desired_active FROM runtime_execution WHERE session_id=${root.id}`,
              ),
            ).toEqual({ state: "cancelled", desired_active: 0 })
            expect(
              yield* f.database.db.get(
                sql`SELECT 1 FROM session_cooperative_pause WHERE session_id=${root.id} AND state IN ('accepted','draining','paused')`,
              ),
            ).toBeUndefined()
          }
        }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
      )
    }).pipe(Effect.scoped),
  30000,
)

it.live("cooperative pause never acknowledges a physical-unknown historical Bash resource", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const root = yield* enrolled(f)
        const view = yield* SessionHandoff.execution(root.id)
        if (!view.identity) throw new Error("Missing identity")
        const assistant = MessageID.ascending()
        yield* f.database.db.run(
          sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${assistant},${root.id},2,2,${JSON.stringify({ role: "assistant", parentID: view.identity.userMessageID, agent: "build", mode: "build", providerID: "test", modelID: "test-model", path: { cwd: f.directory, root: f.directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "tool-calls", time: { created: 2, completed: 2 } })})`,
        )
        yield* f.database.db.run(
          sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('unknown-bash',${assistant},${root.id},2,2,${JSON.stringify({ type: "tool", tool: "bash", callID: "unknown-call", state: { status: "error", error: "outcome unknown", input: { command: "printf historical" }, metadata: { interrupted: true }, time: { start: 2, end: 2 } } })})`,
        )
        const parts = yield* f.database.db.all(sql`SELECT * FROM part WHERE session_id=${root.id}`)
        const request = {
          requestID: randomUUID(),
          expectedDirectory: f.directory,
          expected: view.identity,
          expectedRecoveryRevision: 0,
        }
        expect(yield* SessionHandoff.cooperativePause(root.id, request)).toMatchObject({ state: "accepted" })
        expect(yield* f.runtime.cooperativeBoundary(root.id)).toBe("waiting")
        expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({ state: "accepted" })
        expect((yield* SessionHandoff.execution(root.id)).interruptedResources).toMatchObject([
          { liveness: "unknown", effect: "uncertain" },
        ])
        expect(yield* f.database.db.all(sql`SELECT * FROM part WHERE session_id=${root.id}`)).toEqual(parts)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }).pipe(Effect.scoped),
)

for (const compact of [false, true])
  it.live(
    `cooperative pause during ${compact ? "compaction" : "ordinary"} preparation prevents provider admission`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.store.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const plugin = yield* Plugin.Service
            const root = yield* enrolled(f)
            const view = yield* SessionHandoff.execution(root.id)
            if (!view.identity) throw new Error("Missing identity")
            const entered = Promise.withResolvers<void>()
            const release = Promise.withResolvers<void>()
            yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
            const hooks = yield* plugin.list()
            hooks.push(
              compact
                ? {
                    "experimental.session.compacting": async () => {
                      entered.resolve()
                      await release.promise
                    },
                  }
                : {
                    "experimental.chat.messages.transform": async () => {
                      entered.resolve()
                      await release.promise
                    },
                  },
            )
            yield* f.llm.push(reply().text("Should remain undispatched").stop())
            if (compact) {
              const compaction = yield* SessionCompaction.Service
              yield* compaction.create({
                sessionID: root.id,
                agent: "build",
                model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
                auto: true,
                sourceUserMessageID: MessageID.make(view.identity.userMessageID),
              })
            }
            const fiber = yield* prompt.loop({ sessionID: root.id }).pipe(Effect.forkChild)
            yield* awaitWithTimeout(
              Effect.promise(() => entered.promise),
              "Preparation never entered",
            )
            const request = {
              requestID: randomUUID(),
              expectedDirectory: f.directory,
              expected: view.identity,
              expectedRecoveryRevision: 0,
            }
            expect(yield* SessionHandoff.cooperativePause(root.id, request)).toMatchObject({ state: "accepted" })
            release.resolve()
            yield* awaitWithTimeout(Fiber.join(fiber), "Preparation did not reach pause")
            expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({ state: "paused" })
            expect(yield* f.llm.calls).toBe(0)
            expect(
              yield* f.database.db.all(
                sql`SELECT id FROM message WHERE session_id=${root.id} AND json_extract(data,'$.role')='assistant'`,
              ),
            ).toEqual([])
          }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
        )
      }).pipe(Effect.scoped),
  )

it.live("cooperative pause accepted during a terminal provider error settles instead of stranding the barrier", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const root = yield* enrolled(f)
        const view = yield* SessionHandoff.execution(root.id)
        if (!view.identity) throw new Error("Missing identity")
        const request = {
          requestID: randomUUID(),
          expectedDirectory: f.directory,
          expected: view.identity,
          expectedRecoveryRevision: 0,
        }
        const release = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
        yield* f.llm.push(reply().wait(release.promise).contentFilter())
        const fiber = yield* prompt.loop({ sessionID: root.id }).pipe(Effect.forkChild)
        yield* f.llm.wait(1)
        expect(yield* SessionHandoff.cooperativePause(root.id, request)).toMatchObject({ state: "accepted" })
        release.resolve()
        yield* awaitWithTimeout(Fiber.join(fiber), "Terminal turn did not exit")
        expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({ state: "terminal" })
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }).pipe(Effect.scoped),
)

it.live("explicit cancellation settles an accepted cooperative pause without retaining a barrier", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const root = yield* enrolled(f)
        const view = yield* SessionHandoff.execution(root.id)
        if (!view.identity) throw new Error("Missing identity")
        const release = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
        yield* f.llm.push(reply().wait(release.promise).text("Cancelled response").stop())
        const fiber = yield* prompt.loop({ sessionID: root.id }).pipe(Effect.forkChild)
        yield* f.llm.wait(1)
        const request = {
          requestID: randomUUID(),
          expectedDirectory: f.directory,
          expected: view.identity,
          expectedRecoveryRevision: 0,
        }
        expect(yield* SessionHandoff.cooperativePause(root.id, request)).toMatchObject({ state: "accepted" })
        yield* prompt.cancel(root.id)
        release.resolve()
        yield* Fiber.await(fiber)
        expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({ state: "terminal" })
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }).pipe(Effect.scoped),
)

for (const cancelled of [false, true])
  it.live(
    cancelled
      ? "cancellation after a real paused acknowledgement preserves the receipt and forbids explicit resume"
      : "cooperative pause drains a real Bash result before next dispatch and explicitly resumes the same action",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.store.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const root = yield* enrolled(f)
            const view = yield* SessionHandoff.execution(root.id)
            if (!view.identity) throw new Error("Missing identity")
            const ready = path.join(f.directory, "bash-ready")
            const release = path.join(f.directory, "bash-release")
            const modelRelease = Promise.withResolvers<void>()
            yield* Effect.addFinalizer(() => Effect.sync(() => modelRelease.resolve()))
            yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "release")))
            yield* f.llm.push(
              reply().tool("bash", {
                command: `touch '${ready}'; while ! test -f '${release}'; do sleep 0.05; done; printf 'actual cooperative result'`,
                description: "Gated cooperative tool",
                timeout: 30000,
              }),
              reply().wait(modelRelease.promise).text("Original action resumed").stop(),
            )
            const runner = yield* prompt.loop({ sessionID: root.id }).pipe(Effect.forkChild)
            yield* pollWithTimeout(
              Effect.promise(() => Bun.file(ready).exists()).pipe(Effect.map((exists) => (exists ? true : undefined))),
              "Bash never started",
            )
            const request = {
              requestID: randomUUID(),
              expectedDirectory: f.directory,
              expected: view.identity,
              expectedRecoveryRevision: 0,
            }
            const queueBefore = yield* f.database.db.all(sql`SELECT * FROM session_queue WHERE session_id=${root.id}`)
            expect(yield* SessionHandoff.cooperativePause(root.id, request)).toMatchObject({ state: "accepted" })
            expect(yield* f.llm.calls).toBe(1)
            expect(yield* Effect.flip(prompt.queueFlush(root.id))).toMatchObject({ reason: "conflict" })
            expect(
              yield* Effect.flip(
                prompt.prompt({ sessionID: root.id, parts: [{ type: "text", text: "Must not release pause" }] }),
              ),
            ).toMatchObject({ _tag: "RuntimeDrainingError" })
            expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({ state: "accepted" })
            yield* Effect.promise(() => Bun.write(release, "release"))
            yield* Fiber.join(runner)
            const paused = yield* SessionHandoff.receipt(root.id, request.requestID)
            if (paused.kind !== "cooperative_pause") throw new Error("Missing cooperative pause receipt")
            expect(paused).toMatchObject({ state: "paused", expected: view.identity })
            expect(yield* SessionHandoff.execution(root.id)).toMatchObject({ state: "held", ownerLiveness: "live" })
            expect(yield* f.llm.calls).toBe(1)
            const tools = yield* f.database.db.all<{ data: string }>(
              sql`SELECT data FROM part WHERE session_id=${root.id} AND json_extract(data,'$.type')='tool'`,
            )
            expect(tools).toHaveLength(1)
            expect(JSON.parse(tools[0].data)).toMatchObject({
              state: { status: "completed", output: expect.stringContaining("actual cooperative result") },
            })
            expect(yield* f.database.db.all(sql`SELECT * FROM session_queue WHERE session_id=${root.id}`)).toEqual(
              queueBefore,
            )
            yield* f.runtime.release(root.id, view.identity.fence)
            expect(
              yield* f.database.db.get(sql`SELECT state,fence FROM runtime_execution WHERE session_id=${root.id}`),
            ).toEqual({ state: "cooperative_paused", fence: view.identity.fence })
            expect(yield* Effect.flip(f.runtime.admit({ sessionID: root.id, directory: f.directory }))).toMatchObject({
              _tag: "RuntimeDrainingError",
            })
            const resumeRequest = {
              requestID: randomUUID(),
              pauseRequestID: request.requestID,
              expectedDirectory: f.directory,
              expected: view.identity,
              expectedPauseRevision: paused.pauseRevision,
            }
            if (cancelled) {
              yield* prompt.cancel(root.id)
              expect(
                yield* f.database.db.get(
                  sql`SELECT state,fence,desired_active FROM runtime_execution WHERE session_id=${root.id}`,
                ),
              ).toEqual({ state: "cancelled", fence: view.identity.fence + 1, desired_active: 0 })
              expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toEqual(paused)
              expect(yield* SessionHandoff.cooperativePause(root.id, request)).toEqual(paused)
              const terminal = yield* SessionHandoff.cooperativeResume(root.id, resumeRequest)
              expect(terminal).toMatchObject({ state: "recovery_required", reason: "owner_lost", resumeFence: null })
              expect(yield* SessionHandoff.cooperativeResume(root.id, resumeRequest)).toEqual(terminal)
              expect(
                yield* SessionHandoff.cooperativeResume(root.id, { ...resumeRequest, requestID: randomUUID() }),
              ).toMatchObject({ state: "recovery_required", reason: "owner_lost", resumeFence: null })
              yield* f.runtime.waitForIdle(root.id)
              expect(yield* f.llm.calls).toBe(1)
              expect(
                yield* f.database.db.all(
                  sql`SELECT data FROM part WHERE session_id=${root.id} AND json_extract(data,'$.type')='tool'`,
                ),
              ).toEqual(tools)
              return
            }
            const resumed = yield* SessionHandoff.cooperativeResume(root.id, resumeRequest)
            expect(resumed).toMatchObject({ state: "resumed", resumeFence: view.identity.fence })
            yield* pollWithTimeout(
              f.llm.calls.pipe(Effect.map((calls) => (calls === 2 ? true : undefined))),
              "Resume did not dispatch",
            )
            expect(
              yield* awaitWithTimeout(
                SessionHandoff.cooperativeResume(root.id, resumeRequest),
                "Resume retry waited for live model",
                "1 second",
              ),
            ).toEqual(resumed)
            modelRelease.resolve()
            yield* f.runtime.waitForIdle(root.id)
            expect(
              yield* f.database.db.all(
                sql`SELECT data FROM part WHERE session_id=${root.id} AND json_extract(data,'$.type')='tool'`,
              ),
            ).toEqual(tools)
            expect(
              (yield* f.database.db.get<{ count: number }>(
                sql`SELECT COUNT(*) AS count FROM message WHERE session_id=${root.id} AND json_extract(data,'$.role')='user'`,
              ))?.count,
            ).toBe(1)
            expect((yield* SessionHandoff.execution(root.id)).identity?.fence).toBe(view.identity.fence)
          }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
        )
      }).pipe(Effect.scoped),
  )

for (const ownerLost of [false, true, "error"] as const)
  it.live(
    ownerLost
      ? `qualified recovery truthfully holds a ${ownerLost === "error" ? "failed" : "completed"} background result after accepted pause owner loss`
      : "cooperative pause drains a background child through its next turn and retains its in-action result",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.store.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const root = yield* enrolled(f)
            const view = yield* SessionHandoff.execution(root.id)
            if (!view.identity) throw new Error("Missing identity")
            const parentReady = path.join(f.directory, "parent-ready")
            const childReady = path.join(f.directory, "child-ready")
            const parentRelease = Promise.withResolvers<void>()
            const childRelease = path.join(f.directory, "child-release")
            yield* Effect.addFinalizer(() => Effect.sync(() => parentRelease.resolve()))
            yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(childRelease, "release")))
            const plugin = yield* Plugin.Service
            const hooks = yield* plugin.list()
            hooks.push({
              "tool.execute.after": async (input) => {
                if (input.tool !== "task") return
                await Bun.write(parentReady, "ready")
                await parentRelease.promise
              },
            })
            yield* f.llm.push(
              reply().tool("task", {
                description: "Background pause regression",
                prompt: "Perform gated child work",
                subagent_type: "audit",
                background: true,
              }),
              reply().tool("bash", {
                command: `touch '${childReady}'; while ! test -f '${childRelease}'; do sleep 0.05; done; printf child-real-result`,
                description: "Child gate",
                timeout: 30000,
              }),
              ownerLost === "error"
                ? reply().text("Preserved child failure").contentFilter()
                : reply().text("Preserved child completion").stop(),
              reply().text("Parent resumed with completed child").stop(),
            )
            const fiber = yield* prompt.loop({ sessionID: root.id }).pipe(Effect.forkChild)
            yield* pollWithTimeout(
              Effect.promise(async () =>
                (await Bun.file(parentReady).exists()) && (await Bun.file(childReady).exists()) ? true : undefined,
              ),
              "Parent Task/child Bash not admitted",
              "10 seconds",
            )
            const request = {
              requestID: randomUUID(),
              expectedDirectory: f.directory,
              expected: view.identity,
              expectedRecoveryRevision: 0,
            }
            expect(yield* SessionHandoff.cooperativePause(root.id, request)).toMatchObject({ state: "accepted" })
            if (ownerLost) {
              // Stop only the old root loop at a graceful boundary; its already-admitted child remains live.
              yield* f.runtime.park(root.id)
              parentRelease.resolve()
              yield* awaitWithTimeout(Fiber.join(fiber), "Old root did not park", "10 seconds")
              yield* f.runtime.release(root.id, view.identity.fence)
              // Persisted owner-proof mismatch models a lost root owner without killing or changing the child owner.
              yield* f.database.db.run(
                sql`UPDATE runtime_execution SET owner_start_time='0' WHERE session_id=${root.id}`,
              )
              const restarted = RuntimeLifecycle.make(
                { lineage: f.runtime.identity.lineage },
                yield* Effect.scope,
                f.database,
              )
              yield* restarted.recover(() => Effect.die("Owner-lost pause must never automatically wake"))
              expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({
                state: "refused",
                reason: "not_quiet",
              })
              const child = yield* f.database.db.get<{ session_id: string; fence: number; owner_instance: string }>(
                sql`SELECT session_id,fence,owner_instance FROM runtime_execution WHERE parent_session_id=${root.id} AND parent_mode='background'`,
              )
              if (!child) throw new Error("Missing live background child")
              expect(yield* SessionHandoffRecovery.held(f.database, child.session_id)).toBe(true)
              yield* Effect.promise(() => Bun.write(childRelease, "release"))
              const result = yield* pollWithTimeout(
                f.database.db
                  .get<{
                    state: string
                    parent_notification_state: string
                    fence: number
                    owner_instance: string
                  }>(
                    sql`SELECT state,parent_notification_state,fence,owner_instance FROM runtime_execution WHERE session_id=${child.session_id}`,
                  )
                  .pipe(Effect.map((row) => (row?.state === "completed" ? row : undefined))),
                "Held live child did not complete",
                "15 seconds",
              )
              expect(result).toEqual({
                state: "completed",
                parent_notification_state: "pending",
                fence: child.fence,
                owner_instance: child.owner_instance,
              })
              yield* f.runtime.waitForIdle(child.session_id)
              expect(yield* f.runtime.claimParentNotification(child.session_id)).toBe(false)
              expect(yield* f.llm.calls).toBe(3)
              const before = {
                runtime: yield* f.database.db.all(
                  sql`SELECT * FROM runtime_execution WHERE session_id IN (${root.id},${child.session_id}) ORDER BY session_id`,
                ),
                messages: yield* f.database.db.all(
                  sql`SELECT * FROM message WHERE session_id IN (${root.id},${child.session_id}) ORDER BY id`,
                ),
                parts: yield* f.database.db.all(
                  sql`SELECT * FROM part WHERE session_id IN (${root.id},${child.session_id}) ORDER BY id`,
                ),
                queue: yield* f.database.db.all(
                  sql`SELECT * FROM session_queue_state WHERE session_id IN (${root.id},${child.session_id}) ORDER BY session_id`,
                ),
                holds: yield* f.database.db.all(
                  sql`SELECT * FROM session_handoff_recovery_hold WHERE root_session_id=${root.id} ORDER BY session_id`,
                ),
                selection: yield* f.database.db.all(
                  sql`SELECT id,agent,model,permission,metadata FROM session WHERE id IN (${root.id},${child.session_id}) ORDER BY id`,
                ),
                control: yield* f.database.db.all(
                  sql`SELECT * FROM session_handoff_control WHERE session_id=${root.id}`,
                ),
              }
              expect(
                before.parts.some((part) =>
                  JSON.stringify(part).includes(
                    ownerLost === "error" ? "Preserved child failure" : "Preserved child completion",
                  ),
                ),
              ).toBe(true)
              const fresh = yield* Layer.build(
                AppNodeBuilderV1.build(
                  LayerNode.group([
                    Session.node,
                    SessionPrompt.node,
                    InstanceStore.node,
                    Database.node,
                    SessionProjector.node,
                    Provider.node,
                    Agent.node,
                  ]),
                  [[Database.node, Layer.succeed(Database.Service)(f.database)]],
                ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(restarted)), Layer.fresh),
              )
              yield* Effect.gen(function* () {
                const recovery = yield* SessionHandoff.execution(root.id)
                if (!recovery.identity || recovery.recoveryRevision === null || !recovery.descendantDigest)
                  throw new Error("Missing exact recovery guards")
                expect(recovery.descendants).toMatchObject([
                  { proof: "verified", state: "terminal", resultState: ownerLost === "error" ? "error" : "completed" },
                ])
                const qualified = {
                  requestID: randomUUID(),
                  expected: recovery.identity,
                  expectedRecoveryRevision: recovery.recoveryRevision,
                  expectedDescendantDigest: recovery.descendantDigest,
                  target: { providerID: "test", modelID: "test-model", variant: "default" },
                  children: [],
                }
                const attempt = yield* SessionHandoff.recover(root.id, qualified).pipe(Effect.result)
                if (attempt._tag === "Success") {
                  yield* awaitWithTimeout(
                    restarted.waitForIdle(root.id),
                    "Qualified recovery did not finish",
                    "10 seconds",
                  )
                  expect(
                    yield* f.database.db.get(
                      sql`SELECT state,reason FROM session_handoff_recovery_queue_block WHERE session_id=${root.id}`,
                    ),
                  ).toEqual({
                    state: "owned",
                    reason: ownerLost === "error" ? "unresolved_descendant" : "pending_notification",
                  })
                  expect(yield* restarted.claimParentNotification(child.session_id)).toBe(false)
                }
                expect(attempt._tag).toBe("Failure")
                if (attempt._tag !== "Failure")
                  throw new Error("Pending result was incorrectly admitted into circular restoration")
                expect(attempt.failure).toMatchObject({
                  code: "pending_conflict",
                  message: expect.stringContaining("pending background notification"),
                })
                expect(yield* Effect.flip(SessionHandoff.recover(root.id, qualified))).toMatchObject({
                  code: "pending_conflict",
                })
              }).pipe(Effect.provide(fresh), Effect.provideService(RuntimeLifecycle.Service, restarted))
              expect(yield* f.llm.calls).toBe(3)
              expect(
                yield* f.database.db.all(
                  sql`SELECT * FROM runtime_execution WHERE session_id IN (${root.id},${child.session_id}) ORDER BY session_id`,
                ),
              ).toEqual(before.runtime)
              expect(
                yield* f.database.db.all(
                  sql`SELECT * FROM message WHERE session_id IN (${root.id},${child.session_id}) ORDER BY id`,
                ),
              ).toEqual(before.messages)
              expect(
                yield* f.database.db.all(
                  sql`SELECT * FROM part WHERE session_id IN (${root.id},${child.session_id}) ORDER BY id`,
                ),
              ).toEqual(before.parts)
              expect(
                yield* f.database.db.all(
                  sql`SELECT * FROM session_queue_state WHERE session_id IN (${root.id},${child.session_id}) ORDER BY session_id`,
                ),
              ).toEqual(before.queue)
              expect(
                yield* f.database.db.all(
                  sql`SELECT * FROM session_handoff_recovery_hold WHERE root_session_id=${root.id} ORDER BY session_id`,
                ),
              ).toEqual(before.holds)
              expect(
                yield* f.database.db.all(
                  sql`SELECT id,agent,model,permission,metadata FROM session WHERE id IN (${root.id},${child.session_id}) ORDER BY id`,
                ),
              ).toEqual(before.selection)
              expect(
                yield* f.database.db.all(sql`SELECT * FROM session_handoff_control WHERE session_id=${root.id}`),
              ).toEqual(before.control)
              return
            }
            parentRelease.resolve()
            expect(yield* f.runtime.cooperativeBoundary(root.id)).toBe("waiting")
            expect(yield* f.llm.calls).toBe(2)
            yield* Effect.promise(() => Bun.write(childRelease, "release"))
            yield* awaitWithTimeout(Fiber.join(fiber), "Background child result did not drain", "15 seconds")
            expect(yield* f.llm.calls).toBe(3)
            expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({ state: "paused" })
            const after = yield* SessionHandoff.execution(root.id)
            expect(after.taskNotifications).toMatchObject([{ classification: "in_action", state: "delivered" }])
            expect(after.identity).toEqual(view.identity)
            const history = yield* f.sessions.messages({ sessionID: root.id })
            expect(
              history
                .flatMap((message) => message.parts)
                .some((part) => part.type === "text" && part.text.includes("Preserved child completion")),
            ).toBe(true)
          }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
        )
      }).pipe(Effect.scoped),
  )

const removedTargets = (f: Effect.Success<typeof fixture>, runtime: RuntimeLifecycle.Interface) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      Bun.write(
        path.join(f.directory, "opencode.json"),
        JSON.stringify({
          ...testProviderConfig(f.llm.url),
          model: "test/test-model",
        }),
      ),
    )
    return yield* Layer.build(
      AppNodeBuilderV1.build(LayerNode.group([Session.node, InstanceStore.node, Provider.node, Database.node]), [
        [Database.node, Layer.succeed(Database.Service)(f.database)],
      ]).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime)), Layer.fresh),
    )
  })

for (const recovery of [false, true, "stale"] as const)
  it.live(
    recovery === "stale"
      ? "public recovery corroborates a stale returned runtime link without replaying the reused child"
      : recovery
        ? "public recovery continues the enrolled root without replaying ten returned child invocations"
        : "current execution accepts ten returned invocations of one child with frozen origin metadata",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.store.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const root = yield* enrolled(f)
            const view = yield* SessionHandoff.execution(root.id)
            if (!view.identity) throw new Error("Missing root identity")
            const model = { providerID: "test", modelID: "test-model", variant: "" }
            const links = Array.from({ length: 10 }, () => ({
              assistant: MessageID.ascending(),
              user: MessageID.ascending(),
              call: randomUUID(),
            }))
            const first = links[0]
            const latest = links[9]
            if (!first || !latest) throw new Error("Missing synthetic invocation")
            const child = yield* f.sessions.create({
              title: "reused child",
              parentID: root.id,
              agent: "general",
              metadata: {
                task: {
                  parentSessionId: root.id,
                  parentMessageID: first.assistant,
                  parentCallID: first.call,
                  messageID: first.user,
                  model,
                  variant: "",
                },
              },
            })
            for (const [i, link] of links.entries()) {
              const assistant = {
                role: "assistant",
                agent: "build",
                mode: "build",
                providerID: model.providerID,
                modelID: model.modelID,
                path: { cwd: f.directory, root: f.directory },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              }
              yield* f.database.db.run(sql`INSERT INTO message VALUES
          (${link.assistant},${root.id},${i * 3 + 2},${i * 3 + 2},${JSON.stringify({ ...assistant, parentID: view.identity.userMessageID, finish: "tool-calls", time: { created: i * 3 + 2, completed: i * 3 + 2 } })}),
          (${link.user},${child.id},${i * 3 + 3},${i * 3 + 3},${JSON.stringify({ role: "user", agent: "general", model, time: { created: i * 3 + 3 } })}),
          (${`result-${i}`},${child.id},${i * 3 + 4},${i * 3 + 4},${JSON.stringify({ ...assistant, agent: "general", mode: "general", parentID: link.user, finish: "stop", time: { created: i * 3 + 4, completed: i * 3 + 4 } })})`)
              yield* f.database.db
                .run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES
          (${`task-${i}`},${link.assistant},${root.id},${i * 3 + 2},${i * 3 + 2},${JSON.stringify({ type: "tool", tool: "task", callID: link.call, state: { status: i === 0 ? "error" : "completed", ...(i === 0 ? { error: "initial SchemaError" } : { output: `returned ${i}`, title: "returned review" }), time: { start: i * 3 + 2, end: i * 3 + 2 }, input: { prompt: `review ${i}`, subagent_type: "general", ...(i ? { task_id: child.id } : {}) }, metadata: { sessionId: child.id, parentSessionId: root.id, parentMessageID: link.assistant, parentCallID: link.call, messageID: link.user, model, variant: "" } } })}),
          (${`text-${i}`},${link.user},${child.id},${i * 3 + 3},${i * 3 + 3},${JSON.stringify({ type: "text", text: `review ${i}` })}),
          (${`child-output-${i}`},${`result-${i}`},${child.id},${i * 3 + 4},${i * 3 + 4},${JSON.stringify({ type: "text", text: `returned ${i}` })})`)
              yield* SessionHandoffStore.appendAssistant(
                f.database,
                {
                  sessionID: root.id,
                  queueID: view.identity.queueID,
                  userMessageID: view.identity.userMessageID,
                },
                {
                  kind: "ordinary",
                  messageID: link.assistant,
                  parentUserMessageID: view.identity.userMessageID,
                  authorizationUserMessageID: view.identity.userMessageID,
                  epochSequence: 0,
                  controlRequestID: null,
                  selection: { ...model, variant: "default" },
                  selectionEvidence: "persisted_message",
                  dispatch: "unknown",
                },
              )
            }
            yield* f.runtime.admit({
              sessionID: child.id,
              directory: f.directory,
              parentSessionID: root.id,
              parentMessageID: recovery === "stale" ? first.assistant : latest.assistant,
              parentCallID: recovery === "stale" ? first.call : latest.call,
              parentMode: "foreground",
            })
            yield* f.database.db.run(
              sql`UPDATE runtime_execution SET owner_start_time='0' WHERE session_id IN (${root.id},${child.id})`,
            )
            yield* f.database.db.run(
              sql`UPDATE runtime_execution SET state='recovery_needed' WHERE session_id=${child.id}`,
            )
            const current = yield* SessionHandoff.execution(root.id)
            expect(current.eligibility).toBe("eligible")
            expect(current.descendants).toHaveLength(1)
            expect(current.descendants[0]).toMatchObject({
              proof: "verified",
              state: "terminal",
              link: {
                parentAssistantMessageID: latest.assistant,
                parentCallID: latest.call,
                childUserMessageID: latest.user,
              },
              resultAssistantMessageID: "result-9",
              resultState: "completed",
            })
            expect(
              yield* f.database.db.get(
                sql`SELECT json_extract(data,'$.state.error') AS error FROM part WHERE id='task-0'`,
              ),
            ).toEqual({ error: "initial SchemaError" })
            expect(yield* f.llm.calls).toBe(0)
            if (recovery) {
              const restarted = RuntimeLifecycle.make(
                { lineage: f.runtime.identity.lineage },
                yield* Effect.scope,
                f.database,
              )
              const fresh = yield* Layer.build(
                AppNodeBuilderV1.build(
                  LayerNode.group([
                    Session.node,
                    SessionPrompt.node,
                    InstanceStore.node,
                    Database.node,
                    SessionProjector.node,
                    Provider.node,
                    Agent.node,
                  ]),
                  [[Database.node, Layer.succeed(Database.Service)(f.database)]],
                ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(restarted)), Layer.fresh),
              )
              return yield* Effect.gen(function* () {
                if (!current.identity || current.recoveryRevision === null || !current.descendantDigest)
                  throw new Error("Missing recovery guards")
                const childRuntime = yield* f.database.db.get(
                  sql`SELECT * FROM runtime_execution WHERE session_id=${child.id}`,
                )
                const childMessages = yield* f.database.db.all(
                  sql`SELECT * FROM message WHERE session_id=${child.id} ORDER BY id`,
                )
                const childParts = yield* f.database.db.all(
                  sql`SELECT * FROM part WHERE session_id=${child.id} ORDER BY id`,
                )
                const calls = yield* f.database.db.all(sql`SELECT * FROM part WHERE session_id=${root.id} ORDER BY id`)
                const release = Promise.withResolvers<void>()
                yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
                yield* f.llm.push(
                  reply().wait(release.promise).text("Root continuation after ten returned calls").stop(),
                )
                const request = {
                  requestID: randomUUID(),
                  expected: current.identity,
                  expectedRecoveryRevision: current.recoveryRevision,
                  expectedDescendantDigest: current.descendantDigest,
                  target: { providerID: "test", modelID: "test-model", variant: "default" },
                  children: [],
                }
                const receipt = yield* SessionHandoff.recover(root.id, request)
                expect(receipt).toMatchObject({
                  kind: "recovery",
                  sessionID: root.id,
                  state: "applied",
                  reason: null,
                  expected: current.identity,
                  recoveryFence: current.identity.fence + 1,
                  boundary: { kind: "recovery", selection: request.target },
                  interruptedResources: [],
                  children: [],
                })
                const transitioned = yield* SessionHandoff.execution(root.id)
                expect(transitioned.identity).toMatchObject({
                  queueID: current.identity.queueID,
                  userMessageID: current.identity.userMessageID,
                  ownerLineage: restarted.identity.lineage,
                  ownerInstance: restarted.identity.instance,
                  fence: current.identity.fence + 1,
                })
                expect(transitioned.recoveryRevision).toBe(current.recoveryRevision + 1)
                expect(
                  yield* f.database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id=${child.id}`),
                ).toEqual(childRuntime)
                release.resolve()
                yield* pollWithTimeout(
                  Effect.gen(function* () {
                    const row = yield* f.database.db.get<{ state: string }>(
                      sql`SELECT state FROM runtime_execution WHERE session_id=${root.id}`,
                    )
                    const saved = yield* SessionHandoff.receipt(root.id, request.requestID)
                    expect(saved).toMatchObject({ kind: "recovery", reason: null, children: [] })
                    return row?.state === "completed" ? true : undefined
                  }),
                  "returned-child root recovery did not complete",
                )
                expect(yield* f.llm.calls).toBe(1)
                expect(
                  yield* f.database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id=${child.id}`),
                ).toEqual(childRuntime)
                expect(
                  yield* f.database.db.all(sql`SELECT * FROM message WHERE session_id=${child.id} ORDER BY id`),
                ).toEqual(childMessages)
                expect(
                  yield* f.database.db.all(sql`SELECT * FROM part WHERE session_id=${child.id} ORDER BY id`),
                ).toEqual(childParts)
                expect(
                  yield* f.database.db.all(
                    sql`SELECT * FROM part WHERE session_id=${root.id} AND id LIKE 'task-%' ORDER BY id`,
                  ),
                ).toEqual(calls)
                expect(
                  yield* f.database.db.all(
                    sql`SELECT id FROM message WHERE session_id=${root.id} AND json_extract(data,'$.role')='user'`,
                  ),
                ).toEqual([{ id: current.identity.userMessageID }])
                expect(
                  yield* f.database.db.get(
                    sql`SELECT json_extract(m.data,'$.parentID') AS parent_id, json_extract(p.data,'$.text') AS text FROM part p JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id WHERE p.session_id=${root.id} AND json_extract(p.data,'$.text')='Root continuation after ten returned calls'`,
                  ),
                ).toEqual({
                  parent_id: current.identity.userMessageID,
                  text: "Root continuation after ten returned calls",
                })
                expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({
                  state: "applied",
                  reason: null,
                  expected: current.identity,
                })
                expect(yield* SessionHandoff.recover(root.id, request)).toMatchObject({
                  requestID: request.requestID,
                  recoveryFence: receipt.recoveryFence,
                })
                expect(yield* f.llm.calls).toBe(1)
              }).pipe(Effect.provide(fresh), Effect.provideService(RuntimeLifecycle.Service, restarted))
            }
            for (const [part, assistant, status] of [
              ["older-shell", first.assistant, "error"],
              ["current-shell", latest.assistant, "running"],
            ]) {
              yield* f.database.db
                .run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES
          (${part},${assistant},${root.id},1,1,${JSON.stringify({ type: "tool", tool: "bash", callID: part, state: { status, error: "outcome unknown", input: { command: `systemd-run --user --scope --unit=synthetic-${part}.scope -- true` }, metadata: { interrupted: true, result: 0, inactive: true, journalRecords: 3 } } })})`)
            }
            const blocked = yield* SessionHandoff.execution(root.id)
            expect(blocked.eligibility).toBe("unresolved_resource")
            expect(blocked.descendants[0]).toMatchObject({ proof: "verified", state: "terminal" })
            expect(blocked.interruptedResources).toHaveLength(2)
            expect(
              blocked.interruptedResources.every(
                (resource) => resource.liveness === "unknown" && resource.effect === "uncertain",
              ),
            ).toBe(true)
          }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
        )
      }),
  )

for (const unknown of [false, true])
  it.live(
    `separately enrolled actions reuse the original child across default to max: ${unknown ? "unknown prior effect blocks" : "returned error stays historical"}`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.store.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const root = yield* enrolled(f)
            const a = yield* SessionHandoff.execution(root.id)
            if (!a.identity) throw new Error("Missing A identity")
            const links = [0, 1].map(() => ({
              assistant: MessageID.ascending(),
              user: MessageID.ascending(),
              result: MessageID.ascending(),
              part: PartID.ascending(),
              call: randomUUID(),
            }))
            const origin = links[0]
            const latest = links[1]
            if (!origin || !latest) throw new Error("Missing invocation links")
            const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
            const child = yield* f.sessions.create({
              title: "same implementer",
              parentID: root.id,
              agent: "general",
              metadata: {
                task: {
                  parentSessionId: root.id,
                  parentMessageID: origin.assistant,
                  parentCallID: origin.call,
                  messageID: origin.user,
                  model,
                  variant: "",
                },
              },
            })
            const returned = (index: number, identity: SessionHandoffV1.Identity) =>
              Effect.gen(function* () {
                const link = links[index]
                if (!link) throw new Error("Missing invocation")
                const variant = index ? "max" : ""
                const time = Date.now() + index
                const assistant = {
                  agent: "build",
                  mode: "build",
                  ...model,
                  path: { cwd: f.directory, root: f.directory },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  time: { created: time, completed: time },
                }
                yield* f.sessions.updateMessage({
                  ...assistant,
                  id: link.assistant,
                  sessionID: root.id,
                  role: "assistant",
                  parentID: MessageID.make(identity.userMessageID),
                  finish: "tool-calls",
                })
                yield* f.sessions.updateMessage({
                  id: link.user,
                  sessionID: child.id,
                  role: "user",
                  agent: "general",
                  model: { ...model, variant },
                  time: { created: time },
                })
                yield* f.sessions.updateMessage({
                  ...assistant,
                  id: link.result,
                  sessionID: child.id,
                  role: "assistant",
                  agent: "general",
                  mode: "general",
                  parentID: link.user,
                  finish: "stop",
                  ...(index ? {} : { error: { name: "UnknownError", data: { message: "A exact SchemaError" } } }),
                })
                yield* f.sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: link.user,
                  sessionID: child.id,
                  type: "text",
                  text: `implement ${index}`,
                })
                yield* f.sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: link.result,
                  sessionID: child.id,
                  type: "text",
                  text: index ? "B actual completed result" : "A failed result",
                })
                yield* f.sessions.updatePart({
                  id: link.part,
                  messageID: link.assistant,
                  sessionID: root.id,
                  type: "tool",
                  tool: "task",
                  callID: link.call,
                  state: {
                    ...(index
                      ? { status: "completed" as const, title: "B implementation", output: "B actual completed result" }
                      : { status: "error" as const, error: "A exact SchemaError" }),
                    input: {
                      prompt: `implement ${index}`,
                      subagent_type: "general",
                      ...(index ? { task_id: child.id } : {}),
                    },
                    metadata: {
                      sessionId: child.id,
                      parentSessionId: root.id,
                      parentMessageID: link.assistant,
                      parentCallID: link.call,
                      messageID: link.user,
                      model: { ...model, variant },
                      variant,
                    },
                    time: { start: time, end: time },
                  },
                })
                yield* SessionHandoffStore.appendAssistant(
                  f.database,
                  { sessionID: root.id, queueID: identity.queueID, userMessageID: identity.userMessageID },
                  {
                    kind: "ordinary",
                    messageID: link.assistant,
                    parentUserMessageID: identity.userMessageID,
                    authorizationUserMessageID: identity.userMessageID,
                    epochSequence: 0,
                    controlRequestID: null,
                    selection: { ...model, variant: "default" },
                    selectionEvidence: "persisted_message",
                    dispatch: "unknown",
                  },
                )
              })
            yield* returned(0, a.identity)
            yield* f.sessions.updatePart({
              id: PartID.ascending(),
              sessionID: child.id,
              messageID: origin.result,
              type: "tool",
              tool: "bash",
              callID: "A completed effect",
              state: {
                status: "completed",
                input: { command: "synthetic-completed-work" },
                title: "A completed work",
                output: "A recorded result",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            })
            yield* f.runtime.admit({
              sessionID: child.id,
              directory: f.directory,
              parentSessionID: root.id,
              parentMessageID: origin.assistant,
              parentCallID: origin.call,
              parentMode: "foreground",
            })
            yield* SessionHandoffNotification.terminalize(
              f.database,
              root.id,
              yield* SessionHandoffNotification.boundary(f.database, root.id),
            )
            yield* f.runtime.release(root.id)
            const requestA = { requestID: randomUUID(), expected: a.identity, target: { ...model, variant: "default" } }
            const receiptA = yield* SessionHandoff.modelControl(root.id, requestA)
            expect(receiptA).toMatchObject({ state: "expired", reason: "terminal_action" })
            const keyA = { sessionID: root.id, queueID: a.identity.queueID, userMessageID: a.identity.userMessageID }
            const historyA = yield* SessionHandoffStore.lookup(f.database, keyA)
            expect(historyA?.assistants).toMatchObject([
              { messageID: origin.assistant, parentUserMessageID: a.identity.userMessageID },
            ])
            const originMetadata = yield* f.database.db.get(sql`SELECT metadata FROM session WHERE id=${child.id}`)
            const firstPart = yield* f.database.db.get(sql`SELECT * FROM part WHERE id=${origin.part}`)
            yield* enrolled(f, root)
            const b = yield* SessionHandoff.execution(root.id)
            if (!b.identity) throw new Error("Missing B identity")
            expect(b.identity.userMessageID).not.toBe(a.identity.userMessageID)
            expect(b.identity.queueID).not.toBe(a.identity.queueID)
            yield* returned(1, b.identity)
            if (unknown)
              yield* f.sessions.updatePart({
                id: PartID.ascending(),
                sessionID: child.id,
                messageID: origin.result,
                type: "tool",
                tool: "bash",
                callID: "A interrupted effect",
                state: {
                  status: "error",
                  input: { command: "synthetic-prior-work" },
                  error: "A outcome unknown",
                  metadata: { interrupted: true },
                  time: { start: 1, end: 2 },
                },
              })
            yield* f.database.db.run(
              sql`UPDATE runtime_execution SET owner_start_time='0' WHERE session_id IN (${root.id},${child.id})`,
            )
            yield* f.database.db.run(
              sql`UPDATE runtime_execution SET state='recovery_needed',parent_message_id=${latest.assistant},parent_call_id=${latest.call} WHERE session_id=${child.id}`,
            )
            const current = yield* SessionHandoff.execution(root.id)
            expect(current.eligibility).toBe(unknown ? "unresolved_resource" : "eligible")
            expect(current.descendants).toHaveLength(1)
            expect(current.descendants[0]).toMatchObject({
              proof: "verified",
              state: "terminal",
              selection: { ...model, variant: "max" },
              link: {
                parentAssistantMessageID: latest.assistant,
                parentCallID: latest.call,
                childUserMessageID: latest.user,
              },
              resultAssistantMessageID: latest.result,
              resultState: unknown ? "uncertain" : "completed",
            })
            expect(current.interruptedResources).toEqual([])
            expect(current.descendants[0]?.interruptedResources).toMatchObject(
              unknown ? [{ tool: "bash", liveness: "unknown", effect: "uncertain" }] : [],
            )
            if (!current.identity || current.recoveryRevision === null || !current.descendantDigest)
              throw new Error("Missing B guards")
            const keyB = { queueID: current.identity.queueID, userMessageID: current.identity.userMessageID }
            // Probe the historical bytes only inside a rolled-back disposable transaction.
            expect(
              yield* f.database.db
                .transaction((tx) =>
                  Effect.gen(function* () {
                    yield* tx.run(
                      sql`UPDATE part SET data=json_set(data,'$.state.error','different A error') WHERE id=${origin.part}`,
                    )
                    const changed = yield* SessionHandoffRecovery.inspect(
                      { db: tx },
                      root.id,
                      () => Effect.succeed("dead" as const),
                      undefined,
                      keyB,
                    )
                    expect(changed.descendantDigest).not.toBe(current.descendantDigest)
                    return yield* Effect.fail("rollback historical digest probe")
                  }),
                )
                .pipe(Effect.flip),
            ).toBe("rollback historical digest probe")
            const priorRuntime = yield* f.database.db.get(
              sql`SELECT * FROM runtime_execution WHERE session_id=${child.id}`,
            )
            const childHistory = yield* f.database.db.all(
              sql`SELECT * FROM message WHERE session_id=${child.id} ORDER BY id`,
            )
            const childParts = yield* f.database.db.all(
              sql`SELECT * FROM part WHERE session_id=${child.id} ORDER BY id`,
            )
            const taskParts = yield* f.database.db.all(
              sql`SELECT * FROM part WHERE id IN (${origin.part},${latest.part}) ORDER BY id`,
            )
            const request = {
              requestID: randomUUID(),
              expected: current.identity,
              expectedRecoveryRevision: current.recoveryRevision,
              expectedDescendantDigest: current.descendantDigest,
              target: { ...model, variant: "max" },
              children: [],
            }
            const restarted = RuntimeLifecycle.make(
              { lineage: f.runtime.identity.lineage },
              yield* Effect.scope,
              f.database,
            )
            const fresh = yield* Layer.build(
              AppNodeBuilderV1.build(
                LayerNode.group([
                  Session.node,
                  SessionPrompt.node,
                  InstanceStore.node,
                  Database.node,
                  SessionProjector.node,
                  Provider.node,
                  Agent.node,
                ]),
                [[Database.node, Layer.succeed(Database.Service)(f.database)]],
              ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(restarted)), Layer.fresh),
            )
            yield* Effect.gen(function* () {
              if (unknown) {
                const owners = yield* f.database.db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
                expect(yield* SessionHandoff.recover(root.id, request).pipe(Effect.flip)).toMatchObject({
                  code: "unresolved_resource",
                })
                expect(yield* f.database.db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(
                  owners,
                )
                expect((yield* SessionHandoff.execution(root.id)).descendantDigest).toBe(current.descendantDigest)
              } else {
                const owners = yield* f.database.db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
                expect(
                  yield* SessionHandoff.recover(root.id, {
                    ...request,
                    expectedDescendantDigest: "sha256:v1:stale",
                  }).pipe(Effect.flip),
                ).toMatchObject({ code: "stale_context" })
                expect(
                  yield* SessionHandoff.recover(root.id, {
                    ...request,
                    expectedRecoveryRevision: request.expectedRecoveryRevision + 1,
                  }).pipe(Effect.flip),
                ).toMatchObject({ code: "stale_context" })
                expect(yield* f.database.db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(
                  owners,
                )
                yield* f.llm.push(reply().text("B root continuation only").stop())
                const receipt = yield* SessionHandoff.recover(root.id, request)
                expect(receipt).toMatchObject({
                  state: "applied",
                  expected: request.expected,
                  recoveryFence: request.expected.fence + 1,
                  children: [],
                })
                yield* pollWithTimeout(
                  f.database.db
                    .get<{ state: string }>(sql`SELECT state FROM runtime_execution WHERE session_id=${root.id}`)
                    .pipe(Effect.map((row) => (row?.state === "completed" ? true : undefined))),
                  "B continuation did not complete",
                )
                expect(yield* SessionHandoff.recover(root.id, request)).toMatchObject({
                  requestID: request.requestID,
                  state: "applied",
                  reason: null,
                  recoveryFence: receipt.recoveryFence,
                })
                expect(
                  yield* SessionHandoff.recover(root.id, { ...request, target: { ...model, variant: "default" } }).pipe(
                    Effect.flip,
                  ),
                ).toMatchObject({ code: "request_id_conflict" })
                expect(
                  yield* f.database.db.get(
                    sql`SELECT owner_lineage,owner_instance,fence FROM runtime_execution WHERE session_id=${root.id}`,
                  ),
                ).toEqual({
                  owner_lineage: restarted.identity.lineage,
                  owner_instance: restarted.identity.instance,
                  fence: request.expected.fence + 1,
                })
                expect((yield* SessionHandoff.execution(root.id)).recoveryRevision).toBe(
                  request.expectedRecoveryRevision + 1,
                )
                expect(yield* f.llm.calls).toBe(1)
              }
              expect(
                yield* f.database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id=${child.id}`),
              ).toEqual(priorRuntime)
              expect(
                yield* f.database.db.all(sql`SELECT * FROM message WHERE session_id=${child.id} ORDER BY id`),
              ).toEqual(childHistory)
              expect(
                yield* f.database.db.all(sql`SELECT * FROM part WHERE session_id=${child.id} ORDER BY id`),
              ).toEqual(childParts)
              expect(
                yield* f.database.db.all(
                  sql`SELECT * FROM part WHERE id IN (${origin.part},${latest.part}) ORDER BY id`,
                ),
              ).toEqual(taskParts)
              expect(yield* f.database.db.get(sql`SELECT * FROM part WHERE id=${origin.part}`)).toEqual(firstPart)
              expect(yield* f.database.db.get(sql`SELECT metadata FROM session WHERE id=${child.id}`)).toEqual(
                originMetadata,
              )
              expect(yield* SessionHandoffStore.lookup(f.database, keyA)).toEqual(historyA)
              expect(yield* SessionHandoff.receipt(root.id, requestA.requestID)).toEqual(receiptA)
              expect(yield* SessionHandoff.modelControl(root.id, requestA)).toEqual(receiptA)
            }).pipe(Effect.provide(fresh), Effect.provideService(RuntimeLifecycle.Service, restarted))
          }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
        )
      }),
  )

it.live("obsolete terminal controls reconcile removed models and variants before configuration validation", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const session = yield* enrolled(f)
        const view = yield* SessionHandoff.execution(session.id)
        if (!view.identity) throw new Error("Missing identity")
        const requests = [
          {
            requestID: randomUUID(),
            expected: view.identity,
            target: { providerID: "test", modelID: "test-model", variant: "high" },
          },
          {
            requestID: randomUUID(),
            expected: view.identity,
            target: { providerID: "test", modelID: "obsolete-model", variant: "default" },
          },
        ]
        for (const request of requests)
          expect(yield* Effect.flip(SessionHandoff.receipt(session.id, request.requestID))).toMatchObject({
            code: "not_found",
          })
        const boundary = yield* SessionHandoffNotification.boundary(f.database, session.id)
        yield* SessionHandoffNotification.terminalize(f.database, session.id, boundary)
        const removed = yield* removedTargets(f, f.runtime)
        yield* Effect.gen(function* () {
          for (const request of requests) {
            const receipt = yield* SessionHandoff.modelControl(session.id, request)
            expect(receipt).toMatchObject({
              state: "expired",
              reason: "terminal_action",
              dispatch: "none",
              boundary: null,
              target: request.target,
            })
            expect(yield* SessionHandoff.receipt(session.id, request.requestID)).toEqual(receipt)
            expect(yield* SessionHandoff.modelControl(session.id, request)).toEqual(receipt)
            expect(
              yield* Effect.flip(
                SessionHandoff.modelControl(session.id, {
                  ...request,
                  target: { ...request.target, variant: "changed" },
                }),
              ),
            ).toMatchObject({ code: "request_id_conflict" })
          }
          expect(
            yield* Effect.flip(
              SessionHandoff.modelControl(session.id, {
                ...requests[0],
                requestID: randomUUID(),
                expected: { ...view.identity, contextDigest: "forged" },
              }),
            ),
          ).toMatchObject({ code: "stale_context" })
        }).pipe(Effect.provide(removed), Effect.provideService(RuntimeLifecycle.Service, f.runtime))
        expect(
          (yield* SessionHandoffStore.lookup(f.database, {
            sessionID: session.id,
            queueID: session.id,
            userMessageID: view.identity.userMessageID,
          }))?.boundaries,
        ).toEqual([])
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("removed live targets are not admitted while an exact pending control keeps its real receipt", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const session = yield* enrolled(f)
        const view = yield* SessionHandoff.execution(session.id)
        if (!view.identity) throw new Error("Missing identity")
        const request = {
          requestID: randomUUID(),
          expected: view.identity,
          target: { providerID: "test", modelID: "test-model", variant: "high" },
        }
        const pending = yield* SessionHandoff.modelControl(session.id, request)
        expect(pending.state).toBe("pending")
        const current = yield* SessionHandoff.execution(session.id)
        const removed = yield* removedTargets(f, f.runtime)
        yield* Effect.gen(function* () {
          expect(yield* SessionHandoff.modelControl(session.id, request)).toEqual(pending)
          for (const [target, code] of [
            [{ providerID: "test", modelID: "obsolete-model", variant: "default" }, "unsupported_model"],
            [request.target, "unsupported_variant"],
          ] as const) {
            const unsupported = { requestID: randomUUID(), expected: current.identity, target }
            expect(yield* Effect.flip(SessionHandoff.modelControl(session.id, unsupported))).toMatchObject({ code })
            expect(yield* Effect.flip(SessionHandoff.receipt(session.id, unsupported.requestID))).toMatchObject({
              code: "not_found",
            })
          }
          expect(yield* SessionHandoff.receipt(session.id, request.requestID)).toEqual(pending)
        }).pipe(Effect.provide(removed), Effect.provideService(RuntimeLifecycle.Service, f.runtime))
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("strict aggregate requests and terminal lost-response retries have no admission side effects", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const session = yield* enrolled(f)
        const view = yield* SessionHandoff.execution(session.id)
        Schema.decodeUnknownSync(SessionHandoffV1.ExecutionView)(view)
        if (!view.identity) throw new Error("Missing identity")
        const request = {
          requestID: randomUUID(),
          expected: view.identity,
          target: { providerID: "test", modelID: "test-model", variant: "default" },
        }
        expect(yield* Effect.flip(SessionHandoff.receipt(session.id, request.requestID))).toMatchObject({
          code: "not_found",
        })
        expect(
          yield* Effect.flip(
            SessionHandoff.modelControl(session.id, { ...request, target: { ...request.target, extra: true } }),
          ),
        ).toMatchObject({ code: "invalid_request" })
        expect(
          yield* Effect.flip(
            SessionHandoff.modelControl(session.id, {
              ...request,
              target: { ...request.target, variant: "not-configured" },
            }),
          ),
        ).toMatchObject({ code: "unsupported_variant" })
        expect(
          yield* Effect.flip(
            SessionHandoff.modelControl(session.id, { ...request, target: { ...request.target, modelID: "missing" } }),
          ),
        ).toMatchObject({ code: "unsupported_model" })
        expect(
          yield* f.database.db.get(sql`SELECT 1 FROM session_handoff_request WHERE request_id = ${request.requestID}`),
        ).toBeUndefined()
        const boundary = yield* SessionHandoffNotification.boundary(f.database, session.id)
        expect(yield* SessionHandoffNotification.terminalize(f.database, session.id, boundary)).toBe(true)
        const before = yield* f.database.db.get(
          sql`SELECT fence FROM runtime_execution WHERE session_id = ${session.id}`,
        )
        const receipt = yield* SessionHandoff.modelControl(session.id, request)
        expect(receipt).toMatchObject({ state: "expired", reason: "terminal_action", dispatch: "none" })
        expect(yield* SessionHandoff.modelControl(session.id, request)).toEqual(receipt)
        expect(yield* SessionHandoff.receipt(session.id, request.requestID)).toEqual(receipt)
        expect(
          yield* f.database.db.get(sql`SELECT fence FROM runtime_execution WHERE session_id = ${session.id}`),
        ).toEqual(before)
        expect(
          yield* Effect.flip(
            SessionHandoff.modelControl(session.id, { ...request, target: { ...request.target, modelID: "missing" } }),
          ),
        ).toMatchObject({ code: "request_id_conflict" })
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live(
  "dead-owner recovery atomically fences the existing input and expires authentic unadmitted control retries",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.store.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          const session = yield* enrolled(f)
          const live = yield* SessionHandoff.execution(session.id)
          if (!live.identity) throw new Error("Missing identity")
          const lost = {
            requestID: randomUUID(),
            expected: live.identity,
            target: { providerID: "test", modelID: "test-model", variant: "default" },
          }
          const removedRequests = [
            { ...lost, requestID: randomUUID(), target: { ...lost.target, modelID: "obsolete-model" } },
            { ...lost, requestID: randomUUID(), target: { ...lost.target, variant: "high" } },
          ]
          for (const saved of removedRequests)
            expect(yield* Effect.flip(SessionHandoff.receipt(session.id, saved.requestID))).toMatchObject({
              code: "not_found",
            })
          expect(yield* Effect.flip(SessionHandoff.receipt(session.id, lost.requestID))).toMatchObject({
            code: "not_found",
          })
          yield* f.database.db.run(
            sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id = ${session.id}`,
          )
          const restarted = RuntimeLifecycle.make(
            { lineage: f.runtime.identity.lineage },
            yield* Effect.scope,
            f.database,
          )
          const fresh = yield* Layer.build(
            AppNodeBuilderV1.build(
              LayerNode.group([
                Session.node,
                SessionPrompt.node,
                InstanceStore.node,
                Database.node,
                SessionProjector.node,
                Provider.node,
                Agent.node,
              ]),
              [[Database.node, Layer.succeed(Database.Service)(f.database)]],
            ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(restarted)), Layer.fresh),
          )
          yield* Effect.gen(function* () {
            yield* restarted.recover(() => Effect.die("enrolled recovery must be explicit"))
            const held = yield* SessionHandoff.execution(session.id)
            expect(held).toMatchObject({ state: "held", eligibility: "eligible", ownerLiveness: "dead" })
            if (!held.identity || held.recoveryRevision === null || !held.descendantDigest)
              throw new Error("Missing recovery guards")
            const request = {
              requestID: randomUUID(),
              expected: held.identity,
              expectedRecoveryRevision: held.recoveryRevision,
              target: { ...lost.target, variant: "high" },
              expectedDescendantDigest: held.descendantDigest,
              children: [],
            }
            const fence = yield* f.database.db.get(
              sql`SELECT fence FROM runtime_execution WHERE session_id = ${session.id}`,
            )
            expect(
              yield* Effect.flip(
                SessionHandoff.recover(session.id, {
                  ...request,
                  expectedRecoveryRevision: request.expectedRecoveryRevision + 1,
                }),
              ),
            ).toMatchObject({ code: "stale_context" })
            expect(
              yield* f.database.db.get(sql`SELECT fence FROM runtime_execution WHERE session_id = ${session.id}`),
            ).toEqual(fence)
            const release = Promise.withResolvers<void>()
            yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
            yield* f.llm.push(reply().wait(release.promise).text("Recovered same input").stop())
            const recovered = yield* SessionHandoff.recover(session.id, request)
            expect(recovered).toMatchObject({
              kind: "recovery",
              state: "applied",
              recoveryFence: held.identity.fence + 1,
              boundary: { kind: "recovery", selection: request.target },
            })
            expect(yield* SessionHandoff.recover(session.id, request)).toMatchObject({
              requestID: request.requestID,
              state: "applied",
              recoveryFence: recovered.recoveryFence,
            })
            const removed = yield* removedTargets(f, restarted)
            yield* Effect.gen(function* () {
              for (const saved of removedRequests) {
                const receipt = yield* SessionHandoff.modelControl(session.id, saved)
                expect(receipt).toMatchObject({
                  state: "expired",
                  reason: "stale_fence",
                  dispatch: "none",
                  boundary: null,
                  target: saved.target,
                })
                expect(yield* SessionHandoff.modelControl(session.id, saved)).toEqual(receipt)
                expect(yield* SessionHandoff.receipt(session.id, saved.requestID)).toEqual(receipt)
              }
            }).pipe(
              Effect.provide(removed),
              Effect.provideService(RuntimeLifecycle.Service, restarted),
              Effect.ensuring(Effect.sync(() => release.resolve())),
            )
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const row = yield* f.database.db.get<{ state: string }>(
                  sql`SELECT state FROM runtime_execution WHERE session_id = ${session.id}`,
                )
                return row?.state === "completed" ? true : undefined
              }),
              "same-input recovery did not finish",
            )
            expect(
              yield* f.database.db.get<{ count: number }>(
                sql`SELECT count(*) AS count FROM message WHERE session_id = ${session.id} AND json_extract(data,'$.role') = 'user'`,
              ),
            ).toEqual({ count: 1 })
            const expired = yield* SessionHandoff.modelControl(session.id, lost)
            expect(expired).toMatchObject({ state: "expired", dispatch: "none", boundary: null })
            expect(yield* SessionHandoff.modelControl(session.id, lost)).toEqual(expired)
            const receipt = yield* SessionHandoff.receipt(session.id, request.requestID)
            expect(
              (yield* f.llm.inputs).map((input) => ({ model: input.model, effort: input.reasoning_effort })),
            ).toEqual([{ model: "test-model", effort: "high" }])
            expect(receipt).toMatchObject({
              state: "applied",
              dispatch: "started_or_unknown",
              boundary: { firstOrdinaryAssistantMessageID: expect.any(String) },
            })
          }).pipe(Effect.provide(fresh), Effect.provideService(RuntimeLifecycle.Service, restarted))
        }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
      )
    }),
  30_000,
)

it.live(
  "terminal reconciliation records an expired receipt without claims and historical selectors never gain eligibility",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.store.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          const session = yield* enrolled(f)
          const before = yield* SessionHandoff.execution(session.id)
          if (!before.identity) throw new Error("Missing enrolled identity")
          const pending = {
            requestID: randomUUID(),
            expected: before.identity,
            target: { providerID: "test", modelID: "test-model", variant: "high" },
          }
          expect(yield* SessionHandoff.modelControl(session.id, pending)).toMatchObject({ state: "pending" })
          const observed = yield* SessionHandoffNotification.boundary(f.database, session.id)
          yield* SessionHandoffNotification.terminalize(f.database, session.id, observed)
          expect(yield* SessionHandoff.modelControl(session.id, pending)).toMatchObject({
            state: "expired",
            reason: "terminal_action",
            dispatch: "none",
          })
          yield* f.runtime.release(session.id)
          yield* f.database.db.run(
            sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id = ${session.id}`,
          )
          const view = yield* SessionHandoff.execution(session.id)
          if (!view.identity || view.recoveryRevision === null || !view.descendantDigest)
            throw new Error("Missing terminal proof")
          const request = {
            requestID: randomUUID(),
            expected: view.identity,
            expectedRecoveryRevision: view.recoveryRevision,
            expectedDescendantDigest: view.descendantDigest,
            target: pending.target,
            children: [],
          }
          const runtime = yield* f.database.db.get(
            sql`SELECT * FROM runtime_execution WHERE session_id = ${session.id}`,
          )
          expect(yield* SessionHandoff.recover(session.id, request)).toMatchObject({
            state: "expired",
            reason: "terminal_action",
            recoveryFence: null,
            boundary: null,
            dispatch: "none",
          })
          expect(
            yield* f.database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${session.id}`),
          ).toEqual(runtime)
          expect(
            yield* SessionHandoff.execution(session.id, {
              queueID: view.identity.queueID,
              userMessageID: view.identity.userMessageID,
            }),
          ).toMatchObject({ viewKind: "historical", eligibility: "stale", descendants: [] })
          expect(
            yield* Effect.flip(SessionHandoff.execution(session.id, { queueID: view.identity.queueID })),
          ).toMatchObject({ code: "incomplete_action_selector" })
          expect(
            yield* Effect.flip(
              SessionHandoff.execution(session.id, { queueID: "other", userMessageID: view.identity.userMessageID }),
            ),
          ).toMatchObject({ code: "not_found" })
          expect(yield* f.llm.calls).toBe(0)
        }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
      )
    }),
)

it.live(
  "a persisted root provider error leaves recovery held and records continuation failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.store.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          const session = yield* enrolled(f)
          yield* f.database.db.run(
            sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id = ${session.id}`,
          )
          const restarted = RuntimeLifecycle.make(
            { lineage: f.runtime.identity.lineage },
            yield* Effect.scope,
            f.database,
          )
          const fresh = yield* Layer.build(
            AppNodeBuilderV1.build(
              LayerNode.group([
                Session.node,
                SessionPrompt.node,
                InstanceStore.node,
                Database.node,
                SessionProjector.node,
                Provider.node,
                Agent.node,
              ]),
              [[Database.node, Layer.succeed(Database.Service)(f.database)]],
            ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(restarted)), Layer.fresh),
          )
          yield* Effect.gen(function* () {
            yield* restarted.recover(() => Effect.die("automatic recovery must remain held"))
            const view = yield* SessionHandoff.execution(session.id)
            if (!view.identity || view.recoveryRevision === null || !view.descendantDigest)
              throw new Error("Missing recovery guards")
            const request = {
              requestID: randomUUID(),
              expected: view.identity,
              expectedRecoveryRevision: view.recoveryRevision,
              expectedDescendantDigest: view.descendantDigest,
              target: { providerID: "test", modelID: "test-model", variant: "default" },
              children: [],
            }
            yield* f.llm.push({
              type: "http-error",
              status: 400,
              body: { error: { message: "Synthetic rejected request", type: "invalid_request_error" } },
            })
            yield* SessionHandoff.recover(session.id, request)
            const receipt = yield* pollWithTimeout(
              SessionHandoff.receipt(session.id, request.requestID).pipe(
                Effect.map((value) =>
                  "reason" in value && value.reason === "continuation_failed" ? value : undefined,
                ),
              ),
              "root provider error was treated as successful recovery",
            )
            expect(receipt).toMatchObject({ state: "applied", reason: "continuation_failed" })
            expect(
              yield* f.database.db.get(sql`SELECT state FROM runtime_execution WHERE session_id = ${session.id}`),
            ).toEqual({ state: "recovery_needed" })
            expect(
              yield* f.database.db.get(
                sql`SELECT 1 AS held FROM session_handoff_recovery_hold WHERE root_session_id = ${session.id}`,
              ),
            ).toEqual({ held: 1 })
          }).pipe(Effect.provide(fresh), Effect.provideService(RuntimeLifecycle.Service, restarted))
        }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
      )
    }),
  30_000,
)

for (const scenario of ["root", "terminal", "new_tasks", "compaction"] as const) {
  const terminalRoot = scenario === "terminal"
  const newTasks = scenario === "new_tasks"
  const compaction = scenario === "compaction"
  it.live(
    newTasks
      ? "recovered root admits a new reviewer and audit without releasing the original closure holds"
      : compaction
        ? "recovered root automatic compaction preserves exact owned queue restoration"
        : terminalRoot
          ? "terminal-root recovery resumes only the existing background child without changing or rerunning the root"
          : "service recovery preserves a Task child's original input and selection and reports its actual result separately",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.store.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const root = yield* enrolled(f)
            const original = yield* SessionHandoff.execution(root.id)
            if (!original.identity) throw new Error("Missing root identity")
            const key = { queueID: original.identity.queueID, userMessageID: original.identity.userMessageID }
            const parentMessageID = MessageID.ascending()
            const childUserID = MessageID.ascending()
            const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
            const task = {
              parentSessionId: root.id,
              parentMessageID,
              parentCallID: "review-call",
              messageID: childUserID,
              model,
              ...(newTasks ? { variant: "" } : {}),
            }
            const child = yield* f.sessions.create({
              title: "reviewer",
              parentID: root.id,
              agent: "general",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
              metadata: { task },
            })
            yield* f.sessions.updateMessage({
              id: parentMessageID,
              sessionID: root.id,
              role: "assistant",
              parentID: MessageID.make(original.identity.userMessageID),
              agent: "build",
              mode: "build",
              modelID: model.modelID,
              providerID: model.providerID,
              path: { cwd: f.directory, root: f.directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 2, ...(compaction ? { completed: 2 } : {}) },
              ...(compaction
                ? {
                    finish: "tool-calls",
                    tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  }
                : {}),
            })
            yield* SessionHandoffStore.appendAssistant(
              f.database,
              {
                sessionID: root.id,
                queueID: original.identity.queueID,
                userMessageID: original.identity.userMessageID,
              },
              {
                kind: "ordinary",
                messageID: parentMessageID,
                parentUserMessageID: original.identity.userMessageID,
                authorizationUserMessageID: original.identity.userMessageID,
                epochSequence: 0,
                controlRequestID: null,
                selection: { ...model, variant: "default" },
                selectionEvidence: "persisted_message",
                dispatch: "unknown",
              },
            )
            const partID = PartID.ascending()
            yield* f.sessions.updatePart({
              id: partID,
              sessionID: root.id,
              messageID: parentMessageID,
              type: "tool",
              tool: "task",
              callID: "review-call",
              state: {
                status: "running",
                input: { prompt: "Review the existing input", subagent_type: "general", command: "review" },
                metadata: { ...task, sessionId: child.id, ...(terminalRoot ? { background: true } : {}) },
                time: { start: 2 },
              },
            })
            yield* f.sessions.updateMessage({
              id: childUserID,
              sessionID: child.id,
              role: "user",
              agent: "general",
              model: newTasks ? { ...model, variant: "" } : model,
              time: { created: 3 },
            })
            yield* f.sessions.updatePart({
              id: PartID.ascending(),
              sessionID: child.id,
              messageID: childUserID,
              type: "text",
              text: "Review the existing input",
            })
            yield* f.runtime.admit({
              sessionID: child.id,
              directory: f.directory,
              parentSessionID: root.id,
              parentMessageID,
              parentCallID: "review-call",
              parentMode: terminalRoot ? "background" : "foreground",
            })
            if (terminalRoot) {
              const boundary = yield* SessionHandoffNotification.boundary(f.database, root.id)
              yield* SessionHandoffNotification.terminalize(f.database, root.id, boundary)
              yield* f.runtime.release(root.id)
            }
            const input = yield* f.database.db.get(
              sql`SELECT id,session_id,json_remove(data,'$.summary') AS data FROM message WHERE id = ${childUserID}`,
            )
            yield* f.database.db.run(
              sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id IN (${root.id},${child.id})`,
            )
            const originalParts = yield* f.database.db.all(
              sql`SELECT id,message_id,data FROM part WHERE message_id=${childUserID} ORDER BY id`,
            )
            const originalSelection = yield* f.database.db.get(
              sql`SELECT agent,model,permission,metadata FROM session WHERE id=${child.id}`,
            )
            const rootRuntime = yield* f.database.db.get(
              sql`SELECT * FROM runtime_execution WHERE session_id = ${root.id}`,
            )
            const restarted = RuntimeLifecycle.make(
              { lineage: f.runtime.identity.lineage },
              yield* Effect.scope,
              f.database,
            )
            const fresh = yield* Layer.build(
              AppNodeBuilderV1.build(
                LayerNode.group([
                  Session.node,
                  SessionPrompt.node,
                  InstanceStore.node,
                  Database.node,
                  SessionProjector.node,
                  Provider.node,
                  Agent.node,
                ]),
                [[Database.node, Layer.succeed(Database.Service)(f.database)]],
              ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(restarted)), Layer.fresh),
            )
            yield* Effect.gen(function* () {
              yield* restarted.recover(() => Effect.die("automatic child recovery must remain held"))
              const view = yield* SessionHandoff.execution(root.id)
              if (!view.identity || view.recoveryRevision === null || !view.descendantDigest)
                throw new Error("Missing root recovery guards")
              const descendant = view.descendants[0]
              if (
                !descendant?.link ||
                !descendant.inputDigest ||
                !descendant.ownerLineage ||
                !descendant.ownerInstance ||
                descendant.fence === null ||
                descendant.recoveryRevision === null
              )
                throw new Error("Missing child guards")
              expect(descendant).toMatchObject({
                proof: "verified",
                selection: { ...model, variant: "default" },
                agent: "general",
                resultState: "none",
                interruptedResources: [],
              })
              const request = {
                requestID: randomUUID(),
                expected: view.identity,
                expectedRecoveryRevision: view.recoveryRevision,
                target: { ...model, variant: "high" },
                expectedDescendantDigest: view.descendantDigest,
                children: [
                  {
                    link: descendant.link,
                    inputDigest: descendant.inputDigest,
                    ownerLineage: descendant.ownerLineage,
                    ownerInstance: descendant.ownerInstance,
                    fence: descendant.fence,
                    recoveryRevision: descendant.recoveryRevision,
                  },
                ],
              }
              const prior = yield* f.database.db.all(
                sql`SELECT session_id,fence FROM runtime_execution WHERE session_id IN (${root.id},${child.id}) ORDER BY session_id`,
              )
              expect(yield* Effect.flip(SessionHandoff.recover(root.id, { ...request, children: [] }))).toMatchObject({
                code: "stale_context",
              })
              expect(
                yield* f.database.db.all(
                  sql`SELECT session_id,fence FROM runtime_execution WHERE session_id IN (${root.id},${child.id}) ORDER BY session_id`,
                ),
              ).toEqual(prior)
              const reviewerGate = Promise.withResolvers<void>()
              const finalGate = Promise.withResolvers<void>()
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  reviewerGate.resolve()
                  finalGate.resolve()
                }),
              )
              yield* f.llm.push(
                ...(terminalRoot
                  ? [reply().text("Actual reviewer result").stop()]
                  : newTasks
                    ? [
                        reply().text("Actual reviewer result").stop(),
                        reply().tool("task", {
                          description: "second reviewer",
                          subagent_type: "general",
                          model: "test/test-model",
                          prompt: "Perform a new second review.",
                        }),
                        reply().wait(reviewerGate.promise).text("Second reviewer actual result").stop(),
                        reply().tool("task", {
                          description: "audit",
                          subagent_type: "audit",
                          model: "test/test-model",
                          variant: "high",
                          prompt: "Perform a new audit.",
                        }),
                        reply().text("Audit actual result").stop(),
                        reply().wait(finalGate.promise).text("Root continuation").stop(),
                      ]
                    : compaction
                      ? [
                          reply().text("Actual reviewer result").stop(),
                          reply().text("Synthetic compacted summary").stop(),
                          reply().text("Root continuation").stop(),
                        ]
                      : [reply().text("Actual reviewer result").stop(), reply().text("Root continuation").stop()]),
              )
              yield* f.database.db
                .run(sql`CREATE TRIGGER IF NOT EXISTS reject_early_recovery_final_receipt BEFORE INSERT ON session_handoff_receipt
                WHEN json_extract(NEW.data,'$.kind')='recovery'
                  AND json_extract(NEW.data,'$.children[0].state')='terminal'
                  AND json_extract(NEW.data,'$.children[0].recoveryFence')>json_extract(NEW.data,'$.children[0].priorFence')
                  AND json_extract(NEW.data,'$.reason') IS NOT 'continuation_failed'
                  AND EXISTS (SELECT 1 FROM runtime_execution WHERE session_id=json_extract(NEW.data,'$.sessionID') AND state <> 'completed')
                BEGIN SELECT RAISE(ABORT,'terminal recovery receipt before actual root completion'); END`)
              expect(yield* SessionHandoff.recover(root.id, request)).toMatchObject({
                state: terminalRoot ? "expired" : "applied",
                children: [
                  {
                    link: descendant.link,
                    state: "claimed",
                    priorFence: descendant.fence,
                    recoveryFence: descendant.fence + 1,
                  },
                ],
                interruptedResources: [{ tool: "task", effect: "uncertain" }],
              })
              if (newTasks) {
                yield* pollWithTimeout(
                  f.llm.calls.pipe(Effect.map((calls) => (calls === 3 ? true : undefined))),
                  "new reviewer did not dispatch",
                  "20 seconds",
                )
                const control = yield* f.database.db.get<{ reservation: string; data: string }>(
                  sql`SELECT reservation,data FROM session_handoff_control WHERE session_id=${root.id}`,
                )
                const running = yield* f.database.db.get<{
                  session_id: string
                  parent_message_id: string
                  parent_call_id: string
                }>(
                  sql`SELECT session_id,parent_message_id,parent_call_id FROM runtime_execution WHERE parent_session_id=${root.id} AND session_id!=${child.id} AND state='active'`,
                )
                const owner = yield* f.database.db.get<{ fence: number }>(
                  sql`SELECT fence FROM runtime_execution WHERE session_id=${root.id}`,
                )
                if (!control || !running || !owner) throw new Error("Missing admitted reviewer authority")
                const authority = {
                  sessionID: root.id,
                  reservation: control.reservation,
                  controlData: control.data,
                  ownerLineage: restarted.identity.lineage,
                  ownerInstance: restarted.identity.instance,
                  fence: owner.fence,
                }
                const binding = {
                  sessionID: running.session_id,
                  parentMessageID: running.parent_message_id,
                  parentCallID: running.parent_call_id,
                  parentFence: owner.fence,
                }
                const check = (
                  proof: SessionHandoffRecovery.RootAdmission | undefined,
                  caller = { ownerLineage: authority.ownerLineage, ownerInstance: authority.ownerInstance },
                ) =>
                  SessionHandoffEnrollment.newTaskAllowed(f.database, running.session_id, caller).pipe(
                    Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, proof),
                    Effect.provideService(SessionHandoffRecovery.CurrentNewTask, {
                      ...binding,
                      parentFence: proof?.fence ?? binding.parentFence,
                    }),
                  )
                expect(yield* check(authority)).toBe(true)
                expect(yield* check(undefined)).toBe(false)
                expect(yield* check({ ...authority, fence: authority.fence + 1 })).toBe(false)
                expect(
                  yield* check(
                    { ...authority, ownerInstance: "stale-owner" },
                    { ownerLineage: authority.ownerLineage, ownerInstance: "stale-owner" },
                  ),
                ).toBe(false)
                expect(
                  yield* check(authority, { ownerLineage: authority.ownerLineage, ownerInstance: "foreign-caller" }),
                ).toBe(false)
                expect(yield* check({ ...authority, controlData: `${authority.controlData} ` })).toBe(false)
                expect(
                  yield* SessionHandoffEnrollment.newTaskAllowed(f.database, child.id).pipe(
                    Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, authority),
                    Effect.provideService(SessionHandoffRecovery.CurrentNewTask, { ...binding, sessionID: child.id }),
                  ),
                ).toBe(false)
                for (const mutation of [
                  sql`UPDATE session SET permission='[]' WHERE id=${root.id}`,
                  sql`UPDATE runtime_execution SET fence=fence+1 WHERE session_id=${root.id}`,
                  sql`UPDATE runtime_execution SET owner_instance='replacement-owner' WHERE session_id=${root.id}`,
                  sql`INSERT INTO session_handoff_root (session_id,reservation,state) VALUES (${root.id},'competing-preparation','reserved')`,
                ]) {
                  expect(
                    yield* Effect.flip(
                      f.database.db.transaction(
                        (tx) =>
                          Effect.gen(function* () {
                            yield* tx.run(mutation)
                            expect(
                              yield* SessionHandoffEnrollment.newTaskAllowed({ db: tx }, running.session_id).pipe(
                                Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, authority),
                                Effect.provideService(SessionHandoffRecovery.CurrentNewTask, binding),
                              ),
                            ).toBe(false)
                            return yield* Effect.fail("rollback" as const)
                          }),
                        { behavior: "immediate" },
                      ),
                    ),
                  ).toBe("rollback")
                }
                expect(
                  yield* Effect.flip(
                    SessionHandoffEnrollment.reserve(f.database, running.session_id, "unclaimed-preparation"),
                  ),
                ).toMatchObject({ code: "invalidated" })
                const foreign = RuntimeLifecycle.make(
                  { lineage: restarted.identity.lineage },
                  yield* Effect.scope,
                  f.database,
                )
                expect(
                  yield* Effect.flip(
                    foreign
                      .admit({
                        sessionID: running.session_id,
                        directory: f.directory,
                        parentSessionID: root.id,
                        parentMessageID: running.parent_message_id,
                        parentCallID: running.parent_call_id,
                        parentMode: "foreground",
                      })
                      .pipe(
                        Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, authority),
                        Effect.provideService(SessionHandoffRecovery.CurrentNewTask, binding),
                      ),
                  ),
                ).toMatchObject({ _tag: "RuntimeDrainingError" })
                for (const mismatch of [
                  { parentCallID: "wrong-call" },
                  { parentSessionID: child.id },
                  { parentMode: "background" },
                ] as const) {
                  expect(
                    yield* Effect.flip(
                      restarted
                        .admit({
                          sessionID: running.session_id,
                          directory: f.directory,
                          parentSessionID: root.id,
                          parentMessageID: running.parent_message_id,
                          parentCallID: running.parent_call_id,
                          parentMode: "foreground",
                          ...mismatch,
                        })
                        .pipe(
                          Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, authority),
                          Effect.provideService(SessionHandoffRecovery.CurrentNewTask, binding),
                        ),
                    ),
                  ).toMatchObject({ _tag: "RuntimeDrainingError" })
                }
                reviewerGate.resolve()
                yield* pollWithTimeout(
                  f.llm.calls.pipe(Effect.map((calls) => (calls === 6 ? true : undefined))),
                  "new reviewer and audit did not run",
                  "20 seconds",
                )
                expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({
                  children: [{ state: "continuing", resultState: "completed" }],
                })
                const live = yield* SessionHandoff.execution(root.id)
                expect(live.descendants).toHaveLength(3)
                expect(live.descendants.find((item) => item.childSessionID === child.id)).toMatchObject({
                  state: "terminal",
                  resultState: "completed",
                  link: descendant.link,
                })
                for (const item of live.descendants.filter((item) => item.childSessionID !== child.id)) {
                  expect(item).toMatchObject({
                    proof: "verified",
                    state: "terminal",
                    resultState: "completed",
                    fence: 0,
                    selection: {
                      providerID: "test",
                      modelID: "test-model",
                      variant: item.agent === "audit" ? "high" : "default",
                    },
                  })
                  expect(typeof item.resultAssistantMessageID).toBe("string")
                  expect(
                    yield* f.database.db.get(
                      sql`SELECT count(*) AS count FROM message WHERE session_id=${item.childSessionID} AND json_extract(data,'$.role')='user'`,
                    ),
                  ).toEqual({ count: 1 })
                  expect(
                    yield* f.database.db.get(
                      sql`SELECT json_extract(data,'$.text') AS text FROM part WHERE message_id=${item.resultAssistantMessageID} AND json_extract(data,'$.type')='text'`,
                    ),
                  ).toEqual({ text: item.agent === "audit" ? "Audit actual result" : "Second reviewer actual result" })
                }
                expect(
                  live.descendants
                    .filter((item) => item.childSessionID !== child.id)
                    .map((item) => item.agent)
                    .sort(),
                ).toEqual(["audit", "general"])
                expect(live.descendants.find((item) => item.childSessionID === child.id)?.fence).toBe(
                  descendant.fence + 1,
                )
                expect(
                  yield* f.database.db.get(
                    sql`SELECT count(*) AS count FROM session_handoff_recovery_hold WHERE root_session_id=${root.id}`,
                  ),
                ).toEqual({ count: 2 })
                expect(
                  yield* f.database.db.all(
                    sql`SELECT session_id,state,reason FROM session_handoff_recovery_queue_block WHERE recovery_request_id=${request.requestID} ORDER BY session_id`,
                  ),
                ).toEqual(
                  [root.id, child.id].sort().map((session_id) => ({ session_id, state: "owned", reason: null })),
                )
                finalGate.resolve()
              }
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const row = yield* f.database.db.get<{ state: string }>(
                    sql`SELECT state FROM runtime_execution WHERE session_id = ${terminalRoot ? child.id : root.id}`,
                  )
                  return row?.state === "completed" ? true : undefined
                }),
                "Task tree continuation did not finish",
              )
              if (newTasks) {
                expect(
                  yield* f.database.db.all(
                    sql`SELECT session_id,id,state,delivery FROM session_queue WHERE state IN ('pending','claimed','uncertain')`,
                  ),
                ).toEqual([])
                expect(
                  yield* f.database.db.all(sql`SELECT session_id,paused FROM session_queue_state WHERE paused=1`),
                ).toEqual([])
              }
              if (!terminalRoot)
                expect(
                  yield* f.database.db.all(
                    sql`SELECT state,reason FROM session_handoff_recovery_queue_block WHERE recovery_request_id=${request.requestID}`,
                  ),
                ).toEqual([
                  { state: "restored", reason: null },
                  { state: "restored", reason: null },
                ])
              expect(
                (yield* f.llm.inputs).map((input) => ({ model: input.model, effort: input.reasoning_effort })),
              ).toEqual(
                terminalRoot
                  ? [{ model: "test-model", effort: undefined }]
                  : newTasks
                    ? [
                        { model: "test-model", effort: undefined },
                        { model: "test-model", effort: "high" },
                        { model: "test-model", effort: undefined },
                        { model: "test-model", effort: "high" },
                        { model: "test-model", effort: "high" },
                        { model: "test-model", effort: "high" },
                      ]
                    : compaction
                      ? [
                          { model: "test-model", effort: undefined },
                          { model: "test-model", effort: "high" },
                          { model: "test-model", effort: "high" },
                        ]
                      : [
                          { model: "test-model", effort: undefined },
                          { model: "test-model", effort: "high" },
                        ],
              )
              if (terminalRoot)
                expect(
                  yield* f.database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${root.id}`),
                ).toEqual(rootRuntime)
              if (compaction)
                expect(
                  yield* f.database.db.all(
                    sql`SELECT kind FROM session_handoff_compaction WHERE session_id=${root.id} AND kind IN ('request','continuation') ORDER BY rowid`,
                  ),
                ).toEqual([{ kind: "request" }, { kind: "continuation" }])
              expect((yield* f.llm.inputs)[0]).not.toHaveProperty("reasoning_effort")
              expect(
                yield* f.database.db.get(
                  sql`SELECT id,session_id,json_remove(data,'$.summary') AS data FROM message WHERE id = ${childUserID}`,
                ),
              ).toEqual(input)
              expect(
                yield* f.database.db.all(
                  sql`SELECT id,message_id,data FROM part WHERE message_id=${childUserID} ORDER BY id`,
                ),
              ).toEqual(originalParts)
              expect(
                yield* f.database.db.get(sql`SELECT agent,model,permission,metadata FROM session WHERE id=${child.id}`),
              ).toEqual(originalSelection)
              expect(
                yield* f.database.db.get(
                  sql`SELECT count(*) AS count FROM message WHERE session_id = ${child.id} AND json_extract(data,'$.role') = 'user'`,
                ),
              ).toEqual({ count: 1 })
              expect(
                yield* f.database.db.get<{ status: string }>(
                  sql`SELECT json_extract(data,'$.state.status') AS status FROM part WHERE id = ${partID}`,
                ),
              ).toEqual({ status: "error" })
              expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({
                children: [
                  {
                    link: descendant.link,
                    state: "terminal",
                    resultState: "completed",
                    resultAssistantMessageID: expect.any(String),
                  },
                ],
              })
              expect(
                (yield* SessionHandoff.execution(root.id)).descendants.find((item) => item.childSessionID === child.id),
              ).toMatchObject({
                link: descendant.link,
                state: "terminal",
                resultState: "completed",
                resultAssistantMessageID: expect.any(String),
              })
              if (terminalRoot)
                expect(
                  yield* f.database.db.get(
                    sql`SELECT 1 AS held FROM session_handoff_recovery_hold WHERE root_session_id=${root.id} LIMIT 1`,
                  ),
                ).toEqual({ held: 1 })
              if (!terminalRoot)
                yield* pollWithTimeout(
                  f.database.db
                    .get(sql`SELECT 1 FROM session_handoff_recovery_hold WHERE root_session_id=${root.id}`)
                    .pipe(Effect.map((row) => (row ? undefined : true))),
                  "history capture did not finish",
                )
              if (!terminalRoot) {
                expect(
                  yield* f.database.db.all(
                    sql`SELECT session_id,state FROM session_handoff_recovery_queue_block WHERE recovery_request_id=${request.requestID} ORDER BY session_id`,
                  ),
                ).toEqual([root.id, child.id].sort().map((session_id) => ({ session_id, state: "restored" })))
                expect(
                  yield* f.database.db.all(
                    sql`SELECT blocked,paused FROM session_queue_state WHERE session_id IN (${root.id},${child.id})`,
                  ),
                ).toEqual([
                  { blocked: 0, paused: 0 },
                  { blocked: 0, paused: 0 },
                ])
              }
              const action = yield* SessionHandoff.execution(root.id, key)
              const current = yield* SessionHandoff.execution(root.id)
              expect(action.descendants).toEqual(current.descendants)
              expect(action.descendantDigest).toBe(current.descendantDigest)
              expect(action.descendants.find((item) => item.childSessionID === child.id)).toMatchObject({
                link: descendant.link,
                agent: "general",
                resultState: "completed",
                selection: { providerID: "test", modelID: "test-model", variant: "default" },
              })
              yield* f.database.db.run(
                sql`UPDATE session SET metadata='{}',agent='plan',permission='[]' WHERE id=${child.id}`,
              )
              yield* f.database.db.run(
                sql`UPDATE runtime_execution SET parent_call_id='reused-before-next-root',fence=fence+1 WHERE session_id=${child.id}`,
              )
              yield* SessionHandoffRecovery.captureCurrent(
                f.database,
                child.id,
                restarted.verifyOwner,
                RuntimeLifecycle.processLiveness,
              )
              expect((yield* SessionHandoff.execution(root.id, key)).descendants).toEqual(action.descendants)
              // A later generation and reused child are mutable current state,
              // never evidence for the retained original action selector.
              yield* f.database.db.run(
                sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id) VALUES (${root.id},'later-role','active','later-queue','later-user')`,
              )
              yield* f.database.db.run(
                sql`UPDATE session SET metadata='{}',agent='plan',permission='[]' WHERE id IN (${child.id},${root.id})`,
              )
              yield* f.database.db.run(
                sql`UPDATE runtime_execution SET parent_call_id='later-call',fence=fence+1 WHERE session_id=${child.id}`,
              )
              const historical = yield* SessionHandoff.execution(root.id, key)
              expect(historical).toMatchObject({ isCurrent: false, eligibility: "stale", viewKind: "historical" })
              expect(historical.descendants).toEqual(action.descendants)
              expect(historical.interruptedResources).toEqual(action.interruptedResources)
              expect(historical.descendantDigest).toBe(action.descendantDigest)
              expect(historical.assistants).toEqual(action.assistants)
              expect(yield* SessionHandoff.execution(root.id)).toMatchObject({ enrolled: false, descendants: [] })
              expect(
                yield* Effect.flip(SessionHandoff.execution(root.id, { ...key, userMessageID: "later-user" })),
              ).toMatchObject({ code: "not_found" })
              yield* f.database.db.run(
                sql`INSERT INTO session_handoff_recovery_history (session_id,queue_id,user_message_id,revision,data) SELECT session_id,queue_id,user_message_id,MAX(revision)+1,'{}' FROM session_handoff_recovery_history WHERE session_id=${root.id} AND queue_id=${key.queueID} AND user_message_id=${key.userMessageID}`,
              )
              expect(yield* Effect.flip(SessionHandoff.execution(root.id, key))).toMatchObject({
                code: "history_unavailable",
              })
            }).pipe(Effect.provide(fresh), Effect.provideService(RuntimeLifecycle.Service, restarted))
          }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
        )
      }),
    30_000,
  )
}
