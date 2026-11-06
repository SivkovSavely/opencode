import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { TranscriptSearch } from "../src/session/transcript-search"
import { Global } from "@opencode/util/global"
import { tmpdir } from "./fixture/tmpdir"
import { importTranscriptFixture, transcriptIDs } from "./fixture/transcript-import"
import { SessionHistory } from "../src/session/history"
import { SessionMessageTable } from "../src/session/sql"

function run<A, E>(body: Effect.Effect<A, E, Database.Service>, path = ":memory:") {
  return Effect.runPromise(
    body.pipe(
      Effect.provide(Database.layer({ path })),
      Effect.provideService(Global.Service, Global.make({ data: "/unused" })),
      Effect.scoped,
    ),
  )
}

const seed = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.run(
    sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('global','/closed-project','[]',0,0)`,
  )
  yield* database.db
    .run(sql`INSERT INTO session_v2(id,project_id,slug,directory,version,time_created,time_updated,title)
    VALUES('ses_search','global','search','/closed-project','test',0,0,'Historical')`)
  return database.db
})
function message(db: Database.Interface["db"], id: string, seq: number, type: string, data: unknown, time = seq) {
  return db.run(sql`INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data)
    VALUES(${id},'ses_search',${type},${seq},${time},${time},${JSON.stringify(data)})`)
}
const assistant = (content: unknown[], extra = {}) => ({
  agent: "retired-agent",
  model: { providerID: "old-provider", id: "old-model" },
  content,
  time: { created: 10, completed: 20 },
  ...extra,
})
const text = (value: string) => ({ type: "text", text: value })
const tool = (status = "completed", errorType = "failure") => ({
  type: "tool",
  id: "call_reused",
  name: "read",
  time: { created: 12, completed: 30 },
  state: {
    status,
    input: { path: "public needle", nested: { token: "public-secret" } },
    content: [
      text("output needle"),
      { type: "file", name: "file-needle.txt", uri: "data:excluded-bytes", mime: "text/plain" },
    ],
    error: { type: errorType, message: "error needle interrupted" },
    metadata: { private: "excluded-metadata" },
  },
})

test("categories, exclusions, historical facets, qualified filters and explicit interruption", () =>
  run(
    Effect.gen(function* () {
      const db = yield* seed
      const search = yield* TranscriptSearch.make
      yield* message(db, "msg_user", 1, "user", {
        text: "user needle",
        files: [{ name: "user-needle.txt", uri: "excluded-user-bytes" }],
      })
      yield* message(
        db,
        "msg_assistant",
        2,
        "assistant",
        assistant(
          [
            text("assistant needle"),
            { type: "reasoning", text: "excluded-reasoning" },
            tool("error"),
            { ...tool(), id: "todo", name: "todowrite" },
            { ...tool("running"), id: "question", name: "question" },
          ],
          { error: { type: "failure", message: "assistant-error needle" } },
        ),
      )
      const all = yield* search.search({ query: "needle" })
      expect(new Set(all.hits.map((hit) => hit.category))).toEqual(
        new Set(["text", "file", "tool-input", "tool-output", "tool-error", "assistant-error"]),
      )
      expect(all.hits.find((hit) => hit.category === "tool-output")?.timeCreated).toBe(30)
      expect(all.hits.find((hit) => hit.role === "user")?.agent).toBe("retired-agent")
      expect((yield* search.search({ query: "excluded" })).hits).toEqual([])
      expect((yield* search.search({ query: "public-secret" })).hits).toHaveLength(1)
      expect((yield* search.search({ query: "needle", toolStatuses: ["interrupted"] })).hits).toEqual([])
      yield* message(db, "msg_other", 3, "assistant", assistant([{ ...tool("error", "aborted"), id: "call_reused" }]))
      expect((yield* search.search({ query: "needle", toolStatuses: ["interrupted"] })).hits.length).toBeGreaterThan(0)
      expect((yield* search.search({ query: "needle", categories: ["assistant-error"] })).hits).toEqual([])
      expect(
        (yield* search.search({ query: "needle", models: [{ providerID: "wrong", modelID: "old-model" }] })).hits,
      ).toEqual([])
      const compound = yield* search.search({
        query: "needle",
        content: [
          { role: "user", category: "text" },
          { role: "assistant", category: "tool-output" },
        ],
      })
      expect(compound.hits.some((hit) => hit.role === "assistant" && hit.category === "text")).toBe(false)
      expect(
        (yield* search.search({ query: "needle", categories: ["tool-output"], dateFrom: 30, dateTo: 30 })).hits,
      ).toHaveLength(2)
      const facets = yield* search.facets()
      expect(facets.models).toEqual([{ providerID: "old-provider", modelID: "old-model", lastUsed: 3 }])
      expect(facets.tools.map((item) => item.value)).toEqual(["read"])
      expect((yield* search.status()).ready).toBe(false)
    }),
  ))

test("normalized representation wins; edits, deletes, staged revert and rollback are transaction-consistent", () =>
  run(
    Effect.gen(function* () {
      const db = yield* seed
      const search = yield* TranscriptSearch.make
      yield* message(db, "msg_user", 1, "user", { text: "start needle" })
      yield* message(db, "msg_assistant", 2, "assistant", assistant([text("inline-needle")]))
      yield* db.run(sql`INSERT INTO session_part(message_id,session_id,ordinal,type,data,time_created,time_updated)
    VALUES('msg_assistant','ses_search',0,'text',${JSON.stringify(text("normalized-needle"))},10,10)`)
      expect((yield* search.search({ query: "inline-needle" })).hits).toEqual([])
      expect((yield* search.search({ query: "normalized-needle" })).hits).toHaveLength(1)
      yield* db.run(sql`UPDATE session_part SET data = ${JSON.stringify(text("edited-needle"))}`)
      expect((yield* search.search({ query: "normalized-needle" })).hits).toEqual([])
      yield* db
        .transaction(() =>
          Effect.gen(function* () {
            yield* db.run(sql`UPDATE session_part SET data = ${JSON.stringify(text("rollback-needle"))}`)
            return yield* Effect.fail("rollback")
          }),
        )
        .pipe(Effect.ignore)
      expect((yield* search.search({ query: "rollback-needle" })).hits).toEqual([])
      expect((yield* search.search({ query: "edited-needle" })).hits).toHaveLength(1)
      yield* db.run(sql`UPDATE session_v2 SET revert = '{"messageID":"msg_assistant"}'`)
      expect((yield* search.search({ query: "edited-needle" })).hits).toEqual([])
      expect((yield* search.facets()).tools).toEqual([])
      yield* db.run(sql`UPDATE session_v2 SET revert = NULL,title = 'Renamed'`)
      expect((yield* search.search({ query: "edited-needle" })).hits[0].title).toBe("Renamed")
      yield* db.run(sql`DELETE FROM session_part`)
      expect((yield* search.search({ query: "edited-needle" })).hits).toEqual([])
      expect((yield* search.search({ query: "inline-needle" })).hits).toHaveLength(1)
      yield* db.run(sql`DELETE FROM session_v2`)
      expect((yield* search.search({ query: "needle" })).hits).toEqual([])
    }),
  ))

test("native durable shells keep source ownership and classify only canonical terminal states", () =>
  run(
    Effect.gen(function* () {
      const db = yield* seed
      const search = yield* TranscriptSearch.make
      yield* message(db, "msg_context", 1, "assistant", assistant([]))
      for (const [index, status] of ["running", "exited", "timeout", "killed"].entries())
        yield* message(db, `msg_shell_${index}`, index + 2, "shell", {
          shellID: "shell_reused",
          command: "native-shell-needle command",
          status,
          exit: 0,
          output: { output: "native-shell-needle output", cursor: 25, size: 25, truncated: false },
          time: { created: 12, completed: 30 },
        })
      const hits = yield* search.search({ query: "native-shell-needle" })
      expect(hits.hits).toHaveLength(8)
      expect(new Set(hits.hits.map((hit) => hit.documentID)).size).toBe(8)
      expect(hits.hits.every((hit) => hit.partID === `${hit.messageID}:tool` && hit.agent === "retired-agent")).toBe(
        true,
      )
      for (const status of ["running", "completed", "error", "interrupted"] as const)
        expect((yield* search.search({ query: "native-shell-needle", toolStatuses: [status] })).hits).toHaveLength(2)
    }),
  ))

test("durable backfill is bounded, read-only search never advances, older concurrent IDs and reopen survive", async () => {
  await using tmp = await tmpdir()
  const path = `${tmp.path}/search.db`
  await run(
    Effect.gen(function* () {
      const db = yield* seed
      for (let index = 0; index < 205; index++)
        yield* message(db, `msg_${String(index).padStart(4, "0")}`, index, "user", { text: "historic needle" })
      yield* message(db, "msg_zzparts", 205, "assistant", assistant([]))
      for (let ordinal = 0; ordinal < 205; ordinal++)
        yield* db.run(sql`INSERT INTO session_part(message_id,session_id,ordinal,type,data,time_created,time_updated)
      VALUES('msg_zzparts','ses_search',${ordinal},'text',${JSON.stringify(text("normalized historic needle"))},10,10)`)
      const search = yield* TranscriptSearch.make
      expect((yield* search.search({ query: "needle" })).hits).toEqual([])
      expect((yield* search.status()).backfillCursor).toBe("message:")
      expect((yield* search.advance()).ready).toBe(false)
      expect((yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM transcript_document`))?.count).toBe(
        200,
      )
      yield* message(db, "msg_!older", 206, "user", { text: "concurrent needle" })
      expect((yield* search.search({ query: "concurrent" })).hits).toHaveLength(1)
      expect((yield* search.facets()).projects[0].path).toBe("/closed-project")
    }),
    path,
  )
  await run(
    Effect.gen(function* () {
      const search = yield* TranscriptSearch.make
      expect((yield* search.status()).backfillCursor).toBe("message:msg_0199")
      yield* search.advance()
      expect((yield* search.search({ query: "normalized" })).hits).toEqual([])
      expect((yield* search.advance()).ready).toBe(false)
      const complete = yield* search.advance()
      expect(complete.ready).toBe(true)
      expect(yield* search.advance()).toEqual(complete)
      expect((yield* search.search({ query: "concurrent" })).hits).toHaveLength(1)
      expect((yield* search.search({ query: "historic", limit: 100 })).hits).toHaveLength(100)
    }),
    path,
  )
})

