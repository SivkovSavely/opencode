import { describe, expect } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionQueueStateTable, SessionQueueTable } from "@opencode-ai/core/session/queue.sql"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionQueue } from "@/session/queue"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionQueue.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
      EventV2.node,
    ]),
  ),
)
const payload: SessionQueueV1.Payload = {
  kind: "prompt",
  agent: "build",
  model: { providerID: "test", modelID: "test" },
  parts: [{ type: "text", text: "queued input" }],
}
const processIdentity = RuntimeLifecycle.processIdentity()

const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const queue = yield* SessionQueue.Service
  const database = yield* Database.Service
  const session = yield* sessions.create({})
  return { sessions, queue, db: database.db, sessionID: session.id }
})

const bubble = Effect.fnUntraced(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const messageID = MessageID.ascending()
  const partID = PartID.ascending()
  const data = {
    role: "user" as const,
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    time: { created: Date.now() },
  }
  const part = { type: "text" as const, text: "steer" }
  yield* db.insert(MessageTable).values({ id: messageID, session_id: sessionID, data }).run()
  yield* db.insert(PartTable).values({ id: partID, session_id: sessionID, message_id: messageID, data: part }).run()
  return { messageID, partID }
})

describe("legacy session queue store", () => {
  it.instance("rejects empty inputs and expiring attachments without changing durable state", () =>
    Effect.gen(function* () {
      const s = yield* setup
      for (const value of [
        { ...payload, parts: [] },
        { ...payload, parts: [{ type: "text" as const, text: " \n\t" }] },
        { ...payload, agent: "" },
        { agent: payload.agent, model: payload.model, kind: "shell" as const, command: " " },
        { agent: payload.agent, model: payload.model, kind: "command" as const, command: " ", arguments: "" },
        { ...payload, parts: [{ type: "file" as const, mime: "image/png", url: "blob:temporary" }] },
      ]) {
        const result = yield* s.queue.enqueue(s.sessionID, { id: "invalid", payload: value }).pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure.reason).toBe("invalid")
      }
      expect((yield* s.queue.list(s.sessionID)).items).toEqual([])
      expect((yield* s.queue.list(s.sessionID)).revision).toBe(0)
      const accepted = yield* s.queue.enqueue(s.sessionID, {
        id: "attachment-only",
        payload: { ...payload, parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=" }] },
      })
      expect(accepted.items).toHaveLength(1)
    }),
  )

  it.instance("stable IDs reconcile exact retries, including terminal entries, and reject conflicting reuse", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const first = yield* s.queue.enqueue(s.sessionID, { id: "stable", payload })
      expect(first.revision).toBe(1)
      const retry = yield* s.queue.enqueue(s.sessionID, {
        id: "stable",
        payload: {
          ...payload,
          model: { modelID: "test", providerID: "test" },
        },
        front: false,
      })
      expect(retry).toEqual(first)
      const conflict = yield* s.queue.enqueue(s.sessionID, { id: "stable", payload, front: true }).pipe(Effect.result)
      expect(Result.isFailure(conflict) && conflict.failure.reason).toBe("conflict")
      expect(
        Result.isFailure(
          yield* s.queue
            .enqueue(s.sessionID, { id: "stable", payload: { ...payload, agent: "changed" } })
            .pipe(Effect.result),
        ),
      ).toBe(true)
      yield* s.queue.claimNext(s.sessionID)
      yield* s.queue.delivered(s.sessionID, "stable")
      const delivered = yield* s.queue.enqueue(s.sessionID, { id: "stable", payload })
      expect(delivered.items).toEqual([])
      expect(delivered.revision).toBe(3)
      expect((yield* s.queue.get(s.sessionID, "stable")).state).toBe("delivered")
      const other = yield* s.sessions.create({})
      expect(Result.isFailure(yield* s.queue.enqueue(other.id, { id: "stable", payload }).pipe(Effect.result))).toBe(
        true,
      )
      const deleted = yield* s.queue.enqueue(s.sessionID, { id: "deleted", payload })
      yield* s.queue.update(s.sessionID, { revision: deleted.revision, mutation: { action: "delete", id: "deleted" } })
      expect((yield* s.queue.enqueue(s.sessionID, { id: "deleted", payload })).items).toEqual([])
      expect((yield* s.queue.get(s.sessionID, "deleted")).state).toBe("deleted")
    }),
  )

  it.instance("concurrent submissions and front/end positioning are deterministic", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* Effect.all(
        Array.from({ length: 12 }, () => s.queue.enqueue(s.sessionID, { id: "same", payload })),
        { concurrency: "unbounded" },
      )
      expect((yield* s.queue.list(s.sessionID)).revision).toBe(1)
      yield* s.queue.enqueue(s.sessionID, { id: "end", payload })
      yield* s.queue.enqueue(s.sessionID, { id: "front", payload, front: true })
      expect((yield* s.queue.list(s.sessionID)).items.map((item) => item.id)).toEqual(["front", "same", "end"])
    }),
  )

  it.instance("concurrent claims reserve at most one entry per session", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.queue.enqueue(s.sessionID, { id: "one", payload })
      yield* s.queue.enqueue(s.sessionID, { id: "two", payload })
      const claims = yield* Effect.all(
        Array.from({ length: 16 }, () => s.queue.claimNext(s.sessionID)),
        { concurrency: "unbounded" },
      )
      expect(claims.filter(Boolean).map((item) => item?.id)).toEqual(["one"])
      expect((yield* s.queue.list(s.sessionID)).items.map((item) => item.state)).toEqual(["claimed", "pending"])
      const other = yield* s.sessions.create({})
      yield* s.queue.enqueue(other.id, { id: "independent", payload })
      expect((yield* s.queue.claimNext(other.id))?.id).toBe("independent")
      yield* s.queue.delivered(s.sessionID, "one")
      expect((yield* s.queue.claimNext(s.sessionID))?.id).toBe("two")
    }),
  )

  it.instance("structured output formats round-trip through JSON storage and contract encoding", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const formatted = Schema.decodeUnknownSync(SessionQueueV1.Payload)({
        ...payload,
        format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } } } },
        system: "return structured output",
        tools: { bash: false },
      })
      const initial = yield* s.queue.enqueue(s.sessionID, { id: "formatted", payload: formatted })
      expect(Schema.encodeSync(SessionQueueV1.Snapshot)(initial).items[0]?.payload).toEqual(
        Schema.encodeSync(SessionQueueV1.Payload)(formatted),
      )
      const loaded = yield* s.queue.list(s.sessionID)
      expect(Schema.encodeSync(SessionQueueV1.Snapshot)(loaded)).toEqual(
        Schema.encodeSync(SessionQueueV1.Snapshot)(initial),
      )
      expect(yield* s.queue.enqueue(s.sessionID, { id: "formatted", payload: formatted })).toEqual(initial)
    }),
  )

  it.instance("CAS rejects stale writers and reorder requires the exact pending delivery group", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.queue.enqueue(s.sessionID, { id: "a", payload })
      const initial = yield* s.queue.enqueue(s.sessionID, { id: "b", payload })
      const outcomes = yield* Effect.all(
        [
          s.queue
            .update(s.sessionID, { revision: initial.revision, mutation: { action: "pause", paused: true } })
            .pipe(Effect.result),
          s.queue
            .update(s.sessionID, { revision: initial.revision, mutation: { action: "delete", id: "a" } })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      )
      expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)
      const current = yield* s.queue.list(s.sessionID)
      const ids = current.items.map((item) => item.id)
      for (const invalid of [[], [ids[0] ?? "unknown", ids[0] ?? "unknown"], [...ids, "unknown"]]) {
        const result = yield* s.queue
          .update(s.sessionID, {
            revision: current.revision,
            mutation: { action: "reorder", delivery: "queue", ids: invalid },
          })
          .pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure.reason).toBe("invalid")
      }
      const reordered = yield* s.queue.update(s.sessionID, {
        revision: current.revision,
        mutation: { action: "reorder", delivery: "queue", ids: ids.toReversed() },
      })
      expect(reordered.items.map((item) => item.id)).toEqual(ids.toReversed())
    }),
  )

  it.instance("pending steer conversion/deletion removes the real bubble and cascading parts", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const first = yield* bubble(s.sessionID)
      yield* s.queue.registerSteer(s.sessionID, "steer", payload, first.messageID)
      const initial = yield* s.queue.list(s.sessionID)
      const converted = yield* s.queue.update(s.sessionID, {
        revision: initial.revision,
        mutation: { action: "convert", id: "steer", delivery: "queue" },
      })
      expect(converted.items[0]?.messageID).toBeUndefined()
      expect(converted.items[0]?.delivery).toBe("queue")
      expect(yield* s.db.select().from(MessageTable).where(eq(MessageTable.id, first.messageID)).get()).toBeUndefined()
      expect(yield* s.db.select().from(PartTable).where(eq(PartTable.id, first.partID)).get()).toBeUndefined()
      const journal = yield* s.db.select().from(EventTable).where(eq(EventTable.aggregate_id, s.sessionID)).all()
      expect(
        journal.some((event) => event.type === "message.removed.1" && event.data.messageID === first.messageID),
      ).toBe(true)
      const second = yield* bubble(s.sessionID)
      yield* s.queue.registerSteer(s.sessionID, "delete-steer", payload, second.messageID)
      const beforeDelete = yield* s.queue.list(s.sessionID)
      yield* s.queue.update(s.sessionID, {
        revision: beforeDelete.revision,
        mutation: { action: "delete", id: "delete-steer" },
      })
      expect(yield* s.db.select().from(MessageTable).where(eq(MessageTable.id, second.messageID)).get()).toBeUndefined()
      expect(yield* s.db.select().from(PartTable).where(eq(PartTable.id, second.partID)).get()).toBeUndefined()
    }),
  )

  it.instance("queue-to-steer conversion waits for atomic attachment and claims only transcript bubbles", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const initial = yield* s.queue.enqueue(s.sessionID, { id: "convert", payload })
      const converted = yield* s.queue.update(s.sessionID, {
        revision: initial.revision,
        mutation: { action: "convert", id: "convert", delivery: "steer" },
      })
      expect(converted.items[0]?.messageID).toBeUndefined()
      expect(yield* s.queue.claimSteers(s.sessionID, [])).toEqual([])
      const message = yield* s.db.transaction(
        () =>
          Effect.gen(function* () {
            const message = yield* bubble(s.sessionID)
            yield* s.queue.attachSteer(s.sessionID, "convert", message.messageID)
            return message
          }),
        { behavior: "immediate" },
      )
      expect(yield* s.queue.claimSteers(s.sessionID, [MessageID.ascending()])).toEqual([])
      const claimed = yield* s.db.transaction(() => s.queue.claimSteers(s.sessionID, [message.messageID]), {
        behavior: "immediate",
      })
      expect(claimed.map((item) => item.state)).toEqual(["delivered"])
      const current = yield* s.queue.list(s.sessionID)
      expect(current.items).toEqual([])
      const deletion = yield* s.queue
        .update(s.sessionID, { revision: current.revision, mutation: { action: "delete", id: "convert" } })
        .pipe(Effect.result)
      expect(Result.isFailure(deletion) && deletion.failure.reason).toBe("conflict")
      expect(yield* s.db.select().from(MessageTable).where(eq(MessageTable.id, message.messageID)).get()).toBeDefined()
      expect(yield* s.queue.claimSteers(s.sessionID, [message.messageID])).toEqual([])
    }),
  )

  it.instance("claim/delete races cannot remove a claimed steer bubble", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const message = yield* bubble(s.sessionID)
      yield* s.queue.registerSteer(s.sessionID, "race", payload, message.messageID)
      const current = yield* s.queue.list(s.sessionID)
      yield* Effect.all(
        [
          s.queue.claimSteers(s.sessionID, [message.messageID]),
          s.queue
            .update(s.sessionID, { revision: current.revision, mutation: { action: "delete", id: "race" } })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      )
      const row = yield* s.queue.get(s.sessionID, "race")
      const actual = yield* s.db.select().from(MessageTable).where(eq(MessageTable.id, message.messageID)).get()
      expect(row.state === "delivered" ? actual !== undefined : actual === undefined).toBe(true)
    }),
  )

  it.instance("outer rollback restores entries, revisions, claims, flags, and removed bubbles", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const message = yield* bubble(s.sessionID)
      yield* s.queue.registerSteer(s.sessionID, "rollback-steer", payload, message.messageID)
      const before = yield* s.queue.enqueue(s.sessionID, { id: "rollback-queue", payload })
      const journal = yield* s.db.select().from(EventTable).where(eq(EventTable.aggregate_id, s.sessionID)).all()
      const result = yield* s.db
        .transaction(
          () =>
            Effect.gen(function* () {
              yield* s.queue.update(s.sessionID, {
                revision: before.revision,
                mutation: { action: "delete", id: "rollback-steer" },
              })
              yield* s.queue.claimNext(s.sessionID)
              yield* s.queue.block(s.sessionID)
              yield* s.queue.enqueue(s.sessionID, { id: "rolled-back", payload })
              return yield* Effect.fail("rollback")
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      expect(yield* s.queue.list(s.sessionID)).toEqual(before)
      expect(yield* s.db.select().from(EventTable).where(eq(EventTable.aggregate_id, s.sessionID)).all()).toEqual(
        journal,
      )
      expect(yield* s.db.select().from(MessageTable).where(eq(MessageTable.id, message.messageID)).get()).toBeDefined()
      expect(yield* s.db.select().from(PartTable).where(eq(PartTable.id, message.partID)).get()).toBeDefined()
      const registration = yield* s.db
        .transaction(
          () =>
            Effect.gen(function* () {
              const message = yield* bubble(s.sessionID)
              yield* s.queue.registerSteer(s.sessionID, "rolled-back-registration", payload, message.messageID)
              return yield* Effect.fail("rollback")
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.result)
      expect(Result.isFailure(registration)).toBe(true)
      expect(yield* s.queue.list(s.sessionID)).toEqual(before)
      yield* s.db
        .transaction(
          () =>
            Effect.gen(function* () {
              yield* s.queue.claimSteers(s.sessionID, [message.messageID])
              return yield* Effect.fail("rollback")
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.result)
      expect(yield* s.queue.list(s.sessionID)).toEqual(before)
    }),
  )

  it.instance("native steer registration is idempotent after irreversible transcript admission", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const message = yield* bubble(s.sessionID)
      yield* s.queue.registerSteer(s.sessionID, "native", { ...payload, variant: undefined }, message.messageID)
      expect((yield* s.queue.registerSteer(s.sessionID, "native", payload, message.messageID)).state).toBe("pending")
      yield* s.queue.claimSteers(s.sessionID, [message.messageID])
      const before = yield* s.queue.list(s.sessionID)
      expect((yield* s.queue.registerSteer(s.sessionID, "native", payload, message.messageID)).state).toBe("delivered")
      expect(yield* s.queue.list(s.sessionID)).toEqual(before)
      expect(
        Result.isFailure(
          yield* s.queue.registerSteer(s.sessionID, "native", payload, MessageID.ascending()).pipe(Effect.result),
        ),
      ).toBe(true)
      expect(
        Result.isFailure(
          yield* s.queue.registerSteer(s.sessionID, "other-native", payload, message.messageID).pipe(Effect.result),
        ),
      ).toBe(true)
    }),
  )

  it.instance("pause and block persist independently; only explicit claim bypasses them", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const initial = yield* s.queue.enqueue(s.sessionID, { id: "paused", payload })
      yield* s.queue.update(s.sessionID, { revision: initial.revision, mutation: { action: "pause", paused: true } })
      yield* s.queue.block(s.sessionID)
      expect(yield* s.queue.claimNext(s.sessionID)).toBeUndefined()
      const unblocked = yield* s.queue.unblock(s.sessionID)
      expect(unblocked.paused).toBe(true)
      expect(unblocked.blocked).toBe(false)
      expect(yield* s.queue.claimNext(s.sessionID)).toBeUndefined()
      yield* s.queue.block(s.sessionID)
      expect((yield* s.queue.claimNext(s.sessionID, true))?.id).toBe("paused")
      const state = yield* s.queue.list(s.sessionID)
      expect(state.paused && state.blocked).toBe(true)
    }),
  )

  it.instance("clear tombstones only pending queued entries, preserving steers and in-flight work", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.queue.enqueue(s.sessionID, { id: "claimed", payload })
      yield* s.queue.claimNext(s.sessionID)
      yield* s.queue.enqueue(s.sessionID, { id: "pending", payload })
      const message = yield* bubble(s.sessionID)
      yield* s.queue.registerSteer(s.sessionID, "pending-steer", payload, message.messageID)
      const before = yield* s.queue.list(s.sessionID)
      const after = yield* s.queue.update(s.sessionID, { revision: before.revision, mutation: { action: "clear" } })
      expect(after.items.map((item) => item.id)).toEqual(["claimed", "pending-steer"])
      expect((yield* s.queue.get(s.sessionID, "pending")).state).toBe("deleted")
      expect(yield* s.db.select().from(MessageTable).where(eq(MessageTable.id, message.messageID)).get()).toBeDefined()
    }),
  )

  it.instance("service rebuild preserves durable state; old-process claims become uncertain and never replay", () =>
    Effect.gen(function* () {
      if (!processIdentity) return
      const s = yield* setup
      yield* s.queue.enqueue(s.sessionID, { id: "abandoned", payload })
      yield* s.queue.enqueue(s.sessionID, { id: "remaining", payload })
      yield* s.queue.claimNext(s.sessionID)
      const before = yield* s.queue.block(s.sessionID)
      const rebuilt = yield* SessionQueue.Service.pipe(Effect.provide(Layer.fresh(SessionQueue.layer)))
      expect(yield* rebuilt.list(s.sessionID)).toEqual(before)
      // Model a durable reservation left by a previous process, not a layer reload.
      yield* s.db
        .update(SessionQueueTable)
        .set({ owner: JSON.stringify({ id: "previous-process", process: { ...processIdentity, startTime: "old" } }) })
        .where(eq(SessionQueueTable.id, "abandoned"))
        .run()
      const recovered = yield* rebuilt.list(s.sessionID)
      expect(recovered.revision).toBe(before.revision + 1)
      expect(recovered.blocked).toBe(true)
      expect(recovered.items.find((item) => item.id === "abandoned")?.state).toBe("uncertain")
      expect(yield* rebuilt.list(s.sessionID)).toEqual(recovered)
      expect(yield* rebuilt.claimNext(s.sessionID)).toBeUndefined()
      yield* rebuilt.unblock(s.sessionID)
      expect((yield* rebuilt.claimNext(s.sessionID))?.id).toBe("remaining")
      expect((yield* rebuilt.get(s.sessionID, "abandoned")).state).toBe("uncertain")
      expect(Result.isFailure(yield* rebuilt.delivered(s.sessionID, "abandoned").pipe(Effect.result))).toBe(true)
    }),
  )

  it.instance("queue reads preserve live foreign claims and quarantine them only after verified process exit", () =>
    Effect.gen(function* () {
      if (!processIdentity) return
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "inherit" }),
        ),
        (child) =>
          Effect.promise(async () => {
            child.kill()
            await child.exited
          }),
      )
      const stat = yield* Effect.promise(() => Bun.file(`/proc/${child.pid}/stat`).text())
      const startTime = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[19]
      if (!startTime) return yield* Effect.die("Missing child process start time")
      const s = yield* setup
      yield* s.queue.enqueue(s.sessionID, { id: "foreign-live", payload })
      yield* s.queue.enqueue(s.sessionID, { id: "remaining", payload })
      yield* s.queue.claimNext(s.sessionID)
      yield* s.db
        .update(SessionQueueTable)
        .set({
          owner: JSON.stringify({ id: "other-server", process: { ...processIdentity, pid: child.pid, startTime } }),
        })
        .where(eq(SessionQueueTable.id, "foreign-live"))
        .run()
      const live = yield* s.queue.list(s.sessionID)
      expect(live.items[0].state).toBe("claimed")
      expect(live.blocked).toBe(false)
      expect(yield* s.queue.list(s.sessionID)).toEqual(live)
      expect(yield* s.queue.claimNext(s.sessionID, true)).toBeUndefined()
      yield* s.queue.abandon(s.sessionID)
      expect((yield* s.queue.get(s.sessionID, "foreign-live")).state).toBe("claimed")
      child.kill()
      yield* Effect.promise(() => child.exited)
      const dead = yield* s.queue.list(s.sessionID)
      expect(dead.items[0].state).toBe("uncertain")
      expect(dead.blocked).toBe(true)
      expect(dead.revision).toBe(live.revision + 2)
      expect(yield* s.queue.list(s.sessionID)).toEqual(dead)
      expect((yield* s.queue.claimNext(s.sessionID, true))?.id).toBe("remaining")
    }),
  )

  it.instance("unverifiable foreign claims remain reserved without altering queue revisions", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.queue.enqueue(s.sessionID, { id: "unknown-owner", payload })
      yield* s.queue.claimNext(s.sessionID)
      const before = yield* s.queue.list(s.sessionID)
      for (const owner of [null, "legacy-process-id", JSON.stringify({ id: "unverifiable" })]) {
        yield* s.db.update(SessionQueueTable).set({ owner }).where(eq(SessionQueueTable.id, "unknown-owner")).run()
        expect(yield* s.queue.list(s.sessionID)).toEqual(before)
        expect(yield* s.queue.claimNext(s.sessionID, true)).toBeUndefined()
      }
    }),
  )

  it.instance("closing and reopening SQLite preserves pause, block, revisions, tombstones, and abandoned claims", () =>
    Effect.gen(function* () {
      if (!processIdentity) return
      const s = yield* setup
      const ctx = yield* InstanceRef
      if (!ctx) return yield* Effect.die("Missing test instance")
      const project = yield* s.db.select().from(ProjectTable).where(eq(ProjectTable.id, ctx.project.id)).get()
      const session = yield* s.db.select().from(SessionTable).where(eq(SessionTable.id, s.sessionID)).get()
      if (!project || !session) return yield* Effect.die("Missing persisted fixture")
      const connection = Layer.fresh(
        SessionQueue.layer.pipe(Layer.provideMerge(Database.layerFromPath(ctx.directory + "/queue.db"))),
      )
      const before = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const queue = yield* SessionQueue.Service
        yield* db.insert(ProjectTable).values(project).run()
        yield* db.insert(SessionTable).values(session).run()
        const initial = yield* queue.enqueue(s.sessionID, { id: "restart-claim", payload })
        yield* queue.update(s.sessionID, { revision: initial.revision, mutation: { action: "pause", paused: true } })
        yield* queue.claimNext(s.sessionID, true)
        const queued = yield* queue.enqueue(s.sessionID, { id: "restart-deleted", payload })
        yield* queue.update(s.sessionID, {
          revision: queued.revision,
          mutation: { action: "delete", id: "restart-deleted" },
        })
        yield* queue.block(s.sessionID)
        yield* db
          .update(SessionQueueTable)
          .set({ owner: JSON.stringify({ id: "exited-process", process: { ...processIdentity, startTime: "old" } }) })
          .where(eq(SessionQueueTable.id, "restart-claim"))
          .run()
        return yield* db
          .select()
          .from(SessionQueueStateTable)
          .where(eq(SessionQueueStateTable.session_id, s.sessionID))
          .get()
      }).pipe(Effect.provide(connection), Effect.scoped)
      yield* Effect.gen(function* () {
        const queue = yield* SessionQueue.Service
        const after = yield* queue.list(s.sessionID)
        expect(after.revision).toBe((before?.revision ?? 0) + 1)
        expect(after.paused && after.blocked).toBe(true)
        expect(after.items.map((item) => item.state)).toEqual(["uncertain"])
        expect((yield* queue.enqueue(s.sessionID, { id: "restart-deleted", payload })).items).toHaveLength(1)
        expect((yield* queue.get(s.sessionID, "restart-deleted")).state).toBe("deleted")
        expect(yield* queue.claimNext(s.sessionID, true)).toBeUndefined()
      }).pipe(Effect.provide(connection), Effect.scoped)
    }),
  )

  it.instance("validates archive, project, directory, and missing sessions before accessing queue state", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const ctx = yield* InstanceRef
      if (!ctx) return yield* Effect.die("Missing test instance")
      for (const override of [
        { ...ctx, directory: ctx.directory + "/other-worktree" },
        { ...ctx, project: { ...ctx.project, id: "another-project" } },
      ]) {
        const result = yield* s.queue
          .list(s.sessionID)
          .pipe(Effect.provideService(InstanceRef, override), Effect.result)
        expect(Result.isFailure(result) && result.failure.reason).toBe("scope")
      }
      const missing = yield* s.queue.list(SessionID.descending()).pipe(Effect.result)
      expect(Result.isFailure(missing) && missing.failure.reason).toBe("not_found")
      yield* s.db.update(SessionTable).set({ time_archived: Date.now() }).where(eq(SessionTable.id, s.sessionID)).run()
      const archived = yield* s.queue.enqueue(s.sessionID, { id: "archived", payload }).pipe(Effect.result)
      expect(Result.isFailure(archived) && archived.failure.reason).toBe("archived")
      expect(
        yield* s.db
          .select()
          .from(SessionQueueStateTable)
          .where(eq(SessionQueueStateTable.session_id, s.sessionID))
          .get(),
      ).toBeUndefined()
    }),
  )

  it.instance("session deletion cascades durable queue rows and flags", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.queue.enqueue(s.sessionID, { id: "cascade", payload })
      yield* s.queue.block(s.sessionID)
      yield* s.db.delete(SessionTable).where(eq(SessionTable.id, s.sessionID)).run()
      expect(
        yield* s.db.select().from(SessionQueueTable).where(eq(SessionQueueTable.id, "cascade")).get(),
      ).toBeUndefined()
      expect(
        yield* s.db
          .select()
          .from(SessionQueueStateTable)
          .where(eq(SessionQueueStateTable.session_id, s.sessionID))
          .get(),
      ).toBeUndefined()
    }),
  )

  it.instance(
    "standalone mutations publish the canonical change event after commit and exact retries do not publish",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        const events = yield* EventV2.Service
        const seen: number[] = []
        const unsubscribe = yield* events.listen((event) =>
          Effect.gen(function* () {
            if (
              event.type !== SessionQueue.Event.Changed.type ||
              Schema.decodeUnknownSync(SessionQueue.Event.Changed.data)(event.data).sessionID !== s.sessionID
            )
              return
            const state = yield* s.db
              .select()
              .from(SessionQueueStateTable)
              .where(eq(SessionQueueStateTable.session_id, s.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (state) seen.push(state.revision)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        yield* s.queue.enqueue(s.sessionID, { id: "event", payload })
        yield* s.queue.enqueue(s.sessionID, { id: "event", payload })
        expect(SessionQueue.Event).toBe(SessionQueueV1.Event)
        expect(seen).toEqual([1])
      }),
  )
})
