import { describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Clock, Deferred, Duration, Effect, Exit, Fiber, Ref, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { Server } from "../../src/server/server"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node])))

const seedSession = Effect.fnUntraced(function* (database: Database.Interface) {
  const projectID = randomUUID()
  const sessionID = randomUUID()
  const now = Date.now()
  yield* database.db.run(sql`
    INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES (${projectID}, ${"/tmp"}, ${now}, ${now}, ${JSON.stringify([])})
  `)
  yield* database.db.run(sql`
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (${sessionID}, ${projectID}, ${sessionID}, ${"/tmp"}, ${"test"}, ${"1"}, ${now}, ${now})
  `)
  return sessionID
})

const execution = (database: Database.Interface, sessionID: string) =>
  database.db.get<{ state: string; retry_at: number | null }>(sql`
    SELECT state, retry_at FROM runtime_execution WHERE session_id = ${sessionID}
  `)

const executionDetails = (database: Database.Interface, sessionID: string) =>
  database.db.get<{
    state: string
    desired_active: number
    owner_lineage: string
    owner_instance: string
    fence: number
    retry_at: number | null
  }>(sql`
    SELECT state, desired_active, owner_lineage, owner_instance, fence, retry_at
    FROM runtime_execution
    WHERE session_id = ${sessionID}
  `)

const seedExecution = Effect.fnUntraced(function* (
  database: Database.Interface,
  sessionID: string,
  input: {
    lineage: string
    instance: string
    fence?: number
    state: RuntimeLifecycle.ExecutionState
    retryAt?: number
  },
) {
  const now = Date.now()
  yield* database.db.run(sql`
    INSERT INTO runtime_execution
      (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, retry_at,
       parent_session_id, parent_message_id, parent_call_id, time_created, time_updated)
    VALUES
      (${sessionID}, ${sessionID}, ${"/tmp"}, ${input.lineage}, ${input.instance}, ${input.fence ?? 0},
       ${input.state}, 1, ${input.retryAt ?? null}, NULL, NULL, NULL, ${now}, ${now})
  `)
})

const replaceOwner = Effect.fnUntraced(function* (
  database: Database.Interface,
  sessionID: string,
  ownerInstance: string,
  fence: number,
) {
  yield* database.db.run(sql`
    UPDATE runtime_execution
    SET owner_instance = ${ownerInstance}, fence = ${fence}, time_updated = ${Date.now()}
    WHERE session_id = ${sessionID}
  `)
})

