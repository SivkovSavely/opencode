export * as TranscriptSearch from "./transcript-search.js"

import { Context, Effect, Layer, Schema } from "effect"
import { sql, type SQL } from "drizzle-orm"
import { createHash, randomUUID } from "node:crypto"
import { TranscriptSearch } from "@opencode/schema/transcript-search"
import { Database } from "../database/database.js"

export class InvalidQuery extends Schema.TaggedError<InvalidQuery>()("TranscriptSearch.InvalidQuery", {
  message: Schema.String,
}) {}

// Source identities are separate from navigation identities. In particular tool call IDs
// are only unique inside their owning message, and text parts keep their content ordinal.
const projection = `WITH parts AS (
  SELECT m.id AS message_id, 'm:' || m.id AS source, m.id || ':text:0' AS part_id,
    json_object('type','text','text',json_extract(m.data,'$.text')) AS data, m.time_created
    FROM session_message m WHERE m.type = 'user' AND json_type(m.data,'$.experimental.textParts') IS NULL
  UNION ALL SELECT m.id, 'm:' || m.id, json_extract(t.value,'$.id'),
    json_object('type','text','text',json_extract(t.value,'$.text')), coalesce(json_extract(t.value,'$.timeCreated'),m.time_created)
    FROM session_message m, json_each(m.data,'$.experimental.textParts') t WHERE m.type = 'user'
  UNION ALL SELECT m.id, 'm:' || m.id, coalesce(json_extract(m.data,'$.experimental.filePartIDs[' || f.key || ']'),m.id || ':file:' || f.key),
    json_object('type','file','name',json_extract(f.value,'$.name')), m.time_created
    FROM session_message m, json_each(m.data,'$.files') f WHERE m.type = 'user' AND json_type(m.data,'$.experimental.fileParts') IS NULL
   UNION ALL SELECT m.id,'m:' || m.id,json_extract(f.value,'$.id'),json_object('type','file','name',json_extract(f.value,'$.name')),coalesce(json_extract(f.value,'$.timeCreated'),m.time_created)
    FROM session_message m,json_each(m.data,'$.experimental.fileParts') f WHERE m.type = 'user'
  UNION ALL SELECT m.id, 'm:' || m.id,
    CASE json_extract(c.value,'$.type') WHEN 'tool' THEN json_extract(c.value,'$.id')
      ELSE m.id || ':text:' || (SELECT count(*) FROM json_each(m.data,'$.content') x
        WHERE x.key < c.key AND json_extract(x.value,'$.type') = 'text') END, c.value,
      coalesce(json_extract(c.value,'$.experimental.timeCreated'),m.time_created)
    FROM session_message m, json_each(m.data,'$.content') c WHERE m.type = 'assistant'
      AND NOT EXISTS (SELECT 1 FROM session_part p WHERE p.message_id = m.id)
  UNION ALL SELECT p.message_id, 'p:' || p.message_id || ':' || p.ordinal,
    CASE p.type WHEN 'tool' THEN json_extract(p.data,'$.id') ELSE p.message_id || ':text:' ||
      (SELECT count(*) FROM session_part x WHERE x.message_id = p.message_id AND x.type = 'text' AND x.ordinal < p.ordinal) END,
    json_set(p.data,'$.type',p.type), p.time_created FROM session_part p
  UNION ALL SELECT m.id, 'm:' || m.id, m.id || ':tool', json_object('type','tool','name','bash',
    'time',json_extract(m.data,'$.time'),'state',json_object('input',json_object('command',json_extract(m.data,'$.command')),
     'status',CASE WHEN json_extract(m.data,'$.status') = 'running' THEN 'running'
       WHEN json_extract(m.data,'$.status') = 'killed' THEN 'interrupted'
       WHEN json_extract(m.data,'$.status') IN ('timeout','error') OR coalesce(json_extract(m.data,'$.exit'),0) <> 0 THEN 'error' ELSE 'completed' END,
     'content',json_array(json_object('type','text','text',CASE json_type(m.data,'$.output') WHEN 'text' THEN json_extract(m.data,'$.output') ELSE json_extract(m.data,'$.output.output') END)))),
    m.time_created FROM session_message m WHERE m.type = 'shell'
), categories AS (
  SELECT p.*, c.value AS category FROM parts p,
    json_each(CASE json_extract(p.data,'$.type') WHEN 'text' THEN '["text"]' WHEN 'file' THEN '["file"]'
      WHEN 'tool' THEN '["tool-input","tool-output","tool-error","file"]' ELSE '[]' END) c
    WHERE coalesce(json_extract(p.data,'$.synthetic'),0) = 0 AND coalesce(json_extract(p.data,'$.ignored'),0) = 0
      AND coalesce(json_extract(p.data,'$.experimental.searchable'),1) = 1
      AND coalesce(json_extract(p.data,'$.name'),'') NOT IN ('todowrite','todo.write')
      AND NOT (coalesce(json_extract(p.data,'$.name'),'') IN ('question','question.ask')
        AND json_extract(p.data,'$.state.status') IN ('pending','streaming','running'))
), bodies AS (
  SELECT message_id, source, part_id, category,
    CASE WHEN category IN ('tool-output','tool-error') THEN coalesce(json_extract(data,'$.time.completed'),time_created)
      ELSE coalesce(json_extract(data,'$.time.created'),time_created) END AS time_created,
    CASE category WHEN 'text' THEN json_extract(data,'$.text')
      WHEN 'file' THEN CASE json_extract(data,'$.type') WHEN 'file' THEN json_extract(data,'$.name') ELSE
        (SELECT group_concat(json_extract(f.value,'$.name'),char(10)) FROM json_each(data,'$.state.content') f
          WHERE json_extract(f.value,'$.type') = 'file') END
      WHEN 'tool-input' THEN coalesce(CASE json_type(data,'$.state.input') WHEN 'text' THEN json_extract(data,'$.state.input') ELSE
        (SELECT group_concat(j.fullkey || ': ' || j.value,char(10)) FROM json_tree(data,'$.state.input') j
          WHERE j.type NOT IN ('object','array','null')) END,'') || char(10) || coalesce(json_extract(data,'$.experimental.rawInput'),'')
      WHEN 'tool-output' THEN (SELECT group_concat(json_extract(o.value,'$.text'),char(10))
        FROM json_each(data,'$.state.content') o WHERE json_extract(o.value,'$.type') = 'text')
      WHEN 'tool-error' THEN json_extract(data,'$.state.error.message') END AS body,
    CASE WHEN json_extract(data,'$.type') = 'tool' THEN json_extract(data,'$.name') END AS tool_name,
    CASE WHEN json_extract(data,'$.type') = 'tool' THEN CASE
      WHEN json_extract(data,'$.state.error.type') IN ('aborted','tool.interrupted') THEN 'interrupted'
      WHEN json_extract(data,'$.state.status') IN ('pending','streaming','running') THEN 'running'
      ELSE json_extract(data,'$.state.status') END END AS tool_status FROM categories
  UNION ALL SELECT id, 'm:' || id, NULL, 'assistant-error',
    coalesce(json_extract(data,'$.time.completed'),time_created), json_extract(data,'$.error.message'), NULL, NULL
    FROM session_message WHERE type = 'assistant'
)
SELECT message_id || ':' || coalesce(part_id,'error') || ':' || category AS id,
  message_id, source, part_id, category, time_created, substr(body,1,65536) AS body,
  length(body) > 65536 AS truncated, tool_name, tool_status FROM bodies WHERE coalesce(body,'') <> ''`

