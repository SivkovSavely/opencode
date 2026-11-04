import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { eq, sql } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { GlobalBus } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Snapshot } from "@/snapshot"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionSummary.node,
      EventV2.node,
      EventV2Bridge.node,
      SessionProjector.node,
      Database.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

function user(sessionID: SessionID, diffs: Snapshot.FileDiff[]) {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "user" as const,
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test"), variant: "original" },
    system: "original system prompt",
    tools: { bash: false },
    summary: { title: "original title", body: "original body", diffs },
  } satisfies SessionV1.User
}

for (const unknown of [false, true]) {
  it.instance(`projects historical summary JSON without rewriting records (unknown counts: ${unknown})`, () =>
    Effect.gen(function* () {
      expect(process.env.OPENCODE_DB).toBe(":memory:")
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const { db } = yield* Database.Service
      const parent = yield* sessions.create({})
      const session = yield* sessions.create({ parentID: parent.id })
      const diffs: Snapshot.FileDiff[] = [
        { file: "large.txt", patch: "x".repeat(SnapshotDiff.MAX_PATCH_BYTES + 1), additions: 7, deletions: 5 },
        { file: "small.txt", patch: "-old\n+new\n", additions: 2, deletions: 1 },
        { additions: 11, deletions: 3, omitted: { reason: "older-budget", ...(unknown ? {} : { files: 13 }) } },
      ]
      const message = user(session.id, diffs)
      const raw = JSON.stringify({ ...message, id: undefined, sessionID: undefined })
      // Bypass current write guards to represent a pre-existing oversized row.
      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (${message.id}, ${session.id}, ${message.time.created}, ${message.time.created}, ${raw})`)
      const prompt = {
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: message.id,
        type: "text" as const,
        text: "The original user prompt must remain intact.",
      }
      yield* sessions.updatePart(prompt)
      const newer = user(session.id, [{ file: "normal.txt", patch: "+normal", additions: 1, deletions: 0 }])
      newer.time.created++
      yield* sessions.updateMessage(newer)

      const aggregate = {
        additions: 20,
        deletions: 9,
        omitted: { reason: "aggregate-budget", ...(unknown ? {} : { files: 15 }) },
      }
      const expected = { ...message, summary: { ...message.summary, diffs: [aggregate] } }
      const selected = yield* db.get<{ bytes: number }>(sql`SELECT length(CAST(
        ${MessageV2.summaryProjection(MessageTable.data, "$.summary.diffs")} AS BLOB)) AS bytes
        FROM message WHERE id = ${message.id}`)
      expect(selected?.bytes).toBeLessThan(1024)
      expect(yield* MessageV2.get({ sessionID: session.id, messageID: message.id })).toEqual({
        info: expected,
        parts: [prompt],
      })
      const first = yield* MessageV2.page({ sessionID: session.id, limit: 1 })
      expect(first.items.map((item) => item.info)).toEqual([newer])
      expect(first.more).toBe(true)
      const second = yield* MessageV2.page({ sessionID: session.id, limit: 1, before: first.cursor })
      expect(second.items).toEqual([{ info: expected, parts: [prompt] }])
      expect(second.more).toBe(false)
      expect((yield* sessions.messages({ sessionID: session.id })).map((item) => item.info)).toEqual([expected, newer])
      expect(yield* summary.diff({ sessionID: session.id, messageID: message.id })).toEqual([aggregate])

      const rawDiffs = JSON.stringify(diffs)
      yield* db.run(sql`UPDATE session SET summary_additions = 20, summary_deletions = 9,
        summary_files = 15, summary_diffs = ${rawDiffs} WHERE id = ${session.id}`)
      const expectedSummary = { additions: 20, deletions: 9, files: 15, diffs: [aggregate] }
      expect((yield* sessions.get(session.id)).summary).toEqual(expectedSummary)
      expect((yield* sessions.list()).find((item) => item.id === session.id)?.summary).toEqual(expectedSummary)
      expect((yield* sessions.listGlobal()).find((item) => item.id === session.id)?.summary).toEqual(expectedSummary)
      expect((yield* sessions.children(parent.id))[0]?.summary).toEqual(expectedSummary)
      expect(yield* db.get(sql`SELECT data = ${raw} AS unchanged FROM message WHERE id = ${message.id}`)).toEqual({
        unchanged: 1,
      })
      expect(
        yield* db.get(sql`SELECT summary_diffs = ${rawDiffs} AS unchanged FROM session WHERE id = ${session.id}`),
      ).toEqual({ unchanged: 1 })
      expect(yield* db.get(sql`SELECT count(*) AS count FROM message WHERE session_id = ${session.id}`)).toEqual({
        count: 2,
      })
    }),
  )
}

it.instance("bounds summary writes before durable event recording without mutating the caller", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const session = yield* sessions.create({})
    const patch = "\n".repeat(SnapshotDiff.MAX_PATCH_BYTES / 2 + 1)
    const diffs: Snapshot.FileDiff[] = [
      { file: "large.txt", patch, additions: 7, deletions: 5 },
      ...Array.from({ length: SnapshotDiff.MAX_FILES + 7 }, (_, index) => ({
        file: `${index}.txt`,
        patch: "+x",
        additions: 1,
        deletions: 2,
      })),
      { additions: 11, deletions: 3, omitted: { reason: "older-budget", files: 5 } },
    ]
    const message = user(session.id, diffs)
    const observed: EventV2.Payload[] = []
    const unsubscribe = yield* events.listen((event) => {
      observed.push(event)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const written = yield* sessions.updateMessage(message)
    expect(written.summary.diffs).toHaveLength(SnapshotDiff.MAX_FILES + 1)
    expect(written.summary.diffs[0]).toEqual({
      file: "large.txt",
      patch: "",
      additions: 7,
      deletions: 5,
      omitted: { reason: "patch-budget", files: 1 },
    })
    expect(written.summary.diffs.at(-1)).toEqual({
      additions: 19,
      deletions: 19,
      omitted: { reason: "aggregate-budget", files: 13 },
    })
    expect(
      written.summary.diffs.reduce((size, diff) => size + SnapshotDiff.bytes(diff.patch ?? ""), 0),
    ).toBeLessThanOrEqual(SnapshotDiff.MAX_PATCH_BYTES)
    expect(message.summary.diffs).toBe(diffs)
    expect(diffs[0]?.patch).toBe(patch)
    expect((observed[0]?.data as typeof SessionV1.Event.MessageUpdated.data.Type).info).toEqual(written)
    expect((yield* MessageV2.get({ sessionID: session.id, messageID: message.id })).info).toEqual(written)

    const summary = { additions: 225, deletions: 422, files: 213, diffs }
    yield* sessions.setSummary({ sessionID: session.id, summary })
    yield* sessions.setRevert({ sessionID: session.id, revert: { messageID: message.id }, summary })
    expect((yield* sessions.get(session.id)).summary?.diffs).toEqual(written.summary.diffs)
    const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all()
    const updates = rows.filter((row) => row.type === EventV2.versionedType(SessionV1.Event.Updated.type, 1))
    expect(updates).toHaveLength(2)
    for (const event of updates) {
      expect((event.data as typeof SessionV1.Event.Updated.data.Type).info.summary?.diffs).toEqual(
        written.summary.diffs,
      )
    }
    const stored = rows.find((row) => row.type === EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1))
    expect((stored?.data as typeof SessionV1.Event.MessageUpdated.data.Type).info).toEqual(written)
    expect(Session.toRow({ ...session, summary }).summary_diffs).toEqual(written.summary.diffs)
    expect(summary.diffs).toBe(diffs)
  }),
)

it.instance("preserves normal summaries including a patch exactly at the JSON-string byte budget", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    const message = user(session.id, [
      {
        file: "budget.txt",
        patch: "x".repeat(SnapshotDiff.MAX_PATCH_BYTES - 2),
        additions: 1,
        deletions: 0,
      },
    ])
    yield* sessions.updateMessage(message)
    expect((yield* MessageV2.get({ sessionID: session.id, messageID: message.id })).info).toEqual(message)
    expect((yield* MessageV2.page({ sessionID: session.id, limit: 1 })).items[0]?.info).toEqual(message)
    const summary = { additions: 1, deletions: 0, files: 1, diffs: message.summary.diffs }
    yield* sessions.setSummary({ sessionID: session.id, summary })
    expect((yield* sessions.get(session.id)).summary).toEqual(summary)

    const prompt = { ...user(session.id, []), system: "p".repeat(SnapshotDiff.MAX_INPUT_BYTES + 1) }
    yield* sessions.updateMessage(prompt)
    expect((yield* MessageV2.get({ sessionID: session.id, messageID: prompt.id })).info).toEqual(prompt)
  }),
)

it.instance("bounds historical event views without changing durable replay data", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2.Service
    const bridge = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const session = yield* sessions.create({})
    const message = user(session.id, [
      {
        file: "legacy.txt",
        patch: "x".repeat(SnapshotDiff.MAX_PATCH_BYTES + 1),
        additions: 5,
        deletions: 2,
      },
    ])
    const observed: EventV2.Payload[] = []
    const sync: EventV2.SerializedEvent[] = []
    const unsubscribe = yield* bridge.listen((event) => {
      observed.push(event)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
      if (event.payload.type === "sync" && event.payload.syncEvent?.aggregateID === session.id)
        sync.push(event.payload.syncEvent)
    }
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
    // Core publication simulates events recorded before the Session write guard existed.
    const original = yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: session.id, info: message })
    const expected = {
      ...message,
      summary: {
        ...message.summary,
        diffs: [
          {
            file: "legacy.txt",
            patch: "",
            additions: 5,
            deletions: 2,
            omitted: { reason: "patch-budget", files: 1 },
          },
        ],
      },
    }
    expect((observed[0]?.data as typeof SessionV1.Event.MessageUpdated.data.Type).info).toEqual(expected)
    expect((sync[0]?.data as typeof SessionV1.Event.MessageUpdated.data.Type).info).toEqual(message)
    expect(sync[0]?.data).toBe(original.data)
    if (!sync[0]) throw new Error("Missing canonical sync event")
    yield* events.replay(sync[0])
    const historical = yield* bridge.durable({ aggregateID: session.id }).pipe(
      Stream.filter((event) => event.type === SessionV1.Event.MessageUpdated.type),
      Stream.take(1),
      Stream.runCollect,
    )
    expect((historical[0]?.data as typeof SessionV1.Event.MessageUpdated.data.Type).info).toEqual(expected)
    const stored = yield* db.select().from(EventTable).where(eq(EventTable.id, original.id)).get()
    expect(stored?.data).toEqual({ sessionID: session.id, info: message })
    expect(original.data.info).toEqual(message)
    expect(yield* db.get(sql`SELECT typeof(data) AS storage FROM event WHERE id = ${original.id}`)).toEqual({
      storage: "blob",
    })
  }),
)
