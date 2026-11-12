import { constants, Database } from "bun:sqlite"
import { isUtf8 } from "node:buffer"
import { createHash } from "node:crypto"
import { lstatSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import zlib from "node:zlib"

type Options = {
  source: string
  destination: string
  maxRowBytes?: number
  preflight?: boolean
  signal?: AbortSignal
}

export type Stats = {
  verified: boolean
  tablesCompared: number
  rowsCompared: number
  eventRowsCompared: number
  eventBytesCompared: number
  peakRssBytes: number
  preflight?: true
}

type Column = { name: string; type: string; pk: number; hidden: number }
type Cell = { type: string; value: Uint8Array | bigint | number | null }
type Row = Record<string, unknown>

const schemaObjects = 1024
const schemaBytes = 4 * 1024 * 1024
const keylessRows = 1024
const keylessBytes = 16 * 1024 * 1024
const maximumColumns = 256
const transcriptFts = [
  {
    name: "transcript_search_fts",
    args: ["body", "content='transcript_search'", "content_rowid='rowid'", "tokenize='trigram'"],
    content: "transcript_search",
  },
  {
    name: "transcript_search_error_fts",
    args: ["body", "content=''", "contentless_delete=1", "tokenize='trigram'"],
    content: "message",
  },
  {
    name: "transcript_search_v2_fts",
    args: ["body", "content='transcript_search_v2'", "content_rowid='rowid'", "tokenize='trigram'"],
    content: "transcript_search_v2",
  },
  { name: "transcript_search_v2_error", args: ["message_id UNINDEXED", "body", "tokenize='trigram'"], content: null },
]

class UsageError extends Error {}
class VerificationError extends Error {}

export async function verifyDatabases(input: Options, onProgress?: (stats: Stats) => void): Promise<Stats> {
  const maximum = input.maxRowBytes ?? 256 * 1024 * 1024
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1073741824)
    throw new UsageError("--max-row-bytes must be an integer between 1 and 1073741824")
  const abort = () => {
    if (input.signal?.aborted) throw new VerificationError("Verification interrupted; no verified success")
  }
  abort()
  const source = checkPath(input.source)
  const destination = checkPath(input.destination)
  if (source.identity.dev === destination.identity.dev && source.identity.ino === destination.identity.ino)
    throw new VerificationError("Source and destination must be distinct files, not the same database")
  const stats: Stats = {
    verified: false,
    tablesCompared: 0,
    rowsCompared: 0,
    eventRowsCompared: 0,
    eventBytesCompared: 0,
    peakRssBytes: process.memoryUsage.rss(),
    ...(input.preflight ? { preflight: true as const } : {}),
  }
  const progress = async () => {
    stats.peakRssBytes = Math.max(stats.peakRssBytes, process.memoryUsage.rss())
    onProgress?.({ ...stats })
    await new Promise<void>((resolve) => setImmediate(resolve))
    abort()
  }
  let stage = "opening read-only inputs"
  try {
    using left = open(source.filename)
    using right = open(destination.filename)
    unchanged(source)
    unchanged(destination)
    stage = "checking SQLite and persistent metadata"
    for (const db of [left, right]) {
      const version = db
        .query<{ version: string }, []>("SELECT sqlite_version() AS version")
        .get()!
        .version.split(".")
        .map(Number)
      if (version[0] < 3 || (version[0] === 3 && version[1] < 43))
        throw new VerificationError("SQLite 3.43 or newer is required for bounded octet_length reads")
      if (db.query<{ encoding: string }, []>("PRAGMA encoding").get()?.encoding !== "UTF-8")
        throw new VerificationError("Only UTF-8 databases are supported; no implicit text transcoding")
    }
    if (typeof zlib.zstdDecompressSync !== "function" || typeof zlib.constants.ZSTD_d_windowLogMax !== "number")
      throw new VerificationError("This Bun runtime lacks bounded Zstandard decompression; upgrade Bun")
    for (const pragma of [
      "application_id",
      "user_version",
      "encoding",
      "page_size",
      "auto_vacuum",
      "default_cache_size",
    ]) {
      const a = left.query<Row, []>(`PRAGMA ${pragma}`).get()
      const b = right.query<Row, []>(`PRAGMA ${pragma}`).get()
      if (!a || !b || Object.values(a)[0] !== Object.values(b)[0])
        throw new VerificationError(`Persistent database metadata mismatch: ${pragma}`)
    }
    stage = "comparing schema definitions"
    const a = inventory(left)
    const b = inventory(right)
    if (
      a.length !== b.length ||
      a.some((item, index) =>
        (["type", "name", "table", "sql", "kind", "wr"] as const).some((key) => item[key] !== b[index][key]),
      )
    )
      throw new VerificationError("Schema definitions mismatch; table/index/trigger/view names or SQL changed")
    const tables = a.filter((item) => item.type === "table")
    if (!tables.some((table) => table.name === "event")) throw new VerificationError("Missing required event table")
    const rowids = new Set(
      tables.flatMap((table) => {
        const content = table.kind === "virtual" ? transcriptFts.find((fts) => fts.name === table.name)?.content : null
        return content ? [content] : []
      }),
    )
    if (
      [...rowids].some(
        (name) => !tables.some((table) => table.name === name && table.kind === "table" && table.wr === 0),
      )
    )
      throw new VerificationError("Unsupported FTS external-content table layout; require ordinary rowid tables")
    for (const [index, table] of tables.entries()) {
      abort()
      stage = `table ${index + 1}`
      // Virtual definitions were checked exactly; compare all their backing tables instead of hidden columns.
      if (table.kind === "virtual") {
        stats.tablesCompared++
        continue
      }
      const columns = left
        .query<Column, [string]>("SELECT name, type, pk, hidden FROM pragma_table_xinfo(?) LIMIT 257")
        .all(table.name)
      if (!columns.length || columns.length > maximumColumns || columns.some((column) => column.hidden !== 0))
        throw new VerificationError(`Unsupported generated/hidden columns or column limit at ${stage}`)
      const keys = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)
      if (rowids.has(table.name) && (!keys.length || columns.some((column) => column.name.toLowerCase() === "rowid")))
        throw new VerificationError(`Unsupported FTS external-content primary key/rowid at ${stage}`)
      if (
        table.name === "event" &&
        (keys.length !== 1 ||
          keys[0].name !== "id" ||
          !["aggregate_id", "seq", "type", "data"].every((name) => columns.some((column) => column.name === name)))
      )
        throw new VerificationError(
          "Unsupported event schema: require stable id primary key and event metadata/data columns",
        )
      const pk = left
        .query<
          { name: string; partial: number },
          [string]
        >("SELECT name, partial FROM pragma_index_list(?) WHERE origin = 'pk' LIMIT 2")
        .all(table.name)
      if (pk.length > 1 || pk.some((item) => item.partial))
        throw new VerificationError(`Unsupported primary key at ${stage}`)
      if (pk.length) {
        const parts = left
          .query<{ name: string | null; coll: string; desc: number; key: number }, [string]>(
            "SELECT name, coll, desc, key FROM pragma_index_xinfo(?) LIMIT 258",
          )
          .all(pk[0].name)
          .filter((part) => part.key)
        if (
          parts.length !== keys.length ||
          parts.some((part, i) => part.name !== keys[i].name || part.coll !== "BINARY" || part.desc !== 0)
        )
          throw new VerificationError(
            `Unsupported primary-key ordering/collation at ${stage}; require ascending BINARY keys`,
          )
      }
      if (keys.length && !pk.length && (keys.length !== 1 || keys[0].type.toUpperCase() !== "INTEGER"))
        throw new VerificationError(`Unsupported unindexed primary key at ${stage}`)
      const budget = keys.length ? maximum : Math.min(maximum, keylessBytes)
      const bytes = columns
        .map(
          (column) =>
            `CASE typeof(${quote(column.name)}) WHEN 'text' THEN octet_length(${quote(column.name)}) WHEN 'blob' THEN octet_length(${quote(column.name)}) WHEN 'null' THEN 0 ELSE 8 END`,
        )
        .join(" + ")
      if (Buffer.byteLength(bytes) * (columns.length + 1) > 1024 * 1024)
        throw new VerificationError(`Unsupported wide schema at ${stage}; bounded query-expression budget exceeded`)
      // CASE guards each returned value, not merely a later JS size check.
      const fields = columns.flatMap((column, i) => [
        `typeof(${quote(column.name)}) AS t${i}`,
        `CASE WHEN (${bytes}) <= ${budget} THEN CASE WHEN typeof(${quote(column.name)}) IN ('text','blob') THEN CAST(${quote(column.name)} AS BLOB) ELSE ${quote(column.name)} END END AS v${i}`,
      ])
      const sql = `SELECT (${bytes}) AS bytes, ${fields.join(", ")}${rowids.has(table.name) ? ", rowid AS fts_rowid" : ""} FROM ${quote(table.name)}${pk.length ? ` INDEXED BY ${quote(pk[0].name)}` : ""}${keys.length ? ` ORDER BY ${keys.map((key) => `${quote(key.name)} COLLATE BINARY ASC`).join(", ")}` : ` LIMIT ${keylessRows + 1}`}`
      for (const db of [left, right]) {
        const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all()
        if (plan.some((step) => /TEMP B-TREE|AUTOMATIC INDEX/i.test(step.detail)))
          throw new VerificationError(
            `Unsupported query plan at ${stage}; refusing temporary sorting/index construction`,
          )
      }
      if (input.preflight) {
        stats.tablesCompared++
        continue
      }
      const first = left.prepare<Row, []>(sql)
      const second = right.prepare<Row, []>(sql)
      // @ts-ignore bun-types lacks this runtime API; also used by sqlite.bun.ts.
      first.safeIntegers(true)
      // @ts-ignore bun-types lacks this runtime API; also used by sqlite.bun.ts.
      second.safeIntegers(true)
      const ai = first.iterate()
      const bi = second.iterate()
      try {
        if (!keys.length) {
          const multisets: Buffer[][] = []
          for (const iterator of [ai, bi]) {
            const rows: Buffer[] = []
            let total = 0
            for (const row of iterator) {
              abort()
              if (rows.length === keylessRows)
                throw new VerificationError(`Keyless table row limit exceeded at ${stage}`)
              const encoded = encodeRow(readRow(row, columns.length, budget))
              total += encoded.byteLength
              if (total > keylessBytes) throw new VerificationError(`Keyless table byte limit exceeded at ${stage}`)
              rows.push(encoded)
              await new Promise<void>((resolve) => setImmediate(resolve))
            }
            multisets.push(rows.sort(Buffer.compare))
          }
          if (
            multisets[0].length !== multisets[1].length ||
            multisets[0].some((row, i) => !row.equals(multisets[1][i]))
          )
            throw new VerificationError(`Keyless table multiset/row mismatch at ${stage}`)
          stats.rowsCompared += multisets[0].length
          await progress()
        } else {
          for (let ordinal = 1; ; ordinal++) {
            abort()
            const ar = ai.next()
            const br = bi.next()
            if (ar.done && br.done) break
            if (ar.done || br.done) throw new VerificationError(`Missing/extra row at ${stage}, row ${ordinal}`)
            if (
              rowids.has(table.name) &&
              (typeof ar.value.fts_rowid !== "bigint" || ar.value.fts_rowid !== br.value.fts_rowid)
            )
              throw new VerificationError(`FTS external-content rowid mapping mismatch at ${stage}, row ${ordinal}`)
            const av = readRow(ar.value, columns.length, budget)
            const bv = readRow(br.value, columns.length, budget)
            for (const key of keys) {
              const k = columns.indexOf(key)
              if (av[k].type === "null" || bv[k].type === "null")
                throw new VerificationError(`NULL primary key at ${stage}, row ${ordinal}`)
            }
            for (const [i, column] of columns.entries()) {
              if (table.name === "event" && column.name === "data") {
                const ac = eventBytes(av[i], maximum - Number(ar.value.bytes) + byteSize(av[i]), left)
                const bc = eventBytes(bv[i], maximum - Number(br.value.bytes) + byteSize(bv[i]), right)
                if (!ac.equals(bc)) throw new VerificationError(`Event JSON byte mismatch at ${stage}, row ${ordinal}`)
                stats.eventBytesCompared += ac.byteLength
                continue
              }
              if (!equal(av[i], bv[i]))
                throw new VerificationError(`Storage type/value mismatch at ${stage}, row ${ordinal}, column ${i + 1}`)
            }
            stats.rowsCompared++
            if (table.name === "event") stats.eventRowsCompared++
            await progress()
          }
        }
      } finally {
        ai.return?.(undefined)
        bi.return?.(undefined)
        first.finalize()
        second.finalize()
      }
      stats.tablesCompared++
    }
    // Deliver pending signals and reject any changed/sidecar-bearing input before PASS.
    await progress()
    unchanged(source)
    unchanged(destination)
    stats.verified = !input.preflight
    return stats
  } catch (cause) {
    if (cause instanceof VerificationError) throw cause
    throw new VerificationError(
      `Read-only verification failed while ${stage}; input may be corrupt or unsupported. No values or native diagnostics logged`,
    )
  }
}

