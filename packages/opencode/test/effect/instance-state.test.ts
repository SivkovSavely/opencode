import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { $ } from "bun"
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, ScopedCache } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance } from "@/effect/instance-registry"
import {
  disposeAllInstancesEffect,
  provideInstanceEffect,
  reloadInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer))

const access = <A, E>(state: InstanceState.InstanceState<A, E>, dir: string) =>
  InstanceState.get(state).pipe(provideInstanceEffect(dir))

const tmpdirGitScoped = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  yield* Effect.promise(() => $`git commit --allow-empty --amend -m ${`root commit ${dir}`}`.cwd(dir).quiet())
  return dir
})

it.live("InstanceState caches values per directory", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make(() => Effect.sync(() => ({ n: ++n })))

    const a = yield* access(state, dir)
    const b = yield* access(state, dir)

    expect(a).toBe(b)
    expect(n).toBe(1)
  }),
)

it.live("InstanceState isolates directories", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make((dir) => Effect.sync(() => ({ dir, n: ++n })))

    const a = yield* access(state, one)
    const b = yield* access(state, two)
    const c = yield* access(state, one)

    expect(a).toBe(c)
    expect(a).not.toBe(b)
    expect(n).toBe(2)
  }),
)

it.live("InstanceState recovers interrupted initialization without affecting other directories", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const started = yield* Deferred.make<void>()
    const released: string[] = []
    let n = 0
    const state = yield* InstanceState.make((ctx) =>
      Effect.gen(function* () {
        const value = yield* Effect.acquireRelease(
          Effect.sync(() => ({ directory: ctx.directory, n: ++n })),
          (value) =>
            Effect.sync(() => {
              released.push(`${value.directory}:${value.n}`)
            }),
        )
        if (ctx.directory === one && value.n === 1) {
          yield* Deferred.succeed(started, undefined)
          yield* Effect.never
        }
        return value
      }),
    )

    const first = yield* access(state, one).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const healthy = yield* access(state, two)
    yield* Fiber.interrupt(first)
    const interrupted = yield* Fiber.await(first)
    expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)

    const recovered = yield* access(state, one)
    expect(recovered).toEqual({ directory: one, n: 3 })
    expect(released).toEqual([`${one}:1`])
    expect(yield* access(state, one)).toBe(recovered)
    expect(yield* access(state, two)).toBe(healthy)
    expect(n).toBe(3)

    yield* reloadInstance({ directory: one })
    expect(released).toEqual([`${one}:1`, `${one}:3`])
    const reloaded = yield* access(state, one)
    expect(reloaded).not.toBe(recovered)
    yield* disposeAllInstancesEffect
    expect(released.sort()).toEqual([`${one}:1`, `${one}:3`, `${one}:4`, `${two}:2`].sort())
  }),
)

it.live("InstanceState releases interrupted resources on scope closure without another lookup", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const started = yield* Deferred.make<void>()
    let acquired = 0
    let released = 0

    yield* Effect.gen(function* () {
      const state = yield* InstanceState.make(() =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              acquired += 1
            }),
            () =>
              Effect.sync(() => {
                released += 1
              }),
          )
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      )
      const fiber = yield* access(state, dir).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped)

    expect(acquired).toBe(1)
    expect(released).toBe(1)
  }),
)

it.live("InstanceState keeps ordinary failures and mixed interruption causes cached", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const defect = new Error("initialization defect")
    for (const cause of [
      Cause.fail("initialization failure"),
      Cause.die(defect),
      Cause.combine(Cause.interrupt(), Cause.die(defect)),
      Cause.combine(Cause.interrupt(), Cause.fail("initialization failure")),
    ]) {
      let n = 0
      const state = yield* InstanceState.make(() =>
        Effect.gen(function* () {
          n += 1
          return yield* Effect.failCause(cause)
        }),
      )
      const first = yield* access(state, dir).pipe(Effect.exit)
      const second = yield* access(state, dir).pipe(Effect.exit)
      expect(Exit.isFailure(first)).toBe(true)
      expect(second).toEqual(first)
      expect(n).toBe(1)
    }
  }),
)

