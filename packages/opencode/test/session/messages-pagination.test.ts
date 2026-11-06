import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { eq, sql } from "drizzle-orm"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

import { NotFoundError } from "@/storage/storage"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionQueueImportTable } from "@opencode-ai/core/session/queue-import.sql"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node])))

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

// Helper functions using Effect.gen
const fill = Effect.fn("Test.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
) {
  const session = yield* SessionNs.Service
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    yield* session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as SessionV1.Info)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
})

const addUser = Effect.fn("Test.addUser")(function* (sessionID: SessionID, text?: string) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as SessionV1.Info)
  if (text) {
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    })
  }
  return id
})

const addAssistant = Effect.fn("Test.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  opts?: { summary?: boolean; finish?: string; error?: SessionV1.Assistant["error"] },
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: opts?.summary,
    finish: opts?.finish,
    error: opts?.error,
  } as unknown as SessionV1.Info)
  return id
})

const addCompactionPart = Effect.fn("Test.addCompactionPart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  tailStartID?: MessageID,
) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "compaction",
    auto: true,
    tail_start_id: tailStartID,
  } as any)
})

describe("persisted output format hydration", () => {
  for (const format of [
    undefined,
    new SessionV1.OutputFormatText({ type: "text" }),
    ...[undefined, 0, 2].map(
      (retryCount) =>
        new SessionV1.OutputFormatJsonSchema({
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
          ...(retryCount === undefined ? {} : { retryCount }),
        }),
    ),
  ]) {
    it.instance(
      `encodes stored ${format?.type ?? "implicit text"} format (${format?.type === "json_schema" ? (format.retryCount ?? "default retries") : "no retries"})`,
      () =>
        withSession(({ session, sessionID }) =>
          Effect.gen(function* () {
            const database = yield* Database.Service
            const user = {
              id: MessageID.ascending(),
              sessionID,
              role: "user" as const,
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
              format,
              summary: { title: "title", body: "body", diffs: [{ file: "a.txt", additions: 1, deletions: 0 }] },
            }
            yield* session.updateMessage(user)
            const text = {
              id: PartID.ascending(),
              sessionID,
              messageID: user.id,
              type: "text" as const,
              text: "answer",
            }
            yield* session.updatePart(text)
            const assistantID = yield* addAssistant(sessionID, user.id, { finish: "stop" })
            const stored = yield* database.db.select().from(MessageTable).where(eq(MessageTable.id, user.id)).get()
            expect(stored?.data).toMatchObject({ role: "user", ...(format ? { format: { ...format } } : {}) })
            if (stored && "format" in stored.data) {
              expect(stored.data.format).not.toBeInstanceOf(SessionV1.OutputFormatText)
              expect(stored.data.format).not.toBeInstanceOf(SessionV1.OutputFormatJsonSchema)
            }

            const expected = {
              info: {
                ...user,
                format: format
                  ? { ...format, ...(format.type === "json_schema" ? { retryCount: format.retryCount ?? 2 } : {}) }
                  : undefined,
              },
              parts: [text],
            }
            const direct = yield* MessageV2.get({ sessionID, messageID: user.id })
            expect(Schema.encodeSync(SessionV1.WithParts)(direct)).toEqual(expected)
            if (direct.info.role !== "user") throw new Error("Expected user")
            if (format) expect(direct.info.format).toBeInstanceOf(format.constructor)
            expect(yield* MessageV2.getInfo({ sessionID, messageID: user.id })).toEqual(direct.info)

            const assistant = yield* MessageV2.get({ sessionID, messageID: assistantID })
            expect(Schema.encodeSync(SessionV1.WithParts)(assistant)).toEqual(assistant)
            expect(assistant.info).toMatchObject({ id: assistantID, parentID: user.id, role: "assistant" })
            const first = yield* MessageV2.page({ sessionID, limit: 1 })
            expect(Schema.encodeSync(Schema.Array(SessionV1.WithParts))(first.items)).toEqual([assistant])
            expect(first.more).toBe(true)
            expect(first.cursor).toBeDefined()
            const last = yield* MessageV2.page({ sessionID, limit: 1, before: first.cursor })
            expect(Schema.encodeSync(Schema.Array(SessionV1.WithParts))(last.items)).toEqual([expected])
            expect(last.more).toBe(false)
            expect(last.cursor).toBeUndefined()
            expect(
              Schema.encodeSync(Schema.Array(SessionV1.WithParts))(yield* session.messages({ sessionID })),
            ).toEqual([expected, assistant])
            expect(Schema.encodeSync(Schema.Array(SessionV1.WithParts))(yield* MessageV2.stream(sessionID))).toEqual([
              assistant,
              expected,
            ])
            expect(yield* database.db.select().from(MessageTable).where(eq(MessageTable.id, user.id)).get()).toEqual(
              stored,
            )
          }),
        ),
    )
  }

  for (const format of [null, false, { type: "unknown" }, { type: "json_schema", schema: {}, retryCount: -1 }]) {
    it.instance(`rejects malformed stored format ${JSON.stringify(format)}`, () =>
      withSession(({ sessionID }) =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const messageID = yield* addUser(sessionID)
          // Represent corrupt historical data without passing through current write validation.
          yield* database.db
            .run(sql`UPDATE message SET data = json_set(data, '$.format', json(${JSON.stringify(format)}))
            WHERE id = ${messageID}`)
          for (const read of [
            MessageV2.get({ sessionID, messageID }).pipe(Effect.asVoid),
            MessageV2.page({ sessionID, limit: 1 }).pipe(Effect.asVoid),
          ]) {
            const result = yield* Effect.exit(read)
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("SchemaError:")
          }
        }),
      ),
    )
  }
})

