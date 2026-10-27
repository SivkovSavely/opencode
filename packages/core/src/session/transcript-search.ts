export * as TranscriptSearch from "./transcript-search"

import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Database } from "../database/database"

const bounded = Schema.String.check(Schema.isMaxLength(256))
const values = Schema.Array(bounded).check(Schema.isMaxLength(100))
export const Category = Schema.Literals(["text", "file", "tool-input", "tool-output", "tool-error", "assistant-error"])
export const Request = Schema.Struct({
  query: bounded.check(Schema.isMinLength(1)),
  mode: Schema.optional(Schema.Literals(["literal", "regex"])),
  caseSensitive: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  projectID: Schema.optional(bounded),
  sessionID: Schema.optional(bounded),
  role: Schema.optional(Schema.Literals(["user", "assistant"])),
  agent: Schema.optional(bounded),
  providerID: Schema.optional(bounded),
  modelID: Schema.optional(bounded),
  projectIDs: Schema.optional(values),
  agents: Schema.optional(values),
  providerIDs: Schema.optional(values),
  modelIDs: Schema.optional(values),
  models: Schema.optional(
    Schema.Array(Schema.Struct({ providerID: bounded, modelID: bounded })).check(Schema.isMaxLength(100)),
  ),
  roles: Schema.optional(Schema.Array(Schema.Literals(["user", "assistant"])).check(Schema.isMaxLength(100))),
  categories: Schema.optional(Schema.Array(Category).check(Schema.isMaxLength(100))),
  toolNames: Schema.optional(values),
  toolStatuses: Schema.optional(
    Schema.Array(Schema.Literals(["running", "completed", "error", "interrupted"])).check(Schema.isMaxLength(100)),
  ),
  dateFrom: Schema.optional(Schema.Number),
  dateTo: Schema.optional(Schema.Number),
  sessionKind: Schema.optional(Schema.Literals(["all", "root", "subagent"])),
  archived: Schema.optional(Schema.Literals(["all", "active", "archived"])),
  sort: Schema.optional(Schema.Literals(["newest", "oldest", "session-title"])),
  flags: Schema.optional(bounded),
})
export const Hit = Schema.Struct({
  partID: Schema.optional(Schema.String),
  documentID: Schema.String,
  messageID: Schema.String,
  navigationMessageID: Schema.optional(Schema.String),
  sessionID: Schema.String,
  projectID: Schema.String,
  projectPath: Schema.String,
  title: Schema.String,
  directory: Schema.String,
  role: Schema.String,
  type: Schema.String,
  category: Category,
  agent: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  toolStatus: Schema.optional(Schema.String),
  parentID: Schema.optional(Schema.String),
  archived: Schema.Boolean,
  timeCreated: Schema.Number,
  excerpt: Schema.String,
  excerptOffset: Schema.Number,
  offset: Schema.Number,
  matchLength: Schema.Number,
  truncated: Schema.Boolean,
})
export const Status = Schema.Struct({ ready: Schema.Boolean, backfillCursor: Schema.String })
export const Response = Schema.Struct({
  hits: Schema.Array(Hit),
  nextCursor: Schema.optional(Schema.String),
  scanned: Schema.Number,
  complete: Schema.Boolean,
  scanLimit: Schema.Number,
  contentLimit: Schema.Number,
  scanLimited: Schema.Boolean,
  truncatedDocuments: Schema.Number,
  status: Status,
})
export const Facets = Schema.Struct({
  projects: Schema.Array(Schema.String),
  agents: Schema.Array(Schema.String),
  providers: Schema.Array(Schema.String),
  models: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
  agentDetails: Schema.Array(Schema.Struct({ value: Schema.String, lastUsed: Schema.Number })),
  providerDetails: Schema.Array(Schema.Struct({ value: Schema.String, lastUsed: Schema.Number })),
  modelDetails: Schema.Array(Schema.Struct({ value: Schema.String, lastUsed: Schema.Number })),
  toolDetails: Schema.Array(Schema.Struct({ value: Schema.String, lastUsed: Schema.Number })),
  modelIdentities: Schema.Array(
    Schema.Struct({ providerID: Schema.String, modelID: Schema.String, lastUsed: Schema.Number }),
  ),
  projectDetails: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String, lastUsed: Schema.Number })),
  truncated: Schema.Boolean,
})
export class InvalidQuery extends Schema.TaggedErrorClass<InvalidQuery>()("TranscriptSearchInvalidQuery", {
  message: Schema.String,
}) {}

const toolInput = (
  row: string,
) => `coalesce((SELECT group_concat(substr(j.value, 1, max(0, 65536 - j.start)), char(10)) FROM (
  SELECT fullkey || ': ' || value AS value, id,
    sum(length(fullkey || ': ' || value)) OVER (ORDER BY id) - length(fullkey || ': ' || value) AS start
  FROM json_tree(${row}.data, '$.state.input') WHERE type NOT IN ('object', 'array', 'null')
) j WHERE j.start < 65536), '')`