test("Unicode, literal punctuation, independent SQLite character caps and UTF-16 excerpts", () =>
  run(
    Effect.gen(function* () {
      const db = yield* seed
      const search = yield* TranscriptSearch.make
      yield* message(db, "msg_a", 1, "user", { text: "😀 Kelvin a.b needle\n<script>hello</script>" })
      expect((yield* search.search({ query: "kelvin" })).hits).toHaveLength(1)
      expect((yield* search.search({ query: "kelvin", caseSensitive: true })).hits).toEqual([])
      expect((yield* search.search({ query: "a.b" })).hits).toHaveLength(1)
      const hit = (yield* search.search({ query: "needle" })).hits[0]
      expect(hit.excerpt.slice(hit.offset - hit.excerptOffset, hit.offset - hit.excerptOffset + hit.matchLength)).toBe(
        "needle",
      )
      yield* message(
        db,
        "msg_b",
        2,
        "assistant",
        assistant([
          {
            ...tool(),
            state: {
              ...tool().state,
              input: { long: "😀".repeat(65536) + "beyond-cap" },
              content: [text("short-output needle")],
            },
          },
        ]),
      )
      expect((yield* search.search({ query: "beyond-cap" })).hits).toEqual([])
      expect((yield* search.search({ query: "short-output" })).hits).toHaveLength(1)
      expect((yield* search.search({ query: "😀😀😀" })).hits[0].truncated).toBe(true)
      yield* message(db, "msg_boundary", 3, "user", { text: "😀".repeat(65533) + "ENDafter-cap" })
      const boundary = (yield* search.search({ query: "END", caseSensitive: true })).hits[0]
      expect(boundary.offset).toBe(65533 * 2)
      expect(boundary.excerpt.slice(boundary.offset - boundary.excerptOffset)).toBe("END")
      expect((yield* search.search({ query: "after-cap" })).hits).toEqual([])
    }),
  ))

