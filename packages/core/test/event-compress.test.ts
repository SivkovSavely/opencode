import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import fs from "node:fs/promises"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { compressEvents } from "../script/event-compress"
import { EventTable } from "../src/event/sql"
import { tmpdir } from "./fixture/tmpdir"

function payload(bytes = 4096) {
  return JSON.stringify({ text: "a".repeat(bytes - 11) })
}

function fixture(
  filename: string,
  rows: { data: string | Uint8Array | number; rowid?: bigint; asText?: boolean }[],
  dataColumn = "TEXT NOT NULL",
) {
  using db = new Database(filename, { create: true, strict: true })
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, owner_id TEXT);
    CREATE TABLE event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data ${dataColumn}
    );
    CREATE UNIQUE INDEX event_aggregate_seq_idx ON event(aggregate_id, seq);
    CREATE INDEX event_aggregate_type_seq_idx ON event(aggregate_id, type, seq);
    CREATE TABLE unrelated (value TEXT);
    CREATE TABLE audit (value TEXT);
    CREATE TRIGGER unrelated_insert AFTER INSERT ON unrelated BEGIN
      INSERT INTO audit(value) VALUES (NEW.value);
    END;
  `)
  db.query("INSERT INTO event_sequence VALUES ('synthetic', ?, 'owner')").run(rows.length)
  rows.forEach((row, index) => {
    db.query(
      `INSERT INTO event(rowid, id, aggregate_id, seq, type, data)
       VALUES (?, ?, 'synthetic', ?, 'test.compression.1', ${row.asText ? "CAST(? AS TEXT)" : "?"})`,
    ).run(row.rowid ?? BigInt(index + 1), `evt_${index}`, index, row.data)
  })
}

function stored(filename: string) {
  using db = new Database(filename, { readonly: true, create: false })
  return db
    .query<
      {
        rowid: string
        id: string
        aggregate_id: string
        seq: number
        type: string
        storage: string
        bytes: Uint8Array
      },
      []
    >(
      `SELECT CAST(rowid AS TEXT) AS rowid, id, aggregate_id, seq, type,
              typeof(data) AS storage, CAST(data AS BLOB) AS bytes
       FROM event ORDER BY event.rowid`,
    )
    .all()
}

function frame(json: string) {
  const compressed = Bun.zstdCompressSync(Buffer.from(json), { level: 3 })
  const result = Buffer.alloc(41 + compressed.length)
  result.write("OCEZ")
  result[4] = 1
  result.writeUInt32LE(Buffer.byteLength(json), 5)
  createHash("sha256").update(compressed).digest().copy(result, 9)
  result.set(compressed, 41)
  return result
}

function noise() {
  const random = Buffer.concat(
    Array.from({ length: 256 }, (_, index) => createHash("sha256").update(`noise-${index}`).digest()),
  )
  const ascii = Array.from({ length: 95 }, (_, index) => index + 32).filter((byte) => byte !== 34 && byte !== 92)
  const lead3 = [225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 238, 239]
  const output: number[] = []
  let index = 0
  const next = () => random[index++]
  // Mix valid UTF-8 sequence lengths so the byte histogram does not make an easy Huffman win.
  while (output.length < 4085) {
    const choice = next()
    output.push(
      ...(choice < 176
        ? [ascii[next() % ascii.length]]
        : choice < 232
          ? [194 + (next() % 30), 128 + (next() % 64)]
          : choice < 248
            ? [lead3[next() % lead3.length], 128 + (next() % 64), 128 + (next() % 64)]
            : [241 + (next() % 3), 128 + (next() % 64), 128 + (next() % 64), 128 + (next() % 64)]),
    )
  }
  return JSON.stringify({ text: Buffer.from(output).toString("utf8") })
}

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "script/event-compress.ts", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

describe("offline event compression", () => {
  test("dry-run measures the inclusive UTF-8 threshold without changing database bytes or creating sidecars", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    const unicode = JSON.stringify({ text: "\u96ea".repeat(1361) + "aa" })
    expect(Buffer.byteLength(unicode)).toBe(4096)
    expect(unicode.length).toBeLessThan(4096)
    fixture(filename, [
      { data: payload(4095) },
      { data: payload() },
      { data: unicode },
      { data: Buffer.from("not a valid codec BLOB") },
    ])
    const before = await Bun.file(filename).bytes()
    const mtime = (await fs.stat(filename, { bigint: true })).mtimeNs
    const progress: Awaited<ReturnType<typeof compressEvents>>[] = []

    const result = await compressEvents({ db: filename, mode: "dry-run", pageRows: 1 }, (stats) => {
      progress.push(stats)
    })

    expect(result).toMatchObject({
      examinedRows: 4,
      eligibleRows: 2,
      compressedRows: 2,
      updatedRows: 0,
      skippedSmallRows: 1,
      alreadyCompressedRows: 1,
      nonprofitableRows: 0,
      oversizedRows: 0,
      inputBytes: 8192,
      outputBytes: frame(payload()).length + frame(unicode).length,
      savedBytes: 8192 - frame(payload()).length - frame(unicode).length,
      lastRowid: "4",
      checkpoints: 0,
      peakWalBytes: 0,
      stopped: "complete",
    })
    expect(result.peakRssBytes).toBeGreaterThan(0)
    expect(progress.map((stats) => stats.examinedRows)).toEqual([1, 2, 3, 4])
    expect(progress.map((stats) => stats.lastRowid)).toEqual(["1", "2", "3", "4"])
    expect(await Bun.file(filename).bytes()).toEqual(before)
    expect((await fs.stat(filename, { bigint: true })).mtimeNs).toBe(mtime)
    expect(await fs.readdir(tmp.path)).toEqual(["events.sqlite"])
  })

  test("write preserves serialized whitespace, Unicode, escapes and duplicate keys byte-for-byte", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    const json = ` \n{ "text" : "${"\u96ea".repeat(1500)}", "escaped": "\\u96ea\\ud83d\\ude80\\n\\t\\\\\\\"", "duplicate": 1, "duplicate": 2 }\n `
    fixture(filename, [{ data: json }, { data: payload(4095) }])
    const before = stored(filename)

    const result = await compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })

    expect(result).toMatchObject({ examinedRows: 2, compressedRows: 1, updatedRows: 1, stopped: "complete" })
    const after = stored(filename)
    expect(after[0]).toEqual({ ...before[0], storage: "blob", bytes: frame(json) })
    expect(after[1]).toEqual(before[1])
    expect(Buffer.from(Bun.zstdDecompressSync(after[0].bytes.subarray(41)))).toEqual(Buffer.from(json))
    using db = new Database(filename, { readonly: true, create: false })
    expect(
      drizzle({ client: db })
        .select()
        .from(EventTable)
        .orderBy(EventTable.seq)
        .all()
        .map((row) => row.data),
    ).toEqual([
      { text: "\u96ea".repeat(1500), escaped: '\u96ea\ud83d\ude80\n\t\\"', duplicate: 2 },
      { text: "a".repeat(4084) },
    ])
    expect(db.query("SELECT * FROM event_sequence").all()).toEqual([
      { aggregate_id: "synthetic", seq: 2, owner_id: "owner" },
    ])
    expect(db.query("SELECT * FROM audit").all()).toEqual([])
    expect(db.query("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all()).toEqual([
      { name: "unrelated_insert" },
    ])
  })

  test("skips unchecked BLOBs and nonprofitable JSON without counting them toward max-converted", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    const json = noise()
    expect(Buffer.byteLength(json)).toBeGreaterThanOrEqual(4096)
    expect(frame(json).length).toBeGreaterThanOrEqual(Buffer.byteLength(json))
    fixture(filename, [{ data: Buffer.from("OCEZ\xff") }, { data: json }, { data: payload() }, { data: payload() }])
    const before = stored(filename)

    const result = await compressEvents({
      db: filename,
      mode: "write",
      offline: true,
      minFreeBytes: 0,
      maxConverted: 1,
    })

    expect(result).toMatchObject({
      examinedRows: 3,
      eligibleRows: 2,
      compressedRows: 1,
      updatedRows: 1,
      alreadyCompressedRows: 1,
      nonprofitableRows: 1,
      inputBytes: Buffer.byteLength(json) + 4096,
      outputBytes: Buffer.byteLength(json) + frame(payload()).length,
      savedBytes: 4096 - frame(payload()).length,
      lastRowid: "3",
      stopped: "max-converted",
    })
    const after = stored(filename)
    expect(after[0]).toEqual(before[0])
    expect(after[1]).toEqual(before[1])
    expect(after[2].storage).toBe("blob")
    expect(after[3]).toEqual(before[3])
  })

  test("preserves additional ordinary historical columns while updating only data", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [{ data: payload() }])
    {
      using db = new Database(filename, { create: false })
      db.exec("ALTER TABLE event ADD COLUMN created INTEGER NOT NULL DEFAULT 123456789")
    }
    expect(await compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).toMatchObject({
      updatedRows: 1,
    })
    using db = new Database(filename, { readonly: true, create: false })
    expect(db.query("SELECT id, created, typeof(data) AS storage FROM event").get()).toEqual({
      id: "evt_0",
      created: 123456789,
      storage: "blob",
    })
  })

  test("skips oversized malformed UTF-8 before decoding and accepts a payload exactly at the byte cap", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [
      { data: Buffer.alloc(8193, 0xff), asText: true },
      { data: payload(8193) },
      { data: payload(8192) },
    ])
    const before = stored(filename)

    const result = await compressEvents({
      db: filename,
      mode: "write",
      offline: true,
      minFreeBytes: 0,
      maxPayloadBytes: 8192,
      pageRows: 2,
    })

    expect(result).toMatchObject({
      examinedRows: 3,
      eligibleRows: 1,
      oversizedRows: 2,
      updatedRows: 1,
      inputBytes: 8192,
    })
    expect(stored(filename)).toEqual([
      before[0],
      before[1],
      { ...before[2], storage: "blob", bytes: frame(payload(8192)) },
    ])
  })

  test.each(["dry-run", "write"] as const)(
    "%s rejects eligible invalid JSON and malformed UTF-8 unchanged",
    async (mode) => {
      await using tmp = await tmpdir()
      for (const [index, row] of [
        { data: `private-event-payload:${"a".repeat(4096)}` },
        { data: Buffer.concat([Buffer.from('{"text":"'), Buffer.alloc(4096, 0xff), Buffer.from('"}')]), asText: true },
      ].entries()) {
        const filename = `${tmp.path}/invalid-${index}.sqlite`
        fixture(filename, [row])
        const before = stored(filename)
        const error = await compressEvents({ db: filename, mode, offline: true, minFreeBytes: 0 }).then(
          () => null,
          (cause: unknown) => cause,
        )
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toMatch(/JSON|UTF.?8/i)
        expect(String(error)).not.toContain("private-event-payload")
        expect(stored(filename)).toEqual(before)
      }
    },
  )

  test("rejects non-TEXT/non-BLOB storage without converting it", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [{ data: 123 }], "BLOB NOT NULL")
    expect(stored(filename)[0].storage).toBe("integer")
    await expect(compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow()
    expect(stored(filename)[0].storage).toBe("integer")
  })

  test("restarts idempotently across negative, zero and full 64-bit rowids", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    const rowids = [-9223372036854775808n, -1n, 0n, 9007199254740993n, 9223372036854775807n]
    fixture(
      filename,
      rowids.map((rowid) => ({ data: payload(), rowid })),
    )
    const options = { db: filename, mode: "write" as const, offline: true, minFreeBytes: 0, pageRows: 2 }

    expect(await compressEvents({ ...options, maxScanned: 2 })).toMatchObject({
      examinedRows: 2,
      updatedRows: 2,
      lastRowid: "-1",
      stopped: "max-scanned",
    })
    expect(stored(filename).map((row) => row.storage)).toEqual(["blob", "blob", "text", "text", "text"])
    expect(await compressEvents({ ...options, maxConverted: 2 })).toMatchObject({
      examinedRows: 4,
      alreadyCompressedRows: 2,
      updatedRows: 2,
      lastRowid: "9007199254740993",
      stopped: "max-converted",
    })
    expect(await compressEvents(options)).toMatchObject({
      examinedRows: 5,
      alreadyCompressedRows: 4,
      updatedRows: 1,
      lastRowid: "9223372036854775807",
      stopped: "complete",
    })
    const before = stored(filename)
    expect(await compressEvents(options)).toMatchObject({
      examinedRows: 5,
      alreadyCompressedRows: 5,
      eligibleRows: 0,
      updatedRows: 0,
      inputBytes: 0,
      outputBytes: 0,
    })
    expect(stored(filename)).toEqual(before)
    expect(before.map((row) => row.rowid)).toEqual(rowids.map(String))
  })

  test("dry-run max-converted bounds verified profitable rows, not writes", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [{ data: "{}" }, { data: payload() }, { data: payload() }])
    const before = await Bun.file(filename).bytes()
    expect(await compressEvents({ db: filename, mode: "dry-run", maxScanned: 1, pageRows: 1 })).toMatchObject({
      examinedRows: 1,
      skippedSmallRows: 1,
      compressedRows: 0,
      lastRowid: "1",
      stopped: "max-scanned",
    })
    expect(await compressEvents({ db: filename, mode: "dry-run", maxConverted: 1, pageRows: 1 })).toMatchObject({
      examinedRows: 2,
      compressedRows: 1,
      updatedRows: 0,
      lastRowid: "2",
      stopped: "max-converted",
    })
    expect(await Bun.file(filename).bytes()).toEqual(before)
  })

  test("aborts between individually committed rows and resumes beyond metadata page boundaries", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(
      filename,
      Array.from({ length: 7 }, () => ({ data: payload() })),
    )
    const controller = new AbortController()
    const progress: Awaited<ReturnType<typeof compressEvents>>[] = []
    const options = { db: filename, mode: "write" as const, offline: true, minFreeBytes: 0, pageRows: 2 }

    const result = await compressEvents({ ...options, signal: controller.signal }, (stats) => {
      progress.push(stats)
      if (stats.examinedRows === 3) controller.abort()
    })

    expect(result).toMatchObject({ examinedRows: 3, updatedRows: 3, lastRowid: "3", stopped: "interrupted" })
    expect(progress.map((stats) => [stats.examinedRows, stats.updatedRows])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ])
    expect(stored(filename).map((row) => row.storage)).toEqual(["blob", "blob", "blob", "text", "text", "text", "text"])
    expect(await compressEvents(options)).toMatchObject({
      examinedRows: 7,
      alreadyCompressedRows: 3,
      updatedRows: 4,
      stopped: "complete",
    })
  })

  test("an already-aborted signal does not examine or update a row", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [{ data: payload() }])
    const before = stored(filename)
    expect(
      await compressEvents({
        db: filename,
        mode: "write",
        offline: true,
        minFreeBytes: 0,
        signal: AbortSignal.abort(),
      }),
    ).toMatchObject({ examinedRows: 0, updatedRows: 0, lastRowid: null, stopped: "interrupted" })
    expect(stored(filename)).toEqual(before)
  })

  test.each([
    { checkpointRows: 1, maxWalBytes: 32 * 1024 * 1024 },
    { checkpointRows: 100, maxWalBytes: 1 },
  ])("truncates WAL at the configured checkpoint boundary %j", async (limits) => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(
      filename,
      Array.from({ length: 3 }, () => ({ data: payload() })),
    )
    const result = await compressEvents({
      db: filename,
      mode: "write",
      offline: true,
      minFreeBytes: 0,
      ...limits,
    })
    expect(result.updatedRows).toBe(3)
    expect(result.checkpoints).toBeGreaterThanOrEqual(3)
    expect(result.peakWalBytes).toBeGreaterThan(0)
    expect(existsSync(`${filename}-wal`) ? statSync(`${filename}-wal`).size : 0).toBe(0)
  })

  test("retains an exclusive writer lock between row transactions", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [{ data: payload() }, { data: payload() }])
    const result = await compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 }, () => {
      using competing = new Database(filename, { create: false })
      competing.exec("PRAGMA busy_timeout = 0")
      expect(() => competing.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i)
    })
    expect(result.updatedRows).toBe(2)
  })

  test("rolls back a constraint-failed UPDATE but retains earlier one-row commits", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(
      filename,
      [{ data: payload() }, { data: payload() }],
      "TEXT NOT NULL CHECK (typeof(data) = 'text' OR seq = 0)",
    )
    const before = stored(filename)
    await expect(compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow(
      /constraint|CHECK/i,
    )
    expect(stored(filename)).toEqual([{ ...before[0], storage: "blob", bytes: frame(payload()) }, before[1]])
  })

  test.each(["event", "EVENT", "EvEnT"])("rejects triggers on %s without firing side effects", async (table) => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [{ data: payload() }])
    {
      using db = new Database(filename, { create: false })
      db.exec(
        `CREATE TRIGGER event_update AFTER UPDATE ON ${table} BEGIN INSERT INTO audit VALUES ('must-not-fire'); END`,
      )
    }
    const before = stored(filename)
    await expect(compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow(
      /trigger/i,
    )
    expect(stored(filename)).toEqual(before)
    using db = new Database(filename, { readonly: true, create: false })
    expect(db.query("SELECT * FROM audit").all()).toEqual([])
  })

  test.each([
    "CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT) WITHOUT ROWID",
    "CREATE TABLE event (rowid TEXT, id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT)",
    "CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, data TEXT)",
    "CREATE VIEW event AS SELECT 'id' AS id, 'aggregate' AS aggregate_id, 0 AS seq, 'type' AS type, '{}' AS data",
  ])("rejects unsupported event schema: %s", async (schema) => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    {
      using db = new Database(filename, { create: true })
      db.exec("CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)")
      db.exec(schema)
    }
    await expect(compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow()
    using db = new Database(filename, { readonly: true, create: false })
    expect(db.query("SELECT sql FROM sqlite_schema WHERE name = 'event'").get()).toEqual({ sql: schema })
  })

  test("refuses a non-UTF-8 database", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    {
      using db = new Database(filename, { create: true })
      db.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER)")
      db.exec("CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT)")
    }
    await expect(compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow(
      /UTF.?8|encoding/i,
    )
  })

  test("requires offline acknowledgement and refuses insufficient free space before any update", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [{ data: payload() }])
    const before = stored(filename)
    await expect(compressEvents({ db: filename, mode: "write" })).rejects.toThrow(/offline/i)
    await expect(
      compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow(/space|free/i)
    expect(stored(filename)).toEqual(before)
  })

  test.each([
    "opencode.db",
    "opencode.db-wal",
    "opencode.db.bak",
    "opencode.db.before-compression",
    "opencode.db.next",
    "OPENCODE.DB",
    "oPeNcOdE.dB-WaL",
    "OPENCODE.DB.BAK",
    "oPeNcOdE.dB.Before-Compression",
    "OPENCODE.DB.NEXT",
    "opencode-prebackfill-copy.db",
    "opencode-prebackfill-copy.sqlite",
    "OPENCODE-PREBACKFILL-copy.db",
    "oPeNcOdE-pReBaCkFiLl-copy.sqlite",
  ])("lexically refuses protected name %s even when its parent does not exist", async (basename) => {
    await using tmp = await tmpdir()
    await expect(
      compressEvents({
        db: `${tmp.path}/missing/${basename}`,
        mode: "write",
        offline: true,
        minFreeBytes: 0,
      }),
    ).rejects.toThrow(/Protected production\/backup database name refused/)
    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test.each(["dry-run", "write"] as const)("%s accepts the disposable working-copy filename", async (mode) => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/opencode-backfill-dev.db`
    fixture(filename, [{ data: payload() }])
    expect(await compressEvents({ db: filename, mode, offline: true, minFreeBytes: 0 })).toMatchObject({
      examinedRows: 1,
      compressedRows: 1,
      updatedRows: mode === "write" ? 1 : 0,
    })
  })

  test("rejects blank, memory, URI, missing and nonregular paths without creating a database", async () => {
    await using tmp = await tmpdir()
    for (const filename of [
      "",
      " ",
      ":memory:",
      `file:${tmp.path}/events.sqlite`,
      `${tmp.path}/missing.sqlite`,
      tmp.path,
    ]) {
      await expect(compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow()
    }
    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test("rejects database symlinks, symlinked ancestors and multiply-linked files", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(`${tmp.path}/real`)
    const filename = `${tmp.path}/real/events.sqlite`
    fixture(filename, [{ data: payload() }])
    const before = await Bun.file(filename).bytes()
    await fs.symlink(filename, `${tmp.path}/alias.sqlite`)
    await fs.symlink(`${tmp.path}/real`, `${tmp.path}/linked-directory`)
    for (const candidate of [`${tmp.path}/alias.sqlite`, `${tmp.path}/linked-directory/events.sqlite`]) {
      await expect(compressEvents({ db: candidate, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow(
        /symlink|symbolic/i,
      )
    }
    await fs.link(filename, `${tmp.path}/hardlink.sqlite`)
    for (const candidate of [filename, `${tmp.path}/hardlink.sqlite`]) {
      await expect(compressEvents({ db: candidate, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow(
        /link/i,
      )
    }
    expect(await Bun.file(filename).bytes()).toEqual(before)
  })

  test.each(["-wal", "-shm", "-journal"])(
    "dry-run refuses any preexisting %s sidecar without modifying it",
    async (suffix) => {
      await using tmp = await tmpdir()
      const filename = `${tmp.path}/events.sqlite`
      fixture(filename, [{ data: payload() }])
      const before = await Bun.file(filename).bytes()
      await Bun.write(`${filename}${suffix}`, "uncheckpointed synthetic sidecar")
      await expect(compressEvents({ db: filename, mode: "dry-run" })).rejects.toThrow(
        /sidecar|wal|shm|journal|checkpoint/i,
      )
      expect(await Bun.file(filename).bytes()).toEqual(before)
      expect(await Bun.file(`${filename}${suffix}`).text()).toBe("uncheckpointed synthetic sidecar")
      expect((await fs.readdir(tmp.path)).sort()).toEqual(["events.sqlite", `events.sqlite${suffix}`].sort())
    },
  )

  test.each(["-wal", "-shm", "-journal"])(
    "write refuses unsafe %s sidecars before SQLite opens them",
    async (suffix) => {
      await using tmp = await tmpdir()
      const filename = `${tmp.path}/events.sqlite`
      const target = `${tmp.path}/sentinel`
      fixture(filename, [{ data: payload() }])
      const before = await Bun.file(filename).bytes()
      await Bun.write(target, "must remain untouched")
      const sidecar = `${filename}${suffix}`
      await fs.symlink(target, sidecar)
      await expect(compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow(
        /symlink|symbolic|sidecar/i,
      )
      await fs.unlink(sidecar)
      await fs.link(target, sidecar)
      await expect(compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow(
        /link|sidecar/i,
      )
      await fs.unlink(sidecar)
      await fs.mkdir(sidecar)
      await expect(compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).rejects.toThrow(
        /regular|sidecar/i,
      )
      expect(await Bun.file(filename).bytes()).toEqual(before)
      expect(await Bun.file(target).text()).toBe("must remain untouched")
    },
  )

  test("a killed process cannot commit the UPDATE currently in flight and write mode recovers its WAL", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [{ data: payload() }, { data: payload() }])
    const before = stored(filename)
    const child = Bun.spawn(
      [process.execPath, new URL("./fixture/event-compress-crash.ts", import.meta.url).pathname, filename],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(137)
    expect(child.signalCode).toBe("SIGKILL")
    expect(stdout.trim()).toBe("killed-after-uncommitted-update")
    expect(existsSync(`${filename}-wal`)).toBe(true)
    expect(stored(filename)).toEqual(before)
    expect(await compressEvents({ db: filename, mode: "write", offline: true, minFreeBytes: 0 })).toMatchObject({
      examinedRows: 2,
      updatedRows: 2,
      stopped: "complete",
    })
    expect(stored(filename).map((row) => row.storage)).toEqual(["blob", "blob"])
  })

  test("CLI emits a data-free final JSON summary and applies dry-run/write limits", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    const secret = JSON.stringify({ text: "never-print-this-event".repeat(256) })
    fixture(filename, [{ data: secret }, { data: secret }])
    const before = await Bun.file(filename).bytes()
    const dry = await cli(["--db", filename, "--dry-run", "--max-scanned", "1"])
    expect(dry.code, dry.stderr).toBe(0)
    expect(JSON.parse(dry.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      examinedRows: 1,
      updatedRows: 0,
      stopped: "max-scanned",
    })
    expect(await Bun.file(filename).bytes()).toEqual(before)
    const write = await cli([
      "--db",
      filename,
      "--write",
      "--offline",
      "--min-free-bytes",
      "0",
      "--max-converted",
      "1",
      "--page-rows",
      "1",
    ])
    expect(write.code, write.stderr).toBe(0)
    expect(JSON.parse(write.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      examinedRows: 1,
      updatedRows: 1,
      stopped: "max-converted",
    })
    expect(`${dry.stdout}${dry.stderr}${write.stdout}${write.stderr}`).not.toContain("never-print-this-event")
    expect(stored(filename).map((row) => row.storage)).toEqual(["blob", "text"])
  })

  test("CLI distinguishes help, usage errors and runtime failures", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    fixture(filename, [{ data: payload() }])
    expect((await cli(["--help"])).code).toBe(0)
    for (const args of [
      [],
      ["--db", filename, "--write"],
      ["--db", filename, "--write", "--offline", "--dry-run"],
      ["--db", filename, "--dry-run", "--unknown"],
      ["--db", filename, "--dry-run", "--page-rows", "0"],
      ["--db", filename, "--dry-run", "--page-rows", "1025"],
      ["--db", filename, "--dry-run", "--max-payload-bytes", "67108865"],
      ["--db", filename, "--dry-run", "--max-scanned", "1.5"],
    ]) {
      const result = await cli(args)
      expect(result.code, `${JSON.stringify(args)}\n${result.stderr}`).toBe(2)
    }
    expect((await cli(["--db", `${tmp.path}/missing.sqlite`, "--dry-run"])).code).toBe(1)
    const invalid = `${tmp.path}/invalid.sqlite`
    fixture(invalid, [{ data: `private-invalid-event:${"x".repeat(4096)}` }])
    const failure = await cli(["--db", invalid, "--write", "--offline", "--min-free-bytes", "0"])
    expect(failure.code).toBe(1)
    expect(`${failure.stdout}${failure.stderr}`).not.toContain("private-invalid-event")
    expect(stored(invalid)[0].storage).toBe("text")
    expect(stored(filename)[0].storage).toBe("text")
  })
})