it.live("InstanceState shares recovery initialization and ignores cancellation of a waiter", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const started = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    let n = 0
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        n += 1
        if (n === 1) return yield* Effect.interrupt
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(gate)
        return { n }
      }),
    )

    yield* Effect.gen(function* () {
      const interrupted = yield* InstanceState.get(state).pipe(Effect.exit)
      expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)

      const owner = yield* InstanceState.get(state).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(Deferred.await(started), "recovery initialization did not start")
      const waiter = yield* InstanceState.get(state).pipe(Effect.forkScoped({ startImmediately: true }))
      const cancelled = yield* InstanceState.get(state).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Fiber.interrupt(cancelled)
      const exit = yield* Fiber.await(cancelled)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(n).toBe(2)

      yield* Deferred.succeed(gate, undefined)
      const value = yield* Fiber.join(owner)
      expect(yield* Fiber.join(waiter)).toBe(value)
      expect(yield* InstanceState.get(state)).toBe(value)
      expect(n).toBe(2)
    }).pipe(provideInstanceEffect(dir))
  }),
)

it.live("InstanceState invalidates on reload", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const seen: string[] = []
    let n = 0
    const state = yield* InstanceState.make(() =>
      Effect.acquireRelease(
        Effect.sync(() => ({ n: ++n })),
        (value) =>
          Effect.sync(() => {
            seen.push(String(value.n))
          }),
      ),
    )

    const a = yield* access(state, dir)
    yield* reloadInstance({ directory: dir })
    const b = yield* access(state, dir)

    expect(a).not.toBe(b)
    expect(seen).toEqual(["1"])
  }),
)

it.live("InstanceState invalidates on disposeAll", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const seen: string[] = []
    const state = yield* InstanceState.make((ctx) =>
      Effect.acquireRelease(
        Effect.sync(() => ({ dir: ctx.directory })),
        (value) =>
          Effect.sync(() => {
            seen.push(value.dir)
          }),
      ),
    )

    yield* access(state, one)
    yield* access(state, two)
    yield* disposeAllInstancesEffect

    expect(seen.sort()).toEqual([one, two].sort())
  }),
)

it.live("InstanceState reload commit hooks run after preparation and before releasing old scopes", () =>
  Effect.gen(function* () {
    const one = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const two = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const prepared: string[] = []
    const committed: string[] = []
    let revision = 1
    let broken = true
    const state = yield* InstanceState.make(
      (ctx) =>
        Effect.gen(function* () {
          const value = yield* Effect.acquireRelease(Effect.succeed({ revision }), (value) =>
            Effect.sync(() => {
              if (value.revision === 1) expect(committed).toEqual([one.directory, two.directory])
            }),
          )
          if (revision === 1) return value
          prepared.push(ctx.directory)
          yield* InstanceState.onReloadCommit(() => {
            expect(prepared).toEqual([one.directory, two.directory])
            committed.push(ctx.directory)
          })
          if (broken && ctx.directory === two.directory) return yield* Effect.fail("later preparation failed")
          return value
        }),
      { reloadable: true },
    )
    const beforeOne = yield* access(state, one.directory)
    const beforeTwo = yield* access(state, two.directory)
    revision = 2
    expect(Exit.isFailure(yield* InstanceState.reload([one, two]).pipe(Effect.exit))).toBe(true)
    expect(committed).toEqual([])
    expect(yield* access(state, one.directory)).toBe(beforeOne)
    expect(yield* access(state, two.directory)).toBe(beforeTwo)

    prepared.length = 0
    broken = false
    yield* InstanceState.reload([one, two])
    expect(committed).toEqual([one.directory, two.directory])
    expect((yield* access(state, one.directory)).revision).toBe(2)
    expect((yield* access(state, two.directory)).revision).toBe(2)
  }),
)