describe("runtime lifecycle", () => {
  test("reports the listener runtime and rejects unsupported restart", async () => {
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const status = await fetch(new URL("/global/runtime", listener.url))
      expect(status.status).toBe(200)
      const info = await status.json()
      expect(info.state).toBe("running")

      const restart = await fetch(new URL("/global/runtime/restart", listener.url), { method: "POST" })
      expect(restart.status).toBe(info.restartSupported ? 200 : 400)
      if (info.restartSupported) await listener.lifecycle.awaitStop
    } finally {
      await listener.stop(true)
    }
  })

  test("shutdown request is accepted and reaches quiescence", async () => {
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const response = await fetch(new URL("/global/runtime/shutdown", listener.url), { method: "POST" })
      expect(response.status).toBe(200)
      await listener.lifecycle.awaitStop
      expect((await response.json()).state).toBe("stopping")
    } finally {
      await listener.stop(true)
    }
  })

  it.effect("does not poison local admission after a foreign-owner rejection", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const foreignInstance = randomUUID()
      const sessionID = yield* seedSession(database)
      yield* seedExecution(database, sessionID, {
        lineage,
        instance: foreignInstance,
        fence: 4,
        state: "active",
      })
      const runtime = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)

      const first = yield* runtime.admit({ sessionID, directory: "/tmp" }).pipe(Effect.exit)
      expect(Exit.isFailure(first)).toBe(true)
      expect((yield* runtime.status()).active).toBe(0)

      const second = yield* runtime.admit({ sessionID, directory: "/tmp" }).pipe(Effect.exit)
      expect(Exit.isFailure(second)).toBe(true)
      expect((yield* runtime.status()).active).toBe(0)
      expect((yield* executionDetails(database, sessionID))?.owner_instance).toBe(foreignInstance)
    }),
  )

  it.effect("rejects parked and retry_wait admission without local state", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const runtime = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)

      yield* Effect.forEach(
        ["parked", "retry_wait"] as const,
        (state) =>
          Effect.gen(function* () {
            const sessionID = yield* seedSession(database)
            yield* seedExecution(database, sessionID, {
              lineage,
              instance: randomUUID(),
              state,
              retryAt: state === "retry_wait" ? Date.now() + 10_000 : undefined,
            })
            const result = yield* runtime.admit({ sessionID, directory: "/tmp" }).pipe(Effect.exit)
            expect(Exit.isFailure(result)).toBe(true)
            expect((yield* runtime.status()).active).toBe(0)
          }),
        { discard: true },
      )
    }),
  )

  it.effect("commits durable and local state together after successful admission", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const instance = randomUUID()
      const sessionID = yield* seedSession(database)
      const runtime = RuntimeLifecycle.make({ lineage, instance }, scope, database)

      yield* runtime.admit({ sessionID, directory: "/tmp" })
      expect((yield* runtime.status()).active).toBe(1)
      expect(yield* runtime.beforeTurn(sessionID)).toBe(true)
      expect(yield* executionDetails(database, sessionID)).toMatchObject({
        state: "active",
        desired_active: 1,
        owner_lineage: lineage,
        owner_instance: instance,
        fence: 0,
        retry_at: null,
      })

      yield* runtime.release(sessionID)
      yield* runtime.admit({ sessionID, directory: "/tmp" })
      expect((yield* executionDetails(database, sessionID))?.fence).toBe(1)
      yield* runtime.release(sessionID)
    }),
  )

  it.effect("fails closed when fenced transitions lose ownership", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const runtime = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      const sessionID = yield* seedSession(database)
      yield* runtime.admit({ sessionID, directory: "/tmp" })
      yield* replaceOwner(database, sessionID, randomUUID(), 1)

      expect(Exit.isFailure(yield* runtime.park(sessionID).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* runtime.release(sessionID).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* runtime.retry(sessionID, Date.now() + 10_000).pipe(Effect.exit))).toBe(true)
      expect((yield* executionDetails(database, sessionID))?.state).toBe("active")
      expect((yield* runtime.status()).active).toBe(1)

      expect((yield* runtime.request("shutdown")).state).toBe("draining")
      expect((yield* runtime.status()).active).toBe(1)
      expect(Exit.isFailure(yield* runtime.release(sessionID).pipe(Effect.exit))).toBe(true)
      expect((yield* executionDetails(database, sessionID))?.state).toBe("active")
      expect((yield* runtime.status()).state).toBe("draining")

      const retryRuntime = RuntimeLifecycle.make({ lineage: randomUUID(), instance: randomUUID() }, scope, database)
      const retrySessionID = yield* seedSession(database)
      yield* retryRuntime.admit({ sessionID: retrySessionID, directory: "/tmp" })
      yield* retryRuntime.retry(retrySessionID, Date.now() + 10_000)
      yield* replaceOwner(database, retrySessionID, randomUUID(), 1)
      expect(Exit.isFailure(yield* retryRuntime.resumeRetry(retrySessionID).pipe(Effect.exit))).toBe(true)
      expect((yield* executionDetails(database, retrySessionID))?.state).toBe("retry_wait")
      expect((yield* retryRuntime.status()).active).toBe(1)
    }),
  )

  it.effect("quarantines stale active rows for explicit recovery", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const oldInstance = randomUUID()
      const newInstance = randomUUID()
      const sessionID = yield* seedSession(database)
      const old = RuntimeLifecycle.make({ lineage, instance: oldInstance }, scope, database)
      yield* old.admit({ sessionID, directory: "/tmp" })

      const attempts = yield* Ref.make(0)
      const replacement = RuntimeLifecycle.make({ lineage, instance: newInstance }, scope, database)
      yield* replacement.recover(() => Ref.update(attempts, (value) => value + 1))
      expect(yield* Ref.get(attempts)).toBe(0)
      expect((yield* replacement.status()).active).toBe(0)
      expect(yield* executionDetails(database, sessionID)).toMatchObject({
        state: "recovery_needed",
        owner_instance: oldInstance,
        fence: 1,
      })

      yield* replacement.admit({ sessionID, directory: "/tmp" })
      expect(yield* executionDetails(database, sessionID)).toMatchObject({
        state: "active",
        owner_lineage: lineage,
        owner_instance: newInstance,
        fence: 2,
      })
      expect((yield* replacement.status()).active).toBe(1)
      expect(yield* old.beforeTurn(sessionID)).toBe(false)
      expect(Exit.isFailure(yield* old.release(sessionID).pipe(Effect.exit))).toBe(true)
      expect(yield* executionDetails(database, sessionID)).toMatchObject({
        state: "active",
        owner_instance: newInstance,
        fence: 2,
      })

      yield* replacement.release(sessionID)
      expect((yield* executionDetails(database, sessionID))?.state).toBe("completed")
    }),
  )

  it.effect("does not quarantine active rows outside the current runtime identity", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const runtime = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      const sameInstanceSessionID = yield* seedSession(database)
      const foreignLineageSessionID = yield* seedSession(database)
      yield* seedExecution(database, sameInstanceSessionID, {
        lineage,
        instance: runtime.identity.instance,
        state: "active",
      })
      yield* seedExecution(database, foreignLineageSessionID, {
        lineage: randomUUID(),
        instance: randomUUID(),
        state: "active",
      })
      const attempts = yield* Ref.make(0)

      yield* runtime.recover(() => Ref.update(attempts, (value) => value + 1))
      expect(yield* Ref.get(attempts)).toBe(0)
      expect(yield* executionDetails(database, sameInstanceSessionID)).toMatchObject({ state: "active", fence: 0 })
      expect(yield* executionDetails(database, foreignLineageSessionID)).toMatchObject({
        state: "active",
        fence: 0,
      })
    }),
  )

  it.effect("marks failed recovery as recovery_needed for later explicit takeover", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const sessionID = yield* seedSession(database)
      const old = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      yield* old.admit({ sessionID, directory: "/tmp" })
      yield* old.request("shutdown")
      yield* old.release(sessionID)

      const started = yield* Deferred.make<void>()
      const replacement = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      yield* replacement.recover(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.fail(new Error("recovery failure"))
        }),
      )
      yield* Deferred.await(started)
      while ((yield* executionDetails(database, sessionID))?.state !== "recovery_needed") yield* Effect.yieldNow
      expect((yield* replacement.status()).active).toBe(0)
      expect(yield* executionDetails(database, sessionID)).toMatchObject({
        state: "recovery_needed",
        owner_instance: replacement.identity.instance,
        fence: 1,
      })

      const next = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      yield* next.admit({ sessionID, directory: "/tmp" })
      expect(yield* executionDetails(database, sessionID)).toMatchObject({
        state: "active",
        owner_instance: next.identity.instance,
        fence: 2,
      })
    }),
  )

  it.effect("does not complete a recovery row while an admitted lease remains", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const sessionID = yield* seedSession(database)
      const old = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      yield* old.admit({ sessionID, directory: "/tmp" })
      yield* old.request("shutdown")
      yield* old.release(sessionID)

      const started = yield* Deferred.make<void>()
      const allowCompletion = yield* Deferred.make<void>()
      const replacement = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      yield* replacement.recover(() =>
        Effect.gen(function* () {
          yield* replacement.admit({ sessionID, directory: "/tmp" })
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(allowCompletion)
        }),
      )
      yield* Deferred.await(started)
      yield* Deferred.succeed(allowCompletion, undefined)
      while ((yield* replacement.status()).active !== 1) yield* Effect.yieldNow
      expect((yield* executionDetails(database, sessionID))?.state).toBe("active")

      yield* replacement.release(sessionID)
      expect((yield* executionDetails(database, sessionID))?.state).toBe("completed")
    }),
  )

  it.effect("admits a retry before the next provider attempt", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const sessionID = yield* seedSession(database)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID(), instance: randomUUID() }, scope, database)
      const retryAt = (yield* Clock.currentTimeMillis) + 1000
      yield* runtime.admit({ sessionID, directory: "/tmp" })
      yield* runtime.retry(sessionID, retryAt)

      const admission = yield* Effect.sleep(Duration.millis(1000)).pipe(
        Effect.andThen(runtime.resumeRetry(sessionID)),
        Effect.forkChild,
      )
      yield* TestClock.adjust(999)
      expect(yield* runtime.beforeTurn(sessionID)).toBe(false)
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(admission)).toBe(true)
      expect(yield* runtime.beforeTurn(sessionID)).toBe(true)
      expect(yield* execution(database, sessionID)).toEqual({ state: "active", retry_at: null })
    }),
  )

  it.effect("drain parks a retry without losing its deadline", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const sessionID = yield* seedSession(database)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID(), instance: randomUUID() }, scope, database)
      const retryAt = (yield* Clock.currentTimeMillis) + 10_000
      const attempts = yield* Ref.make(0)
      yield* runtime.admit({ sessionID, directory: "/tmp" })
      yield* runtime.retry(sessionID, retryAt)

      const timer = yield* Effect.raceFirst(
        Effect.sleep(Duration.millis(10_000)).pipe(Effect.andThen(Ref.update(attempts, (value) => value + 1))),
        runtime.awaitDraining,
      ).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* runtime.request("shutdown")
      yield* Fiber.join(timer)
      yield* TestClock.adjust(Duration.millis(20_000))
      expect(yield* Ref.get(attempts)).toBe(0)
      expect(yield* runtime.awaitDrain).toBeUndefined()
      expect(yield* runtime.isParked(sessionID)).toBe(true)
      expect(yield* execution(database, sessionID)).toEqual({ state: "parked", retry_at: retryAt })
    }),
  )

  it.effect("drain waits for a retry that was admitted first", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const sessionID = yield* seedSession(database)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID(), instance: randomUUID() }, scope, database)
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      yield* runtime.admit({ sessionID, directory: "/tmp" })
      yield* runtime.retry(sessionID, (yield* Clock.currentTimeMillis) + 1000)
      expect(yield* runtime.resumeRetry(sessionID)).toBe(true)

      const provider = yield* Effect.gen(function* () {
        expect(yield* runtime.beforeTurn(sessionID)).toBe(true)
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect((yield* runtime.status()).active).toBe(1)
      expect(yield* runtime.request("shutdown")).toMatchObject({ state: "draining", active: 1 })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(provider)
      yield* runtime.release(sessionID)
      expect((yield* runtime.status()).active).toBe(0)
      expect((yield* runtime.status()).state).toBe("stopping")
    }),
  )

  it.effect("recovery waits only for the remaining retry deadline", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const sessionID = yield* seedSession(database)
      const old = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      const retryAt = (yield* Clock.currentTimeMillis) + 1000
      const resumed = yield* Deferred.make<void>()
      const attempts = yield* Ref.make(0)
      yield* old.admit({ sessionID, directory: "/tmp" })
      yield* old.retry(sessionID, retryAt)
      yield* old.request("shutdown")
      expect(yield* execution(database, sessionID)).toEqual({ state: "parked", retry_at: retryAt })

      const replacement = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      yield* replacement.recover(() =>
        Effect.gen(function* () {
          yield* Ref.update(attempts, (value) => value + 1)
          yield* Deferred.succeed(resumed, undefined)
        }),
      )
      while ((yield* replacement.status()).active === 0) yield* Effect.yieldNow
      yield* TestClock.adjust(999)
      expect(yield* Ref.get(attempts)).toBe(0)
      yield* TestClock.adjust(1)
      yield* Deferred.await(resumed)
      expect(yield* Ref.get(attempts)).toBe(1)
      yield* TestClock.adjust(1000)
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )

  it.effect("recovery resumes an already expired retry immediately", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const sessionID = yield* seedSession(database)
      const old = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      const resumed = yield* Deferred.make<void>()
      const attempts = yield* Ref.make(0)
      yield* old.admit({ sessionID, directory: "/tmp" })
      const retryAt = yield* Clock.currentTimeMillis
      yield* old.retry(sessionID, retryAt)
      yield* old.request("shutdown")
      expect(yield* execution(database, sessionID)).toEqual({ state: "parked", retry_at: retryAt })

      const replacement = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      yield* replacement.recover(() =>
        Effect.gen(function* () {
          yield* Ref.update(attempts, (value) => value + 1)
          yield* Deferred.succeed(resumed, undefined)
        }),
      )
      yield* Deferred.await(resumed)
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )

  it.effect("recovery resumes a normally parked execution immediately", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.Scope
      const lineage = randomUUID()
      const sessionID = yield* seedSession(database)
      const old = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      const resumed = yield* Deferred.make<void>()
      yield* old.admit({ sessionID, directory: "/tmp" })
      yield* old.request("shutdown")
      yield* old.release(sessionID)
      expect(yield* execution(database, sessionID)).toEqual({ state: "parked", retry_at: null })

      const replacement = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
      yield* replacement.recover(() => Deferred.succeed(resumed, undefined))
      yield* Deferred.await(resumed)
    }),
  )
})
