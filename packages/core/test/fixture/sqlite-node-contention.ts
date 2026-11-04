import assert from "node:assert/strict"
import { Deferred, Effect, Exit, Fiber, References, Scope } from "effect"
import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
import { Client, sqliteLayer } from "@opencode/core/database/sqlite.node"

await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* Client
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    for (const budget of [32, 2048]) {
      for (const kind of ["query", "reservation", "extension"] as const) {
        for (let padding = Math.max(0, budget - 48); padding < budget + 48; padding++) {
          yield* Effect.yieldNow
          const owner = yield* Effect.gen(function* () {
            for (let i = 0; i < padding; i++) yield* Effect.sync(() => undefined)
            yield* kind === "query"
              ? sql`SELECT 1`
              : kind === "reservation"
                ? sql.reserve
                : sql.loadExtension(`${import.meta.dirname}/missing-extension.so`).pipe(Effect.ignore)
            yield* Effect.never
          }).pipe(
            Effect.scoped,
            Effect.provideService(References.MaxOpsBeforeYield, budget),
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Fiber.interrupt(owner)
          assert.equal(
            (yield* sql.withTransaction(sql`SELECT 1`).pipe(Effect.timeoutOption("2 seconds")))._tag,
            "Some",
            `${kind} leaked at budget ${budget}, padding ${padding}`,
          )
        }
      }
    }
    const holder = yield* Scope.make()
    yield* Scope.provide(sql.reserve, holder)
    const entered = yield* Deferred.make<void>()
    const waiter = yield* Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(db.transaction(() => db.all("SELECT 1"))),
      Effect.forkChild({ startImmediately: true }),
    )
    yield* Deferred.await(entered)
    const cancellation = yield* Fiber.interrupt(waiter).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.addFinalizer(() => Scope.close(holder, Exit.void))
    yield* Effect.yieldNow
    assert.notEqual(cancellation.pollUnsafe(), undefined)
    yield* Scope.close(holder, Exit.void)

    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
    yield* sql`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
    const failed = yield* sql.withTransaction(sql`INSERT INTO child VALUES (1)`).pipe(Effect.exit)
    assert.equal(Exit.isFailure(failed), true)
    assert.deepEqual(yield* sql`SELECT * FROM child`, [])
    yield* db.transaction(() => db.run("INSERT INTO parent VALUES (1)"))
    assert.deepEqual(yield* sql`SELECT id FROM parent`.values, [[1]])

    assert.equal(
      Exit.isFailure(yield* sql.loadExtension(`${import.meta.dirname}/missing-extension.so`).pipe(Effect.exit)),
      true,
    )
    assert.deepEqual(yield* sql`SELECT 1 AS value`.values.pipe(Effect.timeout("2 seconds")), [[1]])
  }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:", disableWAL: true, allowExtension: true })), Effect.scoped),
)
console.log("Node SQLite contention checks passed")