const columns = sql.raw("id,message_id,source,part_id,category,time_created,body,truncated,tool_name,tool_status")
const context = (field: "agent" | "model.id" | "model.providerID") =>
  sql.raw(`CASE WHEN m.type = 'assistant'
  THEN json_extract(m.data,'$.${field}') ELSE coalesce(
    (SELECT json_extract(a.data,'$.${field}') FROM session_message a WHERE a.session_id = m.session_id
      AND a.type = 'assistant' AND a.seq > m.seq AND a.seq < coalesce((SELECT min(b.seq) FROM session_message b
        WHERE b.session_id = m.session_id AND b.seq > m.seq AND b.type IN ('user','shell','idle')),9223372036854775807)
      ORDER BY a.seq DESC LIMIT 1),
    (SELECT json_extract(a.data,'$.${field}') FROM session_message a WHERE a.session_id = m.session_id AND a.seq < m.seq
      AND a.type IN ('assistant','${field === "agent" ? "agent-switched" : "model-switched"}') ORDER BY a.seq DESC LIMIT 1)) END`)

const visible = sql`m.type IN ('user','assistant','shell') AND m.seq < coalesce(
  (SELECT r.seq FROM session_message r WHERE r.id = json_extract(s.revert,'$.messageID') AND r.session_id = s.id),
  9223372036854775807) AND coalesce(json_extract(m.data,'$.metadata.hidden'),0) = 0
  AND coalesce(json_extract(m.data,'$.metadata.queueImportHidden'),0) = 0`
