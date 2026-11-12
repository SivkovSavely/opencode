import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import scheduleMigration from "@opencode-ai/core/database/migration/20261103090000_session_schedule"
import orderMigration from "@opencode-ai/core/database/migration/20261112165157_session_schedule_definition_order"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

test("backfills historical schedule order independently of later rowid changes", async () => {
  await using tmp = await tmpdir()
  const layer = () => SqliteClient.layer({ filename: path.join(tmp.path, "order.db"), disableWAL: true })
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
      yield* db.run(sql`CREATE TABLE session_queue (id TEXT PRIMARY KEY)`)
      yield* DatabaseMigration.applyOnly(db, [scheduleMigration])
      yield* db.run(
        sql`INSERT INTO session_schedule (rowid, id, session_id, input, anchor, time_created, status) VALUES (7, 'z', 's', '{}', 0, 0, 'active'), (12, 'a', 's', '{}', 0, 0, 'active')`,
      )
      yield* DatabaseMigration.applyOnly(db, [orderMigration])
      yield* db.run(sql`UPDATE session_schedule SET rowid = 20 WHERE id = 'z'`)
      yield* DatabaseMigration.applyOnly(db, [orderMigration])
    }).pipe(Effect.provide(layer()), Effect.scoped),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      expect(yield* db.all(sql`SELECT id, definition_order FROM session_schedule ORDER BY definition_order`)).toEqual([
        { id: "z", definition_order: 7 },
        { id: "a", definition_order: 12 },
      ])
    }).pipe(Effect.provide(layer()), Effect.scoped),
  )
})