// Seed projected rows directly so large fixtures don't benchmark event publication.
const seedHistory = Effect.fn("Test.seedHistory")(function* (
  sessionID: SessionID,
  count: number,
  boundaries: {
    at: number
    tail?: number
    summary?: "unfinished" | "failed" | "unmatched" | "absent"
    part?: false
  }[] = [],
  toolBytes = 0,
) {
  const database = yield* Database.Service
  // Deliberately reverse IDs relative to timestamps, as imported messages can do.
  const id = (index: number) => MessageID.make(`msg_history_${String(count - index).padStart(6, "0")}`)
  const messages = Array.from({ length: count }, (_, index): SessionV1.WithParts => {
    const boundary = boundaries.find((item) => item.at === index)
    const summary = boundaries.find((item) => item.at + 1 === index)
    const user = boundary || (!summary && index % 2 === 0)
    const info: SessionV1.Info = user
      ? {
          id: id(index),
          sessionID,
          role: "user",
          time: { created: index + 1 },
          agent: "test",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        }
      : {
          id: id(index),
          sessionID,
          role: "assistant",
          time: { created: index + 1 },
          parentID: id(summary?.summary === "unmatched" ? -1 : index - 1),
          modelID: ModelV2.ID.make("test"),
          providerID: ProviderV2.ID.make("test"),
          mode: "",
          agent: "test",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          summary: !!summary && summary.summary !== "absent",
          finish: summary?.summary === "unfinished" ? undefined : "end_turn",
          error:
            summary?.summary === "failed"
              ? new SessionV1.APIError({ message: "synthetic failure", isRetryable: false }).toObject()
              : undefined,
        }
    const common = { id: PartID.make(`prt_history_${index}`), messageID: id(index), sessionID }
    const part: SessionV1.Part =
      boundary && boundary.part !== false
        ? {
            ...common,
            type: "compaction",
            auto: true,
            tail_start_id: boundary.tail === undefined ? undefined : id(boundary.tail),
          }
        : !user && !summary && toolBytes
          ? {
              ...common,
              type: "tool",
              callID: `call_${index}`,
              tool: "synthetic",
              state: {
                status: "completed",
                input: {},
                output: "x".repeat(toolBytes),
                title: "fixture",
                metadata: {},
                time: { start: index + 1, end: index + 1 },
              },
            }
          : { ...common, type: "text", text: `message ${index}` }
    return { info, parts: [part] }
  })
  for (let offset = 0; offset < messages.length; offset += 100) {
    const batch = messages.slice(offset, offset + 100)
    yield* database.db.insert(MessageTable).values(
      batch.map((message) => ({
        id: message.info.id,
        session_id: sessionID,
        time_created: message.info.time.created,
        time_updated: message.info.time.created,
        data: message.info,
      })),
    )
    yield* database.db.insert(PartTable).values(
      batch.flatMap((message) =>
        message.parts.map((part) => ({
          id: part.id,
          message_id: message.info.id,
          session_id: sessionID,
          time_created: message.info.time.created,
          time_updated: message.info.time.created,
          data: part,
        })),
      ),
    )
  }
  return messages
})

