import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import retirementTable from "../src/database/migration/20261028141815_runtime_retirement_table"
import retirementGuards from "../src/database/migration/20261028141816_runtime_retirement_guards"
import retirementMembers from "../src/database/migration/20261028143259_runtime_retirement_members"
import ownership from "../src/database/migration/20261028171804_managed_command_ownership"
import eligibility from "../src/database/migration/20261028171900_managed_command_eligibility"
import generation from "../src/database/migration/20261028173819_managed_command_generation"
import ancestry from "../src/database/migration/20261028174200_managed_command_ancestry"
import { ManagedCommand } from "../src/managed-command"

test("recovery migrations preserve historical uncertainty and guard retired sessions", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, parent_id text, time_created integer NOT NULL)`)
      yield* db.run(sql`CREATE TABLE runtime_execution (session_id text PRIMARY KEY, parent_session_id text, desired_active integer NOT NULL)`)
      yield* db.run(sql`CREATE TABLE message (session_id text NOT NULL)`)
      yield* db.run(sql`CREATE TABLE session_message (session_id text NOT NULL)`)
      yield* db.run(sql`CREATE TABLE session_input (session_id text NOT NULL)`)
      yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY)`)
      yield* db.run(sql`INSERT INTO session (id, time_created) VALUES ('historical', 1), ('retired', 1)`)

      const migrations = [retirementTable, retirementGuards, retirementMembers, ownership, eligibility, generation, ancestry]
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, 2))
      yield* db.run(sql`INSERT INTO runtime_retirement (session_id, root_session_id, time_created) VALUES ('retired', 'retired', 2)`)
      yield* DatabaseMigration.applyOnly(db, migrations)

      expect(yield* db.all(sql`SELECT root_session_id, session_id FROM runtime_retirement_member`)).toEqual([
        { root_session_id: "retired", session_id: "retired" },
      ])
      expect(yield* db.all(sql`SELECT * FROM managed_command_coverage`)).toEqual([])
      expect(yield* ManagedCommand.coverRoot({ db }, "historical")).toBeUndefined()

      yield* db.run(sql`INSERT INTO session (id, time_created) VALUES ('fresh', 3)`)
      expect(yield* db.all(sql`SELECT root_session_id, state FROM managed_command_coverage`)).toEqual([
        { root_session_id: "fresh", state: "eligible" },
      ])
      expect(yield* ManagedCommand.coverRoot({ db }, "fresh")).toEqual({ root_session_id: "fresh" })
      expect(yield* ManagedCommand.coverRoot({ db }, "historical")).toBeUndefined()

      expect(Exit.isFailure(yield* Effect.exit(db.run(sql`INSERT INTO session (id, parent_id, time_created) VALUES ('child', 'retired', 4)`)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(db.run(sql`UPDATE session SET parent_id = 'retired' WHERE id = 'historical'`)))).toBe(true)
      expect(yield* db.get(sql`INSERT INTO runtime_execution (session_id, parent_session_id, desired_active) VALUES ('retired', NULL, 1) RETURNING session_id`)).toBeUndefined()
      yield* db.run(sql`INSERT INTO runtime_execution (session_id, parent_session_id, desired_active) VALUES ('historical', NULL, 0)`)
      expect(yield* db.get(sql`UPDATE runtime_execution SET parent_session_id = 'retired', desired_active = 1 WHERE session_id = 'historical' RETURNING session_id`)).toBeUndefined()

      yield* DatabaseMigration.applyOnly(db, migrations)
      expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual(migrations.map((migration) => ({ id: migration.id })))
      expect(yield* db.all(sql`SELECT root_session_id, state FROM managed_command_coverage ORDER BY root_session_id`)).toEqual([
        { root_session_id: "fresh", state: "managed" },
      ])
      expect(yield* ManagedCommand.coverRoot({ db }, "historical")).toBeUndefined()
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})