it.live("InstanceState commit hook defects discard staged states without publishing a generation", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const released: number[] = []
    let revision = 1
    const state = yield* InstanceState.make(
      () =>
        Effect.gen(function* () {
          const value = yield* Effect.acquireRelease(Effect.succeed({ revision }), (value) =>
            Effect.sync(() => {
              released.push(value.revision)
            }),
          )
          if (revision === 2)
            yield* InstanceState.onReloadCommit(() => {
              throw new Error("commit failed")
            })
          return value
        }),
      { reloadable: true },
    )
    const before = yield* access(state, ctx.directory)
    revision = 2
    expect(Exit.isFailure(yield* InstanceState.reload([ctx]).pipe(Effect.exit))).toBe(true)
    expect(yield* access(state, ctx.directory)).toBe(before)
    expect(released).toEqual([2])
    expect(yield* ScopedCache.size(state.cache)).toBe(1)
    revision = 3
    yield* InstanceState.reload([ctx])
    expect((yield* access(state, ctx.directory)).revision).toBe(3)
  }),
)

it.live("InstanceState staged reload publishes both directories before releasing old scopes", () =>
  Effect.gen(function* () {
    const one = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const two = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const other = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const released: object[] = []
    const observed: object[] = []
    let revision = 1
    const state: InstanceState.InstanceState<{ directory: string; revision: number }> = yield* InstanceState.make(
      (ctx) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            expect(released).toEqual([])
            return { directory: ctx.directory, revision }
          }),
          (value) =>
            Effect.gen(function* () {
              released.push(value)
              if (value.revision !== 1 || value.directory === other.directory) return
              observed.push(yield* access(state, one.directory), yield* access(state, two.directory))
            }),
        ),
      { reloadable: true },
    )
    let ordinaryBuilds = 0
    const ordinary = yield* InstanceState.make(() => Effect.succeed({ n: ++ordinaryBuilds }))
    let unusedBuilds = 0
    yield* InstanceState.make(() => Effect.succeed(++unusedBuilds), { reloadable: true })
    const first = yield* access(state, one.directory)
    const second = yield* access(state, two.directory)
    const untouched = yield* access(state, other.directory)
    const session = yield* access(ordinary, one.directory)
    session.n = 42
    revision = 2

    yield* InstanceState.reload([one, two, one])

    const nextOne = yield* access(state, one.directory)
    const nextTwo = yield* access(state, two.directory)
    expect(nextOne).toEqual({ directory: one.directory, revision: 2 })
    expect(nextTwo).toEqual({ directory: two.directory, revision: 2 })
    expect(nextOne).not.toBe(first)
    expect(nextTwo).not.toBe(second)
    expect(observed).toEqual([nextOne, nextTwo, nextOne, nextTwo])
    expect(released).toEqual([first, second])
    expect(yield* access(state, other.directory)).toBe(untouched)
    expect(yield* access(ordinary, one.directory)).toBe(session)
    expect(session.n).toBe(42)
    expect(ordinaryBuilds).toBe(1)
    expect(unusedBuilds).toBe(0)
    expect(yield* ScopedCache.size(state.cache)).toBe(3)
  }),
)

