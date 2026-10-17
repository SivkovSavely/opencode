import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { eq } from "drizzle-orm"
import { Effect, Result } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionQueueImportTable } from "@opencode-ai/core/session/queue-import.sql"
import { SessionQueueStateTable, SessionQueueTable } from "@opencode-ai/core/session/queue.sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { MessageV2 } from "@/session/message-v2"
import { SessionQueue } from "@/session/queue"
import { SessionQueueMigration } from "@/session/queue-migration"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionQueue.node, Database.node, SessionProjector.node])),
)
const info = { agent: "plan", model: { providerID: "test", modelID: "test-model" }, variant: "high" }
const prompt = { kind: "prompt", info, body: "restored", parts: [{ type: "text", text: "restored" }] }
const setup = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die("Missing instance")
  const sessions = yield* Session.Service
  const queue = yield* SessionQueue.Service
  const { db } = yield* Database.Service
  const session = yield* sessions.create({})
  const file = SessionQueueMigration.storagePath(ctx.project.id)
  yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(file, { force: true })))
  const write = (value: unknown) => Effect.promise(() => Bun.write(file, JSON.stringify(value)))
  const store = (value: unknown) => write({ version: 1, projectID: ctx.project.id, sessions: { [session.id]: value } })
  return { ctx, sessions, queue, db, session, file, write, store }
})

const message = Effect.fnUntraced(function* (sessionID: SessionID, text: string, hidden = false) {
  const { db } = yield* Database.Service
  const id = MessageID.ascending()
  const data = {
    role: "user" as const,
    agent: "plan",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
    time: { created: Date.now() },
  }
  const part = { type: "text" as const, text, ...(hidden ? { synthetic: true, ignored: true } : {}) }
  yield* db.insert(MessageTable).values({ id, session_id: sessionID, data }).run()
  yield* db
    .insert(PartTable)
    .values({ id: PartID.ascending(), message_id: id, session_id: sessionID, data: part })
    .run()
  return id
})