test("bounded regex rejects unsafe syntax and validates input rather than empty success", () =>
  run(
    Effect.gen(function* () {
      const db = yield* seed
      const search = yield* TranscriptSearch.make
      yield* message(db, "msg_a", 1, "user", { text: "hello abc1\nabc2" })
      expect((yield* search.search({ query: "abc[12]$", mode: "regex", flags: "m" })).hits).toHaveLength(1)
      yield* message(db, "msg_control", 2, "user", { text: "\u0001control sentinel" })
      expect((yield* search.search({ query: "\\cAcontrol", mode: "regex" })).hits.map((hit) => hit.messageID)).toEqual([
        "msg_control",
      ])
      for (const request of [
        { query: "ab" },
        { query: "😀😀" },
        { query: "a".repeat(257) },
        ...["(hello)", "hello|bye", "hello+", "hello.*", "hello\\1", "[abc]", "hello["].map((query) => ({
          query,
          mode: "regex" as const,
        })),
        { query: "hello", mode: "regex" as const, flags: "ii" },
        { query: "hello", mode: "regex" as const, flags: "y" },
        { query: "\\012hello", mode: "regex" as const, flags: "" },
        { query: "hello", agents: Array.from({ length: 101 }, () => "agent") },
        { query: "hello", dateFrom: 2, dateTo: 1 },
      ])
        expect(yield* search.search(request).pipe(Effect.flip)).toBeInstanceOf(TranscriptSearch.InvalidQuery)
    }),
  ))

