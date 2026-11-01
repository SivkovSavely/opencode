import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { McpActivation } from "../../src/session/mcp-activation"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Database } from "@opencode-ai/core/database/database"
import { RuntimeRetirement } from "@opencode-ai/core/runtime-retirement"
import { HistoricalFence } from "@opencode-ai/core/historical-fence"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { sql } from "drizzle-orm"
import { BackgroundJob } from "@/background/job"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Database.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("dispatches ordered deletions after commit without holding the database over listeners", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const database = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const deleted: EventV2.Payload<typeof SessionV1.Event.Deleted>[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== SessionV1.Event.Deleted.type) return
          deleted.push(event as EventV2.Payload<typeof SessionV1.Event.Deleted>)
          if (deleted.at(-1)?.data.sessionID !== child.id) return
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const removal = yield* sessions.remove(root.id).pipe(Effect.forkChild)
      yield* awaitDeferred(entered, "Deletion listener did not start")
      yield* database.db
        .transaction(
          () =>
            Effect.gen(function* () {
              for (const session of [root, child]) {
                expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = ${session.id}`)).toBeUndefined()
                expect(yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${session.id}`)).toEqual([])
                expect(
                  yield* database.db.all(
                    sql`SELECT aggregate_id FROM event_sequence WHERE aggregate_id = ${session.id}`,
                  ),
                ).toEqual([])
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.timeout("2 seconds"))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(removal)
      expect(deleted.map((event) => event.data)).toEqual([
        { sessionID: child.id, info: child },
        { sessionID: root.id, info: root },
      ])
      expect(deleted.every((event) => event.durable && event.location?.directory === root.directory)).toBe(true)
    }),
  )

  it.instance("a late projection failure rolls back the tree without any deletion notifications", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const database = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const deleted: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionV1.Event.Deleted.type) deleted.push(event.type)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* database.db.run(sql`CREATE TEMP TRIGGER reject_root_delete BEFORE DELETE ON session
        WHEN OLD.id = ${sql.raw(`'${root.id}'`)} BEGIN SELECT RAISE(ABORT, 'forced late rollback'); END`)
      yield* Effect.addFinalizer(() => database.db.run(sql`DROP TRIGGER reject_root_delete`).pipe(Effect.orDie))
      expect(Exit.isFailure(yield* sessions.remove(root.id).pipe(Effect.exit))).toBe(true)
      expect(deleted).toEqual([])
      for (const session of [root, child]) {
        expect((yield* sessions.get(session.id)).id).toBe(session.id)
        expect(yield* RuntimeRetirement.lookup(database, session.id)).toBeUndefined()
        expect(yield* database.db.all(sql`SELECT id FROM event WHERE aggregate_id = ${session.id}`)).not.toEqual([])
      }
    }),
  )

  it.instance("caller interruption after commit joins held cleanup and delivers child-before-parent deletions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const database = yield* Database.Service
      const background = yield* BackgroundJob.Service
      const events = yield* EventV2Bridge.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const deleted: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionV1.Event.Deleted.type)
            deleted.push((event as EventV2.Payload<typeof SessionV1.Event.Deleted>).data.sessionID)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const started = yield* Deferred.make<void>()
      const rootStarted = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const joined = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* background.start({
        id: root.id,
        type: "later-prune-cleanup",
        run: Deferred.succeed(rootStarted, undefined).pipe(Effect.andThen(Effect.never)),
      })
      yield* background.start({
        id: child.id,
        type: "held-prune-cleanup",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Deferred.succeed(joined, undefined)),
            ),
          ),
        ),
      })
      yield* awaitDeferred(started, "Job did not start")
      yield* awaitDeferred(rootStarted, "Root job did not start")
      const removal = yield* sessions.remove(root.id).pipe(Effect.forkChild)
      yield* awaitDeferred(cleaning, "Cleanup did not start")
      const interrupting = yield* Fiber.interrupt(removal).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(removal.pollUnsafe()).toBeUndefined()
      expect(deleted).toEqual([])
      expect(
        yield* database.db.get(sql`SELECT id FROM session WHERE id = ${root.id}`).pipe(Effect.timeout("2 seconds")),
      ).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupting)
      expect(yield* Deferred.isDone(joined)).toBe(true)
      expect((yield* background.get(child.id))?.status).toBe("cancelled")
      expect((yield* background.get(root.id))?.status).toBe("cancelled")
      expect(deleted).toEqual([child.id, root.id])
    }),
  )

  it.instance("removal joins a separately cancelled job before completing or notifying", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const database = yield* Database.Service
      const background = yield* BackgroundJob.Service
      const events = yield* EventV2Bridge.Service
      const session = yield* sessions.create({})
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const joined = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const job = yield* background.start({
        type: "separate-cancel",
        metadata: { sessionId: session.id },
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Deferred.succeed(joined, undefined)),
            ),
          ),
        ),
      })
      yield* awaitDeferred(started, "Job did not start")
      const cancelling = yield* background.cancel(job.id).pipe(Effect.forkChild)
      yield* awaitDeferred(cleaning, "Separate cancellation did not start cleanup")
      expect((yield* background.get(job.id))?.status).toBe("cancelled")
      const deleted: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type === SessionV1.Event.Deleted.type) {
            expect(yield* Deferred.isDone(joined)).toBe(true)
            deleted.push((event as EventV2.Payload<typeof SessionV1.Event.Deleted>).data.sessionID)
          }
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const removal = yield* sessions.remove(session.id).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        database.db
          .get(sql`SELECT id FROM session WHERE id = ${session.id}`)
          .pipe(Effect.map((row) => (row ? undefined : true))),
        "Removal did not commit",
      )
      expect(removal.pollUnsafe()).toBeUndefined()
      expect(deleted).toEqual([])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(cancelling)
      yield* Fiber.join(removal)
      expect(yield* Deferred.isDone(joined)).toBe(true)
      expect(deleted).toEqual([session.id])
    }),
  )

  it.instance("same-ID restart joins old cleanup before removal joins the replacement and notifies", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const background = yield* BackgroundJob.Service
      const events = yield* EventV2Bridge.Service
      const session = yield* sessions.create({})
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const joined = yield* Deferred.make<void>()
      const replacementStarted = yield* Deferred.make<void>()
      const replacementCleaning = yield* Deferred.make<void>()
      const replacementRelease = yield* Deferred.make<void>()
      const replacementJoined = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* Effect.addFinalizer(() => Deferred.succeed(replacementRelease, undefined))
      yield* background.start({
        id: session.id,
        type: "old-generation",
        run: Effect.never.pipe(
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Deferred.succeed(joined, undefined)),
            ),
          ),
        ),
      })
      const cancelling = yield* background.cancel(session.id).pipe(Effect.forkChild)
      yield* awaitDeferred(cleaning, "Old cleanup did not start")
      const restarting = yield* background
        .start({
          id: session.id,
          type: "replacement-generation",
          run: Effect.gen(function* () {
            expect(yield* Deferred.isDone(joined)).toBe(true)
            yield* Deferred.succeed(replacementStarted, undefined)
            return yield* Effect.never
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(replacementCleaning, undefined).pipe(
                Effect.andThen(Deferred.await(replacementRelease)),
                Effect.andThen(Deferred.succeed(replacementJoined, undefined)),
              ),
            ),
          ),
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(restarting.pollUnsafe()).toBeUndefined()
      expect(yield* Deferred.isDone(replacementStarted)).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(cancelling)
      yield* Fiber.join(restarting)
      yield* awaitDeferred(replacementStarted, "Replacement did not start after old cleanup")
      const deleted: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== SessionV1.Event.Deleted.type) return
          expect(yield* Deferred.isDone(joined)).toBe(true)
          expect(yield* Deferred.isDone(replacementJoined)).toBe(true)
          deleted.push((event as EventV2.Payload<typeof SessionV1.Event.Deleted>).data.sessionID)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const removal = yield* sessions.remove(session.id).pipe(Effect.forkChild)
      yield* awaitDeferred(replacementCleaning, "Removal did not cancel the replacement")
      expect(removal.pollUnsafe()).toBeUndefined()
      expect(deleted).toEqual([])
      yield* Deferred.succeed(replacementRelease, undefined)
      yield* Fiber.join(removal)
      expect(yield* Deferred.isDone(replacementJoined)).toBe(true)
      expect(deleted).toEqual([session.id])
    }),
  )

  it.instance("notification interruption cannot skip post-commit job cancellation", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const background = yield* BackgroundJob.Service
      const session = yield* sessions.create({})
      const started = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      yield* background.start({
        id: session.id,
        type: "notification-failure",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(finalized, undefined)),
        ),
      })
      yield* awaitDeferred(started, "Job did not start")
      const unsubscribe = yield* events.listen((event) =>
        event.type === SessionV1.Event.Deleted.type ? Effect.interrupt : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      expect(Exit.isFailure(yield* sessions.remove(session.id).pipe(Effect.exit))).toBe(true)
      expect(yield* Deferred.isDone(finalized)).toBe(true)
      expect((yield* background.get(session.id))?.status).toBe("cancelled")
      expect(Exit.isFailure(yield* sessions.get(session.id).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.instance("removes already retired overlapping trees without reattributing shared membership", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const database = yield* Database.Service
      const projectedRoot = yield* sessions.create({})
      const executionRoot = yield* sessions.create({})
      const shared = yield* sessions.create({ parentID: projectedRoot.id })
      const leaf = yield* sessions.create({ parentID: shared.id })
      const runtime = RuntimeLifecycle.make({ lineage: "overlapping-removal" }, yield* Effect.scope, database)
      const lease = yield* runtime.admit({
        sessionID: shared.id,
        directory: shared.directory,
        parentSessionID: executionRoot.id,
      })
      const first = yield* runtime.retireRoot(projectedRoot.id)
      const second = yield* runtime.retireRoot(executionRoot.id)
      yield* sessions.remove(projectedRoot.id)
      yield* sessions.remove(executionRoot.id)
      expect(yield* runtime.retireRoot(projectedRoot.id)).toEqual(first)
      expect(yield* runtime.retireRoot(executionRoot.id)).toEqual(second)
      for (const session of [projectedRoot, executionRoot, shared, leaf])
        expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = ${session.id}`)).toBeUndefined()
      expect(yield* RuntimeRetirement.lookup(database, shared.id)).toEqual({ root_session_id: projectedRoot.id })
      yield* runtime.release(shared.id, lease.fence)
    }),
  )

  it.instance(
    "child removal commits its fence before joining database-using job finalizers, leaving its root and siblings live",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const database = yield* Database.Service
        const background = yield* BackgroundJob.Service
        const root = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: root.id })
        const leaf = yield* sessions.create({ parentID: child.id })
        const sibling = yield* sessions.create({ parentID: root.id })
        const started = yield* Deferred.make<void>()
        const finalized = yield* Deferred.make<boolean>()
        yield* background.start({
          id: child.id,
          type: "prune-finalizer",
          run: Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const retired = yield* RuntimeRetirement.lookup(database, child.id).pipe(Effect.orDie)
                const projected = yield* database.db
                  .get(sql`SELECT id FROM session WHERE id = ${child.id}`)
                  .pipe(Effect.orDie)
                yield* Deferred.succeed(finalized, !!retired && !projected)
              }),
            ),
          ),
        })
        yield* awaitDeferred(started, "Background job did not start")
        yield* sessions.remove(child.id).pipe(Effect.timeout("2 seconds"))
        expect(yield* awaitDeferred(finalized, "Removal did not join the job finalizer")).toBe(true)
        for (const session of [child, leaf]) {
          expect(yield* RuntimeRetirement.lookup(database, session.id)).toEqual({ root_session_id: root.id })
          expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = ${session.id}`)).toBeUndefined()
        }
        for (const session of [root, sibling]) {
          expect((yield* sessions.get(session.id)).id).toBe(session.id)
          expect(yield* RuntimeRetirement.lookup(database, session.id)).toBeUndefined()
        }
      }),
  )

  for (const conflict of ["runtime-parent", "command-owner"] as const) {
    it.instance(`child subtree removal rejects a later ${conflict} conflict without changing any durable state`, () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const database = yield* Database.Service
        const root = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: root.id })
        const valid = yield* sessions.create({ parentID: child.id })
        const conflicting = yield* sessions.create({ parentID: child.id })
        const sibling = yield* sessions.create({ parentID: root.id })
        const other = yield* sessions.create({})
        // Ensure a valid leaf is visited first, independently of the query's row order.
        const leaves = yield* sessions.children(child.id)
        expect(leaves).toHaveLength(2)
        const last = leaves.at(-1)
        if (!last) return yield* Effect.die("Missing conflicting leaf")
        if (conflict === "runtime-parent")
          yield* database.db.run(sql`INSERT INTO runtime_execution (id, session_id, parent_session_id, directory,
            owner_lineage, owner_instance, fence, state, desired_active, retry_at, time_created, time_updated)
            VALUES (${last.id}, ${last.id}, ${other.id}, ${root.directory}, 'owner', 'owner', 7, 'parked', 1, 100, 0, 0)`)
        if (conflict === "command-owner")
          yield* database.db.run(sql`INSERT INTO managed_command (id, session_id, root_session_id,
            owner_instance, execution_generation, state, time_created, time_updated)
            VALUES (${last.id}, ${last.id}, ${other.id}, 'owner', 'generation', 'unknown', 0, 0)`)
        const tables = [
          "session",
          "runtime_execution",
          "runtime_retirement",
          "runtime_retirement_member",
          "historical_fence_prune",
          "historical_fence_evidence",
          "managed_command",
          "event",
          "event_sequence",
        ]
        const before = yield* Effect.forEach(tables, (table) =>
          database.db.all(sql`SELECT * FROM ${sql.identifier(table)}`),
        )
        expect(Exit.isFailure(yield* sessions.remove(child.id).pipe(Effect.exit))).toBe(true)
        expect(
          yield* Effect.forEach(tables, (table) => database.db.all(sql`SELECT * FROM ${sql.identifier(table)}`)),
        ).toEqual(before)
        for (const session of [root, child, valid, conflicting, sibling, other])
          expect((yield* sessions.get(session.id)).id).toBe(session.id)
      }),
    )
  }

  it.instance("root removal rejects conflicting descendant ancestry before any permanent retirement", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const database = yield* Database.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const grandchild = yield* sessions.create({ parentID: child.id })
      const other = yield* sessions.create({})
      yield* database.db.run(sql`INSERT INTO runtime_execution (id, session_id, parent_session_id, directory,
        owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
        VALUES ('conflicting-removal', ${grandchild.id}, ${other.id}, ${root.directory},
          'owner', 'owner', 7, 'parked', 1, 0, 0)`)
      const before = yield* database.db.all(sql`SELECT * FROM runtime_execution WHERE session_id = ${grandchild.id}`)
      expect(Exit.isFailure(yield* sessions.remove(root.id).pipe(Effect.exit))).toBe(true)
      for (const session of [root, child, grandchild, other]) {
        expect((yield* sessions.get(session.id)).id).toBe(session.id)
        expect(yield* RuntimeRetirement.lookup(database, session.id)).toBeUndefined()
        expect(yield* HistoricalFence.partialEvidence(database, session.id)).toBeUndefined()
        expect(
          yield* database.db.all(sql`SELECT * FROM runtime_retirement_member WHERE session_id = ${session.id}`),
        ).toEqual([])
      }
      expect(yield* database.db.all(sql`SELECT * FROM runtime_execution WHERE session_id = ${grandchild.id}`)).toEqual(
        before,
      )
    }),
  )

  it.instance(
    "recursive root removal permanently fences child and grandchild identities before deleting projections",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const database = yield* Database.Service
        const root = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: root.id })
        const grandchild = yield* sessions.create({ parentID: child.id })
        yield* sessions.remove(root.id)
        const ids = [root.id, child.id, grandchild.id].sort()
        expect(yield* RuntimeRetirement.retireRoot(database, root.id)).toEqual({
          rootSessionID: root.id,
          sessionIDs: ids,
        })
        expect(yield* HistoricalFence.partialEvidence(database, root.id)).toMatchObject({
          membershipCoverage: "observed-partial",
        })
        const replacement = RuntimeLifecycle.make({ lineage: "prune-replacement" }, yield* Effect.scope, database)
        expect(yield* replacement.commandStatus(root.id)).toBe("unknown")
        for (const sessionID of ids) {
          expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = ${sessionID}`)).toBeUndefined()
          expect(
            yield* replacement.admit({ sessionID, directory: root.directory, manualRecovery: true }).pipe(Effect.flip),
          ).toMatchObject({ reason: "retired", rootSessionID: root.id })
          expect(
            Exit.isFailure(
              yield* database.db
                .run(
                  sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES (${sessionID}, ${root.projectID}, 'test', ${root.directory}, 'test', '1', 0, 0)
        `,
                )
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        }
      }),
  )

  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("session bookmarks", () => {
  it.instance("persists concurrent, repeated bookmark changes without affecting archive state", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({})

      yield* Effect.all(
        [
          session.setBookmarked({ sessionID: info.id, bookmarked: true }),
          session.setBookmarked({ sessionID: info.id, bookmarked: true }),
        ],
        { concurrency: "unbounded" },
      )
      yield* session.setBookmarked({ sessionID: info.id, bookmarked: true })
      yield* session.setArchived({ sessionID: info.id, time: 1 })

      const persisted = yield* session.get(info.id)
      expect(persisted.bookmarked).toBe(true)
      expect(persisted.time.archived).toBe(1)

      yield* session.setBookmarked({ sessionID: info.id, bookmarked: false })
      expect((yield* session.get(info.id)).bookmarked).toBe(false)
      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("persists concurrent MCP activations and does not copy them into forks", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(
        session.create({ title: "with-mcp-activation", metadata: { source: "sdk", trace: { id: "abc" } } }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      yield* Effect.all(
        ["github", "linear", "docs"].map((name) => session.addMcpActivation({ sessionID: created.id, name })),
        { concurrency: "unbounded" },
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const child = yield* Effect.acquireRelease(
        session.create({ parentID: created.id, metadata: { task: { parentSessionId: created.id } } }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      expect(McpActivation.names(saved.metadata)).toEqual(["github", "linear", "docs"])
      expect(saved.metadata).toMatchObject({ source: "sdk", trace: { id: "abc" } })
      expect(McpActivation.names(fork.metadata)).toEqual([])
      expect(fork.metadata).toMatchObject({ source: "sdk", trace: { id: "abc" } })
      expect(McpActivation.names(child.metadata)).toEqual([])
      expect(child.metadata).toMatchObject({ task: { parentSessionId: created.id } })
    }),
  )

  it.instance("does not accept MCP activation metadata from session creation or metadata updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(
        session.create({
          title: "reject-forged-mcp-activation",
          metadata: {
            [McpActivation.METADATA_KEY]: ["forged"],
            "opencode.mcp.activated": ["legacy"],
            source: "sdk",
          },
        }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      expect(McpActivation.names(created.metadata)).toEqual([])
      expect(created.metadata).not.toHaveProperty("opencode.mcp.activated")
      yield* session.addMcpActivation({ sessionID: created.id, name: "approved" })
      yield* session.setMetadata({
        sessionID: created.id,
        metadata: { [McpActivation.METADATA_KEY]: ["forged"], source: "updated" },
      })

      const saved = yield* session.get(created.id)
      expect(McpActivation.names(saved.metadata)).toEqual(["approved"])
      expect(saved.metadata).toMatchObject({ source: "updated" })

      const abort = new AbortController()
      abort.abort()
      expect(yield* session.addMcpActivation({ sessionID: created.id, name: "cancelled", signal: abort.signal })).toBe(
        false,
      )
      expect(McpActivation.names((yield* session.get(created.id)).metadata)).toEqual(["approved"])
    }),
  )

  it.instance("preserves MCP activations across concurrent full-snapshot updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "activation-update-race" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      yield* Effect.all(
        [
          session.addMcpActivation({ sessionID: created.id, name: "lazy" }),
          session.setTitle({ sessionID: created.id, title: "updated" }),
        ],
        { concurrency: "unbounded" },
      )

      const saved = yield* session.get(created.id)
      expect(saved.title).toBe("updated")
      expect(McpActivation.names(saved.metadata)).toEqual(["lazy"])
    }),
  )

  it.instance("forks the chronological prefix across mixed message ID ordering", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const ids = ["msg_z9-before", "msg_z1-before-wrap", "msg_a0-after-wrap", "msg_a1-after"]
      for (const [index, id] of ids.entries()) {
        yield* session.updateMessage({
          id: MessageID.make(id),
          sessionID: created.id,
          role: "user",
          time: { created: index + 1 },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
      }

      const beforeWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[1]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      const afterWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[2]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      expect((yield* session.messages({ sessionID: beforeWrap.id })).map((msg) => msg.info.time.created)).toEqual([1])
      expect((yield* session.messages({ sessionID: afterWrap.id })).map((msg) => msg.info.time.created)).toEqual([1, 2])
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})
