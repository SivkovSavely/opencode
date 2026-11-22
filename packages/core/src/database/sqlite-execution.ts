import { createHmac, randomBytes } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { References, type Fiber } from "effect"
import { SqlOrigin, sqliteExecutionEnabled, sqlSourceLocations } from "@opencode-ai/effect-drizzle-sqlite"
import { xdgData } from "xdg-basedir"

const maxBytes = 4 * 1024 * 1024

// Only fixed SQL/known schema vocabulary can appear verbatim. Unknown identifiers,
// comments, literals (including SQLite's string-like double quotes) and binds are redacted.
const words = new Set(
  `select insert update delete replace into from as where join left right inner outer cross on using group by having
    order asc desc limit offset distinct union all intersect except exists not in is null like glob match between and or
    case when then else end with recursive over partition window returning values set conflict do nothing
    begin deferred immediate exclusive commit rollback to savepoint release transaction explain query plan
    pragma journal_mode wal wal_checkpoint passive synchronous busy_timeout cache_size foreign_keys table_info foreign_key_list
    create alter drop table index if default primary key references check
    sqlite_master sqlite_schema migration project workspace session message part session_message session_entry session_input
    event event_sequence session_queue_state transcript_search_state runtime_execution id session_id message_id project_id
    directory time_created time_updated seq count sum min max coalesce typeof length`.split(/\s+/),
)
function shape(sql: string) {
  const tokens: string[] = []
  let size = 0
  for (const [token] of sql.matchAll(
    /[ \t\r\n\f]+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[xX]?'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)|`(?:[^`]|``)*(?:`|$)|\[[^\]]*(?:\]|$)|[$:@][\w$\u0080-\uffff]*(?:::[\w$\u0080-\uffff]*)*(?:\([^)]*(?:\)|$))?|\?\d*|0[xX][0-9a-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?|[\w$\u0080-\uffff]+|./g,
  )) {
    if (/^[ \t\r\n\f]|^--|^\/\*/.test(token)) continue
    // SQLite may treat an unqualified double-quoted expression as a string.
    const word = token.toLowerCase().replace(/^[`[]|[`\]]$/g, "")
    const item = words.has(word) ? word.toUpperCase() : /^[(),.;=*+/%<>!|&~-]$/.test(token) ? token : "?"
    size += item.length + 1
    if (size > 384) return tokens.join(" ") + " ..."
    tokens.push(item)
  }
  return tokens.join(" ")
}

function origin(fiber?: Fiber.Fiber<unknown, unknown>) {
  if (!fiber) return sqlSourceLocations(new Error().stack)
  const submitted = fiber.getRef(SqlOrigin)
  if (submitted.length) return submitted
  const locations: string[] = []
  let frame = fiber.getRef(References.CurrentStackFrame)
  for (let i = 0; frame && i < 12 && locations.length < 4; i++, frame = frame.parent) {
    locations.push(...sqlSourceLocations(frame.stack()).slice(0, 4 - locations.length))
  }
  return locations
}

type Mode = "rows" | "values" | "compatibility" | "wal"

function make() {
  let target: string | undefined
  let bytes = 0
  let nextID = 0
  let key: Buffer | undefined
  let unavailable = false

  function write(marker: string, uptimeMs: number, fields: Record<string, unknown>) {
    const line =
      JSON.stringify({
        marker,
        pid: process.pid,
        schemaVersion: 1,
        wallClock: new Date().toISOString(),
        uptimeMs,
        ...fields,
      }) + "\n"
    const size = Buffer.byteLength(line)
    if (!target) {
      // Same log root as Global.Path.log, without initializing the global runtime here.
      const log = join(xdgData!, "opencode", "log")
      mkdirSync(log, { recursive: true })
      target = join(mkdtempSync(join(log, `sqlite-execution-${process.pid}-`)), "queries.jsonl")
    }
    if (bytes + size > maxBytes) {
      renameSync(target, join(target, "..", "queries.previous.jsonl"))
      bytes = 0
    }
    if (bytes === 0) writeFileSync(target, line, { flag: "wx", mode: 0o600 })
    else appendFileSync(target, line)
    bytes += size
  }

  function start(sql: string, mode: Mode, fiber?: Fiber.Fiber<unknown, unknown>, databaseID?: number) {
    if (unavailable) return undefined
    const queryID = ++nextID
    try {
      // Raw text is never emitted; the ephemeral key prevents offline guesses of inline data.
      const statementID = createHmac("sha256", (key ??= randomBytes(32)))
        .update(sql)
        .digest("hex")
        .slice(0, 32)
      const fields = {
        queryID,
        statementID,
        shape: shape(sql),
        mode,
        fiberID: fiber?.id,
        databaseID,
        origin: origin(fiber),
      }
      // The synchronous write must finish before SQLite is entered, even if it never returns.
      write("sqlite_query_start", performance.now(), fields)
      const started = performance.now()
      return (success: boolean) => {
        const end = performance.now()
        try {
          write("sqlite_query_end", end, {
            queryID,
            status: success ? "success" : "failure",
            durationMs: end - started,
          })
        } catch {
          unavailable = true
        }
      }
    } catch {
      // The trace is best effort; its failures must never affect SQL results.
      unavailable = true
      return undefined
    }
  }

  return {
    start,
    startup<A>(query: string, mode: "compatibility" | "wal", run: () => A) {
      const finish = start(query, mode)
      let success = false
      try {
        const result = run()
        success = true
        return result
      } finally {
        finish?.(success)
      }
    },
  }
}

export const sqliteExecution = sqliteExecutionEnabled ? make() : undefined