it.live("InstanceState staged reload rolls back a later directory failure and retries corrected dependencies", () =>
  Effect.gen(function* () {
    const one = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const two = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const released: string[] = []
    let revision = 1
    let broken = true
    const dependency = yield* InstanceState.make(
      (ctx) =>
        Effect.gen(function* () {
          const value = yield* Effect.acquireRelease(Effect.succeed({ directory: ctx.directory, revision }), (value) =>
            Effect.sync(() => {
              released.push(`dependency:${value.directory}:${value.revision}`)
            }),
          )
          if (broken && ctx.directory === two.directory) return yield* Effect.fail("bad dependency")
          return value
        }),
      { reloadable: true },
    )
    const state = yield* InstanceState.make(
      (ctx) =>
        Effect.gen(function* () {
          const value = yield* Effect.acquireRelease(Effect.succeed({ directory: ctx.directory, revision }), (value) =>
            Effect.sync(() => {
              released.push(`state:${value.directory}:${value.revision}`)
            }),
          )
          const dep = revision === 1 ? undefined : yield* InstanceState.get(dependency)
          return { ...value, dependency: dep }
        }),
      { reloadable: true },
    )
    const first = yield* access(state, one.directory)
    const second = yield* access(state, two.directory)
    revision = 2

    const failed = yield* InstanceState.reload([one, two]).pipe(Effect.exit)

    expect(Exit.isFailure(failed)).toBe(true)
    expect(yield* access(state, one.directory)).toBe(first)
    expect(yield* access(state, two.directory)).toBe(second)
    expect(released.sort()).toEqual(
      [
        `dependency:${one.directory}:2`,
        `dependency:${two.directory}:2`,
        `state:${one.directory}:2`,
        `state:${two.directory}:2`,
      ].sort(),
    )
    expect(yield* ScopedCache.size(state.cache)).toBe(2)
    expect(yield* ScopedCache.size(dependency.cache)).toBe(0)

    broken = false
    revision = 3
    yield* InstanceState.reload([one, two])
    const nextOne = yield* access(state, one.directory)
    const nextTwo = yield* access(state, two.directory)
    expect(nextOne.revision).toBe(3)
    expect(nextTwo.revision).toBe(3)
    expect(nextOne.dependency).toBe(yield* access(dependency, one.directory))
    expect(nextTwo.dependency).toBe(yield* access(dependency, two.directory))
    expect(nextOne.dependency?.revision).toBe(3)
    expect(nextTwo.dependency?.revision).toBe(3)
    expect(released).toContain(`state:${one.directory}:1`)
    expect(released).toContain(`state:${two.directory}:1`)
    expect(yield* ScopedCache.size(state.cache)).toBe(2)
    expect(yield* ScopedCache.size(dependency.cache)).toBe(2)
  }),
)

it.live("InstanceState staged dependencies replace cached values without rebuilding the service graph", () =>
  Effect.gen(function* () {
    const one = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const two = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    class Settings extends Context.Service<Settings, { revision: number }>()("@test/InstanceStateReloadSettings") {}
    const settings = { revision: 1 }
    const dependency = yield* InstanceState.make(
      () =>
        Effect.gen(function* () {
          const service = yield* Settings
          return { service, revision: service.revision, reloading: yield* InstanceState.reloading }
        }),
      { reloadable: true },
    ).pipe(
      Effect.provideService(Settings, settings),
      Effect.provideService(InstanceRef, one),
      Effect.provideService(InstanceState.reloading, true),
    )
    const state = yield* InstanceState.make(
      (ctx) => Effect.map(InstanceState.get(dependency), (dependency) => ({ directory: ctx.directory, dependency })),
      { reloadable: true },
    ).pipe(Effect.provideService(Settings, settings), Effect.provideService(InstanceRef, one))
    const first = yield* access(state, one.directory)
    const second = yield* access(state, two.directory)
    expect(first.dependency.reloading).toBe(false)
    expect(second.directory).toBe(two.directory)
    settings.revision = 2

    yield* InstanceState.reload([one, two])

    const nextOne = yield* access(state, one.directory)
    const nextTwo = yield* access(state, two.directory)
    expect(nextOne.dependency).not.toBe(first.dependency)
    expect(nextTwo.dependency).not.toBe(second.dependency)
    expect(nextOne.dependency).toBe(yield* access(dependency, one.directory))
    expect(nextTwo.dependency).toBe(yield* access(dependency, two.directory))
    expect(nextOne.dependency).toEqual({ service: settings, revision: 2, reloading: true })
    expect(nextOne.dependency.service).toBe(settings)
    expect(nextTwo.dependency.service).toBe(settings)
    expect(nextTwo.directory).toBe(two.directory)
    expect(yield* InstanceState.reloading).toBe(false)
    const missing = yield* InstanceState.get(state).pipe(Effect.exit)
    expect(Exit.isFailure(missing)).toBe(true)
  }),
)

