import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import scheduleMigration from "@opencode-ai/core/database/migration/20261103090000_session_schedule"
import { sql } from "drizzle-orm"
import { Effect } from "effect"

describe("durable schedule migration", () => {
  test("upgrades existing queues without losing entries and cascades durable occurrences", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_queue (id TEXT PRIMARY KEY, payload TEXT)`)
        yield* db.run(sql`INSERT INTO session VALUES ('ses_existing')`)
        yield* db.run(sql`INSERT INTO session_queue VALUES ('queued', 'existing')`)
        yield* DatabaseMigration.applyOnly(db, [scheduleMigration])
        yield* DatabaseMigration.applyOnly(db, [scheduleMigration])
        expect(yield* db.get(sql`SELECT id, payload, origin FROM session_queue`)).toEqual({
          id: "queued",
          payload: "existing",
          origin: null,
        })
        yield* db.run(
          sql`INSERT INTO session_schedule (id, session_id, input, anchor, time_created, status) VALUES ('schedule', 'ses_existing', '{}', 0, 0, 'active')`,
        )
        yield* db.run(
          sql`INSERT INTO session_schedule_occurrence (id, schedule_id, scheduled, state) VALUES ('occurrence', 'schedule', 0, 'accepted')`,
        )
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_existing'`)
        expect(yield* db.all(sql`SELECT * FROM session_schedule`)).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM session_schedule_occurrence`)).toEqual([])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })

  test("fresh databases have the same schedule tables and private origin column", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.apply(db)
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'session_schedule%' ORDER BY name`,
          ),
        ).toEqual([{ name: "session_schedule" }, { name: "session_schedule_occurrence" }])
        expect(yield* db.get(sql`SELECT name FROM pragma_table_info('session_queue') WHERE name = 'origin'`)).toEqual({
          name: "origin",
        })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })
})