test("stable keyset pagination permits page-size changes, rejects changed query and completion-generation cursors", () =>
  run(
    Effect.gen(function* () {
      const db = yield* seed
      const search = yield* TranscriptSearch.make
      for (let index = 0; index < 8; index++)
        yield* message(db, `msg_${index}`, index, "user", { text: "needle abc" }, 1)
      for (const sort of ["newest", "oldest", "session-title"] as const) {
        const expected = (yield* search.search({ query: "needle", sort, limit: 100 })).hits.map((hit) => hit.documentID)
        const first = yield* search.search({ query: "needle", sort, limit: 2 })
        const second = yield* search.search({ query: "needle", sort, limit: 6, cursor: first.nextCursor })
        expect([...first.hits, ...second.hits].map((hit) => hit.documentID)).toEqual(expected)
        expect(
          yield* search.search({ query: "other", sort, cursor: first.nextCursor }).pipe(Effect.flip),
        ).toBeInstanceOf(TranscriptSearch.InvalidQuery)
        expect(
          yield* search
            .search({ query: "needle", sort, roles: ["assistant"], cursor: first.nextCursor })
            .pipe(Effect.flip),
        ).toBeInstanceOf(TranscriptSearch.InvalidQuery)
        expect(
          yield* search.search({ query: "needle", sort, cursor: first.nextCursor + "$" }).pipe(Effect.flip),
        ).toBeInstanceOf(TranscriptSearch.InvalidQuery)
      }
      const expected = (yield* search.search({ query: "needle", limit: 100 })).hits.map((hit) => hit.documentID)
      const first = yield* search.search({ query: "needle", limit: 1 })
      yield* message(db, "msg_new_before_cursor", 20, "user", { text: "new needle" }, 100)
      expect(
        (yield* search.search({ query: "needle", cursor: first.nextCursor, limit: 100 })).hits.map(
          (hit) => hit.documentID,
        ),
      ).toEqual(expected.slice(1))
      yield* search.advance()
      yield* search.advance()
      expect(yield* search.search({ query: "needle", cursor: first.nextCursor }).pipe(Effect.flip)).toBeInstanceOf(
        TranscriptSearch.InvalidQuery,
      )
    }),
  ))

test("500 nonmatching candidates yield an empty continuable page and honest truncation counts", () =>
  run(
    Effect.gen(function* () {
      const db = yield* seed
      const search = yield* TranscriptSearch.make
      for (let index = 0; index < 502; index++)
        yield* message(db, `msg_${String(index).padStart(4, "0")}`, index, "user", {
          text: index === 501 ? "needle!" : "needleX" + "x".repeat(index === 0 ? 65536 : 0),
        })
      const first = yield* search.search({ query: "needle[!]$", mode: "regex", sort: "oldest" })
      expect(first.hits).toEqual([])
      expect(first.scanned).toBe(500)
      expect(first.scanLimited).toBe(true)
      expect(first.truncatedDocuments).toBe(1)
      const next = yield* search.search({
        query: "needle[!]$",
        mode: "regex",
        sort: "oldest",
        cursor: first.nextCursor,
      })
      expect(next.hits).toHaveLength(1)
      expect(next.complete).toBe(false)
    }),
  ))