it.live("InstanceState staged reload rebuilds cached failures", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    let broken = true
    const state = yield* InstanceState.make(
      () => (broken ? Effect.fail("invalid settings") : Effect.succeed({ corrected: true })),
      { reloadable: true },
    )
    expect(Exit.isFailure(yield* access(state, ctx.directory).pipe(Effect.exit))).toBe(true)
    broken = false

    yield* InstanceState.reload([ctx])

    expect(yield* access(state, ctx.directory)).toEqual({ corrected: true })
    expect(yield* ScopedCache.size(state.cache)).toBe(1)
  }),
)

it.live("InstanceState rollback releases every staged entry even when a finalizer defects", () =>
  Effect.gen(function* () {
    const one = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const two = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const released: string[] = []
    let revision = 1
    const state = yield* InstanceState.make(
      (ctx) =>
        Effect.gen(function* () {
          const value = yield* Effect.acquireRelease(Effect.succeed({ directory: ctx.directory, revision }), (value) =>
            Effect.gen(function* () {
              released.push(`${value.directory}:${value.revision}`)
              if (value.directory === one.directory && value.revision === 2) {
                yield* Effect.die(new Error("resource close failed"))
              }
            }),
          )
          if (ctx.directory === two.directory && revision === 2) return yield* Effect.fail("bad settings")
          return value
        }),
      { reloadable: true },
    )
    const first = yield* access(state, one.directory)
    const second = yield* access(state, two.directory)
    revision = 2

    const failed = yield* InstanceState.reload([one, two]).pipe(Effect.exit)

    expect(Exit.isFailure(failed)).toBe(true)
    expect(released).toEqual([`${one.directory}:2`, `${two.directory}:2`])
    expect(yield* ScopedCache.size(state.cache)).toBe(2)
    expect(yield* access(state, one.directory)).toBe(first)
    expect(yield* access(state, two.directory)).toBe(second)
  }),
)

