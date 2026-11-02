import { describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { Cause, Effect, Exit } from "effect"
import { layer } from "#sqlite"
import { eq, sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { Sqlite } from "../src/database/sqlite"
import { EventData } from "../src/event/data"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { tmpdir } from "./fixture/tmpdir"

const large = { text: "\u96ea\ud83d\ude80 diff\n".repeat(8192), nested: { values: [true, null, 42], escaped: '"\\\t' } }

function frame(bytes: Uint8Array) {
  const compressed = Bun.zstdCompressSync(bytes, { level: 3 })
  const result = Buffer.alloc(41 + compressed.length)
  result.write("OCEZ")
  result[4] = 1
  result.writeUInt32LE(bytes.length, 5)
  createHash("sha256").update(compressed).digest().copy(result, 9)
  result.set(compressed, 41)
  return result
}

describe("event payload storage codec", () => {
  test("reads legacy TEXT and round-trips large UTF-8 JSON without changing its logical shape", () => {
    expect(EventData.decode(JSON.stringify(large))).toEqual(large)
    const encoded = EventData.encode(large)
    expect(encoded).toBeInstanceOf(Uint8Array)
    expect(encoded.length).toBeLessThan(Buffer.byteLength(JSON.stringify(large)) / 4)
    expect(EventData.decode(encoded)).toEqual(large)
    // SQLite adapters may return a view into a larger buffer.
    const view = Buffer.concat([Buffer.alloc(7), Buffer.from(encoded), Buffer.alloc(11)])
    expect(EventData.decode(view.subarray(7, -11))).toEqual(large)
  })

  test("keeps small and high-entropy payloads as JSON TEXT and measures the threshold in UTF-8 bytes", () => {
    const small = { text: "a".repeat(16 * 1024 - 12) }
    expect(typeof EventData.encode(small)).toBe("string")
    expect(EventData.encode({ text: "a".repeat(16 * 1024 - 11) })).toBeInstanceOf(Uint8Array)
    expect(EventData.encode({ text: "\u96ea".repeat(6000) })).toBeInstanceOf(Uint8Array)
    const entropy = { text: randomBytes(64 * 1024).toString("base64") }
    expect(typeof EventData.encode(entropy)).toBe("string")
    expect(EventData.decode(EventData.encode(entropy))).toEqual(entropy)
  })

  test("rejects unknown formats, unknown versions, truncation, and corruption", () => {
    const encoded = Buffer.from(EventData.encode(large))
    expect(() => EventData.decode(Buffer.from("not a codec"))).toThrow("Unknown event payload BLOB format")
    const version = Buffer.from(encoded)
    version[4] = 255
    expect(() => EventData.decode(version)).toThrow("Unsupported event payload codec version 255")
    expect(() => EventData.decode(encoded.subarray(0, 15))).toThrow("truncated header or frame")
    const changed = Buffer.from(encoded)
    changed[changed.length - 1] ^= 1
    expect(() => EventData.decode(changed)).toThrow("checksum mismatch")
    expect(() => EventData.decode(encoded.subarray(0, -1))).toThrow("checksum mismatch")
    expect(() => EventData.decode(Buffer.concat([encoded, Buffer.from([0])]))).toThrow("checksum mismatch")
    const invalid = Buffer.from(encoded)
    invalid.fill(0, 41)
    createHash("sha256").update(invalid.subarray(41)).digest().copy(invalid, 9)
    expect(() => EventData.decode(invalid)).toThrow("invalid Zstandard, UTF-8, or JSON")
    const size = Buffer.from(encoded)
    size.writeUInt32LE(1, 5)
    expect(() => EventData.decode(size)).toThrow("invalid Zstandard, UTF-8, or JSON")
    expect(() => EventData.decode(frame(Buffer.from("not JSON")))).toThrow("invalid Zstandard, UTF-8, or JSON")
    expect(() => EventData.decode(frame(Uint8Array.of(0xff)))).toThrow("invalid Zstandard, UTF-8, or JSON")
  })

  test("Bun and Node adapters read each other's BLOBs through effect and native Drizzle, preserving legacy TEXT", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/events.sqlite`
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.insert(EventSequenceTable).values({ aggregate_id: "codec", seq: 4 }).run()
        yield* database.db
          .insert(EventTable)
          .values([
            {
              id: "evt_legacy" as typeof EventTable.$inferInsert.id,
              aggregate_id: "codec",
              seq: 0,
              type: "test.codec.1",
              data: sql`${JSON.stringify(large)}`,
            },
            {
              id: "evt_bun" as typeof EventTable.$inferInsert.id,
              aggregate_id: "codec",
              seq: 1,
              type: "test.codec.1",
              data: large,
            },
          ])
          .run()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const native = yield* Sqlite.Drizzle
        native
          .insert(EventTable)
          .values({
            id: "evt_bun_native" as typeof EventTable.$inferInsert.id,
            aggregate_id: "codec",
            seq: 2,
            type: "test.codec.1",
            data: large,
          })
          .run()
        expect(
          native
            .select()
            .from(EventTable)
            .all()
            .map((row) => row.data),
        ).toEqual([large, large, large])
      }).pipe(Effect.provide(layer({ filename })), Effect.scoped),
    )
    const build = await Bun.build({
      entrypoints: [new URL("./fixture/event-data-sqlite.ts", import.meta.url).pathname],
      target: "node",
      outdir: tmp.path,
    })
    expect(build.success, JSON.stringify(build.logs)).toBe(true)
    const child = Bun.spawn(["node", `${tmp.path}/event-data-sqlite.js`, filename], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.rows.map((row: { data: unknown }) => row.data)).toEqual([large, large, large])
    expect(result.storage.map((row: { storage: string }) => row.storage)).toEqual([
      "text",
      "blob",
      "blob",
      "blob",
      "blob",
    ])
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const rows = yield* database.db.select().from(EventTable).orderBy(EventTable.seq).all()
        expect(rows.map((row) => row.data)).toEqual([
          large,
          large,
          large,
          { source: "node", text: "Node \u96ea \ud83d\ude80".repeat(4096), nested: { values: [true, null, 42] } },
          { source: "node", text: "Node \u96ea \ud83d\ude80".repeat(4096), nested: { values: [true, null, 42] } },
        ])
        expect(yield* database.db.get(sql`SELECT data FROM event WHERE seq = 0`)).toEqual({
          data: JSON.stringify(large),
        })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    const before = await Bun.file(filename).bytes()
    const inspect = Bun.spawn(["bun", "script/event-inspect.ts", filename, "evt_bun"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, error, exit] = await Promise.all([
      new Response(inspect.stdout).text(),
      new Response(inspect.stderr).text(),
      inspect.exited,
    ])
    expect(exit, error).toBe(0)
    expect(JSON.parse(output).data).toEqual(large)
    expect(await Bun.file(filename).bytes()).toEqual(before)
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const invalid = Buffer.from(EventData.encode(large))
        invalid[4] = 255
        yield* database.db
          .update(EventTable)
          .set({ data: sql`${invalid}` })
          .where(eq(EventTable.seq, 1))
          .run()
        const result = yield* database.db.select().from(EventTable).where(eq(EventTable.seq, 1)).get().pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain("Unsupported event payload codec version 255")
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  }, 30000)

  test("a runtime without native Zstandard writes TEXT and explicitly rejects BLOBs", async () => {
    await using tmp = await tmpdir()
    const build = await Bun.build({
      entrypoints: [
        new URL("../src/event/data.ts", import.meta.url).pathname,
        new URL("./fixture/event-data-sqlite.ts", import.meta.url).pathname,
      ],
      target: "node",
      outdir: tmp.path,
      naming: "[name].js",
    })
    expect(build.success, JSON.stringify(build.logs)).toBe(true)
    const child = Bun.spawn(
      [
        "node",
        `${tmp.path}/event-data-sqlite.js`,
        "unused",
        "unsupported",
        `${tmp.path}/data.js`,
        Buffer.from(EventData.encode(large)).toString("base64"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited, stderr).toBe(0)
  }, 30000)
})
