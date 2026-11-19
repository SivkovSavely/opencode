import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { NodeHttpServer } from "@effect/platform-node"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import { InstanceReloadBusyError, registerDisposer, withInstanceReload } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { markInstanceForReload } from "../../src/server/routes/instance/httpapi/lifecycle"
import {
  InstanceContextMiddleware,
  instanceContextLayer,
} from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { WorkspaceRouteContext } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const registerDisposerScoped = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(disposer)),
    (off) => Effect.sync(off),
  )

describe("InstanceStore", () => {
  it.live("lists a stable snapshot while awaiting pending loads", () =>
    Effect.gen(function* () {
      const first = yield* tmpdirScoped()
      const pending = yield* tmpdirScoped()
      const later = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const loaded = yield* store.load({ directory: first })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* setBootstrap(
        Effect.gen(function* () {
          if ((yield* InstanceRef)?.directory !== pending) return
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const load = yield* store.load({ directory: pending }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const listing = yield* Effect.suspend(() => store.list()).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* store.load({ directory: later })
      yield* Deferred.succeed(release, undefined)
      const ctx = yield* Fiber.join(load)
      expect(yield* Fiber.join(listing)).toEqual([loaded, ctx])
      expect((yield* withInstanceReload(store.list())).map((ctx) => ctx.directory)).toEqual([first, pending, later])
    }),
  )

  for (const operation of ["load", "reload"] as const) {
    it.live(`keeps cancelled ${operation} bootstrap active until completion`, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const store = yield* InstanceStore.Service
        if (operation === "reload") yield* store.load({ directory: dir })
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* setBootstrap(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }),
        )
        const caller = yield* store[operation]({ directory: dir }).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        const cancelled = yield* Fiber.interrupt(caller).pipe(Effect.forkScoped({ startImmediately: true }))
        const result = yield* withInstanceReload(Effect.void).pipe(Effect.result)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(cancelled)
        const ctx = yield* store.load({ directory: dir })
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(InstanceReloadBusyError)
        expect(Exit.hasInterrupts(yield* Fiber.await(caller))).toBe(true)
        expect(yield* withInstanceReload(store.list())).toEqual([ctx])
      }),
    )
  }

  it.live("counts the provided handler and allows concurrent and nested instance operations", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const other = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const request = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            expect(yield* InstanceRef).toBe(ctx)
            expect(yield* store.load({ directory: dir })).toBe(ctx)
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            yield* store.reload({ directory: dir })
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const result = yield* withInstanceReload(Effect.void).pipe(Effect.result)
      const concurrent = yield* awaitWithTimeout(store.load({ directory: other }), "ordinary instance reads serialized")
      yield* Deferred.succeed(release, undefined)
      yield* awaitWithTimeout(Fiber.join(request), "nested instance reload deadlocked")
      expect(result._tag).toBe("Failure")
      expect(concurrent.directory).toBe(other)
      expect((yield* withInstanceReload(store.list())).length).toBe(2)
    }),
  )

  it.live("keeps HTTP handlers active and permits pre-response instance reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })
      const workspaceID = WorkspaceV2.ID.make("wrk_activity_test")
      const started = yield* Deferred.make<{ instance: typeof ctx | undefined; workspace: string | undefined }>()
      const release = yield* Deferred.make<void>()
      const api = HttpApi.make("instance-activity").add(
        HttpApiGroup.make("probe").add(HttpApiEndpoint.get("get", "/activity")).middleware(InstanceContextMiddleware),
      )
      const handler = yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(
            HttpApiBuilder.group(api, "probe", (handlers) =>
              handlers.handleRaw("get", () =>
                Effect.gen(function* () {
                  const instance = yield* InstanceRef
                  yield* Deferred.succeed(started, { instance, workspace: yield* WorkspaceRef })
                  yield* Deferred.await(release)
                  if (instance) yield* markInstanceForReload(instance, { directory: dir })
                  return HttpServerResponse.empty()
                }),
              ),
            ),
          ),
          Layer.provide(instanceContextLayer),
          Layer.provide(Layer.succeed(WorkspaceRouteContext, { directory: dir, workspaceID })),
          Layer.provide(NodeHttpServer.layerHttpServices),
        ),
      )
      const status = yield* Deferred.make<number>()
      const request = yield* HttpEffect.toHandled(handler, (_request, response) =>
        Deferred.succeed(status, response.status),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("http://localhost/activity")),
        ),
        Effect.provideService(WorkspaceRouteContext, { directory: dir, workspaceID }),
        Effect.forkScoped,
      )
      const observed = yield* Deferred.await(started)
      const result = yield* withInstanceReload(Effect.void).pipe(Effect.result)
      yield* Deferred.succeed(release, undefined)
      yield* awaitWithTimeout(Fiber.join(request), "pre-response instance reload deadlocked")
      expect(observed).toEqual({ instance: ctx, workspace: workspaceID })
      expect(result._tag).toBe("Failure")
      expect(yield* Deferred.await(status)).toBe(204)
      expect(yield* store.load({ directory: dir })).not.toBe(ctx)
    }),
  )

  for (const operation of ["dispose", "disposeDirectory", "disposeAll"] as const) {
    it.live(`keeps cancelled ${operation} active until Promise disposers finish`, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const release = yield* Deferred.make<() => void>()
        yield* registerDisposerScoped(
          () =>
            new Promise<void>((resolve) => {
              Deferred.doneUnsafe(release, Effect.succeed(resolve))
            }),
        )
        const caller = yield* (
          operation === "dispose"
            ? store.dispose(ctx)
            : operation === "disposeDirectory"
              ? store.disposeDirectory(dir)
              : store.disposeAll()
        ).pipe(Effect.forkScoped)
        const finish = yield* Deferred.await(release)
        const cancelled = yield* Fiber.interrupt(caller).pipe(Effect.forkScoped({ startImmediately: true }))
        const result = yield* withInstanceReload(Effect.void).pipe(Effect.result)
        yield* Effect.sync(finish)
        yield* Fiber.join(cancelled)
        expect(result._tag).toBe("Failure")
        expect(Exit.hasInterrupts(yield* Fiber.await(caller))).toBe(true)
      }),
    )
  }

  it.live("loads instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
    }),
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      yield* setBootstrap(
        Effect.gen(function* () {
          initializedDirectory = (yield* InstanceRef)?.directory
        }),
      )
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      yield* Deferred.succeed(release, undefined)

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
          throw new Error("init failed")
        }),
      )
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
        }),
      )
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(attempts).toBe(2)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloading, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(reloading)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReload, undefined)

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const release = yield* Deferred.await(releaseDispose)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([dir])
      yield* Effect.sync(release)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1, dir2])
    }),
  )
})