// Attachment bytes and synthetic/ignored text are deliberately excluded from search.
const body = (row: string) =>
  sql.raw(`CASE
  WHEN json_extract(${row}.data, '$.type') = 'text'
    AND coalesce(json_extract(${row}.data, '$.ignored'), 0) = 0
    AND coalesce(json_extract(${row}.data, '$.synthetic'), 0) = 0
    THEN json_extract(${row}.data, '$.text')
  WHEN json_extract(${row}.data, '$.type') = 'tool'
    AND coalesce(json_extract(${row}.data, '$.ignored'), 0) = 0
    AND coalesce(json_extract(${row}.data, '$.synthetic'), 0) = 0
    AND coalesce(json_extract(${row}.data, '$.tool'), '') <> 'todowrite'
    AND NOT (coalesce(json_extract(${row}.data, '$.tool'), '') = 'question' AND json_extract(${row}.data, '$.state.status') IN ('pending', 'running'))
    THEN substr(coalesce(json_extract(${row}.data, '$.state.title'), ''), 1, 1024) || char(10) ||
      ${toolInput(row)} || char(10) ||
      substr(coalesce(json_extract(${row}.data, '$.state.raw'), ''), 1, 65536) || char(10) ||
      substr(coalesce(json_extract(${row}.data, '$.state.output'), ''), 1, 65536) || char(10) ||
      substr(coalesce(json_extract(${row}.data, '$.state.error'), ''), 1, 65536) || char(10) ||
       substr(coalesce(json_extract(${row}.data, '$.searchFilenames'), '') || char(10) || coalesce((
         SELECT group_concat(coalesce(json_extract(f.value, '$.filename'), json_extract(f.value, '$.name')), char(10))
         FROM json_each(${row}.data, '$.state.attachments') f
       ), ''), 1, 65536)
  WHEN json_extract(${row}.data, '$.type') = 'file' THEN json_extract(${row}.data, '$.filename')
  ELSE '' END`)

const visible = sql`json_extract(m.data, '$.role') IN ('user', 'assistant')
  AND NOT EXISTS (
    SELECT 1 FROM session_queue_import q, json_each(q.hidden) h
    WHERE q.session_id = m.session_id AND h.value = m.id
  )`

const provider = sql`coalesce(json_extract(m.data, '$.providerID'), json_extract(m.data, '$.model.providerID'))`
const model = sql`coalesce(json_extract(m.data, '$.modelID'), json_extract(m.data, '$.model.modelID'))`
const durableContext = (row: string, field: "agent" | "modelID" | "providerID") => {
  const path = field === "agent" ? "$.agent" : field === "modelID" ? "$.model.id" : "$.model.providerID"
  const switchType = field === "agent" ? "agent-switched" : "model-switched"
  const previous = `(SELECT json_extract(previous.data, '${path}') FROM session_message previous
    WHERE previous.session_id = ${row}.session_id AND previous.seq < ${row}.seq
      AND previous.type IN ('assistant', '${switchType}') ORDER BY previous.seq DESC LIMIT 1)`
  const nextAssistant = `(SELECT json_extract(next.data, '${path}') FROM session_message next
    WHERE next.session_id = ${row}.session_id AND next.type = 'assistant' AND next.seq > ${row}.seq
      AND next.seq < coalesce((SELECT min(boundary.seq) FROM session_message boundary
        WHERE boundary.session_id = ${row}.session_id AND boundary.seq > ${row}.seq
          AND (boundary.type IN ('user', 'shell') OR (boundary.type = 'synthetic' AND trim(json_extract(boundary.data, '$.text')) <> ''))), 9223372036854775807)
    ORDER BY next.seq DESC LIMIT 1)`
  return sql.raw(`CASE WHEN ${row}.type = 'assistant' THEN json_extract(${row}.data, '${path}')
    WHEN ${row}.type = 'user' THEN coalesce(${nextAssistant}, ${previous}) ELSE ${previous} END`)
}
// Interruption is classified only from explicit metadata, never error text.
const toolStatus = sql`CASE WHEN json_extract(p.data, '$.state.metadata.interrupted') = 1
  OR json_extract(p.data, '$.state.metadata.status') = 'interrupted' THEN 'interrupted'
  WHEN json_extract(p.data, '$.state.status') IN ('pending', 'running') THEN 'running'
  ELSE json_extract(p.data, '$.state.status') END`

// Normalize only public transcript content. Never pass the durable JSON wholesale to FTS.
const durableParts = (row: string, from = "") =>
  sql.raw(`
  SELECT ${row}.id || ':text:0' AS id, json_object('type','text','text',json_extract(${row}.data,'$.text')) AS data,
    ${row}.time_created AS time_created, ${row}.id AS message_id ${from ? `FROM ${from}` : ""} WHERE ${row}.type = 'user'
  UNION ALL SELECT ${row}.id || ':file:' || f.key, json_object('type','file','filename',json_extract(f.value,'$.name')),
    ${row}.time_created, ${row}.id FROM ${from ? `${from},` : ""} json_each(${row}.data,'$.files') f WHERE ${row}.type = 'user'
  UNION ALL SELECT CASE json_extract(c.value,'$.type') WHEN 'text' THEN ${row}.id || ':text:' ||
    (SELECT count(*) FROM json_each(${row}.data,'$.content') x WHERE x.key < c.key AND json_extract(x.value,'$.type') = 'text')
    ELSE json_extract(c.value,'$.id') END,
    CASE json_extract(c.value,'$.type') WHEN 'text' THEN json_object('type','text','text',json_extract(c.value,'$.text'))
    ELSE json_object('type','tool','tool',json_extract(c.value,'$.name'),
      'searchFilenames',(SELECT group_concat(substr(name,1,max(0,65537-start)),char(10)) FROM (
        SELECT name, coalesce(sum(length(name)+1) OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS start FROM (
          SELECT json_extract(f.value,'$.name') AS name FROM json_each(c.value,'$.state.content') f
            WHERE json_extract(f.value,'$.type') = 'file'
          UNION ALL SELECT coalesce(json_extract(f.value,'$.name'),json_extract(f.value,'$.filename'))
            FROM json_each(c.value,'$.state.attachments') f
        ) WHERE name IS NOT NULL
      ) WHERE start <= 65537),
      'state',json_object(
      'status',json_extract(c.value,'$.state.status'), 'input',json_extract(c.value,'$.state.input'),
      'output',(SELECT substr(group_concat(text,char(10)),1,65537) FROM (
        SELECT substr(json_extract(o.value,'$.text'),1,65537) AS text,
          coalesce(sum(length(json_extract(o.value,'$.text')) + 1) OVER (ORDER BY o.key ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS start
        FROM json_each(c.value,'$.state.content') o WHERE json_extract(o.value,'$.type') = 'text'
      ) WHERE start <= 65537),
      'error',json_extract(c.value,'$.state.error.message'),
      'time',json_object('end',json_extract(c.value,'$.time.completed')))) END,
    ${row}.time_created, ${row}.id FROM ${from ? `${from},` : ""} json_each(${row}.data,'$.content') c
    WHERE ${row}.type = 'assistant' AND json_extract(c.value,'$.type') IN ('text','tool')
  UNION ALL SELECT ${row}.id || ':tool', json_object('type','tool','tool','bash','state',json_object(
    'status', CASE WHEN json_extract(${row}.data,'$.time.completed') IS NULL THEN 'running' ELSE 'completed' END,
    'input',json_object('command',json_extract(${row}.data,'$.command')),
    'output', CASE json_type(${row}.data,'$.output') WHEN 'text' THEN json_extract(${row}.data,'$.output')
      ELSE json_extract(${row}.data,'$.output.output') END,
    'time',json_object('end',json_extract(${row}.data,'$.time.completed')))), ${row}.time_created, ${row}.id ${from ? `FROM ${from}` : ""} WHERE ${row}.type = 'shell'
`)