function quote(name: string) {
  return `"${name.replaceAll('"', '""')}"`
}

function checkPath(input: string) {
  if (
    typeof input !== "string" ||
    !input ||
    input.trim() !== input ||
    /^[a-z][\w+.-]*:/i.test(input) ||
    input.includes("\0")
  )
    throw new VerificationError("Two explicit existing filesystem database paths are required; no URI or memory paths")
  const filename = path.resolve(input)
  let ancestor = path.parse(filename).root
  for (const part of filename.slice(ancestor.length).split(path.sep)) {
    ancestor = path.join(ancestor, part)
    const info = lstatSync(ancestor, { throwIfNoEntry: false })
    if (!info) throw new VerificationError("Database path does not exist; no file will be created")
    if (info.isSymbolicLink()) throw new VerificationError("Symbolic links in database paths are not supported")
    if (ancestor !== filename && !info.isDirectory())
      throw new VerificationError("Database ancestor is not a directory")
    if (ancestor === filename && (!info.isFile() || info.nlink !== 1))
      throw new VerificationError("Database must be a regular file with one hard link")
  }
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (lstatSync(`${filename}${suffix}`, { throwIfNoEntry: false }))
      throw new VerificationError(
        "SQLite sidecar present; require checkpointed, closed inputs. Never remove sidecars to bypass verification",
      )
  return { filename, identity: lstatSync(filename, { bigint: true }) }
}