it.live("InstanceState staged reload remains committed when an old scope finalizer defects", () =>
  Effect.gen(function* () {
    const one = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const two = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const released: object[] = []
    const logs: unknown[] = []
    let revision = 1
    const state = yield* InstanceState.make(
      (ctx) =>
        Effect.acquireRelease(Effect.succeed({ directory: ctx.directory, revision }), (value) =>
          Effect.gen(function* () {
            released.push(value)
            if (value.directory === one.directory && value.revision === 1) {
              yield* Effect.die(new Error("reload-private-secret"))
            }
          }),
        ),
      { reloadable: true },
    )
    const first = yield* access(state, one.directory)
    const second = yield* access(state, two.directory)
    revision = 2

    const exit = yield* InstanceState.reload([one, two]).pipe(
      Effect.exit,
      Effect.provide(Logger.layer([Logger.make((entry) => logs.push({ message: entry.message, cause: entry.cause }))])),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(released).toEqual([first, second])
    expect((yield* access(state, one.directory)).revision).toBe(2)
    expect((yield* access(state, two.directory)).revision).toBe(2)
    expect(yield* ScopedCache.size(state.cache)).toBe(2)
    expect(logs).toHaveLength(1)
    expect(Bun.inspect(logs, { depth: 10 })).not.toContain("reload-private-secret")
  }),
)

it.live("InstanceState staged reload cancellation releases staged scopes and retains both active values", () =>
  Effect.gen(function* () {
    const one = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const two = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const started = yield* Deferred.make<void>()
    const released: object[] = []
    const staged: object[] = []
    const committed: object[] = []
    let revision = 1
    let block = true
    const state = yield* InstanceState.make(
      (ctx) =>
        Effect.gen(function* () {
          const value = yield* Effect.acquireRelease(Effect.succeed({ directory: ctx.directory, revision }), (value) =>
            Effect.sync(() => {
              released.push(value)
            }),
          )
          if (revision === 2) {
            staged.push(value)
            yield* InstanceState.onReloadCommit(() => committed.push(value))
            if (block && ctx.directory === two.directory) {
              yield* Deferred.succeed(started, undefined)
              yield* Effect.never
            }
          }
          return value
        }),
      { reloadable: true },
    )
    const first = yield* access(state, one.directory)
    const second = yield* access(state, two.directory)
    revision = 2
    const fiber = yield* InstanceState.reload([one, two]).pipe(Effect.forkScoped)
    yield* awaitWithTimeout(Deferred.await(started), "second staged directory did not start")
    expect(staged).toHaveLength(2)
    expect(released).toEqual([])
    expect(yield* access(state, one.directory)).toBe(first)
    expect(yield* access(state, two.directory)).toBe(second)

    yield* Fiber.interrupt(fiber)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(released).toEqual(staged)
    expect(committed).toEqual([])
    expect(yield* access(state, one.directory)).toBe(first)
    expect(yield* access(state, two.directory)).toBe(second)
    expect(yield* ScopedCache.size(state.cache)).toBe(2)
    block = false
    revision = 3
    yield* InstanceState.reload([one, two])
    expect((yield* access(state, one.directory)).revision).toBe(3)
    expect((yield* access(state, two.directory)).revision).toBe(3)
  }),
)

it.live("InstanceState disposal removes active and in-flight staged generations", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context.pipe(provideInstanceEffect(yield* tmpdirScoped()))
    const started = yield* Deferred.make<void>()
    const released: number[] = []
    let revision = 1
    const state = yield* InstanceState.make(
      () =>
        Effect.gen(function* () {
          const value = yield* Effect.acquireRelease(Effect.succeed({ revision }), (value) =>
            Effect.gen(function* () {
              released.push(value.revision)
              if (value.revision === 2) yield* Effect.die(new Error("resource close failed"))
            }),
          )
          if (revision === 3) {
            yield* Deferred.succeed(started, undefined)
            yield* Effect.never
          }
          return value
        }),
      { reloadable: true },
    )
    yield* access(state, ctx.directory)
    const initialKeys = yield* ScopedCache.keys(state.cache)
    revision = 2
    yield* InstanceState.reload([ctx])
    revision = 3
    const fiber = yield* InstanceState.reload([ctx]).pipe(Effect.forkScoped)
    yield* awaitWithTimeout(Deferred.await(started), "staged initializer did not start")
    expect(yield* ScopedCache.size(state.cache)).toBe(2)

    yield* Effect.promise(() => disposeInstance(ctx.directory))
    expect(yield* ScopedCache.size(state.cache)).toBe(0)
    yield* Fiber.interrupt(fiber)

    expect(released).toEqual([1, 2, 3])
    expect(yield* ScopedCache.size(state.cache)).toBe(0)
    expect(yield* InstanceState.has(state).pipe(provideInstanceEffect(ctx.directory))).toBe(false)
    revision = 4
    expect((yield* access(state, ctx.directory)).revision).toBe(4)
    expect(yield* ScopedCache.keys(state.cache)).toEqual(initialKeys)
    revision = 5
    yield* InstanceState.reload([ctx])
    expect((yield* access(state, ctx.directory)).revision).toBe(5)
    yield* disposeAllInstancesEffect
    expect(released).toEqual([1, 2, 3, 4, 5])
    expect(yield* ScopedCache.size(state.cache)).toBe(0)
  }),
)