// Observe the real connection in this fiber's transaction, without mocking SQL or
// mutating the shared client. BEGIN/COMMIT execute outside the decorated connection.
const measureHistory = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const memory = process.memoryUsage()
    const stats = {
      statements: 2,
      pages: 0,
      messageRows: 0,
      messages: 0,
      parts: 0,
      bytes: 0,
      sqlMs: 0,
      loadMs: 0,
      transactionMs: 0,
      heapPeak: memory.heapUsed,
      rssPeak: memory.rss,
    }
    const started = performance.now()
    const result = yield* database.db.transaction(
      () =>
        Effect.gen(function* () {
          const current = Option.getOrThrow(yield* Effect.serviceOption(database.db.$client.transactionService))
          const connection = current[0]
          const observe = <T, E2, R2>(query: string, effect: Effect.Effect<T, E2, R2>) =>
            Effect.gen(function* () {
              const start = performance.now()
              const rows = yield* effect
              stats.sqlMs += performance.now() - start
              stats.statements++
              if (!Array.isArray(rows)) return rows
              const messages = query.includes(' from "message" ') && query.includes("order by")
              const parts = query.includes(' from "part" ')
              if (messages) {
                stats.pages++
                stats.messageRows += rows.length
                stats.messages += Math.min(rows.length, 50)
              }
              if (parts) stats.parts += rows.length
              if (messages || parts) {
                for (const row of rows) {
                  if (!Array.isArray(row)) continue
                  for (const value of row) if (typeof value === "string") stats.bytes += Buffer.byteLength(value)
                }
                const memory = process.memoryUsage()
                stats.heapPeak = Math.max(stats.heapPeak, memory.heapUsed)
                stats.rssPeak = Math.max(stats.rssPeak, memory.rss)
              }
              return rows
            })
          const observed = {
            ...connection,
            execute: (...args: Parameters<typeof connection.execute>) => observe(args[0], connection.execute(...args)),
            executeValues: (...args: Parameters<typeof connection.executeValues>) =>
              observe(args[0], connection.executeValues(...args)),
            executeRaw: (...args: Parameters<typeof connection.executeRaw>) =>
              observe(args[0], connection.executeRaw(...args)),
            executeUnprepared: (...args: Parameters<typeof connection.executeUnprepared>) =>
              observe(args[0], connection.executeUnprepared(...args)),
          }
          const start = performance.now()
          const result = yield* read.pipe(
            Effect.provideService(database.db.$client.transactionService, [observed, current[1]]),
          )
          stats.loadMs = performance.now() - start
          return result
        }),
      { behavior: "immediate" },
    )
    stats.transactionMs = performance.now() - started
    return { result, ...stats, heapGrowth: stats.heapPeak - memory.heapUsed, rssGrowth: stats.rssPeak - memory.rss }
  })

