import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, References, Scope, Semaphore } from "effect"
import { DatabaseDiagnostics } from "../src/database/diagnostics"
import { layer } from "#sqlite"
import { SqlClient } from "effect/unstable/sql/SqlClient"

describe("database diagnostics", () => {
  test("interrupted SQLite initialization unregisters diagnostics", async () => {
    if (!DatabaseDiagnostics.diagnostics.enabled) return
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let budget = 5; budget <= 40; budget++) {
          const before = DatabaseDiagnostics.diagnostics.snapshot().active
          const fiber = yield* Effect.never.pipe(
            Effect.provide(layer({ filename: ":memory:", disableWAL: true })),
            Effect.provideService(References.MaxOpsBeforeYield, budget),
            Effect.forkChild({ startImmediately: true }),
          )
          for (
            let attempt = 0;
            attempt < 10_000 && DatabaseDiagnostics.diagnostics.snapshot().active === before;
            attempt++
          ) {
            yield* Effect.yieldNow
          }
          expect(DatabaseDiagnostics.diagnostics.snapshot().active).toBe(before + 1)
          yield* Fiber.interrupt(fiber)
          expect(DatabaseDiagnostics.diagnostics.snapshot().active).toBe(before)
        }
      }).pipe(Effect.timeout("5 seconds")),
    )
  }, 7_000)

  test("in-memory SQLite reports progress without SQL or parameter values", async () => {
    if (!DatabaseDiagnostics.diagnostics.enabled) return
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* sql`SELECT ${"secret-parameter"} AS secret_column`
        const snapshot = DatabaseDiagnostics.diagnostics.snapshot()
        expect(snapshot.databases[0]).toMatchObject({
          acquired: 1,
          completed: 1,
          queries: 1,
          lastQueryKind: "SELECT",
          lastQueryFiberID: expect.any(Number),
          progressAgeMs: expect.any(Number),
        })
        expect(JSON.stringify(snapshot)).not.toContain("secret")
      }).pipe(
        Effect.provide(layer({ filename: ":memory:", disableWAL: true })),
        Effect.scoped,
        Effect.timeout("3 seconds"),
      ),
    )
    expect(DatabaseDiagnostics.diagnostics.snapshot().active).toBe(0)
  }, 5_000)

  test("tracks reservations, waiters, cancellation and release", async () => {
    const diagnostics = DatabaseDiagnostics.makeDiagnostics(true)
    const tracker = diagnostics.register()!
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => tracker.close()))
        const semaphore = yield* Semaphore.make(1)
        const access = DatabaseDiagnostics.acquisitions("connection", semaphore, tracker)
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        yield* Scope.provide(access.transactionAcquirer, scope)
        yield* Effect.withFiber((fiber) => Effect.sync(() => tracker.query("BEGIN /* secret */", fiber.id)))
        expect(diagnostics.snapshot().databases[0]).toMatchObject({
          owner: {
            kind: "reservation",
            lastQueryKind: "BEGIN",
            fiberID: expect.any(Number),
            acquiredAt: expect.any(Number),
            elapsedMs: expect.any(Number),
            waitMs: expect.any(Number),
          },
          acquired: 1,
          permitHeld: true,
          waiting: 0,
          depth: 1,
        })
        const waiter = yield* Effect.forkChild(access.acquirer)
        yield* awaitWaiting(diagnostics, 1)
        expect(diagnostics.snapshot().databases[0]).toMatchObject({
          waiting: 1,
          waiters: [{ kind: "query", ageMs: expect.any(Number) }],
          oldestTrackedWaitMs: expect.any(Number),
        })
        yield* Fiber.interrupt(waiter)
        expect(diagnostics.snapshot().databases[0]).toMatchObject({
          waiting: 0,
          waiters: [],
          oldestTrackedWaitMs: undefined,
        })
        const waitingScope = yield* Scope.make()
        const reservation = yield* Effect.forkChild(Scope.provide(access.transactionAcquirer, waitingScope))
        yield* awaitWaiting(diagnostics, 1)
        expect(diagnostics.snapshot().databases[0]).toMatchObject({ waiting: 1, waiters: [{ kind: "reservation" }] })
        yield* Fiber.interrupt(reservation)
        yield* Scope.close(waitingScope, Exit.void)
        expect(diagnostics.snapshot().databases[0]).toMatchObject({
          waiting: 0,
          acquired: 1,
          completed: 0,
          permitHeld: true,
        })
        const next = yield* Effect.forkChild(access.acquirer)
        yield* awaitWaiting(diagnostics, 1)
        yield* Scope.close(scope, Exit.void)
        yield* Fiber.join(next)
        expect(diagnostics.snapshot().databases[0]).toMatchObject({
          owner: undefined,
          permitHeld: false,
          acquired: 2,
          completed: 2,
          waiting: 0,
        })
      }).pipe(Effect.scoped, Effect.timeout("3 seconds")),
    )
    tracker.close()
    expect(diagnostics.snapshot()).toEqual({ active: 0, omitted: 0, databases: [] })
  }, 6_000)

  test("bounds records and never retains SQL", () => {
    const diagnostics = DatabaseDiagnostics.makeDiagnostics(true)
    const databases = Array.from({ length: 20 }, () => diagnostics.register()!)
    const db = databases[0]!
    const waiters = Array.from({ length: 20 }, (_, i) => db.wait("query", i))
    db.query("BEGIN /* secret-sql */", 123)
    db.query("SAVEPOINT secret-name", 123)
    expect(diagnostics.snapshot()).toMatchObject({ active: 20, omitted: 4 })
    expect(diagnostics.snapshot().databases[0]).toMatchObject({ depth: 2, waiting: 20, omittedWaiters: 4 })
    expect(diagnostics.snapshot().databases[0]?.waiters).toHaveLength(16)
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain("secret")
    db.query("ROLLBACK TO secret-name", 123)
    expect(db.snapshot().depth).toBe(2)
    db.query("COMMIT", 123)
    expect(db.snapshot().depth).toBe(0)
    db.query("secret-custom-operation", 456)
    expect(db.snapshot()).toMatchObject({ lastQueryKind: "OTHER", lastQueryFiberID: 456 })
    expect(JSON.stringify(db.snapshot())).not.toContain("secret")
    waiters.forEach((waiter) => db.unwait(waiter))
    databases.forEach((database) => database.close())
    expect(diagnostics.snapshot().active).toBe(0)
    expect(DatabaseDiagnostics.makeDiagnostics(false).register()).toBeUndefined()
  }, 2_000)

  test("disabled acquisition preserves cancellation and permit release", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(1)
        const access = DatabaseDiagnostics.acquisitions("connection", semaphore)
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        yield* Scope.provide(access.transactionAcquirer, scope)
        const waiter = yield* Effect.forkChild(access.acquirer)
        yield* Fiber.interrupt(waiter)
        yield* Scope.close(scope, Exit.void)
        expect(yield* access.acquirer).toBe("connection")
      }).pipe(Effect.scoped, Effect.timeout("3 seconds")),
    )
  }, 5_000)
})

function awaitWaiting(diagnostics: ReturnType<typeof DatabaseDiagnostics.makeDiagnostics>, count: number) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      if (diagnostics.snapshot().databases[0]?.waiting === count) return
      yield* Effect.yieldNow
    }
    throw new Error(`Database waiter count did not reach ${count}`)
  }).pipe(Effect.timeout("2 seconds"))
}
