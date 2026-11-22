import { Effect } from "effect"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { sql } from "drizzle-orm"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { layer } from "#sqlite"

const dir = process.argv[2]
const filename = join(dir, "fixture.db")
writeFileSync(filename, "")
const probe = Effect.fn("sqliteExecutionProbe")(function* () {
  const sql = yield* SqlClient
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  const query = "SELECT $probe AS fixture_alias /* fixture-comment */"
  const rows = yield* sql.unsafe<{ fixture_alias: string }>(query, [
    {
      get $probe() {
        // SQLite reads the binding inside the native statement call.
        const log = join(dir, "opencode", "log")
        const capture = existsSync(log) && readdirSync(log).find((name) => name.startsWith("sqlite-execution-"))
        if (capture) {
          const line = readFileSync(join(log, capture, "queries.jsonl"), "utf8")
            .trimEnd()
            .split("\n")
            .at(-1)!
          writeFileSync(join(dir, "in-native.json"), line)
        }
        return "fixture-bound"
      },
    },
  ])
  if (rows[0]?.fixture_alias !== "fixture-bound") throw new Error("Unexpected SQLite result")
  yield* sql.unsafe(query, [{ $probe: "fixture-bound-again" }]).values
  yield* db.transaction((tx) =>
    tx.all(
      `SELECT 'fixture-inline' AS "fixture-alias", X'cafebabe', 34567890${process.versions.bun ? ', "fixture-dqs", "event"' : ""}`,
    ),
  )
  yield* db.transaction(() => Effect.fail("rollback")).pipe(Effect.flip)
  if (process.versions.bun) {
    const comparison = yield* db.get<{ result: number }>(`SELECT 'event' IS DISTINCT FROM "event" AS result`)
    if (comparison?.result !== 0) throw new Error("Expected SQLite's double-quoted string fallback")
  }
  yield* sql.unsafe("SELECT abs(-9223372036854775808)").values.pipe(Effect.flip)
  yield* sql.unsafe("SELECT * FROM fixture_missing").pipe(Effect.exit)
})

const submit = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  yield* db.all("SELECT 12345678")
  yield* db.all("SELECT 12345678")
  yield* db
    .select({ probe: sql`87654321` })
    .from(sql`(SELECT 1)`)
    .all()
  yield* db
    .select({ probe: sql`87654321` })
    .from(sql`(SELECT 1)`)
    .all()
  yield* db.select({ probe: sql`87654321` }).from(sql`(SELECT 1)`)
  yield* db.select({ probe: sql`87654321` }).from(sql`(SELECT 1)`)
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.all("SELECT 12345678")
    }),
  )
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.all("SELECT 12345678")
    }),
  )
})

await Effect.runPromise(
  (process.argv[3] === "volume"
    ? Effect.gen(function* () {
        const sql = yield* SqlClient
        for (let i = 0; i < 24_000; i++) yield* sql`SELECT ${i}`
      })
    : submit.pipe(Effect.andThen(probe()))
  ).pipe(Effect.provide(layer({ filename })), Effect.scoped),
)
