import { describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Clock, Deferred, Duration, Effect, Fiber, Ref, Scope } from "effect"
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
      expect((yield* execution(database, sessionID))?.state).toBe("active")
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
