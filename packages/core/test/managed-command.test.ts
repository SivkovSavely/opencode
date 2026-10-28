import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { ManagedCommand } from "../src/managed-command"
import { RuntimeRetirement } from "../src/runtime-retirement"
import { tmpdir } from "./fixture/tmpdir"

const seed = (database: Database.Interface, id = "root") =>
  Effect.gen(function* () {
    yield* database.db.run(sql`INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES ('project', '/tmp', 0, 0, '[]')`)
    yield* database.db
      .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (${id}, 'project', ${id}, '/tmp', 'test', '1', 0, 0)`)
  })

describe("managed command durable ownership", () => {
  test("denies changed ancestry even when neither the command nor its original root was retired", async () => {
    await using tmp = await tmpdir()
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* seed(database)
        yield* seed(database, "replacement")
        yield* seed(database, "child")
        yield* database.db.run(sql`UPDATE session SET parent_id = 'root' WHERE id = 'child'`)
        const permit = yield* ManagedCommand.admit(database, "child", "owner")
        yield* database.db.run(sql`UPDATE session SET parent_id = 'replacement' WHERE id = 'child'`)
        expect(
          yield* ManagedCommand.authorize(database, permit, () => {
            throw new Error("changed ancestry opened a gate")
          }),
        ).toBe(false)
        expect(yield* ManagedCommand.status(database, "root")).toBe("unknown")
      }).pipe(Effect.provide(Database.layerFromPath(path.join(tmp.path, "commands.sqlite"))), Effect.scoped),
    )
  })

  test("coverage is opt-in, cannot upgrade historical roots, and uncertainty survives reopen", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "commands.sqlite")
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        for (const trigger of yield* database.db.all<{ name: string }>(sql`
          SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'managed_command_%'
        `))
          yield* database.db.run(sql`DROP TRIGGER ${sql.identifier(trigger.name)}`)
        yield* database.db.run(sql`DROP TABLE managed_command`)
        yield* database.db.run(sql`DROP TABLE managed_command_coverage`)
        yield* database.db.run(sql`DELETE FROM migration WHERE id IN (
          '20261028171804_managed_command_ownership',
          '20261028171900_managed_command_eligibility',
          '20261028173819_managed_command_generation',
          '20261028174200_managed_command_ancestry'
        )`)
        yield* seed(database, "historical")
        yield* DatabaseMigration.apply(database.db)
        yield* seed(database)
        expect(yield* ManagedCommand.status(database, "root")).toBe("unknown")
        expect(yield* ManagedCommand.coverRoot(database, "root")).toBeDefined()
        expect(yield* ManagedCommand.status(database, "root")).toBe("drained")
        expect(yield* ManagedCommand.coverRoot(database, "historical")).toBeUndefined()
        expect(yield* ManagedCommand.status(database, "historical")).toBe("unknown")
        yield* seed(database, "v2")
        yield* ManagedCommand.coverRoot(database, "v2")
        yield* database.db.run(sql`
          INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
          VALUES ('v2-message', 'v2', 'user', 1, 0, 0, '{}')
        `)
        yield* database.db.run(sql`DELETE FROM session_message WHERE session_id = 'v2'`)
        expect(yield* ManagedCommand.coverRoot(database, "v2")).toBeUndefined()
        expect(yield* ManagedCommand.status(database, "v2")).toBe("unknown")
        const permit = yield* ManagedCommand.admit(database, "root", "crashed")
        expect(yield* ManagedCommand.status(database, "root", new Set([permit.id]))).toBe("draining")
        expect(yield* ManagedCommand.status(database, "root")).toBe("unknown")
        yield* RuntimeRetirement.retireRoot(database, "root")
        expect(
          yield* ManagedCommand.authorize(database, permit, () => {
            throw new Error("retired gate opened")
          }),
        ).toBe(false)
        expect(yield* ManagedCommand.admit(database, "root", "other").pipe(Effect.flip)).toBeInstanceOf(
          ManagedCommand.AdmissionError,
        )
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        expect(yield* ManagedCommand.status(database, "root")).toBe("unknown")
        expect(yield* RuntimeRetirement.retireRoot(database, "root")).toEqual({
          rootSessionID: "root",
          sessionIDs: ["root"],
        })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("only confirmed cleanup releases a permit; nonmanaged execution permanently invalidates coverage", async () => {
    await using tmp = await tmpdir()
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* seed(database)
        yield* ManagedCommand.coverRoot(database, "root")
        const permit = yield* ManagedCommand.admit(database, "root", "owner")
        const opened: string[] = []
        expect(yield* ManagedCommand.authorize(database, permit, () => opened.push("gate"))).toBe(true)
        expect(yield* ManagedCommand.authorize(database, permit, () => opened.push("duplicate"))).toBe(false)
        expect(opened).toEqual(["gate"])
        yield* ManagedCommand.settle(database, { ...permit, ownerInstance: "foreign" }, true)
        expect(yield* ManagedCommand.status(database, "root")).toBe("unknown")
        yield* ManagedCommand.settle(database, permit, true)
        expect(yield* ManagedCommand.status(database, "root")).toBe("drained")
        yield* ManagedCommand.invalidateCoverage(database, "root")
        expect(yield* ManagedCommand.coverRoot(database, "root")).toBeUndefined()
        expect(yield* ManagedCommand.status(database, "root")).toBe("unknown")
      }).pipe(Effect.provide(Database.layerFromPath(path.join(tmp.path, "commands.sqlite"))), Effect.scoped),
    )
  })

  test("a second process cannot open a pending launcher's gate after retirement", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "commands.sqlite")
    const ready = path.join(tmp.path, "ready")
    const opened = path.join(tmp.path, "opened")
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* seed(database)
        yield* ManagedCommand.coverRoot(database, "root")
        const child = Bun.spawn(
          [
            process.execPath,
            path.join(import.meta.dirname, "fixture/managed-command-worker.ts"),
            filename,
            ready,
            opened,
          ],
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => child.kill()))
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 10_000
          while (!(await Bun.file(ready).exists())) {
            if (Date.now() > deadline) throw new Error("worker did not publish its admitted permit")
            await Bun.sleep(5)
          }
        })
        yield* RuntimeRetirement.retireRoot(database, "root")
        child.stdin.end()
        expect(yield* Effect.promise(() => new Response(child.stdout).text())).toBe('{"authorized":false}\n')
        expect(yield* Effect.promise(() => child.exited)).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(opened).exists())).toBe(false)
        expect(yield* ManagedCommand.status(database, "root")).toBe("unknown")
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })
})