describe("MessageV2.page", () => {
  it.instance("returns page result", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 2)

        const result = yield* MessageV2.page({ sessionID, limit: 10 })
        expect(result).toBeDefined()
        expect(result.items).toBeArray()
      }),
    ),
  )

  it.instance("pages backward with opaque cursors", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 6)

        const a = yield* MessageV2.page({ sessionID, limit: 2 })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.items.every((item) => item.parts.length === 1)).toBe(true)
        expect(a.more).toBe(true)
        expect(a.cursor).toBeTruthy()

        const b = yield* MessageV2.page({ sessionID, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
        expect(b.more).toBe(true)
        expect(b.cursor).toBeTruthy()

        const c = yield* MessageV2.page({ sessionID, limit: 2, before: b.cursor! })
        expect(c.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(c.more).toBe(false)
        expect(c.cursor).toBeUndefined()
      }),
    ),
  )

  it.instance("returns items in chronological order within a page", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4)

        const result = yield* MessageV2.page({ sessionID, limit: 4 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("returns empty items for session with no messages", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const result = yield* MessageV2.page({ sessionID, limit: 10 })
        expect(result.items).toEqual([])
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent session", () =>
    Effect.gen(function* () {
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(MessageV2.page({ sessionID: fake, limit: 10 }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )

  it.instance("handles exact limit boundary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 3)

        const result = yield* MessageV2.page({ sessionID, limit: 3 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()
      }),
    ),
  )

  it.instance("limit of 1 returns single newest message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 5)

        const result = yield* MessageV2.page({ sessionID, limit: 1 })
        expect(result.items).toHaveLength(1)
        expect(result.items[0].info.id).toBe(ids[ids.length - 1])
        expect(result.more).toBe(true)
      }),
    ),
  )

  it.instance("hydrates multiple parts per message", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = yield* MessageV2.page({ sessionID, limit: 10 })
        expect(result.items).toHaveLength(1)
        expect(result.items[0].parts).toHaveLength(2)
      }),
    ),
  )

  it.instance("accepts cursors from fractional timestamps", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4, (i: number) => 1000.5 + i)

        const a = yield* MessageV2.page({ sessionID, limit: 2 })
        const b = yield* MessageV2.page({ sessionID, limit: 2, before: a.cursor! })

        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
      }),
    ),
  )

  it.instance("messages with same timestamp are ordered by id", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4, () => 1000)

        const a = yield* MessageV2.page({ sessionID, limit: 2 })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.more).toBe(true)

        const b = yield* MessageV2.page({ sessionID, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(b.more).toBe(false)
      }),
    ),
  )

  it.instance("does not return messages from other sessions", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const a = yield* session.create({})
      const b = yield* session.create({})
      yield* fill(a.id, 3)
      yield* fill(b.id, 2)

      const resultA = yield* MessageV2.page({ sessionID: a.id, limit: 10 })
      const resultB = yield* MessageV2.page({ sessionID: b.id, limit: 10 })
      expect(resultA.items).toHaveLength(3)
      expect(resultB.items).toHaveLength(2)
      expect(resultA.items.every((item) => item.info.sessionID === a.id)).toBe(true)
      expect(resultB.items.every((item) => item.info.sessionID === b.id)).toBe(true)

      yield* session.remove(a.id)
      yield* session.remove(b.id)
    }),
  )

  it.instance("large limit returns all messages without cursor", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 10)

        const result = yield* MessageV2.page({ sessionID, limit: 100 })
        expect(result.items).toHaveLength(10)
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()
      }),
    ),
  )
})

describe("MessageV2.stream", () => {
  it.instance("yields items newest first", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 5)

        const items = yield* MessageV2.stream(sessionID)
        expect(items.map((item) => item.info.id)).toEqual(ids.slice().reverse())
      }),
    ),
  )

  it.instance("yields nothing for empty session", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const items = yield* MessageV2.stream(sessionID)
        expect(items).toHaveLength(0)
      }),
    ),
  )

  it.instance("yields single message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 1)

        const items = yield* MessageV2.stream(sessionID)
        expect(items).toHaveLength(1)
        expect(items[0].info.id).toBe(ids[0])
      }),
    ),
  )

  it.instance("hydrates parts for each yielded message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 3)

        const items = yield* MessageV2.stream(sessionID)
        for (const item of items) {
          expect(item.parts).toHaveLength(1)
          expect(item.parts[0].type).toBe("text")
        }
      }),
    ),
  )

  it.instance("handles sets exceeding internal page size", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 60)

        const items = yield* MessageV2.stream(sessionID)
        expect(items).toHaveLength(60)
        expect(items[0].info.id).toBe(ids[ids.length - 1])
        expect(items[59].info.id).toBe(ids[0])
      }),
    ),
  )

  it.instance("returns an Effect", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 1)

        const result = yield* MessageV2.stream(sessionID)
        expect(result).toHaveLength(1)
      }),
    ),
  )
})

describe("MessageV2.parts", () => {
  it.instance("returns parts for a message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const result = yield* MessageV2.parts(id)
        expect(result).toHaveLength(1)
        expect(result[0].type).toBe("text")
        expect((result[0] as SessionV1.TextPart).text).toBe("m0")
      }),
    ),
  )

  it.instance("returns empty array for message with no parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const id = yield* addUser(sessionID)

        const result = yield* MessageV2.parts(id)
        expect(result).toEqual([])
      }),
    ),
  )

  it.instance("returns multiple parts in order", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "second",
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "third",
        })

        const result = yield* MessageV2.parts(id)
        expect(result).toHaveLength(3)
        expect((result[0] as SessionV1.TextPart).text).toBe("m0")
        expect((result[1] as SessionV1.TextPart).text).toBe("second")
        expect((result[2] as SessionV1.TextPart).text).toBe("third")
      }),
    ),
  )

  it.instance("returns empty for non-existent message id", () =>
    Effect.gen(function* () {
      yield* SessionNs.Service
      const result = yield* MessageV2.parts(MessageID.ascending())
      expect(result).toEqual([])
    }),
  )

  it.instance("parts contain sessionID and messageID", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const result = yield* MessageV2.parts(id)
        expect(result[0].sessionID).toBe(sessionID)
        expect(result[0].messageID).toBe(id)
      }),
    ),
  )
})

