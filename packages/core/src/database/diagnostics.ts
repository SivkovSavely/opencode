export * as DatabaseDiagnostics from "./diagnostics"

import { Context, Effect, Fiber, References, Scope, Semaphore } from "effect"
import { EventDiagnostics } from "../event-diagnostics"

type Kind = "query" | "reservation"
type Waiter = { kind: Kind; fiberID: number; startedAt: number; waiting: boolean }
type QueryKind =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "REPLACE"
  | "BEGIN"
  | "COMMIT"
  | "END"
  | "ROLLBACK"
  | "SAVEPOINT"
  | "RELEASE"
  | "PRAGMA"
  | "CREATE"
  | "ALTER"
  | "DROP"
  | "WITH"
  | "OTHER"
const limit = 16

export function makeDiagnostics(enabled = EventDiagnostics.enabled) {
  let nextID = 0
  const databases = new Map<number, ReturnType<typeof makeDatabase>>()
  let active = 0

  function register() {
    if (!enabled) return undefined
    active++
    const id = ++nextID
    const database = makeDatabase(id)
    if (databases.size < limit) databases.set(id, database)
    let closed = false
    return Object.assign(database, {
      close: () => {
        if (!closed) {
          closed = true
          databases.delete(id)
          active--
        }
      },
    })
  }

  return {
    enabled,
    register,
    snapshot: () => ({
      active,
      omitted: active - databases.size,
      databases: Array.from(databases.values(), (db) => db.snapshot()),
    }),
  }
}

function makeDatabase(id: number) {
  let owner: { kind: Kind; fiberID: number; acquiredAt: number; waitMs: number; lastQueryKind?: QueryKind } | undefined
  let waiting = 0
  const waiters = new Set<Waiter>()
  let acquired = 0
  let completed = 0
  let queries = 0
  let lastAcquiredAt: number | undefined
  let lastCompletedAt: number | undefined
  let lastQueryAt: number | undefined
  let lastQueryFiberID: number | undefined
  let lastQueryKind: QueryKind | undefined
  // Observational only: arbitrary raw SQL, comments, and named savepoint operations can make this estimate inaccurate.
  let depth = 0

  function unwait(waiter: Waiter) {
    if (!waiter.waiting) return
    waiter.waiting = false
    waiting--
    waiters.delete(waiter)
  }

  return {
    wait(kind: Kind, fiberID: number) {
      const waiter = { kind, fiberID, startedAt: Date.now(), waiting: true }
      waiting++
      if (waiters.size < limit) waiters.add(waiter)
      return waiter
    },
    unwait,
    acquire(waiter: Waiter) {
      unwait(waiter)
      lastAcquiredAt = Date.now()
      acquired++
      owner = {
        kind: waiter.kind,
        fiberID: waiter.fiberID,
        acquiredAt: lastAcquiredAt,
        waitMs: Math.max(0, lastAcquiredAt - waiter.startedAt),
      }
    },
    release() {
      owner = undefined
      completed++
      lastCompletedAt = Date.now()
    },
    query(sql: string, fiberID: number) {
      queries++
      lastQueryAt = Date.now()
      lastQueryFiberID = fiberID
      const keyword =
        /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|CREATE|ALTER|DROP|WITH)\b/i
          .exec(sql)?.[1]
          ?.toUpperCase()
      lastQueryKind = (keyword as QueryKind | undefined) ?? "OTHER"
      if (owner?.fiberID === fiberID) owner.lastQueryKind = lastQueryKind
      const control = lastQueryKind
      if (control === "BEGIN") depth = 1
      if (control === "SAVEPOINT") depth++
      if (control === "RELEASE") depth = Math.max(0, depth - 1)
      if (
        control === "COMMIT" ||
        control === "END" ||
        (control === "ROLLBACK" && !/^\s*ROLLBACK\s+(?:TRANSACTION\s+)?TO\b/i.test(sql))
      )
        depth = 0
    },
    snapshot() {
      const now = Date.now()
      const oldest = waiters.values().next().value
      const progress = Math.max(lastAcquiredAt ?? 0, lastCompletedAt ?? 0, lastQueryAt ?? 0)
      return {
        id,
        permitHeld: owner !== undefined,
        owner: owner && {
          kind: owner.kind,
          fiberID: owner.fiberID,
          acquiredAt: owner.acquiredAt,
          waitMs: owner.waitMs,
          elapsedMs: Math.max(0, now - owner.acquiredAt),
          lastQueryKind: owner.lastQueryKind,
        },
        state: depth ? "transaction" : "idle",
        depth,
        waiting,
        waiters: Array.from(waiters, (w) => ({
          kind: w.kind,
          fiberID: w.fiberID,
          startedAt: w.startedAt,
          ageMs: Math.max(0, now - w.startedAt),
        })),
        omittedWaiters: waiting - waiters.size,
        oldestTrackedWaitMs: oldest && Math.max(0, now - oldest.startedAt),
        acquired,
        completed,
        queries,
        lastAcquiredAt,
        lastCompletedAt,
        lastQueryAt,
        lastQueryFiberID,
        lastQueryKind,
        progressAgeMs: progress ? Math.max(0, now - progress) : undefined,
      }
    },
  }
}

export const diagnostics = makeDiagnostics()

export function acquisitions<A>(
  connection: A,
  semaphore: Semaphore.Semaphore,
  tracker?: ReturnType<typeof makeDatabase>,
) {
  // beta.83 can yield after take mutates the semaphore but before cleanup is installed.
  // Only the permit transfer is non-yielding; waiting for a permit remains interruptible.
  if (!tracker) {
    return {
      acquirer: semaphore
        .withPermits(1)(Effect.succeed(connection))
        .pipe(Effect.provideService(References.PreventSchedulerYield, true)),
      transactionAcquirer: Effect.uninterruptibleMask((restore) => {
        const fiber = Fiber.getCurrent()!
        const scope = Context.getUnsafe(fiber.context, Scope.Scope)
        return Effect.as(
          Effect.tap(
            restore(semaphore.take(1)).pipe(Effect.provideService(References.PreventSchedulerYield, true)),
            () => Scope.addFinalizer(scope, semaphore.release(1)),
          ),
          connection,
        )
      }),
    }
  }
  // The ordinary acquirer releases before native SQL runs; only reservations represent a held permit.
  const acquirer = Effect.uninterruptibleMask((restore) =>
    Effect.withFiber((fiber) => {
      const waiter = tracker.wait("query", fiber.id)
      return Effect.ensuring(
        restore(
          semaphore.withPermits(1)(
            Effect.sync(() => {
              tracker.acquire(waiter)
              tracker.release()
              return connection
            }),
          ),
        ).pipe(Effect.provideService(References.PreventSchedulerYield, true)),
        Effect.sync(() => tracker.unwait(waiter)),
      )
    }),
  )
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!
    const scope = Context.getUnsafe(fiber.context, Scope.Scope)
    const waiter = tracker.wait("reservation", fiber.id)
    return Effect.as(
      Effect.ensuring(
        Effect.tap(restore(semaphore.take(1)).pipe(Effect.provideService(References.PreventSchedulerYield, true)), () =>
          Effect.andThen(
            Effect.sync(() => tracker.acquire(waiter)),
            Scope.addFinalizer(
              scope,
              Effect.andThen(
                Effect.sync(() => tracker.release()),
                semaphore.release(1),
              ),
            ),
          ),
        ),
        Effect.sync(() => tracker.unwait(waiter)),
      ),
      connection,
    )
  })
  return { acquirer, transactionAcquirer }
}
