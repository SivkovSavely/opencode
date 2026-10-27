import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { TranscriptSearch } from "../src/session/transcript-search"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const seed = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.run(
    sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('project', '/repo', '[]', 1, 1)`,
  )
  yield* database.db
    .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES ('session', 'project', 'test', '/repo', 'Historical session', '1', 1, 1),
           ('other', 'project', 'other', '/other', 'Other session', '1', 2, 2)`)
  yield* database.db.run(sql`INSERT INTO message (id, session_id, data, time_created, time_updated)
    VALUES ('message', 'session', '{"role":"assistant","agent":"deleted-agent","providerID":"old-provider","modelID":"old-model"}', 1, 1),
           ('user', 'other', '{"role":"user","agent":"user-agent","model":{"providerID":"old-provider","modelID":"old-model"}}', 2, 2)`)
  return database.db
})

const part = (id: string, data: object, message = "message", session = "session") =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
    VALUES (${id}, ${message}, ${session}, ${JSON.stringify(data)}, 1, 1)`)
  })

const durable = (id: string, type: string, data: object, session = "session") =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`INSERT INTO session_message (id, session_id, type, seq, data, time_created, time_updated)
      VALUES (${id}, ${session}, ${type}, (SELECT coalesce(max(seq),0)+1 FROM session_message WHERE session_id = ${session}),
        ${JSON.stringify(data)}, 10, 10)`)
  })

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>, filename = ":memory:") =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped))

describe("persisted transcript search", () => {
  test("searches durable V2 content with Web identities, historical filters and query-independent facets", () =>
    run(
      Effect.gen(function* () {
        yield* seed
        yield* durable("v-user", "user", {
          text: "needle user",
          files: [{ name: "needle.pdf", data: "private-bytes" }],
        })
        yield* durable("v-assistant", "assistant", {
          agent: "v2-agent",
          model: { providerID: "v2-provider", id: "v2-model" },
          time: { created: 10, completed: 20 },
          error: { type: "APIError", message: "needle assistant failure" },
          content: [
            { type: "reasoning", text: "private-reasoning" },
            { type: "text", id: "not-the-web-id", text: "needle first" },
            { type: "text", text: " " },
            {
              type: "tool",
              id: "v-tool",
              name: "v2-tool",
              time: { completed: 15 },
              state: {
                status: "completed",
                input: { command: "needle command\nsecond line" },
                content: [
                  { type: "text", text: "needle output" },
                  { type: "file", name: "needle-tool.txt", uri: "private-uri" },
                ],
                attachments: [{ name: "separate-attachment.log", data: "private-attachment-data" }],
                result: "private-result",
                structured: { text: "private-structured" },
              },
            },
            { type: "text", text: "needle last" },
          ],
        })
        const search = yield* TranscriptSearch.make
        expect((yield* search.facets()).tools).toEqual(["v2-tool"])
        expect((yield* search.status()).ready).toBe(false)
        expect((yield* search.search({ query: "needle" })).hits).toEqual([])
        expect(yield* search.advance()).toEqual({ ready: true, backfillCursor: "" })
        const hits = (yield* search.search({ query: "needle", sort: "oldest" })).hits
        expect(hits).toHaveLength(8)
        expect(
          hits
            .filter((x) => x.category === "text")
            .map((x) => x.partID)
            .sort(),
        ).toEqual(["v-assistant:text:0", "v-assistant:text:2", "v-user:text:0"])
        expect(hits.find((x) => x.category === "assistant-error")).toMatchObject({
          messageID: "v-assistant",
          partID: undefined,
          timeCreated: 20,
        })
        expect(hits.find((x) => x.partID === "v-tool" && x.category === "file")).toMatchObject({
          category: "file",
          messageID: "v-assistant",
        })
        expect(hits.find((x) => x.partID === "v-user:file:0")).toMatchObject({ category: "file", messageID: "v-user" })
        expect(
          (yield* search.search({
            query: "needle",
            agents: ["v2-agent"],
            models: [{ providerID: "v2-provider", modelID: "v2-model" }],
            roles: ["assistant"],
            toolNames: ["v2-tool"],
            toolStatuses: ["completed"],
            categories: ["tool-output"],
            dateFrom: 15,
            dateTo: 15,
          })).hits,
        ).toMatchObject([{ partID: "v-tool", messageID: "v-assistant", category: "tool-output", timeCreated: 15 }])
        expect(
          (yield* search.search({ query: "needle", agent: "v2-agent", providerID: "v2-provider", modelID: "v2-model" }))
            .hits,
        ).toHaveLength(8)
        expect(
          (yield* search.search({
            query: "needle user",
            agents: ["v2-agent"],
            models: [{ providerID: "v2-provider", modelID: "v2-model" }],
            roles: ["user"],
          })).hits,
        ).toMatchObject([{ messageID: "v-user", partID: "v-user:text:0", role: "user", agent: "v2-agent" }])
        expect((yield* search.search({ query: "separate-attachment.log" })).hits).toMatchObject([
          { partID: "v-tool", messageID: "v-assistant", category: "file" },
        ])
        for (const query of [
          "private-reasoning",
          "private-bytes",
          "private-uri",
          "private-result",
          "private-structured",
          "private-attachment-data",
        ])
          expect((yield* search.search({ query })).hits).toEqual([])
        expect(yield* search.facets()).toMatchObject({
          agents: ["v2-agent", "user-agent", "deleted-agent"],
          providers: ["v2-provider", "old-provider"],
          models: ["v2-model", "old-model"],
          tools: ["v2-tool"],
          modelIdentities: [
            { providerID: "v2-provider", modelID: "v2-model", lastUsed: 10 },
            { providerID: "old-provider", modelID: "old-model", lastUsed: 2 },
          ],
        })
      }),
    ))

  test("maps durable tool states without guessing interruption and indexes shell command/output", () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const search = yield* TranscriptSearch.make
        yield* durable("v-tools", "assistant", {
          agent: "v2-agent",
          model: { providerID: "v2-provider", id: "v2-model" },
          content: [
            {
              type: "tool",
              id: "pending",
              name: "test",
              state: { status: "pending", input: '{"text":"needle pending"}' },
            },
            {
              type: "tool",
              id: "running",
              name: "test",
              state: { status: "running", input: { text: "needle running" } },
            },
            {
              type: "tool",
              id: "failed",
              name: "test",
              state: { status: "error", input: {}, error: { message: "needle interrupted" } },
            },
            {
              type: "tool",
              id: "done",
              name: "test",
              state: {
                status: "completed",
                input: { text: "needle done" },
                content: [{ type: "text", text: "needle output" }],
              },
            },
            {
              type: "tool",
              id: "todo",
              name: "todowrite",
              state: {
                status: "completed",
                input: { text: "private-todo" },
                content: [{ type: "text", text: "private-todo" }],
              },
            },
            { type: "tool", id: "question", name: "question", state: { status: "pending", input: "private-question" } },
          ],
        })
        expect(
          (yield* search.search({ query: "needle", toolStatuses: ["running"] })).hits.map((x) => x.partID).sort(),
        ).toEqual(["pending", "running"])
        expect((yield* search.search({ query: "needle", toolStatuses: ["error"] })).hits).toMatchObject([
          { partID: "failed", category: "tool-error", toolStatus: "error" },
        ])
        expect((yield* search.search({ query: "needle", toolStatuses: ["interrupted"] })).hits).toEqual([])
        expect(
          (yield* search.search({ query: "needle", toolStatuses: ["completed"] })).hits.map((x) => x.category).sort(),
        ).toEqual(["tool-input", "tool-output"])
        yield* durable("v-shell", "shell", {
          command: "needle shell",
          output: "needle result",
          time: { created: 10, completed: 12 },
        })
        expect((yield* search.search({ query: "needle", toolNames: ["bash"] })).hits).toMatchObject([
          {
            partID: "v-shell:tool",
            messageID: "v-shell",
            navigationMessageID: "v-shell:assistant",
            category: "tool-output",
            toolStatus: "completed",
          },
          {
            partID: "v-shell:tool",
            messageID: "v-shell",
            navigationMessageID: "v-shell:assistant",
            category: "tool-input",
            toolStatus: "completed",
          },
        ])
        expect((yield* search.search({ query: "private" })).hits).toEqual([])
        const database = yield* Database.Service
        expect(
          yield* database.db.all(
            sql`SELECT rowid FROM transcript_search_v2_fts WHERE transcript_search_v2_fts MATCH 'private'`,
          ),
        ).toEqual([])
        expect((yield* search.facets()).tools).toEqual(["bash", "test"])
      }),
    ))

  test("maintains V2 updates, hidden imports, deletes, reverts and session cascades atomically", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seed
        const search = yield* TranscriptSearch.make
        yield* durable("v-user", "user", { text: "original" })
        yield* durable("v-system", "system", { text: "private-system" })
        yield* durable("v-synthetic", "synthetic", { text: "private-synthetic" })
        yield* durable("v-assistant", "assistant", {
          agent: "new-agent",
          content: [
            { type: "tool", id: "tool", name: "test", state: { status: "running", input: { text: "original" } } },
          ],
        })
        expect((yield* search.search({ query: "original" })).hits).toHaveLength(2)
        const originalRow = yield* db.get<{ rowid: number }>(
          sql`SELECT rowid FROM transcript_search_v2 WHERE message_id = 'v-assistant' AND part_id = 'tool'`,
        )
        yield* db.run(
          sql`UPDATE session_message SET data = ${JSON.stringify({
            agent: "new-agent",
            progress: "checkpoint",
            content: [
              { type: "tool", id: "tool", name: "test", state: { status: "running", input: { text: "original" } } },
            ],
          })} WHERE id = 'v-assistant'`,
        )
        expect(
          yield* db.get<{ rowid: number }>(
            sql`SELECT rowid FROM transcript_search_v2 WHERE message_id = 'v-assistant' AND part_id = 'tool'`,
          ),
        ).toEqual(originalRow)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.run(sql`DELETE FROM session_message WHERE id = 'v-assistant'`)
              return yield* Effect.fail("rollback")
            }),
          )
          .pipe(Effect.flip)
        expect((yield* search.search({ query: "original" })).hits).toHaveLength(2)
        yield* db.run(
          sql`UPDATE session_message SET data = ${JSON.stringify({ agent: "new-agent", error: { message: "replacement error" }, content: [{ type: "tool", id: "tool", name: "test", state: { status: "completed", input: {}, content: [{ type: "text", text: "replacement" }] } }] })} WHERE id = 'v-assistant'`,
        )
        expect((yield* search.search({ query: "original", role: "assistant" })).hits).toEqual([])
        expect((yield* search.search({ query: "replacement" })).hits).toHaveLength(2)
        yield* db.run(sql`INSERT INTO session_queue_import VALUES ('session','["v-assistant"]')`)
        expect((yield* search.search({ query: "replacement" })).hits).toEqual([])
        expect((yield* search.facets()).agents).not.toContain("new-agent")
        yield* db.run(sql`DELETE FROM session_queue_import`)
        expect((yield* search.search({ query: "replacement" })).hits).toHaveLength(2)
        expect((yield* search.search({ query: "private" })).hits).toEqual([])
        yield* db.run(
          sql`DELETE FROM session_message WHERE session_id = 'session' AND seq > (SELECT seq FROM session_message WHERE id = 'v-user')`,
        )
        expect((yield* search.search({ query: "replacement" })).hits).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM transcript_search_v2_error`)).toEqual([])
        expect((yield* search.search({ query: "original" })).hits).toHaveLength(1)
        yield* db.run(sql`DELETE FROM session WHERE id = 'session'`)
        expect(yield* db.all(sql`SELECT * FROM transcript_search_v2`)).toEqual([])
        expect((yield* search.search({ query: "original" })).hits).toEqual([])
      }),
    ))

  test("qualifies repeated tool IDs by durable message and keeps tool text candidates bounded", () =>
    run(
      Effect.gen(function* () {
        yield* seed
        const search = yield* TranscriptSearch.make
        yield* durable("first", "assistant", {
          content: [
            {
              type: "tool",
              id: "repeated-call",
              name: "test",
              state: { status: "completed", input: {}, content: [{ type: "text", text: "needle first" }] },
            },
          ],
        })
        yield* durable(
          "second",
          "assistant",
          {
            content: [
              {
                type: "tool",
                id: "repeated-call",
                name: "test",
                state: {
                  status: "completed",
                  input: { command: "needle input" },
                  content: [
                    { type: "text", text: "needle second " + "x".repeat(70000) },
                    { type: "text", text: "outside-bound" },
                  ],
                },
              },
            ],
          },
          "other",
        )
        const hits = (yield* search.search({ query: "needle", categories: ["tool-output"] })).hits
        expect(hits.map((x) => x.messageID).sort()).toEqual(["first", "second"])
        expect(new Set(hits.map((x) => x.documentID)).size).toBe(2)
        expect(hits.find((x) => x.messageID === "second")?.truncated).toBe(true)
        expect((yield* search.search({ query: "needle first", categories: ["tool-output"] })).scanned).toBe(1)
        expect((yield* search.search({ query: "outside-bound" })).hits).toEqual([])
      }),
    ))

  test("limits mixed legacy and durable backfill to 200 source rows per request", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seed
        yield* db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 205)
        INSERT INTO session_message (id,session_id,type,seq,data,time_created,time_updated)
        SELECT printf('v%04d',i),'session','user',i,'{"text":"historical durable"}',10,10 FROM n`)
        const search = yield* TranscriptSearch.make
        expect(yield* search.advance()).toEqual({ ready: false, backfillCursor: "durable:v0198" })
        expect((yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM transcript_search_v2`))?.count).toBe(
          198,
        )
        expect(yield* search.advance()).toEqual({ ready: true, backfillCursor: "" })
      }),
    ))

  test("prefers durable projections and paginates new messages without skipping earlier results", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seed
        yield* part("legacy", { type: "text", text: "needle legacy" })
        const search = yield* TranscriptSearch.make
        yield* search.advance()
        yield* durable("message", "assistant", {
          agent: "durable-agent",
          content: [{ type: "text", text: "needle durable" }],
        })
        yield* durable("v-user", "user", { text: "needle user" })
        const first = yield* search.search({ query: "needle", sort: "oldest", limit: 1 })
        expect(first.hits[0]).toMatchObject({ messageID: "message", partID: "message:text:0", agent: "durable-agent" })
        yield* durable("new-user", "user", { text: "needle new" })
        expect(
          (yield* search.search({ query: "needle", sort: "oldest", cursor: first.nextCursor! })).hits.map(
            (x) => x.messageID,
          ),
        ).toEqual(["new-user", "v-user"])
        expect((yield* search.search({ query: "legacy" })).hits).toEqual([])
        expect((yield* search.facets()).agents).not.toContain("deleted-agent")
        yield* db.run(sql`DELETE FROM session_message WHERE id = 'message'`)
        expect((yield* search.search({ query: "legacy" })).hits.map((x) => x.partID)).toEqual(["legacy"])
      }),
    ))

  test("upgrades a ready legacy index and resumes durable backfill across SQLite reopen", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "v2-search.sqlite")
    await run(
      Effect.gen(function* () {
        const db = yield* seed
        yield* db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 205)
        INSERT INTO session_message (id,session_id,type,seq,data,time_created,time_updated)
        SELECT printf('v%04d',i),'session','user',i,'{"text":"historical durable"}',10,10 FROM n`)
        yield* db.run(sql`INSERT INTO transcript_search_state VALUES (1,'',1)`)
        const search = yield* TranscriptSearch.make
        expect(yield* search.status()).toEqual({ ready: false, backfillCursor: "durable:" })
        expect((yield* search.search({ query: "historical" })).hits).toEqual([])
        expect(yield* search.status()).toEqual({ ready: false, backfillCursor: "durable:" })
        expect(yield* search.advance()).toEqual({ ready: false, backfillCursor: "durable:v0200" })
        yield* durable("a-older", "user", { text: "concurrent durable" })
      }),
      filename,
    )
    await run(
      Effect.gen(function* () {
        const search = yield* TranscriptSearch.make
        expect(yield* search.status()).toEqual({ ready: false, backfillCursor: "durable:v0200" })
        expect(yield* search.advance()).toEqual({ ready: true, backfillCursor: "" })
        expect(yield* search.advance()).toEqual({ ready: true, backfillCursor: "" })
        expect((yield* search.search({ query: "concurrent" })).hits.map((x) => x.messageID)).toEqual(["a-older"])
        const ids: string[] = []
        let cursor: string | undefined
        do {
          const page = yield* search.search({ query: "historical", limit: 100, cursor })
          ids.push(...page.hits.map((x) => x.messageID))
          cursor = page.nextCursor
        } while (cursor)
        expect(ids).toHaveLength(205)
        expect(new Set(ids).size).toBe(205)
      }),
      filename,
    )
  })

  test("combines multi-value historical identities, dates, archive and session filters", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seed
        yield* part("a", { type: "text", text: "needle" })
        yield* part("b", { type: "text", text: "needle" }, "user", "other")
        yield* db.run(sql`UPDATE session SET parent_id = 'session', time_archived = 3 WHERE id = 'other'`)
        const search = yield* TranscriptSearch.make
        yield* search.advance()
        expect(
          (yield* search.search({
            query: "needle",
            projectIDs: ["missing", "project"],
            agents: ["deleted-agent"],
            roles: ["assistant"],
            models: [{ providerID: "old-provider", modelID: "old-model" }],
            categories: ["text"],
            dateFrom: 1,
            dateTo: 1,
            archived: "active",
            sessionKind: "root",
          })).hits.map((x) => x.partID),
        ).toEqual(["a"])
        expect(
          (yield* search.search({ query: "needle", archived: "archived", sessionKind: "subagent" })).hits.map(
            (x) => x.partID,
          ),
        ).toEqual(["b"])
        expect(
          (yield* search.search({ query: "needle", models: [{ providerID: "wrong", modelID: "old-model" }] })).hits,
        ).toEqual([])
        expect(yield* search.search({ query: "needle", dateFrom: 3, dateTo: 1 }).pipe(Effect.flip)).toBeInstanceOf(
          TranscriptSearch.InvalidQuery,
        )
        expect((yield* search.facets()).modelIdentities).toEqual([
          { providerID: "old-provider", modelID: "old-model", lastUsed: 2 },
        ])
        expect((yield* search.facets()).agentDetails).toEqual([
          { value: "user-agent", lastUsed: 2 },
          { value: "deleted-agent", lastUsed: 1 },
        ])
        expect((yield* search.facets()).modelDetails).toEqual([{ value: "old-model", lastUsed: 2 }])
      }),
    ))

  test("separates tool categories, running states, explicit interruption and assistant errors", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seed
        yield* part("pending", {
          type: "tool",
          tool: "historical-tool",
          state: { status: "pending", input: { text: "needle" } },
        })
        yield* part("running", {
          type: "tool",
          tool: "historical-tool",
          state: { status: "running", input: { text: "needle" } },
        })
        yield* part("failed", {
          type: "tool",
          tool: "historical-tool",
          state: { status: "error", error: "needle interrupted" },
        })
        yield* part("interrupted", {
          type: "tool",
          tool: "historical-tool",
          state: { status: "error", error: "needle", metadata: { interrupted: true } },
        })
        yield* part("completed", {
          type: "tool",
          tool: "historical-tool",
          state: { status: "completed", input: { text: "needle" }, output: "needle" },
        })
        yield* part("hidden-todo", {
          type: "tool",
          tool: "todowrite",
          state: {
            status: "completed",
            input: { text: "private internal content" },
            output: "private internal content",
          },
        })
        yield* part("hidden-question", {
          type: "tool",
          tool: "question",
          state: { status: "running", input: { text: "private question" } },
        })
        yield* db.run(
          sql`UPDATE message SET data = json_set(data, '$.error', json('{"name":"APIError","data":{"message":"needle failure"}}'), '$.metadata.secret', 'privateinternalterm') WHERE id = 'message'`,
        )
        yield* db.run(
          sql`CREATE VIRTUAL TABLE transcript_search_message_fts USING fts5(data, content='', contentless_delete=1, tokenize='trigram')`,
        )
        yield* db.run(sql`INSERT INTO transcript_search_message_fts(rowid, data) SELECT rowid, data FROM message`)
        const search = yield* TranscriptSearch.make
        expect(yield* db.all(sql`SELECT name FROM sqlite_master WHERE name = 'transcript_search_message_fts'`)).toEqual(
          [],
        )
        yield* search.advance()
        expect(
          yield* db.all(
            sql`SELECT rowid FROM transcript_search_error_fts WHERE transcript_search_error_fts MATCH 'privateinternalterm'`,
          ),
        ).toEqual([])
        expect(
          (yield* search.search({ query: "needle", toolStatuses: ["running"] })).hits.map((x) => x.partID),
        ).toEqual(["running", "pending"])
        expect((yield* search.search({ query: "private" })).hits).toEqual([])
        expect((yield* search.search({ query: "needle", toolStatuses: ["error"] })).hits.map((x) => x.partID)).toEqual([
          "failed",
        ])
        expect((yield* search.search({ query: "needle", toolStatuses: ["interrupted"] })).hits[0]).toMatchObject({
          toolStatus: "interrupted",
          category: "tool-error",
        })
        expect((yield* search.search({ query: "needle", categories: ["assistant-error"] })).hits[0]).toMatchObject({
          partID: undefined,
          messageID: "message",
          category: "assistant-error",
        })
        expect(
          (yield* search.search({
            query: "needle",
            toolNames: ["historical-tool"],
            toolStatuses: ["completed"],
          })).hits.map((x) => x.category),
        ).toEqual(["tool-output", "tool-input"])
        expect((yield* search.facets()).tools).toEqual(["historical-tool"])
        expect((yield* search.facets()).toolDetails).toEqual([{ value: "historical-tool", lastUsed: 1 }])
      }),
    ))

  test("returns only assistant errors rendered by the latest message in a turn", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seed
        yield* db.run(sql`INSERT INTO message (id, session_id, data, time_created, time_updated) VALUES
          ('legacy-user', 'session', '{"role":"user"}', 5, 5),
          ('legacy-failed', 'session', '{"role":"assistant","parentID":"legacy-user","error":{"data":{"message":"legacy retry failure"}}}', 6, 6),
          ('legacy-success', 'session', '{"role":"assistant","parentID":"legacy-user"}', 7, 7),
          ('legacy-final-user', 'session', '{"role":"user"}', 8, 8),
          ('legacy-final-error', 'session', '{"role":"assistant","parentID":"legacy-final-user","error":{"data":{"message":"legacy final failure"}}}', 9, 9)`)
        yield* durable("v-user-retry", "user", { text: "retry" })
        yield* durable("v-assistant-failed", "assistant", {
          error: { type: "APIError", message: "durable retry failure" },
          content: [],
        })
        yield* durable("v-assistant-success", "assistant", {
          content: [{ type: "text", text: "recovered" }],
        })
        yield* durable("v-user-final", "user", { text: "again" })
        yield* durable("v-assistant-final-error", "assistant", {
          error: { type: "APIError", message: "durable final failure" },
          content: [],
        })
        const search = yield* TranscriptSearch.make
        yield* search.advance()
        expect((yield* search.search({ query: "legacy retry failure" })).hits).toEqual([])
        expect((yield* search.search({ query: "durable retry failure" })).hits).toEqual([])
        expect((yield* search.search({ query: "legacy final failure" })).hits).toMatchObject([
          { messageID: "legacy-final-error", category: "assistant-error" },
        ])
        expect((yield* search.search({ query: "durable final failure" })).hits).toMatchObject([
          { messageID: "v-assistant-final-error", category: "assistant-error" },
        ])
      }),
    ))

  test("keyset pagination is deterministic across ties, categories and all sort orders", () =>
    run(
      Effect.gen(function* () {
        yield* seed
        yield* part("a", { type: "tool", state: { input: { text: "needle" }, output: "needle" } })
        yield* part("b", { type: "text", text: "needle" })
        yield* part("c", { type: "text", text: "needle" }, "user", "other")
        const search = yield* TranscriptSearch.make
        yield* search.advance()
        for (const sort of ["newest", "oldest", "session-title"] as const) {
          const expected =
            sort === "newest"
              ? ["c:text", "b:text", "a:tool-output", "a:tool-input"]
              : ["a:tool-input", "a:tool-output", "b:text", "c:text"]
          expect((yield* search.search({ query: "needle", sort })).hits.map((x) => x.documentID)).toEqual(expected)
          const actual: string[] = []
          let cursor: string | undefined
          do {
            const page = yield* search.search({ query: "needle", sort, limit: 1, cursor })
            actual.push(...page.hits.map((x) => x.documentID))
            cursor = page.nextCursor ?? undefined
          } while (cursor)
          expect(actual).toEqual(expected)
          expect(new Set(actual).size).toBe(4)
        }
        const first = yield* search.search({ query: "needle", limit: 1 })
        expect(yield* search.search({ query: "changed", cursor: first.nextCursor! }).pipe(Effect.flip)).toBeInstanceOf(
          TranscriptSearch.InvalidQuery,
        )
        expect((yield* search.search({ query: "/NEEDLE/ig", mode: "regex" })).hits).toHaveLength(4)
        expect(yield* search.search({ query: "/needle/y", mode: "regex" }).pipe(Effect.flip)).toBeInstanceOf(
          TranscriptSearch.InvalidQuery,
        )
      }),
    ))

  test("uses stable keyset pagination when new matching messages arrive between pages", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seed
        yield* part("first", { type: "text", text: "needle" })
        yield* part("second", { type: "text", text: "needle" }, "user", "other")
        const search = yield* TranscriptSearch.make
        yield* search.advance()
        const first = yield* search.search({ query: "needle", sort: "oldest", limit: 1 })
        yield* db.run(sql`INSERT INTO message (id, session_id, data, time_created, time_updated)
          VALUES ('new-message', 'session', '{"role":"assistant"}', 1, 1)`)
        yield* part("new-part", { type: "text", text: "needle" }, "new-message", "session")
        const rest = yield* search.search({ query: "needle", sort: "oldest", limit: 10, cursor: first.nextCursor! })
        expect(first.hits.map((hit) => hit.partID)).toEqual(["first"])
        expect(rest.hits.map((hit) => hit.partID)).toEqual(["new-part", "second"])
        expect((yield* search.search({ query: "needle", sort: "oldest" })).hits.map((hit) => hit.partID)).toEqual([
          "first",
          "new-part",
          "second",
        ])
      }),
    ))

  test("backfills historical content across sessions, filters and paginates literal matches safely", () =>
    run(
      Effect.gen(function* () {
        yield* seed
        yield* part("a", { type: "text", text: "Hello [literal].* needle" })
        yield* part("b", { type: "text", text: "hello needle" }, "user", "other")
        const search = yield* TranscriptSearch.make
        expect((yield* search.status()).ready).toBe(false)
        expect((yield* search.search({ query: "hello" })).status.ready).toBe(false)
        expect((yield* search.status()).ready).toBe(false)
        expect(yield* search.advance()).toEqual({ ready: true, backfillCursor: "" })
        const first = yield* search.search({ query: "hello", limit: 1, sort: "oldest" })
        expect(first.status.ready).toBe(true)
        expect(first.hits.map((x) => x.partID)).toEqual(["a"])
        expect(first.hits[0]).toMatchObject({ offset: 0, matchLength: 5, excerptOffset: 0, projectPath: "/repo" })
        expect(first.nextCursor).toBeString()
        expect(
          (yield* search.search({ query: "hello", sort: "oldest", cursor: first.nextCursor! })).hits.map(
            (x) => x.partID,
          ),
        ).toEqual(["b"])
        expect((yield* search.search({ query: "[literal].*" })).hits.map((x) => x.partID)).toEqual(["a"])
        expect((yield* search.search({ query: "hello", caseSensitive: true })).hits.map((x) => x.partID)).toEqual(["b"])
        expect(
          (yield* search.search({
            query: "needle",
            sessionID: "other",
            role: "user",
            agent: "user-agent",
            providerID: "old-provider",
            modelID: "old-model",
            projectID: "project",
          })).hits.map((x) => x.partID),
        ).toEqual(["b"])
        expect(yield* search.facets()).toMatchObject({
          projects: ["project"],
          agents: ["user-agent", "deleted-agent"],
          providers: ["old-provider"],
          models: ["old-model"],
          truncated: false,
        })
      }),
    ))

  test("indexes visible text, tool input, tool errors and filenames without attachment bytes", () =>
    run(
      Effect.gen(function* () {
        yield* seed
        yield* part("reasoning", { type: "reasoning", text: "Reasoning content" })
        yield* part("tool", {
          type: "tool",
          state: { status: "error", error: "Tool error", input: { secret: "raw-secret" } },
        })
        yield* part("tool-file", {
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: "",
            attachments: [{ filename: "tool-result.log", data: "private" }],
          },
        })
        yield* part("file", { type: "file", filename: "report.txt", url: "data:text/plain;base64,raw-secret" })
        yield* part("unicode", { type: "text", text: "\u0130Hello" })
        yield* part("unicode-case", { type: "text", text: "Ångström" })
        const search = yield* TranscriptSearch.make
        yield* search.advance()
        expect((yield* search.search({ query: "reasoning content" })).hits).toEqual([])
        expect((yield* search.search({ query: "tool error" })).hits.map((x) => x.partID)).toEqual(["tool"])
        expect((yield* search.search({ query: "report.txt" })).hits.map((x) => x.partID)).toEqual(["file"])
        expect((yield* search.search({ query: "tool-result.log" })).hits).toMatchObject([
          { partID: "tool-file", category: "file" },
        ])
        expect((yield* search.search({ query: "raw-secret" })).hits.map((x) => x.category)).toEqual(["tool-input"])
        expect((yield* search.search({ query: "hello" })).hits[0]).toMatchObject({ offset: 1, matchLength: 5 })
        expect((yield* search.search({ query: "/\\u00C5ngström/", mode: "regex" })).hits.map((x) => x.partID)).toEqual([
          "unicode-case",
        ])
        expect((yield* search.search({ query: "ångström" })).hits.map((x) => x.partID)).toEqual(["unicode-case"])
      }),
    ))

  test("preserves multiline structured inputs and indexes each bounded tool category independently", () =>
    run(
      Effect.gen(function* () {
        yield* seed
        yield* part("long-tool", {
          type: "tool",
          tool: "shell",
          state: {
            status: "completed",
            input: { command: "first line\nsecond line", large: "x".repeat(70000) },
            output: "needle output",
            time: { start: 1, end: 9 },
          },
        })
        const search = yield* TranscriptSearch.make
        yield* search.advance()
        expect(
          (yield* search.search({ query: "first line\nsecond line", categories: ["tool-input"] })).hits[0],
        ).toMatchObject({
          category: "tool-input",
          excerpt: expect.stringContaining("first line\nsecond line"),
        })
        expect(
          (yield* search.search({ query: "needle", categories: ["tool-output"], dateFrom: 9, dateTo: 9 })).hits[0],
        ).toMatchObject({ category: "tool-output", timeCreated: 9 })
      }),
    ))

  test("retains every V1 tool category in the trigram candidate body", () =>
    run(
      Effect.gen(function* () {
        yield* seed
        yield* part("wide-tool", {
          type: "tool",
          tool: "bash",
          state: {
            status: "error",
            title: "t".repeat(1024),
            input: { command: "i".repeat(65536) },
            raw: "r".repeat(65536),
            output: "o".repeat(65536),
            error: "e".repeat(65524) + "errorneedle",
            attachments: [{ filename: "f".repeat(65520) + ".log", data: "private" }],
          },
        })
        const search = yield* TranscriptSearch.make
        yield* search.advance()
        expect((yield* search.search({ query: "errorneedle", categories: ["tool-error"] })).hits).toMatchObject([
          { partID: "wide-tool", category: "tool-error" },
        ])
      }),
    ))

  test("tracks updates, visibility, tool completion, metadata changes and cascading deletion", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seed
        const search = yield* TranscriptSearch.make
        yield* part("a", { type: "text", text: "visible" })
        yield* part("synthetic", { type: "text", text: "invisible", synthetic: true })
        yield* part("ignored", { type: "text", text: "invisible", ignored: true })
        yield* part("tool", { type: "tool", state: { status: "running", title: "Task" } })
        expect((yield* search.search({ query: "invisible" })).hits).toEqual([])
        expect(yield* search.search({ query: "^$", mode: "regex" }).pipe(Effect.flip)).toBeInstanceOf(
          TranscriptSearch.InvalidQuery,
        )
        expect(
          yield* search.search({ query: "visible", roles: Array(101).fill("user" as const) }).pipe(Effect.flip),
        ).toBeInstanceOf(TranscriptSearch.InvalidQuery)
        expect(
          yield* search.search({ query: "visible", categories: Array(101).fill("text" as const) }).pipe(Effect.flip),
        ).toBeInstanceOf(TranscriptSearch.InvalidQuery)
        expect(
          yield* search
            .search({ query: "visible", toolStatuses: Array(101).fill("running" as const) })
            .pipe(Effect.flip),
        ).toBeInstanceOf(TranscriptSearch.InvalidQuery)
        yield* db.run(
          sql`UPDATE part SET data = '{"type":"tool","state":{"status":"completed","output":"completed output"}}' WHERE id = 'tool'`,
        )
        expect((yield* search.search({ query: "completed output" })).hits.map((x) => x.partID)).toEqual(["tool"])
        yield* db.run(sql`UPDATE part SET data = '{"type":"text","text":"replacement"}' WHERE id = 'a'`)
        expect((yield* search.search({ query: "visible" })).hits).toEqual([])
        yield* db.run(sql`UPDATE session SET title = 'Renamed' WHERE id = 'session'`)
        expect((yield* search.search({ query: "replacement" })).hits[0]?.title).toBe("Renamed")
        yield* db.run(sql`INSERT INTO session_queue_import VALUES ('session', '["message"]')`)
        expect((yield* search.search({ query: "replacement" })).hits).toEqual([])
        expect((yield* search.facets()).agents).toEqual(["user-agent"])
        yield* db.run(sql`DELETE FROM session_queue_import`)
        yield* db.run(sql`UPDATE message SET data = '{"role":"assistant","agent":"new-agent"}' WHERE id = 'message'`)
        expect((yield* search.search({ query: "replacement", agent: "deleted-agent" })).hits).toEqual([])
        expect((yield* search.search({ query: "replacement", agent: "new-agent" })).hits).toHaveLength(1)
        yield* db.run(sql`DELETE FROM part WHERE id = 'a'`)
        expect((yield* search.search({ query: "replacement" })).hits).toEqual([])
        yield* db.run(sql`DELETE FROM message WHERE id = 'message'`)
        expect(yield* db.all(sql`SELECT * FROM transcript_search`)).toEqual([])
        yield* part("user-part", { type: "text", text: "user text" }, "user", "other")
        yield* db.run(sql`DELETE FROM session WHERE id = 'other'`)
        expect(yield* db.all(sql`SELECT * FROM transcript_search`)).toEqual([])
      }),
    ))

  test("resumes durable backfill after reopening SQLite and captures older concurrent IDs", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "search.sqlite")
    await run(
      Effect.gen(function* () {
        const db = yield* seed
        yield* db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 205)
        INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
        SELECT printf('p%04d', i), 'message', 'session', '{"type":"text","text":"historical"}', 1, 1 FROM n`)
        const search = yield* TranscriptSearch.make
        expect(yield* search.advance()).toEqual({ ready: false, backfillCursor: "p0200" })
        yield* part("a-older", { type: "text", text: "concurrent" })
      }),
      filename,
    )
    await run(
      Effect.gen(function* () {
        const search = yield* TranscriptSearch.make
        expect(yield* search.advance()).toEqual({ ready: true, backfillCursor: "" })
        expect((yield* search.search({ query: "concurrent" })).hits.map((x) => x.partID)).toEqual(["a-older"])
        expect((yield* search.search({ query: "historical" })).hits).toHaveLength(50)
      }),
      filename,
    )
  })

  test("bounds scans and part size, returns continuation on empty pages, rejects unsafe regex", () =>
    run(
      Effect.gen(function* () {
        const db = yield* seed
        yield* db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 510)
      INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
      SELECT printf('p%04d', i), 'message', 'session', '{"type":"text","text":"no match"}', 1, 1 FROM n`)
        const search = yield* TranscriptSearch.make
        yield* search.advance()
        yield* search.advance()
        yield* search.advance()
        yield* part("class", { type: "text", text: "foo+" })
        yield* part("unicode", { type: "text", text: "😀ab" })
        expect((yield* search.search({ query: "/foo[+]/", mode: "regex" })).hits.map((x) => x.partID)).toEqual([
          "class",
        ])
        expect((yield* search.search({ query: "😀ab" })).hits.map((x) => x.partID)).toEqual(["unicode"])
        const empty = yield* search.search({ query: "/match[a-z]x/", mode: "regex" })
        expect(empty.scanned).toBe(500)
        expect(empty.hits).toEqual([])
        expect(empty.nextCursor).toBeString()
        expect(empty.scanLimited).toBe(true)
        expect((yield* search.search({ query: "/match[a-z]x/", mode: "regex", projectID: "absent" })).scanned).toBe(0)
        expect(
          (yield* search.search({ query: "/match[a-z]x/", mode: "regex", cursor: empty.nextCursor! })).nextCursor,
        ).toBeUndefined()
        yield* part("z", { type: "text", text: "start" + "x".repeat(65536) + "outside" })
        expect((yield* search.search({ query: "start" })).hits[0]?.truncated).toBe(true)
        expect((yield* search.search({ query: "outside" })).hits).toEqual([])
        expect((yield* search.search({ query: "outside" })).truncatedDocuments).toBe(1)
        expect((yield* search.search({ query: "/^sta[r-t]t/im", mode: "regex" })).hits).toHaveLength(1)
        for (const query of ["(a+)+$", "a*", "a{1000}", "a|b", "\\1", "["]) {
          expect(yield* search.search({ query, mode: "regex" }).pipe(Effect.flip)).toBeInstanceOf(
            TranscriptSearch.InvalidQuery,
          )
        }
        expect(yield* search.search({ query: "x", limit: 101 }).pipe(Effect.flip)).toBeInstanceOf(
          TranscriptSearch.InvalidQuery,
        )
        expect(yield* search.search({ query: "x" }).pipe(Effect.flip)).toMatchObject({
          message: "Literal searches require at least three Unicode characters",
        })
      }),
    ))
})