test("session title pagination uses deterministic UTF-8 order rather than locale collation", () =>
  run(
    Effect.gen(function* () {
      const db = yield* seed
      const search = yield* TranscriptSearch.make
      for (const [index, title] of ["😀", "é", "Z"].entries()) {
        const id = `ses_utf8_${index}`
        yield* db.run(sql`INSERT INTO session_v2(id,project_id,slug,directory,version,time_created,time_updated,title)
      VALUES(${id},'global',${id},'/closed-project','test',0,0,${title})`)
        yield* db.run(sql`INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data)
      VALUES(${"msg_utf8_" + index},${id},'user',0,1,1,'{"text":"needle"}')`)
      }
      const first = yield* search.search({ query: "needle", sort: "session-title", limit: 1 })
      const next = yield* search.search({ query: "needle", sort: "session-title", cursor: first.nextCursor })
      expect([...first.hits, ...next.hits].map((hit) => hit.title)).toEqual(["Z", "é", "😀"])
    }),
  ))

test("actual V1 transform import retains multipart identity, historical dates, exclusions and rebuild safety", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const imported = yield* importTranscriptFixture(database.db, "/closed-project")
      expect(imported.warnings).toEqual([])
      const search = yield* TranscriptSearch.make
      expect((yield* search.search({ query: "sentinel" })).hits).toEqual([])
      expect((yield* search.facets()).models).toContainEqual({
        providerID: "retired-provider",
        modelID: "retired-model",
        lastUsed: 1700000000060,
      })
      yield* search.advance()
      yield* search.advance()
      const result = yield* search.search({ query: "sentinel", limit: 100 })
      expect(result.complete).toBe(true)
      expect(new Set(result.hits.map((hit) => hit.category))).toEqual(
        new Set(["text", "file", "tool-input", "tool-output", "tool-error", "assistant-error"]),
      )
      expect(result.hits.find((hit) => hit.partID === transcriptIDs.second)?.timeCreated).toBe(1700000000002)
      expect(result.hits.find((hit) => hit.partID === transcriptIDs.file)?.timeCreated).toBe(1700000000001)
      expect(result.hits.find((hit) => hit.category === "assistant-error")?.timeCreated).toBe(1700000000020)
      expect(
        result.hits.find((hit) => hit.category === "tool-output" && hit.partID === transcriptIDs.call)?.timeCreated,
      ).toBe(1700000000015)
      expect((yield* search.search({ query: "preferred durable" })).hits.map((hit) => hit.messageID)).toEqual([
        transcriptIDs.durable,
      ])
      expect(
        (yield* search.search({ query: "durable-shell", categories: ["tool-output"] })).hits.map(
          (hit) => hit.messageID,
        ),
      ).toEqual([transcriptIDs.shell])
      expect((yield* search.search({ query: "excluded" })).hits).toEqual([])
      const interrupted = yield* search.search({ query: "sentinel", toolStatuses: ["interrupted"] })
      expect(interrupted.hits.every((hit) => hit.partID === "call_import_interrupted")).toBe(true)
      expect(interrupted.hits.length).toBeGreaterThan(0)
      const rows = yield* database.db.select().from(SessionMessageTable)
      const messages = yield* SessionHistory.decodeMessageRows(database.db, rows)
      const user = messages.find((item) => item.id === transcriptIDs.user)
      expect(user?.type).toBe("user")
      if (user?.type !== "user") throw new Error("Missing imported user")
      expect(user.experimental?.textParts?.map((part) => part.id)).toEqual([transcriptIDs.first, transcriptIDs.second])
      expect(user.experimental?.textParts?.map((part) => part.text).join("")).toBe(
        " first @notes.txt\n\tsecond sentinel @retired-agent ",
      )
      const cursor = (yield* search.search({ query: "sentinel", limit: 1 })).nextCursor
      expect((yield* search.advance({ rebuild: true })).ready).toBe(false)
      expect(yield* search.search({ query: "sentinel", cursor }).pipe(Effect.flip)).toBeInstanceOf(
        TranscriptSearch.InvalidQuery,
      )
      yield* search.advance()
      expect((yield* search.search({ query: "sentinel", limit: 100 })).hits.map((hit) => hit.documentID)).toEqual(
        result.hits.map((hit) => hit.documentID),
      )
    }),
  ))