const sources = sql`WITH message_source AS (
  SELECT rowid, 0 AS durable, json_extract(data, '$.role') AS sourceType, id, session_id, time_created, data FROM message
    WHERE NOT EXISTS (SELECT 1 FROM session_message v WHERE v.id = message.id)
  UNION ALL SELECT rowid, 1, type, id, session_id, time_created,
    json_set(data, '$.role', CASE type WHEN 'shell' THEN 'assistant' ELSE type END,
      '$.agent', ${durableContext("v", "agent")},
      '$.modelID', ${durableContext("v", "modelID")}, '$.providerID', ${durableContext("v", "providerID")})
    FROM session_message v
), part_source AS (
  SELECT rowid, id, message_id, time_created, data FROM part
    WHERE NOT EXISTS (SELECT 1 FROM session_message v WHERE v.id = part.message_id)
  UNION ALL SELECT NULL, part_id, message_id, time_created, data FROM transcript_search_v2
)`

const documents = (candidate: string | undefined) => sql`${sources}${
  candidate
    ? sql`, fts_candidates AS MATERIALIZED (
  SELECT p.message_id AS messageID, t.part_id AS partID
    FROM transcript_search_fts JOIN transcript_search t ON t.rowid = transcript_search_fts.rowid
    JOIN part p ON p.id = t.part_id WHERE transcript_search_fts MATCH ${candidate}
  UNION SELECT v.message_id, v.part_id
    FROM transcript_search_v2_fts JOIN transcript_search_v2 v ON v.rowid = transcript_search_v2_fts.rowid
    WHERE transcript_search_v2_fts MATCH ${candidate}
  UNION SELECT m.id, NULL FROM transcript_search_error_fts JOIN message m ON m.rowid = transcript_search_error_fts.rowid
    WHERE transcript_search_error_fts MATCH ${candidate}
  UNION SELECT message_id, NULL FROM transcript_search_v2_error WHERE transcript_search_v2_error MATCH ${candidate}
)`
    : sql``
}, documents AS (
  SELECT p.id AS partID, p.message_id AS messageID, c.value AS category,
    CASE c.value
      WHEN 'text' THEN json_extract(p.data, '$.text')
      WHEN 'file' THEN coalesce(json_extract(p.data, '$.filename'), json_extract(p.data, '$.searchFilenames'),
        (SELECT group_concat(coalesce(json_extract(f.value, '$.filename'), json_extract(f.value, '$.name')), char(10))
         FROM json_each(p.data, '$.state.attachments') f))
      WHEN 'tool-input' THEN ${sql.raw(toolInput("p"))} || char(10) || coalesce(json_extract(p.data, '$.state.raw'), '')
      WHEN 'tool-output' THEN json_extract(p.data, '$.state.output')
      WHEN 'tool-error' THEN json_extract(p.data, '$.state.error') END AS content,
    CASE WHEN c.value IN ('tool-output', 'tool-error')
      THEN coalesce(json_extract(p.data, '$.state.time.end'), p.time_created)
      ELSE p.time_created END AS timeCreated
   FROM part_source p ${candidate ? sql`JOIN fts_candidates f ON f.messageID = p.message_id AND f.partID = p.id` : sql``},
    json_each(CASE json_extract(p.data, '$.type')
      WHEN 'tool' THEN '["tool-input","tool-output","tool-error","file"]'
       WHEN 'text' THEN '["text"]'
      WHEN 'file' THEN '["file"]' ELSE '[]' END) c
   WHERE (p.rowid IS NULL OR EXISTS (SELECT 1 FROM transcript_search t WHERE t.part_id = p.id))
      AND coalesce(json_extract(p.data, '$.ignored'), 0) = 0 AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
     AND (json_extract(p.data, '$.type') <> 'tool' OR (
       coalesce(json_extract(p.data, '$.tool'), '') <> 'todowrite'
       AND NOT (coalesce(json_extract(p.data, '$.tool'), '') = 'question' AND json_extract(p.data, '$.state.status') IN ('pending', 'running'))
     ))
  UNION ALL
  SELECT NULL, m.id, 'assistant-error', json_extract(m.data, '$.error.data.message'),
    coalesce(json_extract(m.data, '$.time.completed'), m.time_created) FROM message m
    ${candidate ? sql`JOIN fts_candidates f ON f.messageID = m.id AND f.partID IS NULL` : sql``}
   WHERE json_extract(m.data, '$.role') = 'assistant' AND json_extract(m.data, '$.error.data.message') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM session_message v WHERE v.id = m.id)
     AND NOT EXISTS (
       SELECT 1 FROM message later WHERE later.session_id = m.session_id
        AND json_extract(later.data, '$.role') = 'assistant'
        AND json_extract(later.data, '$.parentID') = json_extract(m.data, '$.parentID')
        AND (later.time_created > m.time_created OR (later.time_created = m.time_created AND later.id > m.id))
     )
   UNION ALL SELECT NULL, v.id, 'assistant-error', json_extract(v.data,'$.error.message'),
     coalesce(json_extract(v.data,'$.time.completed'),v.time_created)
     FROM session_message v JOIN transcript_search_v2_error e ON e.message_id = v.id
       ${candidate ? sql`JOIN fts_candidates f ON f.messageID = v.id AND f.partID IS NULL` : sql``}
     WHERE v.type = 'assistant' AND NOT EXISTS (
       SELECT 1 FROM session_message later WHERE later.session_id = v.session_id AND later.type = 'assistant'
        AND later.seq > v.seq AND later.seq < coalesce((
          SELECT min(boundary.seq) FROM session_message boundary
          WHERE boundary.session_id = v.session_id AND boundary.seq > v.seq
            AND (boundary.type IN ('user','shell') OR (boundary.type = 'synthetic' AND trim(json_extract(boundary.data,'$.text')) <> ''))
        ), 9223372036854775807)
     )
 )`

