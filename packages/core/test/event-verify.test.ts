import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import { verifyDatabases } from "../script/event-verify"
import { tmpdir } from "./fixture/tmpdir"

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

function fixture(filename: string, options: { eventData?: string | Uint8Array; extra?: string } = {}) {
  using db = new Database(filename, { create: true, strict: true })
  db.exec(`
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, owner_id TEXT);
    CREATE TABLE event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created INTEGER NOT NULL DEFAULT 17
    );
    CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value);
    ${options.extra ?? ""}
  `)
  db.query("INSERT INTO event_sequence VALUES ('a', 1, 'owner')").run()
  db.query("INSERT INTO event(id, aggregate_id, seq, type, data) VALUES ('e1', 'a', 1, 'test', ?)").run(
    options.eventData ?? '{ "x": 1, "x": 2 }',
  )
  db.query("INSERT INTO unrelated VALUES (1, 9007199254740993)").run()
}

function change(filename: string, sql: string) {
  using db = new Database(filename, { create: false })
  db.exec(sql)
}

function transcriptFixture(filename: string) {
  change(
    filename,
    `CREATE TABLE transcript_search(part_id TEXT PRIMARY KEY, body TEXT, truncated INTEGER);
     CREATE TABLE transcript_search_v2(message_id TEXT NOT NULL, part_id TEXT NOT NULL, body TEXT, PRIMARY KEY(message_id,part_id));
     CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT);
     INSERT INTO transcript_search VALUES ('p1','searchable alpha transcript',0),('p2','searchable beta transcript',0);
     INSERT INTO transcript_search_v2 VALUES ('m1','p1','searchable alpha transcript'),('m2','p2','searchable beta transcript');
     INSERT INTO message VALUES ('m1','{}'),('m2','{}');
     CREATE VIRTUAL TABLE transcript_search_fts USING fts5(body, content='transcript_search', content_rowid='rowid', tokenize='trigram');
     CREATE VIRTUAL TABLE transcript_search_error_fts USING fts5(body, content='', contentless_delete=1, tokenize='trigram');
     CREATE VIRTUAL TABLE transcript_search_v2_fts USING fts5(body, content='transcript_search_v2', content_rowid='rowid', tokenize='trigram');
     CREATE VIRTUAL TABLE transcript_search_v2_error USING fts5(message_id UNINDEXED, body, tokenize='trigram');
     INSERT INTO transcript_search_fts(rowid,body) SELECT rowid,body FROM transcript_search;
     INSERT INTO transcript_search_v2_fts(rowid,body) SELECT rowid,body FROM transcript_search_v2;
     INSERT INTO transcript_search_error_fts(rowid,body) SELECT rowid,'searchable error transcript' FROM message;
     INSERT INTO transcript_search_v2_error(message_id,body) VALUES ('m1','searchable error transcript');`,
  )
}

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "script/event-verify.ts", ...args], {
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

async function pair() {
  const tmp = await tmpdir()
  const source = `${tmp.path}/source.sqlite`
  const destination = `${tmp.path}/destination.sqlite`
  fixture(source)
  fixture(destination)
  return { tmp, source, destination }
}

describe("offline event database verification", () => {
  test("compares semantic rows while accepting TEXT and independently framed event BLOBs", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    {
      using db = new Database(destination, { create: false })
      db.query("UPDATE event SET data = ?").run(frame('{ "x": 1, "x": 2 }'))
    }
    expect(await verifyDatabases({ source, destination })).toMatchObject({
      verified: true,
      tablesCompared: 3,
      rowsCompared: 3,
      eventRowsCompared: 1,
    })
  })

  test("compares serialized event JSON bytes, not parsed JSON equivalence", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    change(destination, "UPDATE event SET data = '{\"x\":2}'")
    await expect(verifyDatabases({ source, destination })).rejects.toThrow(/event|row|data|mismatch/i)
  })

  test("preserves Unicode, whitespace, escapes, duplicate keys and existing compressed bytes", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    const json = ' \n{ "text": "雪\\u96ea\\n", "x": 1, "x": 2 }\t'
    for (const filename of [source, destination]) {
      using db = new Database(filename, { create: false })
      db.query("UPDATE event SET data=?").run(filename === source ? json : frame(json))
    }
    expect((await verifyDatabases({ source, destination })).eventBytesCompared).toBe(Buffer.byteLength(json))
    {
      using db = new Database(source, { create: false })
      db.query("UPDATE event SET data=?").run(frame(json))
    }
    expect((await verifyDatabases({ source, destination })).verified).toBe(true)
  })

  test("distinguishes equal-valued INTEGER/REAL and TEXT/BLOB storage classes", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    for (const [a, b] of [
      ["1", "1.0"],
      ["'same'", "x'73616d65'"],
    ]) {
      change(source, `UPDATE unrelated SET value=${a}`)
      change(destination, `UPDATE unrelated SET value=${b}`)
      await expect(verifyDatabases({ source, destination })).rejects.toThrow(/storage type\/value mismatch/i)
    }
  })

  test.each([
    ["missing", "DELETE FROM event WHERE id = 'e1'"],
    ["extra", "INSERT INTO event(id, aggregate_id, seq, type, data) VALUES ('e2', 'a', 2, 'test', '{}')"],
  ])("detects an %s event row", async (_label, sql) => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    change(destination, sql)
    await expect(verifyDatabases({ source, destination })).rejects.toThrow(/row|count|mismatch/i)
  })

  test.each([
    ["event id", "UPDATE event SET id = 'other'"],
    ["event sequence", "UPDATE event SET seq = 2"],
    ["event aggregate", "UPDATE event SET aggregate_id = 'other'"],
    ["event type", "UPDATE event SET type = 'other'"],
    ["event created", "UPDATE event SET created = 18"],
    ["sequence owner", "UPDATE event_sequence SET owner_id = 'other'"],
    ["other table value", "UPDATE unrelated SET value = 1"],
    ["integer versus real", "UPDATE unrelated SET value = 9007199254740992.0"],
    ["NULL versus integer", "UPDATE unrelated SET value = NULL"],
    ["BLOB versus TEXT", "UPDATE unrelated SET value = x'31'"],
  ])("detects changed %s", async (_label, sql) => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    change(destination, sql)
    await expect(verifyDatabases({ source, destination })).rejects.toThrow()
  })

  test("ignores implicit rowids, including event rowid changes and VACUUM reordering", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    change(source, "INSERT INTO unrelated(value) VALUES ('first'), ('second')")
    change(destination, "INSERT INTO unrelated(value) VALUES ('first'), ('second')")
    change(destination, "UPDATE event SET rowid = rowid + 100")
    change(destination, "VACUUM")
    expect((await verifyDatabases({ source, destination })).verified).toBe(true)
  })

  test("compares composite WITHOUT ROWID primary keys and exact duplicate multisets on keyless tables", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    for (const filename of [source, destination])
      change(
        filename,
        "CREATE TABLE composite (a TEXT, b INTEGER, value BLOB, PRIMARY KEY(a,b)) WITHOUT ROWID; CREATE TABLE keyless(value)",
      )
    change(source, "INSERT INTO composite VALUES ('a',1,x'01'); INSERT INTO keyless VALUES ('x'),('x'),('y')")
    change(destination, "INSERT INTO composite VALUES ('a',1,x'01'); INSERT INTO keyless VALUES ('y'),('x'),('x')")
    expect((await verifyDatabases({ source, destination })).verified).toBe(true)
    change(destination, "INSERT INTO keyless VALUES ('x')")
    await expect(verifyDatabases({ source, destination })).rejects.toThrow(/row|count|multiset|mismatch/i)
  })

  test("compares VACUUM INTO output with different implicit rowids and every keyless value intact", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    for (const filename of [source, destination])
      change(filename, "CREATE TABLE keyless(value); INSERT INTO keyless(rowid,value) VALUES(7,'a'),(900,'b')")
    // Some SQLite versions preserve rowids during VACUUM; exercise valid renumbering explicitly.
    change(destination, "UPDATE keyless SET rowid=CASE rowid WHEN 7 THEN 1 ELSE 2 END")
    const compact = `${tmp.path}/compact.sqlite`
    change(destination, `VACUUM INTO '${compact}'`)
    {
      using before = new Database(source, { readonly: true, create: false })
      using after = new Database(compact, { readonly: true, create: false })
      expect(after.query("SELECT rowid FROM keyless").all()).not.toEqual(
        before.query("SELECT rowid FROM keyless").all(),
      )
    }
    expect((await verifyDatabases({ source, destination: compact })).verified).toBe(true)
  })

  test("bounds keyless tables and rejects generated columns and nullable primary-key layouts", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    for (const filename of [source, destination])
      change(filename, "CREATE TABLE keyless(value); INSERT INTO keyless VALUES (1),(1),(1)")
    expect((await verifyDatabases({ source, destination })).verified).toBe(true)
    for (const filename of [source, destination])
      change(
        filename,
        `DELETE FROM keyless; INSERT INTO keyless VALUES ${Array.from({ length: 1025 }, () => "(1)").join(",")}`,
      )
    await expect(verifyDatabases({ source, destination })).rejects.toThrow(/bound|limit|keyless|rows/i)
    for (const filename of [source, destination])
      change(
        filename,
        "DELETE FROM keyless; CREATE TABLE generated (a INTEGER PRIMARY KEY, b INTEGER GENERATED ALWAYS AS (a + 1))",
      )
    await expect(verifyDatabases({ source, destination })).rejects.toThrow(/unsupported|generated/i)
  })

  test.each([
    ["application_id", "PRAGMA application_id = 7"],
    ["user_version", "PRAGMA user_version = 7"],
    ["index definition", "CREATE INDEX changed_index ON unrelated(value)"],
    ["trigger definition", "CREATE TRIGGER changed_trigger AFTER INSERT ON unrelated BEGIN SELECT 1; END"],
    ["view definition", "CREATE VIEW changed_view AS SELECT value FROM unrelated"],
  ])("rejects different %s", async (_label, sql) => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    change(destination, sql)
    await expect(verifyDatabases({ source, destination })).rejects.toThrow()
  })

  test("enforces inclusive row-byte caps and validates the entire event frame", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    const max = Buffer.byteLength('e1atest{ "x": 1, "x": 2 }') + 16
    expect((await verifyDatabases({ source, destination, maxRowBytes: max })).verified).toBe(true)
    await expect(verifyDatabases({ source, destination, maxRowBytes: max - 1 })).rejects.toThrow(/limit|large|cap/i)
    for (const mutate of [
      (bytes: Buffer) => bytes.fill(0, 0, 4),
      (bytes: Buffer) => {
        bytes[0] |= 128
      },
      (bytes: Buffer) => {
        bytes[4] = 2
      },
      (bytes: Buffer) => {
        bytes[9] ^= 1
      },
      (bytes: Buffer) => {
        bytes[bytes.length - 1] ^= 1
      },
    ]) {
      const bytes = frame('{ "x": 1, "x": 2 }')
      mutate(bytes)
      using db = new Database(destination, { create: false })
      db.query("UPDATE event SET data = ?").run(bytes)
      await expect(verifyDatabases({ source, destination })).rejects.toThrow()
      db.query("UPDATE event SET data = ?").run('{ "x": 1, "x": 2 }')
    }
  })

  test("rejects malformed framed payloads on either side without logging their contents", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    for (const path of [source, destination]) {
      for (const corrupt of [
        Buffer.from("private-invalid-event"),
        Buffer.from([0x4f, 0x43, 0x45, 0x5a, 1]),
        Buffer.concat([frame("{}"), frame("{}")]),
      ]) {
        using db = new Database(path, { create: false })
        db.query("UPDATE event SET data = ?").run(corrupt)
        const error = await verifyDatabases({ source, destination }).then(
          () => null,
          (cause: unknown) => cause,
        )
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).not.toContain("private-invalid-event")
        db.query("UPDATE event SET data = ?").run('{ "x": 1, "x": 2 }')
      }
    }
  })

  test("rejects corrupt frames even with a freshly recomputed envelope checksum", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    const original = frame('{ "x": 1, "x": 2 }')
    const compressed = original.subarray(41)
    for (const bad of [
      compressed.subarray(0, -1),
      Buffer.concat([compressed, Buffer.from([0])]),
      Buffer.concat([compressed, compressed]),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 255, 1, 0, 0]),
    ]) {
      const bytes = Buffer.concat([original.subarray(0, 41), bad])
      createHash("sha256").update(bad).digest().copy(bytes, 9)
      using db = new Database(destination, { create: false })
      db.query("UPDATE event SET data=?").run(bytes)
      await expect(verifyDatabases({ source, destination })).rejects.toThrow(/Zstandard frame/i)
    }
    const large = Buffer.from(original)
    large.writeUInt32LE(1024 * 1024, 5)
    {
      using db = new Database(destination, { create: false })
      db.query("UPDATE event SET data=?").run(large)
    }
    await expect(verifyDatabases({ source, destination, maxRowBytes: 1024 })).rejects.toThrow(/decompression cap/i)
  })

  test("fails before loading oversized invalid TEXT and rejects invalid eligible UTF-8/JSON", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    change(source, "UPDATE event SET data=CAST(zeroblob(4096) AS TEXT)")
    await expect(verifyDatabases({ source, destination, maxRowBytes: 128 })).rejects.toThrow(/row byte cap/i)
    for (const sql of ["CAST(x'ff' AS TEXT)", "'private-bad-json'"]) {
      change(source, `UPDATE event SET data=${sql}`)
      await expect(verifyDatabases({ source, destination })).rejects.toThrow(/invalid serialized event/i)
    }
  })

  test("rejects NUL-terminated JSON even when SQLite accepts the prefix", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    const json = "{}\0private-trailing-data"
    for (const filename of [source, destination]) {
      using db = new Database(filename, { create: false })
      db.query("UPDATE event SET data=?").run(filename === source ? json : frame(json))
    }
    await expect(verifyDatabases({ source, destination })).rejects.toThrow(/invalid serialized event/i)
  })

  test("rejects unsupported schemas, NULL event keys, and non-UTF-8 databases", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    change(destination, "UPDATE event SET id = NULL")
    await expect(verifyDatabases({ source, destination })).rejects.toThrow(/null|key|id/i)
    change(destination, "UPDATE event SET id = 'e1'; CREATE VIRTUAL TABLE unsupported USING fts5(value)")
    await expect(verifyDatabases({ source, destination })).rejects.toThrow(/unsupported|virtual/i)
    const utf16 = `${tmp.path}/utf16.sqlite`
    {
      using db = new Database(utf16, { create: true })
      db.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE t (id INTEGER PRIMARY KEY)")
    }
    await expect(verifyDatabases({ source: utf16, destination })).rejects.toThrow(/UTF.?8|encoding/i)
  })

  test("reports progress without exposing row contents and aborts without verified success", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    await expect(verifyDatabases({ source, destination, signal: AbortSignal.abort() })).rejects.toThrow(
      /abort|interrupt/i,
    )
    const controller = new AbortController()
    await expect(
      verifyDatabases({ source, destination, signal: controller.signal }, (stats) => {
        expect(stats.verified).toBe(false)
        expect(JSON.stringify(stats)).not.toContain('{ "x"')
        controller.abort()
      }),
    ).rejects.toThrow(/abort|interrupt/i)
  })

  test("fails if progress-time changes add a sidecar or alter an input", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    await expect(
      verifyDatabases({ source, destination }, () =>
        writeFileSync(`${source}-journal`, "appeared during verification"),
      ),
    ).rejects.toThrow(/sidecar|changed|journal/i)
    await fs.unlink(`${source}-journal`)
    await expect(
      verifyDatabases({ source, destination }, () => change(destination, "UPDATE unrelated SET value = 1")),
    ).rejects.toThrow(/changed|modified|mismatch|row/i)
  })

  test("does not alter either database and refuses sidecars, aliases, and identical paths", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    const before = await Promise.all(
      [source, destination].map(
        async (path) => [await Bun.file(path).bytes(), (await fs.stat(path, { bigint: true })).mtimeNs] as const,
      ),
    )
    expect((await verifyDatabases({ source, destination })).verified).toBe(true)
    for (const [index, path] of [source, destination].entries()) {
      expect(await Bun.file(path).bytes()).toEqual(before[index][0])
      expect((await fs.stat(path, { bigint: true })).mtimeNs).toBe(before[index][1])
    }
    expect((await fs.readdir(tmp.path)).sort()).toEqual(["destination.sqlite", "source.sqlite"])
    await expect(verifyDatabases({ source, destination: source })).rejects.toThrow(/same|distinct|identical/i)
    await fs.symlink(destination, `${tmp.path}/alias.sqlite`)
    await expect(verifyDatabases({ source, destination: `${tmp.path}/alias.sqlite` })).rejects.toThrow(
      /symlink|symbolic/i,
    )
    await fs.link(destination, `${tmp.path}/hardlink.sqlite`)
    await expect(verifyDatabases({ source: `${tmp.path}/hardlink.sqlite`, destination })).rejects.toThrow(
      /link|same|identical/i,
    )
    await Bun.write(`${source}-wal`, "sentinel")
    await expect(verifyDatabases({ source, destination })).rejects.toThrow(/sidecar|wal/i)
  })

  test("CLI handles help, usage errors, missing inputs, and explicit paths", async () => {
    const { tmp, source, destination } = await pair()
    await using _tmp = tmp
    expect((await cli(["--help"])).code).toBe(0)
    for (const args of [[], ["--source", source], ["--source", source, "--destination", destination, "--unknown"]])
      expect((await cli(args)).code).toBe(2)
    const success = await cli(["--source", source, "--destination", destination, "--max-row-bytes", "1024"])
    expect(success.code, success.stderr).toBe(0)
    expect(JSON.parse(success.stdout)).toMatchObject({ verified: true, tablesCompared: 3 })
    expect((await cli(["--source", `${tmp.path}/missing.sqlite`, "--destination", destination])).code).toBe(1)
    expect((await cli(["--source", source, "--destination", source])).code).toBe(1)
    expect((await cli(["--source", source, "--destination", destination, "--max-row-bytes", "1073741824"])).code).toBe(
      0,
    )
    expect((await cli(["--source", source, "--destination", destination, "--max-row-bytes", "1073741825"])).code).toBe(
      2,
    )
  })

  describe("TranscriptSearch FTS5", () => {
    test("compares all known virtual definitions and shadow data after VACUUM INTO", async () => {
      const { tmp, source, destination } = await pair()
      await using _tmp = tmp
      for (const filename of [source, destination]) transcriptFixture(filename)
      change(destination, "UPDATE event SET rowid=rowid+100")
      const compact = `${tmp.path}/compact.sqlite`
      change(destination, `VACUUM INTO '${compact}'`)
      expect(await verifyDatabases({ source, destination: compact })).toMatchObject({
        verified: true,
        tablesCompared: 27,
      })
    })

    test.each([
      ["segments", "UPDATE transcript_search_v2_fts_data SET block=x'ffeedd' WHERE id=1"],
      ["index", "UPDATE transcript_search_v2_fts_idx SET pgno=pgno+1"],
      ["document sizes", "UPDATE transcript_search_v2_fts_docsize SET sz=x'ff'"],
      ["configuration types", "UPDATE transcript_search_v2_fts_config SET v=CAST(v AS TEXT)"],
      ["content", "UPDATE transcript_search_v2_error_content SET c0='private changed content'"],
    ])("compares exact stored shadow %s", async (_label, sql) => {
      const { tmp, source, destination } = await pair()
      await using _tmp = tmp
      for (const filename of [source, destination]) transcriptFixture(filename)
      // Bun keeps defensive mode enabled; disable it only in this synthetic corruption writer.
      const writer = Bun.spawnSync([
        "node",
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from 'node:sqlite';
         const db = new DatabaseSync(process.argv[1]);
         db.enableDefensive(false);
         if (db.prepare(process.argv[2]).run().changes < 1) throw new Error('Fixture update changed no rows');
         db.close();`,
        destination,
        sql,
      ])
      expect(writer.exitCode, writer.stderr.toString()).toBe(0)
      await expect(verifyDatabases({ source, destination })).rejects.toThrow(/Storage type\/value mismatch/)
    })

    test.each(["transcript_search", "transcript_search_v2", "message"])(
      "rejects changed external-content rowid mappings for %s after VACUUM INTO",
      async (table) => {
        const { tmp, source, destination } = await pair()
        await using _tmp = tmp
        for (const filename of [source, destination]) transcriptFixture(filename)
        change(destination, `UPDATE ${table} SET rowid=rowid+100`)
        const compact = `${tmp.path}/compact.sqlite`
        change(destination, `VACUUM INTO '${compact}'`)
        await expect(verifyDatabases({ source, destination: compact })).rejects.toThrow(
          /FTS external-content rowid mapping mismatch/,
        )
      },
    )

    test.each([
      "CREATE VIRTUAL TABLE unknown_search USING fts5(body)",
      "CREATE VIRTUAL TABLE transcript_search_fts USING rtree(id, minimum, maximum)",
      "CREATE VIRTUAL TABLE transcript_search_fts USING fts5(body, content='message', tokenize='trigram')",
    ])("refuses unknown virtual modules/names/layouts: %s", async (sql) => {
      const { tmp, source, destination } = await pair()
      await using _tmp = tmp
      for (const filename of [source, destination]) change(filename, sql)
      await expect(verifyDatabases({ source, destination })).rejects.toThrow(/Unsupported.*virtual|Unsupported.*FTS/i)
    })

    test("still compares supported virtual SQL definitions exactly", async () => {
      const { tmp, source, destination } = await pair()
      await using _tmp = tmp
      for (const filename of [source, destination]) transcriptFixture(filename)
      change(
        destination,
        "DROP TABLE transcript_search_v2_error; CREATE VIRTUAL TABLE transcript_search_v2_error USING fts5(message_id UNINDEXED, body, tokenize = 'trigram')",
      )
      await expect(verifyDatabases({ source, destination })).rejects.toThrow(/Schema definitions mismatch/)
    })

    test("does not misclassify triggers sharing virtual-table names", async () => {
      const { tmp, source, destination } = await pair()
      await using _tmp = tmp
      for (const filename of [source, destination]) {
        transcriptFixture(filename)
        change(filename, "CREATE TRIGGER transcript_search_fts AFTER INSERT ON unrelated BEGIN SELECT 1; END")
      }
      expect((await verifyDatabases({ source, destination })).verified).toBe(true)
    })

    test("does not exclude ordinary prefix lookalikes or allow generated columns", async () => {
      const { tmp, source, destination } = await pair()
      await using _tmp = tmp
      for (const filename of [source, destination]) {
        transcriptFixture(filename)
        change(
          filename,
          "CREATE TABLE transcript_search_v2_fts_extra(id INTEGER PRIMARY KEY, value); INSERT INTO transcript_search_v2_fts_extra VALUES(1,'same')",
        )
      }
      change(destination, "UPDATE transcript_search_v2_fts_extra SET value='different'")
      await expect(verifyDatabases({ source, destination })).rejects.toThrow(/Storage type\/value mismatch/)
      for (const filename of [source, destination])
        change(
          filename,
          "UPDATE transcript_search_v2_fts_extra SET value='same'; CREATE TABLE generated(a INTEGER PRIMARY KEY,b INTEGER GENERATED ALWAYS AS(a+1))",
        )
      await expect(verifyDatabases({ source, destination })).rejects.toThrow(/Unsupported generated\/hidden/)
    })

    test("metadata-only preflight permits FTS hidden columns without certifying or reading contents", async () => {
      const { tmp, source, destination } = await pair()
      await using _tmp = tmp
      for (const filename of [source, destination]) {
        transcriptFixture(filename)
        change(filename, "UPDATE event SET data='invalid private JSON'")
      }
      const result = await cli(["--source", source, "--destination", destination, "--preflight"])
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ preflight: true, verified: false, rowsCompared: 0 })
      expect(result.stdout + result.stderr).not.toContain("invalid private JSON")
      await expect(verifyDatabases({ source, destination })).rejects.toThrow(/Invalid serialized event/)
    })
  })
})
