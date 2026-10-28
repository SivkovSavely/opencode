import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { RuntimeRetirement } from "../src/runtime-retirement"
import { tmpdir } from "./fixture/tmpdir"

describe("runtime retirement persistence", () => {
  test("upgrades existing databases and keeps retirement after closing and reopening SQLite", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "retirement.sqlite")
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        // Simulate the immediately preceding schema and journal without touching historical migrations.
        for (const name of [
          "session_retired_insert",
          "session_retired_reparent",
          "runtime_retired_insert",
          "runtime_retired_update",
        ])
          yield* database.db.run(sql`DROP TRIGGER ${sql.identifier(name)}`)
        yield* database.db.run(sql`DROP TABLE runtime_retirement`)
        yield* database.db.run(sql`DROP TABLE runtime_retirement_member`)
        yield* database.db.run(sql`DELETE FROM migration WHERE id IN (
        '20261028141815_runtime_retirement_table', '20261028141816_runtime_retirement_guards',
        '20261028143259_runtime_retirement_members'
      )`)
        yield* database.db.run(sql`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES ('project', '/tmp', 0, 0, '[]')
      `)
        yield* database.db.run(sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('root', 'project', 'root', '/tmp', 'test', '1', 0, 0)
      `)
        yield* DatabaseMigration.apply(database.db)
        expect(yield* RuntimeRetirement.retireRoot(database, "root")).toEqual({
          rootSessionID: "root",
          sessionIDs: ["root"],
        })
        // Upgrading a database that already has tombstones preserves their membership.
        yield* database.db.run(sql`DROP TABLE runtime_retirement_member`)
        yield* database.db.run(sql`DELETE FROM migration WHERE id = '20261028143259_runtime_retirement_members'`)
        yield* DatabaseMigration.apply(database.db)
        expect(
          yield* database.db.all(sql`
          SELECT root_session_id, session_id FROM runtime_retirement_member
        `),
        ).toEqual([{ root_session_id: "root", session_id: "root" }])
        yield* database.db.run(sql`DELETE FROM session WHERE id = 'root'`)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        expect(yield* RuntimeRetirement.lookup(database, "root")).toEqual({ root_session_id: "root" })
        expect(yield* RuntimeRetirement.retireRoot(database, "root")).toEqual({
          rootSessionID: "root",
          sessionIDs: ["root"],
        })
        const result = yield* database.db.get(sql`
        INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance,
          fence, state, desired_active, time_created, time_updated)
        VALUES ('root', 'root', '/tmp', 'new', 'new', 0, 'active', 1, 0, 0) RETURNING session_id
      `)
        expect(result).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })
})
