import { constants, Database } from "bun:sqlite"
import { lstatSync, statfsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import zlib from "node:zlib"
import { EventData } from "../src/event/data"

export type Options = {
  db: string
  mode: "dry-run" | "write"
  offline?: boolean
  maxPayloadBytes?: number
  maxScanned?: number
  maxConverted?: number
  pageRows?: number
  minFreeBytes?: number
  checkpointRows?: number
  maxWalBytes?: number
  busyTimeoutMs?: number
  signal?: AbortSignal
}

export type Stats = {
  examinedRows: number
  eligibleRows: number
  compressedRows: number
  updatedRows: number
  skippedSmallRows: number
  alreadyCompressedRows: number
  nonprofitableRows: number
  oversizedRows: number
  inputBytes: number
  outputBytes: number
  savedBytes: number
  lastRowid: string | null
  checkpoints: number
  peakWalBytes: number
  peakRssBytes: number
  stopped: "complete" | "max-scanned" | "max-converted" | "interrupted"
}

type Metadata = { rowid: string; storage: string; bytes: number }

class UsageError extends Error {}
class SafetyError extends Error {}

export async function compressEvents(input: Options, onProgress?: (stats: Stats) => void): Promise<Stats> {
  const options = validateOptions(input)
  const filename = checkPath(options.db, options.mode)
  const identity = lstatSync(filename)
  const stats: Stats = {
    examinedRows: 0,
    eligibleRows: 0,
    compressedRows: 0,
    updatedRows: 0,
    skippedSmallRows: 0,
    alreadyCompressedRows: 0,
    nonprofitableRows: 0,
    oversizedRows: 0,
    inputBytes: 0,
    outputBytes: 0,
    savedBytes: 0,
    lastRowid: null,
    checkpoints: 0,
    peakWalBytes: 0,
    peakRssBytes: process.memoryUsage.rss(),
    stopped: "complete",
  }
  let stage = "opening the database"
  try {
    // Immutable mode cannot replay WAL. checkPath refuses ALL sidecars for dry-run.
    using db = new Database(
      options.mode === "dry-run" ? `${pathToFileURL(filename).href}?immutable=1&mode=ro` : filename,
      constants.SQLITE_OPEN_NOFOLLOW |
        constants.SQLITE_OPEN_URI |
        (options.mode === "dry-run" ? constants.SQLITE_OPEN_READONLY : constants.SQLITE_OPEN_READWRITE),
    )
    const opened = lstatSync(filename)
    if (identity.dev !== opened.dev || identity.ino !== opened.ino)
      throw new SafetyError("Database path changed while opening; use an isolated, stable working directory")
    db.exec(`
      PRAGMA busy_timeout = ${options.busyTimeoutMs};
      PRAGMA cache_size = -8192;
      PRAGMA mmap_size = 0;
      PRAGMA temp_store = MEMORY;
      PRAGMA trusted_schema = OFF;
      PRAGMA foreign_keys = ON;
    `)
    if (options.mode === "dry-run") db.exec("PRAGMA query_only = ON")
    stage = "checking SQLite compatibility and event schema"
    checkSchema(db)
    if (typeof zlib.zstdDecompressSync !== "function")
      throw new SafetyError("This Bun runtime lacks bounded native Zstandard decompression; upgrade Bun")

    const space = (bytes: number) => {
      const disk = statfsSync(path.dirname(filename))
      const available = disk.bavail * disk.bsize
      const required = options.minFreeBytes + bytes * 3
      if (available < required)
        throw new SafetyError(
          `Insufficient free space: ${available} bytes available, ${required} required. Free space on the working-copy filesystem before restarting`,
        )
    }
    const walBytes = () => {
      const size = lstatSync(`${filename}-wal`, { throwIfNoEntry: false })?.size ?? 0
      stats.peakWalBytes = Math.max(stats.peakWalBytes, size)
      return size
    }
    const checkpoint = () => {
      stage = "checkpointing WAL"
      space(options.maxPayloadBytes)
      walBytes()
      const result = db
        .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
        .get()
      if (!result || result.busy !== 0 || result.log !== result.checkpointed || walBytes() !== 0)
        throw new SafetyError(
          "WAL checkpoint blocked or incomplete. Close every other connection to this working copy, then restart",
        )
      stats.checkpoints++
    }

    if (options.mode === "write") {
      stage = "acquiring exclusive offline ownership"
      space(options.maxPayloadBytes)
      db.exec("PRAGMA locking_mode = EXCLUSIVE")
      const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()
      if (journal?.journal_mode !== "wal") throw new SafetyError("Cannot enable WAL on this working copy")
      db.exec("PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0; PRAGMA journal_size_limit = 0")
      db.transaction(() => {}).exclusive()
      // Recheck under the retained exclusive lock, before any event update.
      checkSchema(db)
      checkpoint()
    }

    const columns = "CAST(event.rowid AS TEXT) AS rowid, typeof(data) AS storage, octet_length(data) AS bytes"
    const first = db.query<Metadata, [number]>(`SELECT ${columns} FROM event ORDER BY event.rowid LIMIT ?`)
    const next = db.query<Metadata, [bigint, number]>(
      `SELECT ${columns} FROM event WHERE event.rowid > ? ORDER BY event.rowid LIMIT ?`,
    )
    const read = db.query<{ data: Uint8Array }, [bigint, number, number]>(`
      SELECT CAST(data AS BLOB) AS data FROM event
      WHERE rowid = ? AND typeof(data) = 'text' AND octet_length(data) = ? AND octet_length(data) <= ?
    `)
    const valid = db.query<{ valid: number }, [string]>("SELECT json_valid(?) AS valid")
    const update =
      options.mode === "write"
        ? db.query("UPDATE event SET data = ? WHERE rowid = ? AND typeof(data) = 'text' AND CAST(data AS BLOB) = ?")
        : undefined
    const verify = db.query<{ valid: number }, [bigint, Uint8Array]>(
      "SELECT typeof(data) = 'blob' AND data = ?2 AS valid FROM event WHERE rowid = ?1",
    )
    const write = db.transaction((rowid: bigint, original: Uint8Array, encoded: Uint8Array) => {
      if (update?.run(encoded, rowid, original).changes !== 1)
        throw new SafetyError("Guarded UPDATE did not affect exactly one intended TEXT row; transaction rolled back")
      if (verify.get(rowid, encoded)?.valid !== 1)
        throw new SafetyError("Stored BLOB verification failed; transaction rolled back")
    })

    for (;;) {
      if (options.signal?.aborted) {
        stats.stopped = "interrupted"
        break
      }
      if (options.maxScanned !== undefined && stats.examinedRows >= options.maxScanned) {
        stats.stopped = "max-scanned"
        break
      }
      if (options.maxConverted !== undefined && stats.compressedRows >= options.maxConverted) {
        stats.stopped = "max-converted"
        break
      }
      stage = "reading bounded row metadata"
      const limit = Math.min(options.pageRows, (options.maxScanned ?? Infinity) - stats.examinedRows)
      const page = stats.lastRowid === null ? first.all(limit) : next.all(BigInt(stats.lastRowid), limit)
      if (page.length === 0) break
      for (const row of page) {
        if (
          options.signal?.aborted ||
          (options.maxConverted !== undefined && stats.compressedRows >= options.maxConverted)
        )
          break
        stage = `examining rowid ${row.rowid}`
        stats.examinedRows++
        stats.lastRowid = row.rowid
        if (row.storage === "blob") stats.alreadyCompressedRows++
        else if (row.storage !== "text") throw new SafetyError(`Unexpected event storage type at rowid ${row.rowid}`)
        else if (row.bytes > options.maxPayloadBytes) stats.oversizedRows++
        else if (row.bytes < 4096) stats.skippedSmallRows++
        else {
          stats.eligibleRows++
          stage = `loading bounded TEXT at rowid ${row.rowid}`
          const original = read.get(BigInt(row.rowid), row.bytes, options.maxPayloadBytes)?.data
          if (!original || original.byteLength !== row.bytes)
            throw new SafetyError(
              `TEXT changed or became unavailable at rowid ${row.rowid}; restart on an offline copy`,
            )
          const json = decodeUtf8(original, row.rowid)
          if (valid.get(json)?.valid !== 1)
            throw new SafetyError(`Invalid JSON at rowid ${row.rowid}; no payload logged`)
          if (!Buffer.from(json).equals(original)) throw new SafetyError(`UTF-8 byte mismatch at rowid ${row.rowid}`)
          stage = `compressing and verifying rowid ${row.rowid}`
          const encoded = EventData.encodeJson(json)
          if (typeof encoded === "string") {
            stats.nonprofitableRows++
            stats.inputBytes += row.bytes
            stats.outputBytes += row.bytes
          } else {
            const restored = zlib.zstdDecompressSync(encoded.subarray(41), { maxOutputLength: row.bytes })
            if (!restored.equals(original))
              throw new SafetyError(`Compression round-trip byte mismatch at rowid ${row.rowid}`)
            if (options.mode === "write") {
              stage = `updating rowid ${row.rowid}`
              checkPath(filename, "write")
              const current = lstatSync(filename)
              if (current.dev !== identity.dev || current.ino !== identity.ino)
                throw new SafetyError("Working-copy identity changed; refusing further writes")
              space(row.bytes)
              // Exactly one bounded payload per transaction, compression finished before BEGIN.
              write.immediate(BigInt(row.rowid), original, encoded)
              stats.updatedRows++
            }
            stats.compressedRows++
            stats.inputBytes += row.bytes
            stats.outputBytes += encoded.byteLength
            stats.savedBytes += row.bytes - encoded.byteLength
            if (
              options.mode === "write" &&
              (walBytes() >= options.maxWalBytes || stats.updatedRows % options.checkpointRows === 0)
            )
              checkpoint()
          }
        }
        stats.peakRssBytes = Math.max(stats.peakRssBytes, process.memoryUsage.rss())
        onProgress?.({ ...stats })
        // Let SIGINT/SIGTERM run only at safe, committed row boundaries.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    if (options.mode === "write") checkpoint()
    stats.peakRssBytes = Math.max(stats.peakRssBytes, process.memoryUsage.rss())
    return stats
  } catch (cause) {
    if (cause instanceof SafetyError) throw cause
    const code =
      cause instanceof Error && "code" in cause && typeof cause.code === "string" && /^[A-Z_0-9]+$/.test(cause.code)
        ? cause.code
        : "unknown error"
    throw new SafetyError(
      `Failed while ${stage} (${code}). Stop other connections, check disk space and SQLite compatibility. Earlier committed rows are retained; restart from the beginning. No payload logged`,
    )
  }
}

function validateOptions(input: Options) {
  if (input.mode !== "dry-run" && input.mode !== "write") throw new UsageError("Select --dry-run or --write")
  if (input.mode === "write" && input.offline !== true)
    throw new UsageError("Write mode requires --offline: acknowledge this is an isolated, offline working copy")
  const options = {
    ...input,
    maxPayloadBytes: input.maxPayloadBytes ?? 16 * 1024 * 1024,
    pageRows: input.pageRows ?? 128,
    minFreeBytes: input.minFreeBytes ?? 1024 * 1024 * 1024,
    checkpointRows: input.checkpointRows ?? 32,
    maxWalBytes: input.maxWalBytes ?? 32 * 1024 * 1024,
    busyTimeoutMs: input.busyTimeoutMs ?? 5000,
  }
  for (const [name, value, minimum, maximum] of [
    ["max-payload-bytes", options.maxPayloadBytes, 1, 64 * 1024 * 1024],
    ["page-rows", options.pageRows, 1, 1024],
    ["min-free-bytes", options.minFreeBytes, 0, Number.MAX_SAFE_INTEGER],
    ["checkpoint-rows", options.checkpointRows, 1, 1024],
    ["max-wal-bytes", options.maxWalBytes, 1, 64 * 1024 * 1024],
    ["busy-timeout-ms", options.busyTimeoutMs, 0, 60_000],
    ["max-scanned", options.maxScanned ?? 1, 1, Number.MAX_SAFE_INTEGER],
    ["max-converted", options.maxConverted ?? 1, 1, Number.MAX_SAFE_INTEGER],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new UsageError(`--${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return options
}

function checkPath(input: string, mode: Options["mode"]) {
  if (!input || input.trim() !== input || !input.trim() || /^[a-z][\w+.-]*:/i.test(input) || input.includes("\0"))
    throw new SafetyError("An explicit filesystem database path is required; no URI, blank or memory databases")
  const filename = path.resolve(input)
  // Reject protected names BEFORE even statting their parent directories.
  if (
    /^opencode\.db(?:[.-]|$)/i.test(path.basename(filename)) ||
    /^opencode-prebackfill-/i.test(path.basename(filename))
  )
    throw new SafetyError("Protected production/backup database name refused; use a separately named working copy")
  const parts = filename.slice(path.parse(filename).root.length).split(path.sep)
  let ancestor = path.parse(filename).root
  for (const part of parts) {
    ancestor = path.join(ancestor, part)
    const info = lstatSync(ancestor, { throwIfNoEntry: false })
    if (!info) throw new SafetyError("Database path does not exist; refusing accidental database creation")
    if (info.isSymbolicLink())
      throw new SafetyError("Database path or ancestor is a symbolic link; use a real isolated path")
    if (ancestor !== filename && !info.isDirectory()) throw new SafetyError("Database ancestor is not a directory")
    if (ancestor === filename && (!info.isFile() || info.nlink !== 1))
      throw new SafetyError("Database must be a regular file with exactly one hard link")
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const info = lstatSync(`${filename}${suffix}`, { throwIfNoEntry: false })
    if (!info) continue
    if (mode === "dry-run")
      throw new SafetyError(
        "Dry-run requires a checkpointed, sidecar-free offline copy; never remove sidecars to bypass this check",
      )
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
      throw new SafetyError("SQLite sidecar must be a regular, non-symbolic file with exactly one hard link")
  }
  return filename
}

function checkSchema(db: Database) {
  const version = db
    .query<{ version: string }, []>("SELECT sqlite_version() AS version")
    .get()!
    .version.split(".")
    .map(Number)
  if (version[0] < 3 || (version[0] === 3 && version[1] < 43))
    throw new SafetyError("SQLite 3.43.0 or later is required for metadata-only octet_length(); upgrade Bun")
  if (db.query<{ encoding: string }, []>("PRAGMA encoding").get()?.encoding !== "UTF-8")
    throw new SafetyError("Only UTF-8 SQLite databases are supported; refusing to transcode historical JSON")
  const table = db.query<{ type: string; wr: number }, []>("PRAGMA main.table_list('event')").get()
  const columns = db.query<{ name: string; hidden: number }, []>("PRAGMA main.table_xinfo('event')").all()
  if (
    table?.type !== "table" ||
    table.wr !== 0 ||
    ["id", "aggregate_id", "seq", "type", "data"].some((name) => !columns.some((column) => column.name === name)) ||
    columns.some((column) => column.hidden !== 0 || column.name.toLowerCase() === "rowid")
  )
    throw new SafetyError("Unsupported event schema: expected ordinary event columns and an unshadowed implicit rowid")
  if (
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'event' COLLATE NOCASE LIMIT 1").get()
  )
    throw new SafetyError("Event-table triggers are not supported: they could modify identity or other tables")
  if (
    db
      .query(
        `
    SELECT 1 FROM sqlite_schema AS s JOIN pragma_foreign_key_list(s.name) AS f
    WHERE s.type = 'table' AND f."table" = 'event' COLLATE NOCASE AND f."to" = 'data' COLLATE NOCASE LIMIT 1
  `,
      )
      .get()
  )
    throw new SafetyError("Foreign keys referencing event.data are not supported")
}

function decodeUtf8(bytes: Uint8Array, rowid: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new SafetyError(`Invalid UTF-8 at rowid ${rowid}; no payload logged`)
  }
}

const help = `Offline V1 historical event compression (never run against production).

Usage:
  bun script/event-compress.ts --db PATH --dry-run [options]
  bun script/event-compress.ts --db PATH --write --offline [options]

--db PATH                 Existing, separately named working copy (required)
--dry-run                 Immutable read-only; requires NO SQLite sidecars
--write --offline         Explicitly opt in to writes on an isolated offline copy
--max-scanned N           Stop after N examined rows, including skips
--max-converted N         Stop after N verified profitable rows (also in dry-run)
--max-payload-bytes N     Per-row cap, default 16777216, maximum 67108864
--page-rows N             Metadata page size, default 128, maximum 1024
--min-free-bytes N        Disk reserve, default 1073741824, plus 3x row budget
--checkpoint-rows N       Checkpoint every N updates, default 32, maximum 1024
--max-wal-bytes N         Checkpoint threshold, default 33554432, maximum 67108864
--busy-timeout-ms N       SQLite lock wait, default 5000, maximum 60000
--help                    Show this help

One row per transaction. WAL can exceed its threshold by one bounded transaction.
Restart from the beginning: BLOBs are skipped, no persisted rowid cursor.
Existing BLOBs and skipped TEXT are NOT validated. No VACUUM, deletion or cutover.
JSON summaries contain counts/bytes only. savedBytes is potential in dry-run;
database file size does not shrink until separate operator-managed compaction.
Exit: 0 success/bounded stop, 1 safety/SQLite failure, 2 usage, 130 INT, 143 TERM.
`

if (import.meta.main) {
  const controller = new AbortController()
  let interrupted = 0
  process.on("SIGINT", () => {
    interrupted = 130
    controller.abort()
  })
  process.on("SIGTERM", () => {
    interrupted = 143
    controller.abort()
  })
  try {
    let parsed: ReturnType<typeof parseArgs>
    try {
      parsed = parseArgs({
        args: process.argv.slice(2),
        options: {
          db: { type: "string" },
          "dry-run": { type: "boolean" },
          write: { type: "boolean" },
          offline: { type: "boolean" },
          help: { type: "boolean" },
          ...Object.fromEntries(
            [
              "max-scanned",
              "max-converted",
              "max-payload-bytes",
              "page-rows",
              "min-free-bytes",
              "checkpoint-rows",
              "max-wal-bytes",
              "busy-timeout-ms",
            ].map((name) => [name, { type: "string" as const }]),
          ),
        },
        strict: true,
        allowPositionals: false,
      })
    } catch {
      throw new UsageError("Unknown option or missing option value; use --help")
    }
    const values = parsed.values
    if (values.help) {
      console.log(help)
    } else {
      if (typeof values.db !== "string" || !values.db || !!values.write === !!values["dry-run"])
        throw new UsageError("Provide --db PATH and exactly one of --dry-run or --write --offline; use --help")
      const number = (name: string) => (values[name] === undefined ? undefined : Number(values[name]))
      const options = validateOptions({
        db: values.db,
        mode: values.write ? "write" : "dry-run",
        offline: values.offline === true,
        maxScanned: number("max-scanned"),
        maxConverted: number("max-converted"),
        maxPayloadBytes: number("max-payload-bytes"),
        pageRows: number("page-rows"),
        minFreeBytes: number("min-free-bytes"),
        checkpointRows: number("checkpoint-rows"),
        maxWalBytes: number("max-wal-bytes"),
        busyTimeoutMs: number("busy-timeout-ms"),
        signal: controller.signal,
      })
      let last = Date.now()
      const result = await compressEvents(options, (stats) => {
        if (stats.examinedRows % 1000 !== 0 && Date.now() - last < 5000) return
        console.error(JSON.stringify(stats))
        last = Date.now()
      })
      console.log(JSON.stringify(result))
      process.exitCode = interrupted
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "Compression failed; no payload logged")
    process.exitCode = interrupted || (cause instanceof UsageError ? 2 : 1)
  }
}