describe("MessageV2.get", () => {
  it.instance("returns message with hydrated parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const result = yield* MessageV2.get({ sessionID, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.info.sessionID).toBe(sessionID)
        expect(result.info.role).toBe("user")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as SessionV1.TextPart).text).toBe("m0")
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const messageID = MessageID.ascending()
        const error = yield* Effect.flip(MessageV2.get({ sessionID, messageID }))
        expect(error).toBeInstanceOf(NotFoundError)
        expect(error.message).toBe(`Message not found: ${messageID}`)
      }),
    ),
  )

  it.instance("scopes by session id", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const a = yield* session.create({})
      const b = yield* session.create({})
      const [id] = yield* fill(a.id, 1)

      const error = yield* Effect.flip(MessageV2.get({ sessionID: b.id, messageID: id }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Message not found: ${id}`)
      const result = yield* MessageV2.get({ sessionID: a.id, messageID: id })
      expect(result.info.id).toBe(id)

      yield* session.remove(a.id)
      yield* session.remove(b.id)
    }),
  )

  it.instance("returns message with multiple parts", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = yield* MessageV2.get({ sessionID, messageID: id })
        expect(result.parts).toHaveLength(2)
      }),
    ),
  )

  it.instance("returns assistant message with correct role", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const uid = yield* addUser(sessionID, "hello")
        const aid = yield* addAssistant(sessionID, uid)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: aid,
          type: "text",
          text: "response",
        })

        const result = yield* MessageV2.get({ sessionID, messageID: aid })
        expect(result.info.role).toBe("assistant")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as SessionV1.TextPart).text).toBe("response")
      }),
    ),
  )

  it.instance("returns message with zero parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const id = yield* addUser(sessionID)

        const result = yield* MessageV2.get({ sessionID, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.parts).toEqual([])
      }),
    ),
  )
})

describe("Session.messages", () => {
  it.instance("returns all messages in chronological order across pages", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 55)
        const result = yield* session.messages({ sessionID })
        expect(result.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(session.messages({ sessionID: fake }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )
})

describe("Session.findMessage", () => {
  it.instance("searches newest-first", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 3)
        const result = yield* session.findMessage(sessionID, () => true)
        expect(Option.isSome(result) ? result.value.info.id : undefined).toBe(ids.at(-1))
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(session.findMessage(fake, () => true))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )
})

describe("MessageV2.filterCompacted", () => {
  it.instance("returns all messages when no compaction", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 5)

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        expect(result).toHaveLength(5)
        // reversed from newest-first to chronological
        expect(result.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("stops at compaction boundary and returns chronological order", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        // Chronological: u1(+compaction part), a1(summary, parentID=u1), u2, a2
        // Stream (newest first): a2, u2, a1(adds u1 to completed), u1(in completed + compaction) -> break
        const u1 = yield* addUser(sessionID, "first question")
        const a1 = yield* addAssistant(sessionID, u1, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a1,
          type: "text",
          text: "summary",
        })
        yield* addCompactionPart(sessionID, u1)

        const u2 = yield* addUser(sessionID, "new question")
        const a2 = yield* addAssistant(sessionID, u2)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a2,
          type: "text",
          text: "new response",
        })

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        // Includes compaction boundary: u1, a1, u2, a2
        expect(result[0].info.id).toBe(u1)
        expect(result.length).toBe(4)
      }),
    ),
  )

  it.live("handles empty iterable", () =>
    Effect.sync(() => {
      const result = MessageV2.filterCompacted([])
      expect(result).toEqual([])
    }),
  )

  it.instance("does not break on compaction part without matching summary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)
        yield* addUser(sessionID, "world")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        expect(result).toHaveLength(2)
      }),
    ),
  )

  it.instance("skips assistant with error even if marked as summary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)

        const error = new SessionV1.APIError({
          message: "boom",
          isRetryable: true,
        }).toObject() as SessionV1.Assistant["error"]
        yield* addAssistant(sessionID, u1, { summary: true, finish: "end_turn", error })
        yield* addUser(sessionID, "retry")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        // Error assistant doesn't add to completed, so compaction boundary never triggers
        expect(result).toHaveLength(3)
      }),
    ),
  )

  it.instance("skips assistant without finish even if marked as summary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)

        // summary=true but no finish
        yield* addAssistant(sessionID, u1, { summary: true })
        yield* addUser(sessionID, "next")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        expect(result).toHaveLength(3)
      }),
    ),
  )

  it.instance("retains original tail when compaction stores tail_start_id", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, u2)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))

        expect(result.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])
      }),
    ),
  )

  it.instance("fork remaps compaction tail_start_id for filterCompacted", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})

      const u1 = yield* addUser(created.id, "first")
      const a1 = yield* addAssistant(created.id, u1, { finish: "end_turn" })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID: a1,
        type: "text",
        text: "first reply",
      })

      const u2 = yield* addUser(created.id, "second")
      const a2 = yield* addAssistant(created.id, u2, { finish: "end_turn" })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID: a2,
        type: "text",
        text: "second reply",
      })

      const c1 = yield* addUser(created.id)
      yield* addCompactionPart(created.id, c1, u2)
      const s1 = yield* addAssistant(created.id, c1, { summary: true, finish: "end_turn" })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID: s1,
        type: "text",
        text: "summary",
      })

      const u3 = yield* addUser(created.id, "third")
      const a3 = yield* addAssistant(created.id, u3, { finish: "end_turn" })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID: a3,
        type: "text",
        text: "third reply",
      })

      const parentFiltered = MessageV2.filterCompacted(yield* MessageV2.stream(created.id))
      expect(parentFiltered.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])
      expect(yield* MessageV2.filterCompactedEffect(created.id)).toEqual(parentFiltered)

      const forked = yield* session.fork({ sessionID: created.id })
      const childFiltered = MessageV2.filterCompacted(yield* MessageV2.stream(forked.id))
      expect(childFiltered).toHaveLength(parentFiltered.length)
      expect(yield* MessageV2.filterCompactedEffect(forked.id)).toEqual(childFiltered)

      const tailPart = childFiltered.flatMap((m) => m.parts).find((p) => p.type === "compaction")
      expect(tailPart?.type).toBe("compaction")
      if (!tailPart || tailPart.type !== "compaction") throw new Error("Expected forked compaction part")
      expect(tailPart.tail_start_id).toBeDefined()
      expect(childFiltered.some((m) => m.info.id === tailPart.tail_start_id)).toBe(true)

      yield* session.remove(forked.id)
      yield* session.remove(created.id)
    }),
  )

  it.instance("retains an assistant tail when compaction starts inside a turn", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a2,
          type: "text",
          text: "second reply",
        })
        const a3 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a3,
          type: "text",
          text: "tail reply",
        })

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, a3)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = yield* addUser(sessionID, "third")
        const a4 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a4,
          type: "text",
          text: "third reply",
        })

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))

        expect(result.map((item) => item.info.id)).toEqual([c1, s1, a3, u3, a4])
      }),
    ),
  )

  it.instance("prefers latest compaction boundary when repeated compactions exist", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, u2)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: s1,
          type: "text",
          text: "summary one",
        })

        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const c2 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c2, u3)
        const s2 = yield* addAssistant(sessionID, c2, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: s2,
          type: "text",
          text: "summary two",
        })

        const u4 = yield* addUser(sessionID, "fourth")
        const a4 = yield* addAssistant(sessionID, u4, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a4,
          type: "text",
          text: "fourth reply",
        })

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))

        expect(result.map((item) => item.info.id)).toEqual([c2, s2, u3, a3, u4, a4])
      }),
    ),
  )

  test("works with array input", () => {
    // filterCompacted accepts any Iterable, not just generators
    const id = MessageID.ascending()
    const items: SessionV1.WithParts[] = [
      {
        info: {
          id,
          sessionID: "s1",
          role: "user",
          time: { created: 1 },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        } as unknown as SessionV1.Info,
        parts: [{ type: "text", text: "hello" }] as unknown as SessionV1.Part[],
      },
    ]
    const result = MessageV2.filterCompacted(items)
    expect(result).toHaveLength(1)
    expect(result[0].info.id).toBe(id)
  })
})

describe("MessageV2.filterCompactedEffect", () => {
  const cases: { name: string; boundaries: Parameters<typeof seedHistory>[2]; pages: number; toolBytes?: number }[] = [
    { name: "no compaction", boundaries: [], pages: 6 },
    { name: "recent completed compaction", boundaries: [{ at: 280 }], pages: 1 },
    { name: "boundary at the end of a page", boundaries: [{ at: 250 }], pages: 1 },
    { name: "summary and boundary on different pages", boundaries: [{ at: 249 }], pages: 2 },
    { name: "retained tail across pages", boundaries: [{ at: 280, tail: 144 }], pages: 4 },
    { name: "tail at the end of a page", boundaries: [{ at: 280, tail: 150 }], pages: 3 },
    { name: "tail pointing to the compaction itself", boundaries: [{ at: 280, tail: 280 }], pages: 1 },
    { name: "missing tail", boundaries: [{ at: 280, tail: -1 }], pages: 6 },
    { name: "tail newer than its compaction", boundaries: [{ at: 280, tail: 290 }], pages: 6 },
    { name: "multiple completed compactions", boundaries: [{ at: 180 }, { at: 280, tail: 244 }], pages: 2 },
    {
      name: "retained tail crossing an older compaction",
      boundaries: [
        { at: 180, tail: 140 },
        { at: 280, tail: 144 },
      ],
      pages: 4,
    },
    { name: "unfinished summary", boundaries: [{ at: 280, summary: "unfinished" }], pages: 6 },
    { name: "failed summary", boundaries: [{ at: 280, summary: "failed" }], pages: 6 },
    { name: "non-summary assistant", boundaries: [{ at: 280, summary: "absent" }], pages: 6 },
    { name: "unmatched summary parent", boundaries: [{ at: 280, summary: "unmatched" }], pages: 6 },
    { name: "missing compaction part", boundaries: [{ at: 280, part: false }], pages: 6 },
    { name: "failed newer compaction", boundaries: [{ at: 180 }, { at: 280, summary: "failed" }], pages: 3 },
    { name: "large tool results", boundaries: [{ at: 280 }], pages: 1, toolBytes: 32 * 1024 },
  ]
  for (const fixture of cases) {
    it.instance(`stops database paging without changing output: ${fixture.name}`, () =>
      withSession(({ sessionID }) =>
        Effect.gen(function* () {
          yield* seedHistory(sessionID, 300, fixture.boundaries, fixture.toolBytes)
          const full = yield* measureHistory(MessageV2.stream(sessionID))
          expect(full.pages).toBe(6)
          expect(full.messages).toBe(300)
          expect(full.parts).toBe(300)
          const expected = MessageV2.filterCompacted(full.result)
          for (let iteration = 0; iteration < 2; iteration++) {
            const actual = yield* measureHistory(MessageV2.filterCompactedEffect(sessionID))
            expect(actual.result).toEqual(expected)
            expect(actual.pages).toBe(fixture.pages)
            expect(actual.messages).toBe(fixture.pages * 50)
            expect(actual.parts).toBe(fixture.pages * 50)
            // Every page does the queue-migration checks, message query and part query.
            expect(actual.statements).toBe(fixture.pages * 4 + 2)
          }
        }),
      ),
    )
  }

  it.instance("stops at a remapped fork tail across pages", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        yield* seedHistory(sessionID, 300, [{ at: 280, tail: 144 }])
        yield* Effect.acquireUseRelease(
          session.fork({ sessionID }),
          (fork) =>
            Effect.gen(function* () {
              const full = yield* MessageV2.stream(fork.id)
              const actual = yield* measureHistory(MessageV2.filterCompactedEffect(fork.id))
              expect(actual.result).toEqual(MessageV2.filterCompacted(full))
              expect(actual.result).toHaveLength(156)
              expect(actual.pages).toBe(4)
              expect(actual.messages).toBe(200)
              const part = actual.result.flatMap((message) => message.parts).find((part) => part.type === "compaction")
              expect(part?.tail_start_id).toBeDefined()
              expect(actual.result.some((message) => message.info.id === part?.tail_start_id)).toBe(true)
            }),
          (fork) => session.remove(fork.id).pipe(Effect.ignore),
        )
      }),
    ),
  )

  it.instance("preserves empty and missing-session behavior", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        expect(yield* MessageV2.filterCompactedEffect(sessionID)).toEqual([])
        expect(yield* MessageV2.filterCompactedEffect(SessionID.make("ses_missing"))).toEqual([])
      }),
    ),
  )

  if (process.env.OPENCODE_HISTORY_BENCHMARK === "1") {
    it.instance(
      "profiles bounded synthetic history reads",
      () =>
        Effect.gen(function* () {
          for (const fixture of [
            { name: "uncompacted", boundaries: [] },
            { name: "compacted", boundaries: [{ at: 5980 }] },
            { name: "retained-tail", boundaries: [{ at: 5980, tail: 5844 }] },
          ]) {
            yield* withSession(({ sessionID }) =>
              Effect.gen(function* () {
                yield* seedHistory(sessionID, 6000, fixture.boundaries, 16 * 1024)
                const database = yield* Database.Service
                // Model an already-imported session without per-page legacy file probes.
                yield* database.db.insert(SessionQueueImportTable).values({ session_id: sessionID, hidden: [] })
                for (let iteration = 0; iteration < 5; iteration++) {
                  for (const mode of ["eager", "bounded"] as const) {
                    Bun.gc(true)
                    const delays = { last: performance.now(), max: 0 }
                    const sample = () => {
                      const now = performance.now()
                      delays.max = Math.max(delays.max, now - delays.last)
                      delays.last = now
                    }
                    const timer = setInterval(sample, 1)
                    const measured = yield* measureHistory(
                      mode === "eager"
                        ? MessageV2.stream(sessionID).pipe(Effect.map(MessageV2.filterCompacted))
                        : MessageV2.filterCompactedEffect(sessionID),
                    ).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          sample()
                          clearInterval(timer)
                        }),
                      ),
                    )
                    const { result, ...stats } = measured
                    console.log(
                      JSON.stringify({
                        fixture: fixture.name,
                        mode,
                        iteration,
                        retained: result.length,
                        ...stats,
                        timerGapMs: delays.max,
                      }),
                    )
                  }
                }
              }),
            )
          }
        }),
      120_000,
    )
  }
})

describe("MessageV2.cursor", () => {
  test("encode/decode roundtrip", () => {
    const input = { id: MessageID.ascending(), time: 1234567890 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.id).toBe(input.id)
    expect(decoded.time).toBe(input.time)
  })

  test("encode/decode with fractional time", () => {
    const input = { id: MessageID.ascending(), time: 1234567890.5 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.time).toBe(1234567890.5)
  })

  test("encoded cursor is base64url", () => {
    const encoded = MessageV2.cursor.encode({ id: MessageID.ascending(), time: 0 })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("MessageV2 consistency", () => {
  it.instance("page hydration matches get for each message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 3)

        const paged = yield* MessageV2.page({ sessionID, limit: 10 })
        for (const item of paged.items) {
          const got = yield* MessageV2.get({ sessionID, messageID: item.info.id as MessageID })
          expect(got.info).toEqual(item.info)
          expect(got.parts).toEqual(item.parts)
        }
      }),
    ),
  )

  it.instance("parts from get match standalone parts call", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const got = yield* MessageV2.get({ sessionID, messageID: id })
        const standalone = yield* MessageV2.parts(id)
        expect(got.parts).toEqual(standalone)
      }),
    ),
  )

  it.instance("stream collects same messages as exhaustive page iteration", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 7)

        const streamed = yield* MessageV2.stream(sessionID)

        const paged = [] as SessionV1.WithParts[]
        let cursor: string | undefined
        while (true) {
          const result = yield* MessageV2.page({ sessionID, limit: 3, before: cursor })
          for (let i = result.items.length - 1; i >= 0; i--) {
            paged.push(result.items[i])
          }
          if (!result.more || !result.cursor) break
          cursor = result.cursor
        }

        expect(streamed.map((m) => m.info.id)).toEqual(paged.map((m) => m.info.id))
      }),
    ),
  )

  it.instance("filterCompacted of full stream returns same as Array.from when no compaction", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 4)

        const stream = yield* MessageV2.stream(sessionID)
        const filtered = MessageV2.filterCompacted(stream)
        const all = stream.toReversed()

        expect(filtered.map((m) => m.info.id)).toEqual(all.map((m) => m.info.id))
      }),
    ),
  )
})