it.live("InstanceState.get reads the current directory lazily", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()

    interface Api {
      readonly get: () => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/InstanceStateLazy") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))
          const get = InstanceState.get(state)

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              return yield* get
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const a = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(one))
      const b = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(two))

      expect(a).toBe(one)
      expect(b).toBe(two)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState preserves directory across async boundaries", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirGitScoped
    const two = yield* tmpdirGitScoped
    const three = yield* tmpdirGitScoped

    interface Api {
      readonly get: () => Effect.Effect<{ directory: string; worktree: string; project: string }>
    }

    class Test extends Context.Service<Test, Api>()("@test/InstanceStateAsync") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) =>
            Effect.sync(() => ({
              directory: ctx.directory,
              worktree: ctx.worktree,
              project: ctx.project.id,
            })),
          )

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              yield* Effect.sleep(Duration.millis(1))
              yield* Effect.sleep(Duration.millis(1))
              for (let i = 0; i < 100; i++) {
                yield* Effect.yieldNow
              }
              for (let i = 0; i < 100; i++) {
                yield* Effect.promise(() => Promise.resolve())
              }
              yield* Effect.sleep(Duration.millis(2))
              yield* Effect.sleep(Duration.millis(1))
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const [a, b, c] = yield* Effect.all(
        [one, two, three].map((dir) => Test.use((svc) => svc.get()).pipe(provideInstanceEffect(dir))),
        { concurrency: "unbounded" },
      )

      expect(a).toEqual({ directory: one, worktree: one, project: a.project })
      expect(b).toEqual({ directory: two, worktree: two, project: b.project })
      expect(c).toEqual({ directory: three, worktree: three, project: c.project })
      expect(a.project).not.toBe(b.project)
      expect(a.project).not.toBe(c.project)
      expect(b.project).not.toBe(c.project)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState survives high-contention concurrent access", () =>
  Effect.gen(function* () {
    const dirs = yield* Effect.all(
      Array.from({ length: 20 }, () => tmpdirScoped()),
      { concurrency: "unbounded" },
    )

    interface Api {
      readonly get: () => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/HighContention") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              for (let i = 0; i < 10; i++) {
                yield* Effect.sleep(Duration.millis(Math.random() * 3))
                yield* Effect.yieldNow
                yield* Effect.promise(() => Promise.resolve())
              }
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const results = yield* Effect.all(
        dirs.map((dir) => Test.use((svc) => svc.get()).pipe(provideInstanceEffect(dir))),
        { concurrency: "unbounded" },
      )

      expect(results).toEqual(dirs)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState correct after interleaved init and dispose", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()

    interface Api {
      readonly get: () => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/InterleavedDispose") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) =>
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(5))
              return ctx.directory
            }),
          )

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const a = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(one))
      expect(a).toBe(one)

      const [, b] = yield* Effect.all(
        [reloadInstance({ directory: one }), Test.use((svc) => svc.get()).pipe(provideInstanceEffect(two))],
        { concurrency: "unbounded" },
      )
      expect(b).toBe(two)

      const c = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(one))
      expect(c).toBe(one)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState mutation in one directory does not leak to another", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const state = yield* InstanceState.make(() => Effect.sync(() => ({ count: 0 })))

    const s1 = yield* access(state, one)
    s1.count = 42

    const s2 = yield* access(state, two)
    expect(s2.count).toBe(0)

    const s1again = yield* access(state, one)
    expect(s1again.count).toBe(42)
    expect(s1again).toBe(s1)
  }),
)

it.live("InstanceState dedupes concurrent lookups", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        n += 1
        yield* Effect.sleep(Duration.millis(10))
        return { n }
      }),
    )

    const [a, b] = yield* Effect.all([access(state, dir), access(state, dir)], { concurrency: "unbounded" })
    expect(a).toBe(b)
    expect(n).toBe(1)
  }),
)

it.live("InstanceState survives deferred resume from the same instance context", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })

    interface Api {
      readonly get: (gate: Deferred.Deferred<void>) => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/DeferredResume") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

          return Test.of({
            get: Effect.fn("Test.get")(function* (gate: Deferred.Deferred<void>) {
              yield* Deferred.await(gate)
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const fiber = yield* Test.use((svc) => svc.get(gate)).pipe(provideInstanceEffect(dir), Effect.forkScoped)

      yield* Deferred.succeed(gate, undefined).pipe(provideInstanceEffect(dir))
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe(dir)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState survives deferred resume outside ALS when InstanceRef is set", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })

    interface Api {
      readonly get: (gate: Deferred.Deferred<void>) => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/DeferredResumeOutside") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

          return Test.of({
            get: Effect.fn("Test.get")(function* (gate: Deferred.Deferred<void>) {
              yield* Deferred.await(gate)
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const fiber = yield* Test.use((svc) => svc.get(gate)).pipe(provideInstanceEffect(dir), Effect.forkScoped)

      yield* Deferred.succeed(gate, undefined)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe(dir)
    }).pipe(Effect.provide(Test.layer))
  }),
)
