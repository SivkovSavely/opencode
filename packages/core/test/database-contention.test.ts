import { expect } from "bun:test"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Exit, Fiber, References, Scope, Semaphore } from "effect"
import { DatabaseDiagnostics } from "../src/database/diagnostics"
import { layer } from "../src/database/sqlite.bun"
import { testEffect } from "./lib/effect"

const it = testEffect(layer({ filename: ":memory:", disableWAL: true }))

for (const enabled of [false, true]) {
  for (const budget of [32, 2048]) {
    it.live(
      `does not leak a cancelled acquisition (diagnostics=${enabled}, yield budget=${budget})`,
      () =>
        Effect.gen(function* () {
          const diagnostics = DatabaseDiagnostics.makeDiagnostics(enabled)
          const leaks: string[] = []
          // Sweep the automatic-yield boundary rather than depending on one implementation-specific operation count.
          for (const kind of ["query", "reservation"] as const) {
            for (let padding = Math.max(0, budget - 48); padding < budget + 48; padding++) {
              const semaphore = yield* Semaphore.make(1)
              const tracker = diagnostics.register()
              const access = DatabaseDiagnostics.acquisitions("connection", semaphore, tracker)
              const owner = yield* Effect.gen(function* () {
                for (let i = 0; i < padding; i++) yield* Effect.sync(() => {})
                yield* kind === "query" ? access.acquirer : access.transactionAcquirer
                yield* Effect.never
              }).pipe(
                Effect.scoped,
                Effect.provideService(References.MaxOpsBeforeYield, budget),
                Effect.forkChild({ startImmediately: true }),
              )
              yield* Fiber.interrupt(owner)
              const reused = yield* access.acquirer.pipe(Effect.timeoutOption("50 millis"))
              if (reused._tag === "None" || tracker?.snapshot().waiting) leaks.push(`${kind}:${padding}`)
              tracker?.close()
            }
          }
          expect(leaks).toEqual([])
        }).pipe(Effect.timeout("8 seconds")),
      10_000,
    )
  }

  it.live(
    `cancels queued acquisitions before releasing their holder (diagnostics=${enabled})`,
    () =>
      Effect.gen(function* () {
        const diagnostics = DatabaseDiagnostics.makeDiagnostics(enabled)
        for (const kind of ["query", "reservation"] as const) {
          for (let padding = 0; padding < 64; padding++) {
            yield* Effect.gen(function* () {
              const semaphore = yield* Semaphore.make(1)
              const tracker = diagnostics.register()
              yield* Effect.addFinalizer(() => Effect.sync(() => tracker?.close()))
              const access = DatabaseDiagnostics.acquisitions("connection", semaphore, tracker)
              const scope = yield* Scope.make()
              yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
              yield* Scope.provide(access.transactionAcquirer, scope)
              const waiter = yield* Effect.gen(function* () {
                for (let i = 0; i < padding; i++) yield* Effect.sync(() => {})
                yield* kind === "query" ? access.acquirer : access.transactionAcquirer
              }).pipe(
                Effect.scoped,
                Effect.provideService(References.MaxOpsBeforeYield, 32),
                Effect.forkChild({ startImmediately: true }),
              )
              expect((yield* Fiber.interrupt(waiter).pipe(Effect.timeoutOption("200 millis")))._tag).toBe("Some")
              if (tracker) expect(tracker.snapshot()).toMatchObject({ permitHeld: true, waiting: 0 })
              yield* Scope.close(scope, Exit.void)
              expect(yield* access.acquirer.pipe(Effect.timeout("200 millis"))).toBe("connection")
            }).pipe(Effect.scoped)
          }
        }
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )
}

for (const kind of ["query", "transaction"] as const) {
  it.live(
    `reuses the SQLite connection after cancelling ${kind} acquisition at an automatic yield`,
    () =>
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        const leaks: number[] = []
        for (let padding = 1980; padding < 2100; padding++) {
          const owner = yield* Effect.gen(function* () {
            for (let i = 0; i < padding; i++) yield* Effect.sync(() => {})
            yield* kind === "query" ? db.all("select 1") : db.transaction(() => Effect.never)
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Fiber.interrupt(owner)
          const reused = yield* db.transaction(() => db.all("select 1")).pipe(Effect.timeoutOption("50 millis"))
          if (reused._tag === "None") {
            leaks.push(padding)
            break
          }
        }
        expect(leaks).toEqual([])
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )
}

it.live(
  "isolates ordinary queries from concurrent transaction rollback across scheduler yields",
  () =>
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("create table writes (id integer primary key, kind text not null)")
      yield* Effect.all(
        [
          Effect.forEach(
            Array.from({ length: 40 }, (_, i) => i),
            (i) => db.run(`insert into writes values (${i}, 'query')`),
            { concurrency: "unbounded" },
          ),
          Effect.forEach(
            Array.from({ length: 10 }, (_, i) => i + 100),
            (i) =>
              db
                .transaction(() =>
                  db
                    .run(`insert into writes values (${i}, 'rollback')`)
                    .pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.fail("rollback"))),
                )
                .pipe(Effect.ignore),
            { concurrency: "unbounded" },
          ),
        ],
        { concurrency: "unbounded" },
      )
      expect(yield* db.all("select * from writes where kind = 'query'")).toHaveLength(40)
      expect(yield* db.all("select * from writes where kind = 'rollback'")).toEqual([])
    }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 32), Effect.timeout("5 seconds")),
  10_000,
)