export const make = Effect.gen(function* () {
  const { db } = yield* Database.Service
  // Triggers are installed before backfill starts, so concurrent writes (including
  // IDs older than the cursor) cannot be missed. Joins keep message/session metadata live.
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const installed = yield* tx.get(sql`SELECT 1 FROM sqlite_master WHERE name = 'transcript_search_v2'`)
      const oldMessageIndex = yield* tx.get(
        sql`SELECT 1 FROM sqlite_master WHERE name = 'transcript_search_message_fts'`,
      )
      if (oldMessageIndex) {
        yield* tx.run(sql`DROP TRIGGER IF EXISTS transcript_search_message_fts_insert`)
        yield* tx.run(sql`DROP TRIGGER IF EXISTS transcript_search_message_fts_update`)
        yield* tx.run(sql`DROP TRIGGER IF EXISTS transcript_search_message_fts_delete`)
        yield* tx.run(sql`DROP TABLE transcript_search_message_fts`)
      }
      yield* tx.run(sql`CREATE TABLE IF NOT EXISTS transcript_search_v2 (
        part_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES session_message(id) ON DELETE CASCADE,
        time_created INTEGER NOT NULL, data TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(message_id, part_id)
      )`)
      yield* tx.run(sql`CREATE INDEX IF NOT EXISTS transcript_search_v2_message ON transcript_search_v2(message_id)`)
      yield* tx.run(
        sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search_v2_fts USING fts5(body, content='transcript_search_v2', content_rowid='rowid', tokenize='trigram')`,
      )
      yield* tx.run(
        sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search_v2_error USING fts5(message_id UNINDEXED, body, tokenize='trigram')`,
      )
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_v2_insert AFTER INSERT ON transcript_search_v2 BEGIN
        INSERT INTO transcript_search_v2_fts(rowid,body) VALUES (new.rowid,new.body); END`)
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_v2_update AFTER UPDATE ON transcript_search_v2
        WHEN old.body IS NOT new.body BEGIN
        INSERT INTO transcript_search_v2_fts(transcript_search_v2_fts,rowid,body) VALUES ('delete',old.rowid,old.body);
        INSERT INTO transcript_search_v2_fts(rowid,body) VALUES (new.rowid,new.body); END`)
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_v2_delete AFTER DELETE ON transcript_search_v2 BEGIN
        INSERT INTO transcript_search_v2_fts(transcript_search_v2_fts,rowid,body) VALUES ('delete',old.rowid,old.body); END`)
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_durable_insert AFTER INSERT ON session_message BEGIN
          INSERT INTO transcript_search_v2(part_id,message_id,time_created,data,body)
            SELECT p.id,new.id,p.time_created,p.data,substr(coalesce(${body("p")},''),1,327680)
            FROM (${durableParts("new")}) p;
          INSERT INTO transcript_search_v2_error(message_id,body)
            SELECT new.id,substr(json_extract(new.data,'$.error.message'),1,65536)
            WHERE new.type = 'assistant' AND json_extract(new.data,'$.error.message') IS NOT NULL;
          END`)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS transcript_search_durable_update`)
      yield* tx.run(sql`CREATE TRIGGER transcript_search_durable_update AFTER UPDATE ON session_message BEGIN
          DELETE FROM transcript_search_v2 WHERE message_id = new.id AND part_id NOT IN (
            SELECT p.id FROM (${durableParts("new")}) p
          );
          INSERT INTO transcript_search_v2(part_id,message_id,time_created,data,body)
            SELECT p.id,new.id,p.time_created,p.data,substr(coalesce(${body("p")},''),1,327680)
            FROM (${durableParts("new")}) p WHERE true
            ON CONFLICT(message_id,part_id) DO UPDATE SET
              time_created = excluded.time_created, data = excluded.data, body = excluded.body
            WHERE transcript_search_v2.time_created IS NOT excluded.time_created
              OR transcript_search_v2.data IS NOT excluded.data OR transcript_search_v2.body IS NOT excluded.body;
          DELETE FROM transcript_search_v2_error WHERE message_id = new.id
            AND json_extract(old.data,'$.error.message') IS NOT json_extract(new.data,'$.error.message');
          INSERT INTO transcript_search_v2_error(message_id,body)
            SELECT new.id,substr(json_extract(new.data,'$.error.message'),1,65536)
            WHERE new.type = 'assistant' AND json_extract(new.data,'$.error.message') IS NOT NULL
              AND json_extract(old.data,'$.error.message') IS NOT json_extract(new.data,'$.error.message');
          END`)
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_durable_delete AFTER DELETE ON session_message BEGIN
        DELETE FROM transcript_search_v2_error WHERE message_id = old.id; END`)
      for (const event of ["INSERT", "UPDATE"] as const) {
        yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS ${sql.identifier(`transcript_search_${event.toLowerCase()}`)}
        AFTER ${sql.raw(event)} ON part BEGIN
          INSERT INTO transcript_search (part_id, body, truncated)
           VALUES (new.id, substr(coalesce(${body("new")}, ''), 1, 393216), length(coalesce(${body("new")}, '')) > 393216)
          ON CONFLICT(part_id) DO UPDATE SET body = excluded.body, truncated = excluded.truncated;
        END`)
      }
      yield* tx.run(
        sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search_fts USING fts5(body, content='transcript_search', content_rowid='rowid', tokenize='trigram')`,
      )
      yield* tx.run(
        sql`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search_error_fts USING fts5(body, content='', contentless_delete=1, tokenize='trigram')`,
      )
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_fts_insert AFTER INSERT ON transcript_search BEGIN
        INSERT INTO transcript_search_fts(rowid, body) VALUES (new.rowid, new.body);
      END`)
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_fts_update AFTER UPDATE ON transcript_search BEGIN
        INSERT INTO transcript_search_fts(transcript_search_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
        INSERT INTO transcript_search_fts(rowid, body) VALUES (new.rowid, new.body);
      END`)
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_fts_delete AFTER DELETE ON transcript_search BEGIN
        INSERT INTO transcript_search_fts(transcript_search_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      END`)
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_error_fts_insert AFTER INSERT ON message
        WHEN json_extract(new.data, '$.role') = 'assistant' AND json_extract(new.data, '$.error.data.message') IS NOT NULL BEGIN
        INSERT INTO transcript_search_error_fts(rowid, body)
          VALUES (new.rowid, substr(json_extract(new.data, '$.error.data.message'), 1, 65536));
      END`)
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_error_fts_update AFTER UPDATE ON message BEGIN
        DELETE FROM transcript_search_error_fts WHERE rowid = old.rowid;
        INSERT INTO transcript_search_error_fts(rowid, body)
          SELECT new.rowid, substr(json_extract(new.data, '$.error.data.message'), 1, 65536)
          WHERE json_extract(new.data, '$.role') = 'assistant' AND json_extract(new.data, '$.error.data.message') IS NOT NULL;
      END`)
      yield* tx.run(sql`CREATE TRIGGER IF NOT EXISTS transcript_search_error_fts_delete AFTER DELETE ON message BEGIN
        DELETE FROM transcript_search_error_fts WHERE rowid = old.rowid;
      END`)
      yield* tx.run(sql`INSERT OR IGNORE INTO transcript_search_state VALUES (1, '', 0)`)
      // Upgrade a previously completed legacy index without scanning durable history.
      if (!installed)
        yield* tx.run(sql`UPDATE transcript_search_state SET cursor = 'durable:', ready = 0 WHERE ready = 1`)
    }),
  )

  const advance = () =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        const state = yield* tx.get<{ cursor: string; ready: number }>(
          sql`SELECT cursor, ready FROM transcript_search_state WHERE id = 1`,
        )
        if (state?.ready) return { ready: true, backfillCursor: state.cursor }
        let remaining = 200
        let cursor = state?.cursor ?? ""
        let phase = cursor.startsWith("durable:") ? "durable" : cursor.startsWith("message:") ? "message" : "part"
        if (phase !== "part") cursor = cursor.slice(phase.length + 1)
        if (phase === "part") {
          const rows = yield* tx.all<{ id: string }>(
            sql`SELECT id FROM part WHERE id > ${cursor} ORDER BY id LIMIT 200`,
          )
          if (rows.length) {
            yield* tx.run(sql`INSERT INTO transcript_search (part_id, body, truncated)
             SELECT p.id, substr(coalesce(${body("p")}, ''), 1, 393216), length(coalesce(${body("p")}, '')) > 393216
              FROM part p WHERE p.id > ${cursor} AND p.id <= ${rows[rows.length - 1]!.id}
              ON CONFLICT(part_id) DO UPDATE SET body = excluded.body, truncated = excluded.truncated`)
            cursor = rows[rows.length - 1]!.id
          }
          remaining -= rows.length
          if (rows.length === 200) {
            yield* tx.run(sql`UPDATE transcript_search_state SET cursor = ${cursor}, ready = 0 WHERE id = 1`)
            return { ready: false, backfillCursor: cursor }
          }
          phase = "message"
          cursor = ""
        }
        if (phase === "message") {
          const rows = yield* tx.all<{ id: string }>(
            sql`SELECT id FROM message WHERE id > ${cursor} ORDER BY id LIMIT ${remaining}`,
          )
          if (rows.length) {
            yield* tx.run(sql`INSERT OR REPLACE INTO transcript_search_error_fts(rowid, body)
              SELECT rowid, substr(json_extract(data, '$.error.data.message'), 1, 65536) FROM message
              WHERE id > ${cursor} AND id <= ${rows[rows.length - 1]!.id}
                AND json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.error.data.message') IS NOT NULL`)
            cursor = rows[rows.length - 1]!.id
          }
          remaining -= rows.length
          if (remaining === 0) {
            const backfillCursor = `message:${cursor}`
            yield* tx.run(sql`UPDATE transcript_search_state SET cursor = ${backfillCursor}, ready = 0 WHERE id = 1`)
            return { ready: false, backfillCursor }
          }
          cursor = ""
        }
        const rows = yield* tx.all<{ id: string }>(
          sql`SELECT id FROM session_message WHERE id > ${cursor} ORDER BY id LIMIT ${remaining}`,
        )
        if (rows.length) {
          yield* tx.run(
            sql`DELETE FROM transcript_search_v2 WHERE message_id > ${cursor} AND message_id <= ${rows[rows.length - 1]!.id}`,
          )
          yield* tx.run(sql`WITH batch AS (SELECT * FROM session_message WHERE id > ${cursor} AND id <= ${rows[rows.length - 1]!.id})
            INSERT INTO transcript_search_v2(part_id,message_id,time_created,data,body)
             SELECT p.id,p.message_id,p.time_created,p.data,substr(coalesce(${body("p")},''),1,393216)
            FROM (${durableParts("v", "batch v")}) p`)
          yield* tx.run(
            sql`DELETE FROM transcript_search_v2_error WHERE message_id > ${cursor} AND message_id <= ${rows[rows.length - 1]!.id}`,
          )
          yield* tx.run(sql`INSERT INTO transcript_search_v2_error(message_id,body)
            SELECT id,substr(json_extract(data,'$.error.message'),1,65536) FROM session_message
            WHERE id > ${cursor} AND id <= ${rows[rows.length - 1]!.id} AND type = 'assistant' AND json_extract(data,'$.error.message') IS NOT NULL`)
        }
        const ready = rows.length < remaining
        const backfillCursor = ready ? "" : `durable:${rows[rows.length - 1]!.id}`
        yield* tx.run(
          sql`UPDATE transcript_search_state SET cursor = ${backfillCursor}, ready = ${Number(ready)} WHERE id = 1`,
        )
        return { ready, backfillCursor }
      }),
    )

  const status = Effect.fn("TranscriptSearch.status")(function* () {
    const state = yield* db.get<{ cursor: string; ready: number }>(
      sql`SELECT cursor, ready FROM transcript_search_state WHERE id = 1`,
    )
    return { ready: Boolean(state?.ready), backfillCursor: state?.cursor ?? "" }
  })

  const search = Effect.fn("TranscriptSearch.search")(function* (input: typeof Request.Type) {
    yield* Schema.decodeUnknownEffect(Request)(input).pipe(
      Effect.mapError(() => new InvalidQuery({ message: "Invalid search request" })),
    )
    if (input.dateFrom !== undefined && input.dateTo !== undefined && input.dateFrom > input.dateTo)
      return yield* new InvalidQuery({ message: "dateFrom must not exceed dateTo" })
    const slash = input.mode === "regex" ? /^\/(.*)\/([a-z]*)$/s.exec(input.query) : null
    const source = slash?.[1] ?? input.query
    const flags = input.flags ?? slash?.[2] ?? (input.caseSensitive ? "u" : "iu")
    if (/[^gimsu]/.test(flags) || new Set(flags).size !== flags.length)
      return yield* new InvalidQuery({ message: "Supported regex flags: g, i, m, s, u" })
    // Keep matching bounded: no repetitions, groups, alternation or backreferences.
    if (input.mode === "regex" && unsafeRegex(source))
      return yield* new InvalidQuery({
        message:
          "Regex supports literals, escapes, dot, character classes and anchors; groups, alternation and quantifiers are not supported",
      })
    const pattern = yield* Effect.try({
      try: () =>
        new RegExp(
          input.mode === "regex" ? source : input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          input.mode === "regex" ? flags.replace(/g/g, "") : input.caseSensitive ? "u" : "iu",
        ),
      catch: () => new InvalidQuery({ message: "Invalid regex" }),
    })
    if (input.mode !== "regex" && Array.from(input.query.trim()).length < 3)
      return yield* new InvalidQuery({ message: "Literal searches require at least three Unicode characters" })
    const indexStatus = yield* status()
    const sort = input.sort ?? "newest"
    const signature = createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(input)
            .filter(([key]) => key !== "cursor" && key !== "limit")
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest("hex")
    const cursor =
      input.cursor === undefined
        ? undefined
        : yield* Effect.try({
            try: () => {
              const value: unknown = JSON.parse(Buffer.from(input.cursor!, "base64url").toString())
              if (
                !Array.isArray(value) ||
                value.length !== 4 ||
                value[0] !== signature ||
                (typeof value[1] !== "string" && typeof value[1] !== "number") ||
                typeof value[2] !== "string" ||
                typeof value[3] !== "string"
              )
                throw new Error()
              return { key: value[1] as string | number, message: value[2] as string, document: value[3] as string }
            },
            catch: () => new InvalidQuery({ message: "Invalid cursor or changed search parameters" }),
          })
    const key = sort === "session-title" ? sql`s.title` : sql`d.timeCreated`
    const document = sql`CASE WHEN m.durable THEN 'v2:' || d.messageID || ':' ELSE '' END || coalesce(d.partID, d.messageID) || ':' || d.category`
    const filters = [visible, sql`coalesce(d.content, '') <> ''`]
    const candidate = input.mode === "regex" ? regexCandidate(source) : source
    if (input.mode === "regex" && !candidate)
      return yield* new InvalidQuery({ message: "Regex search requires a literal run of at least three characters" })
    const indexedCandidate =
      candidate && Array.from(candidate).length >= 3 ? `"${candidate.replaceAll('"', '""')}"` : undefined
    if (input.projectID !== undefined) filters.push(sql`s.project_id = ${input.projectID}`)
    if (input.sessionID !== undefined) filters.push(sql`s.id = ${input.sessionID}`)
    if (input.role !== undefined) filters.push(sql`json_extract(m.data, '$.role') = ${input.role}`)
    if (input.agent !== undefined) filters.push(sql`json_extract(m.data, '$.agent') = ${input.agent}`)
    if (input.providerID !== undefined)
      filters.push(
        sql`coalesce(json_extract(m.data, '$.providerID'), json_extract(m.data, '$.model.providerID')) = ${input.providerID}`,
      )
    if (input.modelID !== undefined)
      filters.push(
        sql`coalesce(json_extract(m.data, '$.modelID'), json_extract(m.data, '$.model.modelID')) = ${input.modelID}`,
      )
    for (const [column, list] of [
      [sql`s.project_id`, input.projectIDs],
      [sql`json_extract(m.data, '$.agent')`, input.agents],
      [provider, input.providerIDs],
      [model, input.modelIDs],
      [sql`json_extract(m.data, '$.role')`, input.roles],
      [sql`d.category`, input.categories],
      [sql`json_extract(p.data, '$.tool')`, input.toolNames],
      [toolStatus, input.toolStatuses],
    ] as const) {
      if (list?.length)
        filters.push(
          sql`${column} IN (${sql.join(
            list.map((x) => sql`${x}`),
            sql`, `,
          )})`,
        )
    }
    if (input.models?.length)
      filters.push(
        sql`(${sql.join(
          input.models.map((x) => sql`(${provider} = ${x.providerID} AND ${model} = ${x.modelID})`),
          sql` OR `,
        )})`,
      )
    if (input.dateFrom !== undefined) filters.push(sql`d.timeCreated >= ${input.dateFrom}`)
    if (input.dateTo !== undefined) filters.push(sql`d.timeCreated <= ${input.dateTo}`)
    if (input.sessionKind === "root") filters.push(sql`s.parent_id IS NULL`)
    if (input.sessionKind === "subagent") filters.push(sql`s.parent_id IS NOT NULL`)
    if (input.archived === "active") filters.push(sql`s.time_archived IS NULL`)
    if (input.archived === "archived") filters.push(sql`s.time_archived IS NOT NULL`)
    if (cursor)
      filters.push(
        sort === "newest"
          ? sql`(${key}, m.id, ${document}) < (${cursor.key}, ${cursor.message}, ${cursor.document})`
          : sql`(${key}, m.id, ${document}) > (${cursor.key}, ${cursor.message}, ${cursor.document})`,
      )
    const direction = sql.raw(sort === "newest" ? "DESC" : "ASC")
    const rows = yield* db.all<
      Omit<typeof Hit.Type, "excerpt" | "excerptOffset" | "offset" | "matchLength" | "truncated"> & {
        body: string
        truncated: number
        sortKey: string | number
      }
    >(sql`
      ${documents(indexedCandidate)}
      SELECT d.partID, m.id AS messageID,
        CASE WHEN m.durable = 1 AND m.sourceType = 'shell' THEN m.id || ':assistant' END AS navigationMessageID,
        ${document} AS documentID, d.category, m.session_id AS sessionID,
        s.project_id AS projectID, project.worktree AS projectPath, s.title, s.directory, json_extract(m.data, '$.role') AS role,
        coalesce(json_extract(p.data, '$.type'), 'error') AS type,
        json_extract(m.data, '$.agent') AS agent, ${provider} AS providerID, ${model} AS modelID,
        json_extract(p.data, '$.tool') AS toolName, ${toolStatus} AS toolStatus,
        s.parent_id AS parentID, s.time_archived IS NOT NULL AS archived,
        substr(d.content, 1, 65536) AS body, length(d.content) > 65536 AS truncated, d.timeCreated AS timeCreated, ${key} AS sortKey
      FROM documents d JOIN message_source m ON m.id = d.messageID
      LEFT JOIN part_source p ON p.id = d.partID AND p.message_id = d.messageID JOIN session s ON s.id = m.session_id
      JOIN project ON project.id = s.project_id
      WHERE ${sql.join(filters, sql` AND `)} ORDER BY ${key} ${direction}, m.id ${direction}, ${document} ${direction} LIMIT 501`)
    const hits: (typeof Hit.Type)[] = []
    let scanned = 0
    let next = input.cursor ?? ""
    for (const row of rows.slice(0, 500)) {
      scanned++
      next = Buffer.from(JSON.stringify([signature, row.sortKey, row.messageID, row.documentID])).toString("base64url")
      const match = pattern.exec(row.body)
      if (!match) continue
      const { body, truncated, sortKey, ...hit } = row
      hits.push({
        ...hit,
        partID: hit.partID ?? undefined,
        navigationMessageID: hit.navigationMessageID ?? undefined,
        agent: hit.agent ?? undefined,
        providerID: hit.providerID ?? undefined,
        modelID: hit.modelID ?? undefined,
        toolName: hit.toolName ?? undefined,
        toolStatus: hit.toolStatus ?? undefined,
        parentID: hit.parentID ?? undefined,
        archived: Boolean(hit.archived),
        offset: match.index,
        matchLength: match[0].length,
        excerptOffset: Math.max(0, match.index - 80),
        excerpt: body.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80),
        truncated: Boolean(truncated),
      })
      if (hits.length >= (input.limit ?? 50)) break
    }
    const nextCursor = scanned < rows.length ? next : null
    return {
      hits,
      scanned,
      nextCursor: nextCursor ?? undefined,
      status: indexStatus,
      complete: indexStatus.ready && nextCursor === null,
      scanLimit: 500,
      contentLimit: 65536,
      scanLimited: scanned === 500 && nextCursor !== null,
      truncatedDocuments: rows.slice(0, scanned).filter((row) => row.truncated).length,
    }
  })

  const facets = Effect.fn("TranscriptSearch.facets")(function* () {
    // Historical message metadata, not today's configured agents/providers/models.
    const rows = yield* db.all<{ kind: string; value: string; lastUsed: number }>(sql`
      ${sources}, facet_tools AS (
        SELECT p.message_id, json_extract(p.data,'$.tool') AS tool FROM part p
          WHERE NOT EXISTS (SELECT 1 FROM session_message v WHERE v.id = p.message_id)
          AND json_extract(p.data,'$.type') = 'tool'
          AND coalesce(json_extract(p.data,'$.ignored'),0) = 0 AND coalesce(json_extract(p.data,'$.synthetic'),0) = 0
          AND coalesce(json_extract(p.data,'$.tool'),'') <> 'todowrite'
          AND NOT (coalesce(json_extract(p.data,'$.tool'),'') = 'question' AND json_extract(p.data,'$.state.status') IN ('pending','running'))
        UNION ALL SELECT v.id, json_extract(c.value,'$.name') FROM session_message v, json_each(v.data,'$.content') c
          WHERE v.type = 'assistant' AND json_extract(c.value,'$.type') = 'tool'
          AND json_extract(c.value,'$.name') <> 'todowrite'
          AND NOT (json_extract(c.value,'$.name') = 'question' AND json_extract(c.value,'$.state.status') IN ('pending','running'))
        UNION ALL SELECT id, 'bash' FROM session_message WHERE type = 'shell'
      )
      SELECT 'projects' AS kind, s.project_id AS value, max(m.time_created) AS lastUsed FROM message_source m JOIN session s ON s.id = m.session_id WHERE ${visible} GROUP BY s.project_id
      UNION ALL SELECT 'agents', json_extract(m.data, '$.agent'), max(m.time_created) FROM message_source m WHERE ${visible} GROUP BY json_extract(m.data, '$.agent')
      UNION ALL SELECT 'providers', ${provider}, max(m.time_created) FROM message_source m WHERE ${visible} GROUP BY ${provider}
      UNION ALL SELECT 'models', ${model}, max(m.time_created) FROM message_source m WHERE ${visible} GROUP BY ${model}
       UNION ALL SELECT 'tools', t.tool, max(m.time_created) FROM facet_tools t JOIN message_source m ON m.id = t.message_id WHERE ${visible} GROUP BY t.tool
       ORDER BY lastUsed DESC, kind, value`)
    const identities = yield* db.all<{ providerID: string; modelID: string; lastUsed: number }>(sql`
      ${sources}
      SELECT ${provider} AS providerID, ${model} AS modelID, max(m.time_created) AS lastUsed
      FROM message_source m WHERE ${visible} AND ${provider} IS NOT NULL AND ${model} IS NOT NULL
       GROUP BY ${provider}, ${model} ORDER BY lastUsed DESC, providerID, modelID`)
    const projects = yield* db.all<{ id: string; path: string; lastUsed: number }>(sql`
      ${sources}
      SELECT s.project_id AS id, p.worktree AS path, max(m.time_created) AS lastUsed
      FROM message_source m JOIN session s ON s.id = m.session_id JOIN project p ON p.id = s.project_id
       WHERE ${visible} GROUP BY s.project_id ORDER BY lastUsed DESC, s.project_id`)
    const values = (kind: string) =>
      rows.filter((x) => x.kind === kind && x.value != null).map((x) => ({ value: x.value, lastUsed: x.lastUsed }))
    return {
      projects: values("projects").map((x) => x.value),
      agents: values("agents").map((x) => x.value),
      providers: values("providers").map((x) => x.value),
      models: values("models").map((x) => x.value),
      tools: values("tools").map((x) => x.value),
      agentDetails: values("agents"),
      providerDetails: values("providers"),
      modelDetails: values("models"),
      toolDetails: values("tools"),
      modelIdentities: identities,
      projectDetails: projects,
      truncated: false,
    }
  })
  return { search, advance, status, facets }
})

