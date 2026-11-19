import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { withInstanceActivity, withInstanceReload } from "@/effect/instance-registry"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

it.live("reload rejects active work and releases its gate", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const reader = yield* withInstanceActivity(
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }),
    ).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    expect(Exit.isFailure(yield* Effect.exit(withInstanceReload(Effect.void)))).toBe(true)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(reader)
    expect(Exit.isSuccess(yield* Effect.exit(withInstanceReload(Effect.void)))).toBe(true)
  }),
)

it.live("reload blocks new activity and allows nested activity", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const entered = yield* Deferred.make<void>()
    const writer = yield* withInstanceReload(
      Effect.gen(function* () {
        yield* withInstanceActivity(withInstanceActivity(Effect.void))
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }),
    ).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const reader = yield* withInstanceActivity(Deferred.succeed(entered, undefined)).pipe(
      Effect.forkScoped({ startImmediately: true }),
    )
    expect(Deferred.isDoneUnsafe(entered)).toBe(false)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(writer)
    yield* Fiber.join(reader)
    expect(Deferred.isDoneUnsafe(entered)).toBe(true)
  }),
)

it.live("cancelled reload releases the gate and stale inherited tokens cannot bypass it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const resume = yield* Deferred.make<void>()
    const entered = yield* Deferred.make<void>()
    const child = yield* withInstanceReload(
      Effect.gen(function* () {
        return yield* Effect.gen(function* () {
          yield* Deferred.await(resume)
          yield* withInstanceActivity(Deferred.succeed(entered, undefined))
        }).pipe(Effect.forkScoped({ startImmediately: true }))
      }),
    )
    const writer = yield* withInstanceReload(
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Effect.never
      }),
    ).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* Deferred.succeed(resume, undefined)
    yield* Effect.yieldNow
    expect(Deferred.isDoneUnsafe(entered)).toBe(false)
    yield* Fiber.interrupt(writer)
    yield* Fiber.join(child)
    expect(Deferred.isDoneUnsafe(entered)).toBe(true)
  }),
)

it.live("concurrent reloads serialize", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const entered = yield* Deferred.make<void>()
    const first = yield* withInstanceReload(
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }),
    ).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const second = yield* withInstanceReload(Deferred.succeed(entered, undefined)).pipe(
      Effect.forkScoped({ startImmediately: true }),
    )
    expect(Deferred.isDoneUnsafe(entered)).toBe(false)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    expect(Deferred.isDoneUnsafe(entered)).toBe(true)
  }),
)
