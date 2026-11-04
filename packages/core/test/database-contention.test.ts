import { expect } from "bun:test"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, References, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
import { Client, sqliteLayer } from "@opencode/core/database/sqlite.bun"
import { testEffect } from "./lib/effect"
import { tmpdirScoped } from "./fixture/tmpdir"

const it = testEffect(sqliteLayer({ filename: ":memory:", disableWAL: true }))

for (const budget of [32, 2048]) {
  for (const kind of ["query", "reservation", "export", "extension"] as const) {
    it.live(`reuses SQLite after interrupted ${kind} acquisition at yield budget ${budget}`, () =>
      Effect.gen(function* () {
        const sql = yield* Client
        const leaks: number[] = []
        // Sweep the yield boundary instead of depending on one internal operation count.
        for (let padding = Math.max(0, budget - 48); padding < budget + 48; padding++) {
          yield* Effect.yieldNow
          const owner = yield* Effect.gen(function* () {
            // Successful exits such as Effect.void do not consume scheduler operations.
            for (let i = 0; i < padding; i++) yield* Effect.sync(() => undefined)
            yield* kind === "query"
              ? sql`SELECT 1`
              : kind === "reservation"
                ? sql.reserve
                : kind === "export"
                  ? sql.export
                  : sql.loadExtension(path.join(import.meta.dir, "missing-extension.so")).pipe(Effect.ignore)
            yield* Effect.never
          }).pipe(
            Effect.scoped,
            Effect.provideService(References.MaxOpsBeforeYield, budget),
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Fiber.interrupt(owner)
          const reused = yield* sql.withTransaction(sql`SELECT 1`).pipe(Effect.timeoutOption("2 seconds"))
          if (reused._tag === "None") {
            leaks.push(padding)
            break
          }
        }
        expect(leaks).toEqual([])
      }),
    )
  }
}

for (const kind of ["query", "reservation", "drizzle"] as const) {
  it.live(`cancels a queued ${kind} before releasing the connection holder`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const holder = yield* Scope.make()
      yield* Scope.provide(sql.reserve, holder)
      const entered = yield* Deferred.make<void>()
      const acquired: string[] = []
      const waiter = yield* Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* kind === "query"
          ? sql`SELECT 1`
          : kind === "reservation"
            ? sql.reserve
            : db.transaction(() => db.all("SELECT 1"))
        acquired.push(kind)
      }).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const cancellation = yield* Fiber.interrupt(waiter).pipe(Effect.forkChild({ startImmediately: true }))
      // Release first during test cleanup, even when a broken waiter ignores interruption.
      yield* Effect.addFinalizer(() => Scope.close(holder, Exit.void))
      yield* Effect.yieldNow
      expect(cancellation.pollUnsafe()).toBeDefined()
      expect(waiter.pollUnsafe()).toBeDefined()
      expect(acquired).toEqual([])
      yield* Scope.close(holder, Exit.void)
      expect(yield* sql.withTransaction(sql`SELECT 1 AS value`)).toEqual([{ value: 1 }])
      expect(acquired).toEqual([])
    }),
  )
}

it.live("isolates ordinary inserts from concurrent transaction rollback", () =>
  Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run("CREATE TABLE writes (id INTEGER PRIMARY KEY, kind TEXT)")
    yield* Effect.all(
      [
        Effect.forEach(
          Array.from({ length: 40 }, (_, i) => i),
          (i) => db.run(`INSERT INTO writes VALUES (${i}, 'query')`),
          { concurrency: "unbounded" },
        ),
        Effect.forEach(
          Array.from({ length: 10 }, (_, i) => i + 100),
          (i) =>
            db
              .transaction(() =>
                db
                  .run(`INSERT INTO writes VALUES (${i}, 'rollback')`)
                  .pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.fail("rollback"))),
              )
              .pipe(Effect.ignore),
          { concurrency: "unbounded" },
        ),
      ],
      { concurrency: "unbounded" },
    )
    expect(yield* db.all("SELECT * FROM writes WHERE kind = 'query'")).toHaveLength(40)
    expect(yield* db.all("SELECT * FROM writes WHERE kind = 'rollback'")).toEqual([])
  }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 32)),
)