function regexCandidate(source: string) {
  const runs: string[] = []
  let current = ""
  const flush = () => {
    if (Array.from(current).length >= 3) runs.push(current)
    current = ""
  }
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v" }
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (character === "\\") {
      const escaped = source[++index]
      if (!escaped) break
      if (escaped === "x" && /^[\da-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
        current += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 3), 16))
        index += 2
        continue
      }
      if (escaped === "u" && /^[\da-f]{4}$/i.test(source.slice(index + 1, index + 5))) {
        current += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 5), 16))
        index += 4
        continue
      }
      if (/[\\/.^$*+?()[\]{}|]/.test(escaped)) {
        current += escaped
        continue
      }
      if (escapes[escaped]) {
        current += escapes[escaped]
        continue
      }
      flush()
      continue
    }
    if (character === "[") {
      flush()
      while (index + 1 < source.length) {
        index++
        if (source[index] === "\\") index++
        else if (source[index] === "]") break
      }
      continue
    }
    if (/[.^$*+?(){}|]/.test(character)) {
      flush()
      continue
    }
    current += character
  }
  flush()
  return runs.sort((a, b) => Array.from(b).length - Array.from(a).length)[0]
}

function unsafeRegex(source: string) {
  let characterClass = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (character === "\\") {
      const escaped = source[++index]
      if (!characterClass && escaped && /[1-9kpP]/.test(escaped)) return true
      continue
    }
    if (characterClass) {
      if (character === "]") characterClass = false
      continue
    }
    if (character === "[") {
      characterClass = true
      continue
    }
    if (/[()*+?{}|]/.test(character)) return true
  }
  return false
}

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/TranscriptSearch") {}
export const layer = Layer.effect(Service, make.pipe(Effect.orDie))