test.each([
  { label: "numeric one", metadata: { interrupted: 1 }, interrupted: true },
  { label: "boolean true", metadata: { interrupted: true }, interrupted: true },
  { label: "explicit status", metadata: { status: "interrupted" }, interrupted: true },
  { label: "session outcome only", metadata: {}, interrupted: false },
  { label: "numeric zero", metadata: { interrupted: 0 }, interrupted: false },
  { label: "other number", metadata: { interrupted: 2 }, interrupted: false },
  { label: "string one", metadata: { interrupted: "1" }, interrupted: false },
])("import interruption markers preserve explicit V1 classification: $label", (fixture) =>
  run(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* importTranscriptFixture(database.db, "/imported-project", 0, fixture.metadata)
      yield* database.db.run(sql`UPDATE session_v2 SET idle_outcome='interrupted' WHERE id=${transcriptIDs.session}`)
      const search = yield* TranscriptSearch.make
      yield* search.advance()
      yield* search.advance()
      expect(
        (yield* search.search({ query: "sentinel", toolStatuses: ["interrupted"] })).hits.map((hit) => hit.partID),
      ).toEqual(fixture.interrupted ? ["call_import_interrupted", "call_import_interrupted"] : [])
      expect(
        (yield* search.search({ query: "public-error-sentinel", toolStatuses: ["error"] })).hits.map(
          (hit) => hit.partID,
        ),
      ).toEqual(["call_import_error"])
      expect((yield* search.search({ query: "public-error-sentinel", toolStatuses: ["interrupted"] })).hits).toEqual([])
    }),
  ),
)

test("live tool completion, hidden/unhidden sources, root/archive filters and turn error supersession", () =>
  run(
    Effect.gen(function* () {
      const db = yield* seed
      const search = yield* TranscriptSearch.make
      yield* message(db, "msg_user", 0, "user", { text: "needle" })
      yield* message(
        db,
        "msg_error",
        1,
        "assistant",
        assistant([], { error: { type: "failure", message: "old needle" } }),
      )
      yield* message(db, "msg_steer", 2, "user", { text: "steer needle" })
      yield* message(
        db,
        "msg_tool",
        3,
        "assistant",
        assistant([{ ...tool("running"), state: { status: "running", input: { path: "needle" } } }]),
      )
      expect((yield* search.search({ query: "needle", categories: ["assistant-error"] })).hits).toEqual([])
      expect((yield* search.search({ query: "needle", toolStatuses: ["running"] })).hits).toHaveLength(1)
      yield* db.run(sql`UPDATE session_message SET data=${JSON.stringify(assistant([tool()]))} WHERE id='msg_tool'`)
      expect((yield* search.search({ query: "needle", toolStatuses: ["running"] })).hits).toEqual([])
      expect((yield* search.search({ query: "needle", toolStatuses: ["completed"] })).hits.length).toBeGreaterThan(0)
      yield* db.run(
        sql`UPDATE session_message SET data=json_set(data,'$.metadata.queueImportHidden',1) WHERE id='msg_tool'`,
      )
      expect((yield* search.search({ query: "needle", toolStatuses: ["completed"] })).hits).toEqual([])
      expect((yield* search.facets()).tools).toEqual([])
      yield* db.run(
        sql`UPDATE session_message SET data=json_remove(data,'$.metadata.queueImportHidden') WHERE id='msg_tool'`,
      )
      expect((yield* search.facets()).tools.map((item) => item.value)).toEqual(["read"])
      yield* db.run(sql`UPDATE session_v2 SET parent_id='ses_parent',time_archived=100`)
      expect((yield* search.search({ query: "needle", sessionKind: "root" })).hits).toEqual([])
      expect((yield* search.search({ query: "needle", archived: "active" })).hits).toEqual([])
      expect(
        (yield* search.search({ query: "needle", archived: "archived", sessionKind: "subagent" })).hits.length,
      ).toBeGreaterThan(0)
    }),
  ))