for (const kind of ["sql", "drizzle"] as const) {
  it.live(`reuses SQLite after a deferred constraint fails ${kind} commit`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* sql`PRAGMA foreign_keys = ON`
      yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
      yield* sql`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
      const failed = yield* (
        kind === "sql"
          ? sql.withTransaction(sql`INSERT INTO child VALUES (1)`)
          : db.transaction(() => db.run("INSERT INTO child VALUES (1)"))
      ).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      if (Exit.isFailure(failed)) expect(Cause.pretty(failed.cause)).toContain("FOREIGN KEY constraint failed")
      expect(yield* sql`SELECT * FROM child`).toEqual([])
      yield* db.transaction(() => db.run("INSERT INTO parent VALUES (1)"))
      expect(yield* sql`SELECT * FROM parent`).toEqual([{ id: 1 }])
    }),
  )
}

it.live("rolls back interrupted and defective transaction callbacks and releases their reservations", () =>
  Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run("CREATE TABLE writes (id INTEGER)")
    const written = yield* Deferred.make<void>()
    const transaction = yield* db
      .transaction(() =>
        db
          .run("INSERT INTO writes VALUES (1)")
          .pipe(Effect.andThen(Deferred.succeed(written, undefined)), Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(written)
    yield* Fiber.interrupt(transaction)
    const defect = yield* db
      .transaction(() => db.run("INSERT INTO writes VALUES (2)").pipe(Effect.andThen(Effect.die("callback defect"))))
      .pipe(Effect.exit)
    expect(Exit.isFailure(defect)).toBe(true)
    if (Exit.isFailure(defect)) expect(Cause.pretty(defect.cause)).toContain("callback defect")
    expect(yield* db.all("SELECT * FROM writes")).toEqual([])
    yield* db.transaction(() => db.run("INSERT INTO writes VALUES (3)"))
    expect(yield* db.all("SELECT * FROM writes")).toEqual([{ id: 3 }])
  }),
)

it.live("preserves nested rollback, child-fiber context and normal callback scheduling", () =>
  Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run("CREATE TABLE writes (id INTEGER)")
    yield* db.transaction(() =>
      Effect.gen(function* () {
        expect(yield* References.PreventSchedulerYield).toBe(false)
        yield* db.run("INSERT INTO writes VALUES (1)")
        yield* db
          .transaction(() => db.run("INSERT INTO writes VALUES (2)").pipe(Effect.andThen(Effect.fail("nested"))))
          .pipe(Effect.ignore)
        const child = yield* db.run("INSERT INTO writes VALUES (3)").pipe(Effect.forkChild())
        yield* Fiber.join(child)
        yield* Effect.yieldNow
      }),
    )
    expect(yield* db.all("SELECT * FROM writes ORDER BY id")).toEqual([{ id: 1 }, { id: 3 }])
  }),
)

it.live("releases the connection after exporting a Bun database", () =>
  Effect.gen(function* () {
    const sql = yield* Client
    yield* sql`CREATE TABLE exported (id INTEGER)`
    expect(Buffer.isBuffer(yield* sql.export)).toBe(true)
    expect(yield* sql`SELECT 1 AS value`.pipe(Effect.timeout("2 seconds"))).toEqual([{ value: 1 }])
  }),
)

it.live("releases the connection after a Bun extension fails to load", () =>
  Effect.gen(function* () {
    const sql = yield* Client
    const directory = yield* tmpdirScoped()
    expect(
      Exit.isFailure(yield* sql.loadExtension(path.join(directory.path, "missing-extension.so")).pipe(Effect.exit)),
    ).toBe(true)
    expect(yield* sql`SELECT 1 AS value`.pipe(Effect.timeout("2 seconds"))).toEqual([{ value: 1 }])
  }),
)

it.live("Node SQLite cancels contended transactions and rolls back failed commits", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const build = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: [path.join(import.meta.dir, "fixture/sqlite-node-contention.ts")],
        target: "node",
        conditions: ["node"],
        outdir: directory.path,
      }),
    )
    expect(build.success).toBe(true)
    const output = build.outputs[0]
    if (!output) throw new Error("Node SQLite fixture was not bundled")
    const child = Bun.spawn(["node", output.path], { stdout: "pipe", stderr: "pipe" })
    yield* Effect.addFinalizer(() => Effect.sync(() => child.kill()))
    const [code, stdout, stderr] = yield* Effect.promise(() =>
      Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
    )
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout.trim()).toBe("Node SQLite contention checks passed")
  }),
)