describe("legacy queue migration", () => {
  it.instance(
    "imports every payload in order, blocks replay, and preserves the original file",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        const input = [
          {
            ...prompt,
            parts: [
              { type: "text", text: "restored", id: "prt_old", messageID: "msg_old", sessionID: "ses_old" },
              { type: "file", mime: "text/plain", url: "file:///tmp/input.txt" },
              { type: "agent", name: "build" },
              { type: "subtask", prompt: "sub", description: "task", agent: "build" },
            ],
          },
          {
            kind: "command",
            info,
            source: "/test arg",
            cmd: "test",
            args: "arg",
            files: [{ type: "file", mime: "text/plain", url: "file:///tmp/input.txt", id: "prt_old" }],
          },
          { kind: "shell", info, source: "!pwd", shell: "pwd" },
          { kind: "compact", info, source: "/compact" },
          prompt,
          prompt,
        ]
        yield* s.store({ items: input, stopped: true, hidden: [] })
        const original = yield* Effect.promise(() => Bun.file(s.file).text())
        expect(s.file.endsWith(`${createHash("sha256").update(s.ctx.project.id).digest("hex")}.json`)).toBe(true)
        const snapshots = yield* Effect.all(
          Array.from({ length: 8 }, () => s.queue.list(s.session.id)),
          { concurrency: "unbounded" },
        )
        const snapshot = snapshots[0]
        if (!snapshot) return yield* Effect.die("Missing snapshot")
        expect(snapshots.every((item) => JSON.stringify(item) === JSON.stringify(snapshot))).toBe(true)
        expect(snapshot.items.map((item) => item.payload.kind)).toEqual([
          "prompt",
          "command",
          "shell",
          "compact",
          "prompt",
          "prompt",
        ])
        expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(6)
        expect(
          snapshot.items.every(
            (item) => item.id.startsWith("queue-import-") && item.delivery === "queue" && item.state === "pending",
          ),
        ).toBe(true)
        expect(snapshot.items[0]?.payload).toEqual({
          kind: "prompt",
          ...info,
          parts: [
            { type: "text", text: "restored" },
            { type: "file", mime: "text/plain", url: "file:///tmp/input.txt" },
            { type: "agent", name: "build" },
            { type: "subtask", prompt: "sub", description: "task", agent: "build" },
          ],
        })
        expect(snapshot.paused).toBe(true)
        expect(snapshot.blocked).toBe(true)
        expect(yield* s.queue.claimNext(s.session.id)).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(s.file).text())).toBe(original)
        const first = snapshot.items[0]
        if (!first) return yield* Effect.die("Missing imported entry")
        expect(yield* s.queue.enqueue(s.session.id, { id: first.id, payload: first.payload })).toEqual(snapshot)
      }),
    { git: true },
  )

  it.instance(
    "never reapplies pause/block or resurrects deleted or delivered imports",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        yield* s.store({ items: [prompt, prompt], stopped: true, hidden: [] })
        const first = yield* s.queue.list(s.session.id)
        yield* s.queue.update(s.session.id, { revision: first.revision, mutation: { action: "pause", paused: false } })
        yield* s.queue.unblock(s.session.id)
        const claim = yield* s.queue.claimNext(s.session.id)
        if (!claim) return yield* Effect.die("No claim")
        yield* s.queue.delivered(s.session.id, claim.id)
        const current = yield* s.queue.list(s.session.id)
        const remaining = current.items[0]
        if (!remaining) return yield* Effect.die("Missing remaining entry")
        yield* s.queue.update(s.session.id, {
          revision: current.revision,
          mutation: { action: "delete", id: remaining.id },
        })
        // A rebuilt layer/process reads the same durable marker, not an in-memory flag.
        yield* SessionQueueMigration.ensure(s.session.id)
        expect((yield* s.queue.list(s.session.id)).items).toEqual([])
        expect((yield* s.queue.list(s.session.id)).paused).toBe(false)
        expect((yield* s.queue.list(s.session.id)).blocked).toBe(false)
        const rows = yield* s.db
          .select()
          .from(SessionQueueTable)
          .where(eq(SessionQueueTable.session_id, s.session.id))
          .all()
        expect(rows.map((row) => row.state).sort()).toEqual(["deleted", "delivered"])
      }),
    { git: true },
  )

  it.instance(
    "running restores remain blocked until explicit action, including enqueue-before-list",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        yield* s.store({ items: [prompt], stopped: false, hidden: [] })
        const snapshot = yield* s.queue.enqueue(s.session.id, {
          id: "new",
          payload: { kind: "shell", ...info, command: "pwd" },
        })
        expect(snapshot.items.map((item) => item.payload.kind)).toEqual(["prompt", "shell"])
        expect(snapshot.paused).toBe(false)
        expect(snapshot.blocked).toBe(true)
        expect(yield* s.queue.claimNext(s.session.id)).toBeUndefined()
        expect((yield* s.queue.claimNext(s.session.id, true))?.id).toBe(snapshot.items[0]?.id)
      }),
    { git: true },
  )

  it.instance(
    "hides verified IDs before UI pagination and model history without rewriting history",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        const visible = yield* message(s.session.id, "visible")
        const hidden = yield* Effect.forEach(Array.from({ length: 55 }), () => message(s.session.id, "", true))
        const normal = yield* message(s.session.id, "do not hide me")
        const foreign = yield* s.sessions.create({})
        const foreignID = yield* message(foreign.id, "", true)
        yield* s.store({ items: [], stopped: false, hidden: [...hidden, normal, foreignID, "msg_missing", 123] })
        // Transcript reads, not queue list, must trigger migration first.
        expect((yield* s.sessions.messages({ sessionID: s.session.id, limit: 1 })).map((item) => item.info.id)).toEqual(
          [normal],
        )
        expect(
          (yield* MessageV2.page({ sessionID: s.session.id, limit: 2 })).items.map((item) => item.info.id),
        ).toEqual([visible, normal])
        expect((yield* MessageV2.filterCompactedEffect(s.session.id)).map((item) => item.info.id)).toEqual([
          visible,
          normal,
        ])
        yield* Effect.promise(() => fs.rm(s.file))
        expect((yield* MessageV2.filterCompactedEffect(s.session.id)).map((item) => item.info.id)).toEqual([
          visible,
          normal,
        ])
        expect(
          yield* s.db.select().from(MessageTable).where(eq(MessageTable.session_id, s.session.id)).all(),
        ).toHaveLength(57)
        expect((yield* s.sessions.messages({ sessionID: foreign.id })).map((item) => item.info.id)).toEqual([foreignID])
      }),
    { git: true },
  )

  it.instance(
    "skips malformed items individually and rejects invalid files without consuming migration",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        for (const value of [
          null,
          { version: 2 },
          { version: 1, projectID: "wrong", sessions: {} },
          { version: 1, projectID: s.ctx.project.id, sessions: { [s.session.id]: { items: [], stopped: "yes" } } },
        ]) {
          yield* s.write(value)
          expect((yield* s.queue.list(s.session.id)).items).toEqual([])
          expect(
            yield* s.db
              .select()
              .from(SessionQueueImportTable)
              .where(eq(SessionQueueImportTable.session_id, s.session.id))
              .get(),
          ).toBeUndefined()
        }
        yield* Effect.promise(() => Bun.write(s.file, "{invalid json"))
        expect((yield* s.queue.list(s.session.id)).items).toEqual([])
        yield* s.store({
          items: [
            null,
            { ...prompt, info: {} },
            prompt,
            { kind: "unknown", info },
            { ...prompt, parts: [{ type: "tool" }] },
            { kind: "shell", info, source: "!bad", shell: 123 },
          ],
          stopped: false,
          hidden: "invalid",
        })
        expect((yield* s.queue.list(s.session.id)).items).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "exact project/directory/workspace placement is required and missing sessions are not recreated",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        yield* s.store({ items: [prompt], stopped: true, hidden: [] })
        for (const ctx of [
          { ...s.ctx, directory: `${s.ctx.directory}/other` },
          { ...s.ctx, project: { ...s.ctx.project, id: "wrong" } },
        ]) {
          yield* SessionQueueMigration.ensure(s.session.id).pipe(Effect.provideService(InstanceRef, ctx))
        }
        yield* SessionQueueMigration.ensure(s.session.id).pipe(
          Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make("wrk_foreign")),
        )
        expect(
          yield* s.db
            .select()
            .from(SessionQueueImportTable)
            .where(eq(SessionQueueImportTable.session_id, s.session.id))
            .get(),
        ).toBeUndefined()
        yield* SessionQueueMigration.ensure(SessionID.make("ses_missing"))
        expect(Result.isFailure(yield* s.queue.list(SessionID.make("ses_missing")).pipe(Effect.result))).toBe(true)
        expect((yield* s.queue.list(s.session.id)).items).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "marker, hidden state, pause and items roll back together",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        yield* s.store({ items: [prompt], stopped: true, hidden: [] })
        yield* s.db
          .transaction(() =>
            Effect.gen(function* () {
              yield* SessionQueueMigration.ensure(s.session.id)
              return yield* Effect.fail("rollback")
            }),
          )
          .pipe(Effect.result)
        expect(
          yield* s.db
            .select()
            .from(SessionQueueImportTable)
            .where(eq(SessionQueueImportTable.session_id, s.session.id))
            .get(),
        ).toBeUndefined()
        expect(
          yield* s.db
            .select()
            .from(SessionQueueStateTable)
            .where(eq(SessionQueueStateTable.session_id, s.session.id))
            .get(),
        ).toBeUndefined()
        expect(
          yield* s.db.select().from(SessionQueueTable).where(eq(SessionQueueTable.session_id, s.session.id)).all(),
        ).toEqual([])
        expect((yield* s.queue.list(s.session.id)).items).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "archived sessions retain placeholder filtering without importing executable backlog",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        const hidden = yield* message(s.session.id, "", true)
        yield* s.store({ items: [prompt], stopped: false, hidden: [hidden] })
        yield* s.db
          .update(SessionTable)
          .set({ time_archived: Date.now() })
          .where(eq(SessionTable.id, s.session.id))
          .run()
        expect((yield* MessageV2.page({ sessionID: s.session.id, limit: 10 })).items).toEqual([])
        expect(
          yield* s.db.select().from(SessionQueueTable).where(eq(SessionQueueTable.session_id, s.session.id)).all(),
        ).toEqual([])
        expect(
          yield* s.db
            .select()
            .from(SessionQueueImportTable)
            .where(eq(SessionQueueImportTable.session_id, s.session.id))
            .get(),
        ).toEqual({ session_id: s.session.id, hidden: [hidden] })
      }),
    { git: true },
  )

  it.instance(
    "an import ID collision rolls back the marker, first imported item and state",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        yield* s.store({ items: [prompt, prompt], stopped: true, hidden: [] })
        const initial = yield* s.queue.list(s.session.id)
        const collision = initial.items[1]
        if (!collision) return yield* Effect.die("Missing imported entry")
        yield* s.db.delete(SessionQueueImportTable).where(eq(SessionQueueImportTable.session_id, s.session.id)).run()
        yield* s.db.delete(SessionQueueTable).where(eq(SessionQueueTable.session_id, s.session.id)).run()
        yield* s.db.delete(SessionQueueStateTable).where(eq(SessionQueueStateTable.session_id, s.session.id)).run()
        const other = yield* s.sessions.create({})
        yield* s.queue.enqueue(other.id, {
          id: collision.id,
          payload: { kind: "shell", ...info, command: "unrelated" },
        })
        const original = yield* Effect.promise(() => Bun.file(s.file).text())
        const outcome = yield* SessionQueueMigration.ensure(s.session.id).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        expect(
          yield* s.db
            .select()
            .from(SessionQueueImportTable)
            .where(eq(SessionQueueImportTable.session_id, s.session.id))
            .get(),
        ).toBeUndefined()
        expect(
          yield* s.db
            .select()
            .from(SessionQueueStateTable)
            .where(eq(SessionQueueStateTable.session_id, s.session.id))
            .get(),
        ).toBeUndefined()
        expect(
          yield* s.db.select().from(SessionQueueTable).where(eq(SessionQueueTable.session_id, s.session.id)).all(),
        ).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(s.file).text())).toBe(original)
      }),
    { git: true },
  )
})