const metadata = sql`WITH metadata AS (
  SELECT m.id, m.session_id, m.seq, m.time_created, m.type, m.data,
    CASE m.type WHEN 'user' THEN 'user' ELSE 'assistant' END AS role,
    ${context("agent")} AS agent, ${context("model.id")} AS modelID, ${context("model.providerID")} AS providerID
  FROM session_message m
)`

export const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const db = database.db
  // Install tracking atomically before any backfill. Source writes and FTS updates
  // use SQLite triggers, including writes outside the event projector and rollbacks.
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.run(sql.raw(`CREATE VIEW IF NOT EXISTS transcript_source AS ${projection}`))
        yield* tx.run(
          sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(body,content='transcript_document',content_rowid='rowid',tokenize='trigram')`,
        )
        yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_fts_insert AFTER INSERT ON transcript_document BEGIN
      INSERT INTO transcript_fts(rowid,body) VALUES(new.rowid,new.body); END`)
        yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_fts_delete AFTER DELETE ON transcript_document BEGIN
      INSERT INTO transcript_fts(transcript_fts,rowid,body) VALUES('delete',old.rowid,old.body); END`)
        yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_fts_update AFTER UPDATE ON transcript_document BEGIN
      INSERT INTO transcript_fts(transcript_fts,rowid,body) VALUES('delete',old.rowid,old.body);
      INSERT INTO transcript_fts(rowid,body) VALUES(new.rowid,new.body); END`)
        for (const table of ["session_message", "session_part"]) {
          for (const event of ["INSERT", "UPDATE", "DELETE"]) {
            const reference = event === "DELETE" ? "old" : "new"
            const id = `${reference}.${table === "session_message" ? "id" : "message_id"}`
            yield* tx.run(
              sql.raw(`CREATE TRIGGER IF NOT EXISTS transcript_${table}_${event.toLowerCase()}
          AFTER ${event} ON ${table} BEGIN
          DELETE FROM transcript_document WHERE message_id = ${id};
          INSERT INTO transcript_document SELECT * FROM transcript_source WHERE message_id = ${id}; END`),
            )
          }
        }
        yield* tx.run(
          sql`INSERT OR IGNORE INTO transcript_state(id,cursor,phase,ready,generation) VALUES(1,'','message',0,${randomUUID()})`,
        )
      }),
    )
    .pipe(Effect.orDie)

  const status = Effect.fn("TranscriptSearch.status")(function* () {
    const row = yield* db
      .get<{
        ready: number
        cursor: string
        phase: string
        generation: string
      }>(sql`SELECT * FROM transcript_state WHERE id = 1`)
      .pipe(Effect.orDie)
    return { ready: Boolean(row!.ready), backfillCursor: `${row!.phase}:${row!.cursor}`, generation: row!.generation }
  })
  const advance = Effect.fn("TranscriptSearch.advance")(function* (options?: { rebuild?: boolean }) {
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          if (options?.rebuild) {
            yield* tx.run(sql`DELETE FROM transcript_document`)
            yield* tx.run(
              sql`UPDATE transcript_state SET cursor = '',phase = 'message',ready = 0,generation = ${randomUUID()} WHERE id = 1`,
            )
          }
          const state = yield* tx.get<{ ready: number; cursor: string; phase: string }>(
            sql`SELECT * FROM transcript_state WHERE id = 1`,
          )
          if (state!.ready) return
          const rows =
            state!.phase === "message"
              ? yield* tx.all<{ key: string }>(
                  sql`SELECT id AS key FROM session_message WHERE id > ${state!.cursor} ORDER BY id LIMIT 200`,
                )
              : yield* tx.all<{
                  key: string
                }>(sql`SELECT message_id || ':' || printf('%012d',ordinal) AS key FROM session_part
            WHERE message_id || ':' || printf('%012d',ordinal) > ${state!.cursor} ORDER BY key LIMIT 200`)
          for (const row of rows) {
            const source = state!.phase === "message" ? `m:${row.key}` : `p:${row.key.replace(/:0*(\d+)$/, ":$1")}`
            yield* tx.run(sql`DELETE FROM transcript_document WHERE source = ${source}`)
            yield* tx.run(
              sql`INSERT OR REPLACE INTO transcript_document(${columns}) SELECT ${columns} FROM transcript_source WHERE source = ${source}`,
            )
          }
          const done = rows.length < 200
          yield* tx.run(sql`UPDATE transcript_state SET cursor = ${done ? "" : rows.at(-1)!.key},
        phase = ${done && state!.phase === "message" ? "part" : state!.phase},
        ready = ${Number(done && state!.phase === "part")},
        generation = CASE WHEN ${Number(done && state!.phase === "part")} THEN ${randomUUID()} ELSE generation END WHERE id = 1`)
        }),
      )
      .pipe(Effect.orDie)
    return yield* status()
  })

  const search = Effect.fn("TranscriptSearch.search")(function* (request: TranscriptSearch.Request) {
    const input = yield* Schema.decodeUnknownEffect(TranscriptSearch.Request)(request).pipe(
      Effect.mapError(() => new InvalidQuery({ message: "Invalid search request" })),
    )
    if (input.dateFrom !== undefined && input.dateTo !== undefined && input.dateFrom > input.dateTo)
      return yield* new InvalidQuery({ message: "dateFrom must not exceed dateTo" })
    const expression = yield* Effect.try({
      try: () => compile(input),
      catch: (error) => new InvalidQuery({ message: error instanceof Error ? error.message : "Invalid query" }),
    })
    const indexStatus = yield* status()
    const signature = createHash("sha256")
      .update(
        JSON.stringify([
          indexStatus.generation,
          Object.entries(input)
            .filter(([key]) => key !== "cursor" && key !== "limit")
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        ]),
      )
      .digest("hex")
    const sort = input.sort ?? "newest"
    const Cursor = Schema.Tuple([
      Schema.String,
      sort === "session-title" ? Schema.String : Schema.Finite,
      Schema.String,
      Schema.String,
    ])
    const cursor =
      input.cursor === undefined
        ? undefined
        : yield* Effect.try({
            try: () => {
              if (!/^[A-Za-z0-9_-]+$/.test(input.cursor!)) throw new Error()
              if (Buffer.from(input.cursor!, "base64url").toString("base64url") !== input.cursor) throw new Error()
              const value = Schema.decodeUnknownSync(Schema.fromJsonString(Cursor))(
                Buffer.from(input.cursor!, "base64url").toString(),
              )
              if (value[0] !== signature) throw new Error()
              return value
            },
            catch: () => new InvalidQuery({ message: "Invalid cursor or changed search parameters" }),
          })
    const key = sort === "session-title" ? sql`coalesce(s.title,'') COLLATE BINARY` : sql`d.time_created`
    const direction = sql.raw(sort === "newest" ? "DESC" : "ASC")
    const filters: SQL[] = [visible]
    // SQLite's trigram tokenizer and lower() do not implement ECMAScript Unicode
    // folding. Non-ASCII bodies/queries take a correctness-first candidate fallback.
    if (/^[\x20-\x7e]+$/.test(expression.candidate))
      filters.push(sql`(d.rowid IN
      (SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH ${'"' + expression.candidate.replaceAll('"', '""') + '"'})
      OR d.body GLOB '*[^ -~]*')`)
    for (const [column, list] of [
      [sql`s.project_id`, input.projectIDs],
      [sql`s.id`, input.sessionIDs],
      [sql`m.role`, input.roles],
      [sql`d.category`, input.categories],
      [sql`m.agent`, input.agents],
      [sql`m.providerID`, input.providerIDs],
      [sql`d.tool_name`, input.toolNames],
      [sql`d.tool_status`, input.toolStatuses],
    ] as const)
      if (list?.length)
        filters.push(
          sql`${column} IN (${sql.join(
            list.map((value) => sql`${value}`),
            sql`,`,
          )})`,
        )
    if (input.models?.length)
      filters.push(
        sql`(${sql.join(
          input.models.map((value) => sql`(m.providerID = ${value.providerID} AND m.modelID = ${value.modelID})`),
          sql` OR `,
        )})`,
      )
    if (input.content?.length)
      filters.push(
        sql`(${sql.join(
          input.content.map((value) => sql`(m.role = ${value.role} AND d.category = ${value.category})`),
          sql` OR `,
        )})`,
      )
    if (input.dateFrom !== undefined) filters.push(sql`d.time_created >= ${input.dateFrom}`)
    if (input.dateTo !== undefined) filters.push(sql`d.time_created <= ${input.dateTo}`)
    if (input.sessionKind === "root") filters.push(sql`s.parent_id IS NULL`)
    if (input.sessionKind === "subagent") filters.push(sql`s.parent_id IS NOT NULL`)
    if (input.archived === "active") filters.push(sql`s.time_archived IS NULL`)
    if (input.archived === "archived") filters.push(sql`s.time_archived IS NOT NULL`)
    filters.push(sql`(d.category <> 'assistant-error' OR NOT EXISTS (SELECT 1 FROM session_message a
      WHERE a.session_id = m.session_id AND a.type = 'assistant' AND a.seq > m.seq
        AND (CASE WHEN json_type(m.data,'$.experimental.parentMessageID') IS NOT NULL
          THEN json_extract(a.data,'$.experimental.parentMessageID') = json_extract(m.data,'$.experimental.parentMessageID')
          ELSE a.seq < coalesce((SELECT min(b.seq) FROM session_message b WHERE b.session_id = m.session_id
          AND b.seq > m.seq AND b.type = 'idle'),9223372036854775807) END)
        AND a.seq < coalesce((SELECT r.seq FROM session_message r WHERE r.id = json_extract(s.revert,'$.messageID')),9223372036854775807)))`)
    if (cursor)
      filters.push(
        sort === "newest"
          ? sql`(${key},m.id,d.id) < (${cursor[1]},${cursor[2]},${cursor[3]})`
          : sql`(${key},m.id,d.id) > (${cursor[1]},${cursor[2]},${cursor[3]})`,
      )
    type Row = Omit<
      TranscriptSearch.Hit,
      "excerpt" | "excerptOffset" | "offset" | "matchLength" | "truncated" | "archived"
    > & { body: string; truncated: number; archived: number; sortKey: string | number }
    const rows = yield* db
      .all<Row>(
        sql`${metadata}
      SELECT d.id AS documentID, m.id AS messageID, d.part_id AS partID, s.id AS sessionID,
        s.project_id AS projectID, p.worktree AS projectPath, s.directory, coalesce(s.title,'') AS title,
        m.role, d.category, m.agent, m.providerID, m.modelID, d.tool_name AS toolName, d.tool_status AS toolStatus,
        s.parent_id AS parentID, s.time_archived IS NOT NULL AS archived, d.time_created AS timeCreated,
        d.body,d.truncated,${key} AS sortKey FROM transcript_document d JOIN metadata m ON m.id = d.message_id
        JOIN session_v2 s ON s.id = m.session_id JOIN project p ON p.id = s.project_id
        WHERE ${sql.join(filters, sql` AND `)} ORDER BY ${key} ${direction},m.id ${direction},d.id ${direction} LIMIT 501`,
      )
      .pipe(Effect.orDie)
    const hits: TranscriptSearch.Hit[] = []
    let scanned = 0
    let next: string | undefined
    let truncatedDocuments = 0
    for (const row of rows.slice(0, 500)) {
      scanned++
      if (row.truncated) truncatedDocuments++
      next = Buffer.from(JSON.stringify([signature, row.sortKey, row.messageID, row.documentID])).toString("base64url")
      const match = expression.pattern.exec(row.body)
      if (!match) continue
      const { body, sortKey: _, truncated, archived, ...hit } = row
      hits.push({
        ...hit,
        partID: hit.partID ?? undefined,
        agent: hit.agent ?? undefined,
        providerID: hit.providerID ?? undefined,
        modelID: hit.modelID ?? undefined,
        toolName: hit.toolName ?? undefined,
        toolStatus: hit.toolStatus ?? undefined,
        parentID: hit.parentID ?? undefined,
        archived: Boolean(archived),
        truncated: Boolean(truncated),
        offset: match.index,
        matchLength: match[0].length,
        excerptOffset: Math.max(0, match.index - 80),
        excerpt: body.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80),
      })
      if (hits.length >= (input.limit ?? 50)) break
    }
    const nextCursor = scanned < rows.length ? next : undefined
    return {
      hits,
      nextCursor,
      scanned,
      truncatedDocuments,
      status: indexStatus,
      complete: indexStatus.ready && !nextCursor,
      scanLimit: 500,
      contentLimit: 65536,
      scanLimited: scanned === 500 && Boolean(nextCursor),
    }
  })

  const facets = Effect.fn("TranscriptSearch.facets")(function* () {
    const rows = yield* db
      .all<{
        projectID: string
        path: string
        agent: string | null
        providerID: string | null
        modelID: string | null
        time: number
        id: string
      }>(
        sql`${metadata}
      SELECT m.id,s.project_id AS projectID,p.worktree AS path,m.agent,m.providerID,m.modelID,m.time_created AS time
      FROM metadata m JOIN session_v2 s ON s.id = m.session_id JOIN project p ON p.id = s.project_id WHERE ${visible}`,
      )
      .pipe(Effect.orDie)
    const tools = yield* db
      .all<{ value: string; lastUsed: number }>(
        sql`${metadata}
      SELECT d.tool_name AS value,max(d.time_created) AS lastUsed FROM transcript_source d JOIN metadata m ON m.id = d.message_id
      JOIN session_v2 s ON s.id = m.session_id WHERE ${visible} AND d.tool_name IS NOT NULL GROUP BY d.tool_name ORDER BY value COLLATE BINARY`,
      )
      .pipe(Effect.orDie)
    const distinct = <T>(items: T[], identity: (item: T) => string, time: (item: T) => number) => [
      ...items
        .reduce((map, item) => {
          const key = identity(item)
          if (!map.has(key) || time(map.get(key)!) < time(item)) map.set(key, item)
          return map
        }, new Map<string, T>())
        .values(),
    ]
    return {
      projects: distinct(
        rows.map((row) => ({ id: row.projectID, path: row.path, lastUsed: row.time })),
        (row) => row.id,
        (row) => row.lastUsed,
      ),
      agents: distinct(
        rows.flatMap((row) => (row.agent ? [{ value: row.agent, lastUsed: row.time }] : [])),
        (row) => row.value,
        (row) => row.lastUsed,
      ),
      providers: distinct(
        rows.flatMap((row) => (row.providerID ? [{ value: row.providerID, lastUsed: row.time }] : [])),
        (row) => row.value,
        (row) => row.lastUsed,
      ),
      models: distinct(
        rows.flatMap((row) =>
          row.providerID && row.modelID
            ? [{ providerID: row.providerID, modelID: row.modelID, lastUsed: row.time }]
            : [],
        ),
        (row) => JSON.stringify([row.providerID, row.modelID]),
        (row) => row.lastUsed,
      ),
      tools,
      truncated: false,
    }
  })
  return { search, status, advance, facets }
})

