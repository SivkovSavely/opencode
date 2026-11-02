import { Effect } from "effect"
import { layer } from "#sqlite"
import { eq, sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { Sqlite } from "../../src/database/sqlite"
import { EventTable } from "../../src/event/sql"
import zlib from "node:zlib"

if (process.argv[3] === "unsupported") {
  // Only this child process loses native support; do not mutate the test runner.
  Reflect.deleteProperty(zlib, "zstdCompressSync")
  Reflect.deleteProperty(zlib, "zstdDecompressSync")
  const { EventData } = await import(process.argv[4]!)
  const data = { text: "large payload".repeat(4096) }
  if (typeof EventData.encode(data) !== "string") throw new Error("Unsupported runtime must write TEXT")
  const compressed = Buffer.from(process.argv[5]!, "base64")
  try {
    EventData.decode(compressed)
    throw new Error("Expected unsupported runtime to reject compressed data")
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.includes("no native Zstandard support")) throw cause
  }
  process.exit(0)
}

const data = { source: "node", text: "Node \u96ea \ud83d\ude80".repeat(4096), nested: { values: [true, null, 42] } }
const rows = await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const rows = yield* database.db.select().from(EventTable).all()
    yield* database.db
      .insert(EventTable)
      .values({
        id: "evt_node" as typeof EventTable.$inferInsert.id,
        aggregate_id: "codec",
        seq: 3,
        type: "test.codec.1",
        data,
      })
      .run()
    const selected = yield* database.db.select().from(EventTable).where(eq(EventTable.seq, 3)).get()
    if (JSON.stringify(selected?.data) !== JSON.stringify(data))
      throw new Error("Node effect Drizzle round trip failed")
    return rows
  }).pipe(Effect.provide(Database.layerFromPath(process.argv[2]!)), Effect.scoped),
)
const storage = await Effect.runPromise(
  Effect.gen(function* () {
    const native = yield* Sqlite.Drizzle
    native
      .insert(EventTable)
      .values({
        id: "evt_node_native" as typeof EventTable.$inferInsert.id,
        aggregate_id: "codec",
        seq: 4,
        type: "test.codec.1",
        data,
      })
      .run()
    return native.all(sql`SELECT seq, typeof(data) AS storage FROM event ORDER BY seq`)
  }).pipe(Effect.provide(layer({ filename: process.argv[2]! })), Effect.scoped),
)
console.log(JSON.stringify({ rows, storage }))