function unchanged(input: ReturnType<typeof checkPath>) {
  const current = checkPath(input.filename).identity
  if ((["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const).some((key) => current[key] !== input.identity[key]))
    throw new VerificationError("Input database changed during verification; require isolated, stable offline copies")
}

function open(filename: string) {
  const db = new Database(
    `${pathToFileURL(filename).href}?immutable=1&mode=ro`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW,
  )
  db.exec(
    "PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000",
  )
  return db
}

function inventory(db: Database) {
  const rows = db
    .query<
      { id: number; bytes: number },
      []
    >("SELECT rowid AS id, coalesce(octet_length(type),0)+coalesce(octet_length(name),0)+coalesce(octet_length(tbl_name),0)+coalesce(octet_length(sql),0) AS bytes FROM sqlite_schema LIMIT 1025")
    .all()
  if (rows.length > schemaObjects || rows.reduce((sum, row) => sum + row.bytes, 0) > schemaBytes)
    throw new VerificationError("Schema metadata object/byte limit exceeded")
  const kinds = db
    .query<
      { name: string; type: string; wr: number },
      []
    >("SELECT name, type, wr FROM pragma_table_list WHERE schema='main' LIMIT 1026")
    .all()
  const objects = rows
    .map((row) => {
      const item = db
        .query<
          { type: Uint8Array; name: Uint8Array; table: Uint8Array; sql: Uint8Array | null },
          [number]
        >("SELECT CAST(type AS BLOB) AS type, CAST(name AS BLOB) AS name, CAST(tbl_name AS BLOB) AS 'table', CAST(sql AS BLOB) AS sql FROM sqlite_schema WHERE rowid=?")
        .get(row.id)!
      const text = (bytes: Uint8Array) => {
        if (!isUtf8(bytes)) throw new VerificationError("Unsupported non-UTF-8 schema metadata")
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")
      }
      const name = text(item.name)
      const type = text(item.type)
      const kind = type === "table" || type === "view" ? kinds.find((row) => row.name === name) : undefined
      return {
        type,
        name,
        table: text(item.table),
        sql: item.sql === null ? null : text(item.sql),
        kind: kind?.type ?? null,
        wr: kind?.wr ?? null,
      }
    })
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const shadows = new Set<string>()
  for (const table of objects.filter((table) => table.kind === "virtual")) {
    const fts = transcriptFts.find((fts) => fts.name === table.name)
    const definition = table.sql?.match(
      /^CREATE\s+VIRTUAL\s+TABLE\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s+USING\s+fts5\s*\(([^;]*)\)\s*$/i,
    )
    const args = definition?.[5].split(",").map((arg) =>
      arg
        .trim()
        .replace(/\s*=\s*/g, "=")
        .replace(/\s+/g, " ")
        .toLowerCase(),
    )
    if (
      !fts ||
      !definition ||
      (definition[1] ?? definition[2] ?? definition[3] ?? definition[4]) !== table.name ||
      args?.length !== fts.args.length ||
      args.some((arg, i) => arg !== fts.args[i].toLowerCase())
    )
      throw new VerificationError("Unsupported virtual table/module or TranscriptSearch FTS5 layout")
    for (const suffix of ["data", "idx", "config", "docsize", ...(fts.content === null ? ["content"] : [])]) {
      const name = `${table.name}_${suffix}`
      if (!objects.some((item) => item.name === name && item.kind === "shadow"))
        throw new VerificationError("Unsupported or missing FTS5 shadow table metadata")
      shadows.add(name)
    }
  }
  if (objects.some((table) => table.kind === "shadow" && !shadows.has(table.name)))
    throw new VerificationError("Unsupported FTS5 shadow table metadata; no supported owning virtual table")
  return objects
}

function readRow(row: Row, count: number, maximum: number): Cell[] {
  if (typeof row.bytes !== "bigint" || row.bytes < 0 || row.bytes > BigInt(maximum))
    throw new VerificationError("Row byte cap exceeded before loading values; verification cannot skip oversized rows")
  return Array.from({ length: count }, (_, i) => {
    const type = row[`t${i}`]
    const value = row[`v${i}`]
    if (
      typeof type !== "string" ||
      !(
        (type === "null" && value === null) ||
        (type === "integer" && typeof value === "bigint") ||
        (type === "real" && typeof value === "number") ||
        ((type === "text" || type === "blob") && value instanceof Uint8Array)
      )
    )
      throw new VerificationError("Unsupported SQLite storage type or value")
    return { type, value: value as Cell["value"] }
  })
}

function equal(a: Cell, b: Cell) {
  if (a.type !== b.type) return false
  if (a.value instanceof Uint8Array && b.value instanceof Uint8Array)
    return Buffer.from(a.value.buffer, a.value.byteOffset, a.value.byteLength).equals(b.value)
  return Object.is(a.value, b.value)
}

function byteSize(cell: Cell) {
  return cell.value instanceof Uint8Array ? cell.value.byteLength : cell.type === "null" ? 0 : 8
}

function encodeRow(cells: Cell[]) {
  return Buffer.concat(
    cells.map((cell) => {
      const prefix = Buffer.alloc(5)
      prefix[0] = ["null", "integer", "real", "text", "blob"].indexOf(cell.type)
      const bytes = cell.value instanceof Uint8Array ? cell.value : Buffer.alloc(cell.type === "null" ? 0 : 8)
      if (typeof cell.value === "bigint") (bytes as Buffer).writeBigInt64LE(cell.value)
      if (typeof cell.value === "number") (bytes as Buffer).writeDoubleLE(cell.value)
      prefix.writeUInt32LE(bytes.byteLength, 1)
      return Buffer.concat([prefix, bytes])
    }),
  )
}

// Independent format verification: do not import EventData or the compressor.
function eventBytes(cell: Cell, maximum: number, db: Database) {
  if (!(cell.value instanceof Uint8Array) || (cell.type !== "text" && cell.type !== "blob"))
    throw new VerificationError("Event data must be serialized JSON TEXT or an OCEZ v1 BLOB")
  const stored = Buffer.from(cell.value.buffer, cell.value.byteOffset, cell.value.byteLength)
  const bytes = (() => {
    if (cell.type === "text") return stored
    if (stored.length <= 41 || !stored.subarray(0, 4).equals(Buffer.from("OCEZ")) || stored[4] !== 1)
      throw new VerificationError("Invalid OCEZ magic/version/header")
    const size = stored.readUInt32LE(5)
    if (size < 1 || size > maximum)
      throw new VerificationError("OCEZ declared length exceeds the row/decompression cap")
    const frame = stored.subarray(41)
    if (!createHash("sha256").update(frame).digest().equals(stored.subarray(9, 41)))
      throw new VerificationError("OCEZ SHA-256 checksum mismatch")
    verifyFrame(frame, size, maximum)
    const result = zlib.zstdDecompressSync(frame, {
      maxOutputLength: size,
      params: { [zlib.constants.ZSTD_d_windowLogMax]: Math.ceil(Math.log2(Math.max(8388608, maximum))) },
    })
    if (result.byteLength !== size) throw new VerificationError("OCEZ decompressed length mismatch")
    return result
  })()
  if (bytes.byteLength > maximum) throw new VerificationError("Logical event bytes exceed row cap")
  // SQLite's JSON parser can accept a valid prefix followed by NUL; JSON cannot contain raw NUL.
  if (
    bytes.includes(0) ||
    !isUtf8(bytes) ||
    db.query<{ valid: number }, [Uint8Array]>("SELECT json_valid(CAST(? AS TEXT)) AS valid").get(bytes)?.valid !== 1
  )
    throw new VerificationError("Invalid serialized event UTF-8/JSON; no contents logged")
  return bytes
}

function verifyFrame(frame: Buffer, size: number, maximum: number) {
  const invalid = () => new VerificationError("Invalid, unsupported or truncated Zstandard frame")
  if (frame.length < 6 || frame.readUInt32LE(0) !== 0xfd2fb528) throw invalid()
  const flags = frame[4]
  const single = (flags & 32) !== 0
  if (flags & 27) throw invalid() // Reserved/unused bits and dictionaries are not codec output.
  let offset = 5
  if (!single) {
    const descriptor = frame[offset++]
    const base = 2 ** (10 + (descriptor >> 3))
    if (base + (base / 8) * (descriptor & 7) > Math.max(8388608, maximum)) throw invalid()
  }
  const length = [single ? 1 : 0, 2, 4, 8][flags >> 6]
  if (offset + length > frame.length) throw invalid()
  if (length) {
    const content =
      length === 8 ? frame.readBigUInt64LE(offset) : BigInt(frame.readUIntLE(offset, length) + (length === 2 ? 256 : 0))
    if (content !== BigInt(size)) throw invalid()
  }
  offset += length
  for (;;) {
    if (offset + 3 > frame.length) throw invalid()
    const block = frame.readUIntLE(offset, 3)
    offset += 3
    const type = (block >> 1) & 3
    const bytes = block >> 3
    if (type === 3 || bytes > 131072) throw invalid()
    offset += type === 1 ? 1 : bytes
    if (offset > frame.length) throw invalid()
    if (block & 1) break
  }
  if (flags & 4) offset += 4
  if (offset !== frame.length) throw invalid()
}

const help = `Independent offline V1 SQLite content verifier (read-only).

Usage: bun script/event-verify.ts --source BACKUP --destination COMPACT [options]
--source PATH          Explicit existing pristine offline source (required)
--destination PATH     Explicit existing compressed/VACUUM output (required)
--max-row-bytes N      Stored/logical row cap, default 268435456, max 1073741824
--preflight            Metadata/plans only; never certifies contents (verified=false)
--help                 Show help

Inputs must be distinct, closed, UTF-8, sidecar-free regular files with no links.
Immutable read-only: no migrations, writes, checkpoints, VACUUM or file creation.
All columns/types and schema are compared; only event.data TEXT/OCEZ may differ.
Stable indexed primary keys; FTS-referenced content rowid mappings must also match.
Known TranscriptSearch FTS5 schemas and ALL shadow data are compared, not hidden columns.
Other virtual/generated layouts are unsupported. Keyless tables: max 1024 rows/16 MiB.
Limits or corruption FAIL verification, never skip. Use verified MemoryMax=8G,
MemorySwapMax=0 for final comparison. Requires SQLite >=3.43 and bounded Zstd.
Exit: 0 complete (preflight is metadata only), 1 mismatch/safety/unsupported, 2 usage, 130 INT, 143 TERM.
`

if (import.meta.main) {
  const controller = new AbortController()
  let interrupted = 0
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.on(signal, () => {
      interrupted ||= code
      controller.abort()
    })
  try {
    let parsed: ReturnType<typeof parseArgs>
    try {
      parsed = parseArgs({
        options: {
          source: { type: "string" },
          destination: { type: "string" },
          "max-row-bytes": { type: "string" },
          preflight: { type: "boolean" },
          help: { type: "boolean" },
        },
        strict: true,
        allowPositionals: false,
      })
    } catch {
      throw new UsageError("Unknown/missing option; use --help")
    }
    if (parsed.values.help) console.log(help)
    else {
      if (typeof parsed.values.source !== "string" || typeof parsed.values.destination !== "string")
        throw new UsageError("Provide both --source PATH and --destination PATH; use --help")
      let last = Date.now()
      const result = await verifyDatabases(
        {
          source: parsed.values.source,
          destination: parsed.values.destination,
          maxRowBytes:
            parsed.values["max-row-bytes"] === undefined ? undefined : Number(parsed.values["max-row-bytes"]),
          signal: controller.signal,
          preflight: parsed.values.preflight === true,
        },
        (stats) => {
          if (stats.rowsCompared % 1000 !== 0 && Date.now() - last < 5000) return
          console.error(JSON.stringify(stats))
          last = Date.now()
        },
      )
      console.log(JSON.stringify(result))
    }
  } catch (cause) {
    console.error(
      cause instanceof UsageError || cause instanceof VerificationError
        ? cause.message
        : "Read-only verification failed; no values logged",
    )
    process.exitCode = interrupted || (cause instanceof UsageError ? 2 : 1)
  }
}
