import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { SessionWatchStore } from "../src/session/watch-store"

test("independent-session orchestration is introduced by one final migration", () => {
  expect(
    migrations
      .filter((migration) => /^20261119\d+_session_(watch|control|orchestration)/.test(migration.id))
      .map((migration) => migration.id),
  ).toEqual(["20261119170251_session_orchestration"])
})

for (const mode of ["baseline upgrade", "fresh database"]) {
  test(`${mode} preserves execution ownership and installs idempotent journal and replay storage`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        // This is the last migration present at the feature's 6aafba5b63 baseline.
        if (mode === "baseline upgrade")
          yield* DatabaseMigration.applyOnly(
            db,
            migrations.filter((migration) => migration.id <= "20261116003000_session_handoff_recovery_queue_block"),
          )
        if (mode === "fresh database") yield* DatabaseMigration.apply(db)
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES ('project', '/project', 1, 1, '[]')`)
        for (const id of ["ses_source", "ses_parked", "ses_historical", "ses_destination"])
          yield* db.run(sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (${id}, 'project', ${id}, '/project', ${id}, 'test', 1, 1)`)
        for (const [id, state] of [
          ["ses_source", "active"],
          ["ses_parked", "active"],
          ["ses_historical", "completed"],
        ]) {
          yield* db.run(sql`INSERT INTO runtime_execution
          (id, session_id, directory, owner_lineage, owner_instance, fence, desired_active, state, time_created, time_updated)
          VALUES (${id}, ${id}, '/project', 'lineage', 'instance', 7, ${state === "completed" ? 0 : 1}, ${state}, 1, 10)`)
        }
        yield* db.run(sql`UPDATE runtime_execution SET state = 'parked' WHERE session_id = 'ses_parked'`)
        const ownership = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.apply(db)
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(ownership)
        expect(
          yield* db.all(sql`SELECT session_id, state, owner_lineage, owner_instance, fence
        FROM session_watch_execution ORDER BY session_id`),
        ).toEqual([
          {
            session_id: "ses_parked",
            state: "running",
            owner_lineage: "lineage",
            owner_instance: "instance",
            fence: 7,
          },
          {
            session_id: "ses_source",
            state: "running",
            owner_lineage: "lineage",
            owner_instance: "instance",
            fence: 7,
          },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_watch_event`)).toEqual([])
        expect(
          yield* db.all(sql`SELECT name FROM pragma_table_info('session_control_request')
        WHERE name IN ('scopes', 'agent', 'auto') ORDER BY name`),
        ).toEqual([{ name: "agent" }, { name: "auto" }, { name: "scopes" }])
        const execution = yield* db.get<{ id: string }>(
          sql`SELECT id FROM session_watch_execution WHERE session_id = 'ses_source'`,
        )
        if (!execution) return yield* Effect.die("Active execution is missing its durable journal identity")
        const watch = yield* SessionWatchStore.create(
          { db },
          {
            id: "watch",
            owner: "ses_destination",
            source: "ses_source",
            destination: "ses_destination",
            events: ["completed"],
            mode: "once",
            delivery: "auto",
            limit: 1,
          },
        )
        expect(watch.execution_id).toBe(execution.id)
        yield* SessionWatchStore.result({ db }, "ses_source", {
          outcome: "completed",
          summary: "finished after upgrade",
          ownerLineage: "lineage",
          ownerInstance: "instance",
          fence: 7,
        })
        yield* db.run(
          sql`UPDATE runtime_execution SET state = 'completed', desired_active = 0, time_updated = 20 WHERE session_id = 'ses_source'`,
        )
        expect(yield* SessionWatchStore.deliveries({ db }, "ses_destination", "watch")).toMatchObject([
          { execution_id: execution.id, state: "pending", outcome: "completed" },
        ])
        const scopes = JSON.stringify([{ sessionID: "ses_destination", projectID: "project", directory: "/project" }])
        yield* db.run(sql`INSERT INTO session_control_request
        (id, owner_id, action, submission, session_id, state, queue_id, scopes, agent, auto, time_created)
        VALUES ('control', 'ses_destination', 'prompt', 'immutable', 'ses_destination', 'admitted', 'queue', ${scopes}, 'build', 1, 30)`)
        yield* DatabaseMigration.apply(db)
        expect(yield* SessionWatchStore.deliveries({ db }, "ses_destination", "watch")).toHaveLength(1)
        expect(
          yield* db.get(sql`SELECT state, scopes, agent, auto FROM session_control_request WHERE id = 'control'`),
        ).toEqual({ state: "admitted", scopes, agent: "build", auto: 1 })
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })
}