// Parse the bounded grammar without executing unrestricted user expressions. Escape
// sequences not understood as literals split candidate runs, never invent candidates.
function compile(input: TranscriptSearch.Request) {
  if (input.mode !== "regex") {
    if (Array.from(input.query.trim()).length < 3)
      throw new Error("Literal searches require at least three Unicode characters")
    return {
      candidate: input.query,
      pattern: new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), input.caseSensitive ? "u" : "iu"),
    }
  }
  const flags = input.flags ?? "iu"
  if (/[^gimsu]/.test(flags) || new Set(flags).size !== flags.length)
    throw new Error("Supported regex flags: g, i, m, s, u")
  const runs: string[] = []
  let run = ""
  const flush = () => {
    if (Array.from(run).length >= 3) runs.push(run)
    run = ""
  }
  let inClass = false
  for (let index = 0; index < input.query.length; index++) {
    const char = input.query[index]!
    if (char === "\\") {
      const escaped = input.query[++index]
      if (!escaped || /[1-9kpP]/.test(escaped)) throw new Error("Unsupported regex escape")
      if (escaped === "0" && /\d/.test(input.query[index + 1] ?? "")) throw new Error("Octal escapes are not supported")
      if (inClass) continue
      if (escaped === "c") {
        const letter = input.query[++index]
        if (!letter || !/^[a-z]$/i.test(letter)) throw new Error("Invalid control escape")
        run += String.fromCharCode(letter.toUpperCase().charCodeAt(0) % 32)
        continue
      }
      const count = escaped === "x" ? 2 : escaped === "u" ? 4 : 0
      if (count && new RegExp(`^[\\da-f]{${count}}$`, "i").test(input.query.slice(index + 1, index + 1 + count))) {
        run += String.fromCharCode(parseInt(input.query.slice(index + 1, index + 1 + count), 16))
        index += count
        continue
      }
      const control: Record<string, string> = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v" }
      if (control[escaped]) {
        run += control[escaped]
        continue
      }
      if (/[\\/.^$*+?()[\]{}|]/.test(escaped)) {
        run += escaped
        continue
      }
      flush()
      continue
    }
    if (inClass) {
      if (char === "]") inClass = false
      continue
    }
    if (char === "[") {
      flush()
      inClass = true
      continue
    }
    if (/[()*+?{}|]/.test(char))
      throw new Error("Groups, alternation, quantifiers and backreferences are not supported")
    if (/[.^$]/.test(char)) {
      flush()
      continue
    }
    run += char
  }
  flush()
  const candidate = runs.sort((a, b) => Array.from(b).length - Array.from(a).length)[0]
  if (!candidate) throw new Error("Regex requires a literal run of at least three Unicode characters")
  return { candidate, pattern: new RegExp(input.query, flags.replaceAll("g", "")) }
}

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/TranscriptSearch") {}
export const layer = Layer.effect(Service, make)
