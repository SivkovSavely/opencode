import { Cause, Context, Effect, Exit, ScopedCache, Scope } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"
const ReloadableId = "~opencode/InstanceState/reloadable"

interface Reloadable {
  readonly generations: Map<string, number>
  readonly has: (directory: string) => Effect.Effect<boolean>
  readonly load: (ctx: InstanceContext) => Effect.Effect<void>
  readonly invalidate: (directory: string, generation: number) => Effect.Effect<void>
}

interface Stage {
  active: boolean
  readonly generation: number
  readonly directories: Set<string>
  readonly entries: Map<Reloadable, Map<string, number>>
  readonly commits: Set<() => void>
}

const reloadables = new Set<Reloadable>()
let generation = 0
const staging = Context.Reference<Stage | undefined>("~opencode/InstanceState/staging", {
  defaultValue: () => undefined,
})

export const reloading = Context.Reference<boolean>("~opencode/InstanceState/reloading", {
  defaultValue: () => false,
})

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
  readonly [ReloadableId]?: Reloadable
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

/** Register an in-memory transition that must not yield before generation publication. */
export const onReloadCommit = (commit: () => void): Effect.Effect<void> =>
  Effect.gen(function* () {
    const stage = yield* staging
    if (!stage?.active) return yield* Effect.die(new Error("No active reload stage"))
    stage.commits.add(commit)
  })

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
  options?: { readonly reloadable: true },
): Effect.Effect<InstanceState<A, E>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.makeWith<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      // A cancelled initializer must not poison the directory until disposal.
      timeToLive: (exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? 0 : Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const state: InstanceState<A, E> = {
      [TypeId]: TypeId,
      cache,
      [ReloadableId]: options?.reloadable
        ? {
            generations: new Map(),
            has: (directory) => ScopedCache.has(cache, key(state, directory)),
            load: (ctx) => get(state).pipe(Effect.provideService(InstanceRef, ctx), Effect.orDie, Effect.asVoid),
            invalidate: (directory, generation) => ScopedCache.invalidate(cache, generationKey(directory, generation)),
          }
        : undefined,
    }
    const reloadable = state[ReloadableId]
    if (reloadable) reloadables.add(reloadable)
    const off = registerDisposer((directory) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (!reloadable) return yield* ScopedCache.invalidate(cache, directory)
          reloadable.generations.delete(directory)
          const prefix = `[${JSON.stringify(directory)},`
          const keys = yield* ScopedCache.keys(cache)
          yield* keys
            .filter((key) => key.startsWith(prefix))
            .map((key) => ScopedCache.invalidate(cache, key))
            .reduce((effect, invalidate) => Effect.ensuring(effect, invalidate), Effect.void)
        }),
      ),
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        off()
        if (!reloadable) return
        reloadables.delete(reloadable)
        reloadable.generations.clear()
      }),
    )

    return state
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const ctx = yield* context
    const stage = yield* staging
    const reloadable = self[ReloadableId]
    if (reloadable && stage?.active && stage.directories.has(ctx.directory)) {
      const entries = stage.entries.get(reloadable) ?? new Map<string, number>()
      if (!entries.has(ctx.directory)) entries.set(ctx.directory, reloadable.generations.get(ctx.directory) ?? 0)
      stage.entries.set(reloadable, entries)
    }
    // Materialize runtime references, including defaults, before the cache merges its captured services.
    const services = Context.make(InstanceRef, ctx).pipe(
      Context.add(staging, stage),
      Context.add(reloading, yield* reloading),
    )
    return yield* ScopedCache.get(self.cache, key(self, ctx.directory, stage)).pipe(Effect.provideContext(services))
  })

/** The caller holds the exclusive instance gate and runtime barrier throughout this transaction. */
export const reload = (contexts: readonly InstanceContext[]): Effect.Effect<void> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const stage: Stage = {
        active: true,
        generation: ++generation,
        directories: new Set(contexts.map((ctx) => ctx.directory)),
        entries: new Map(),
        commits: new Set(),
      }
      // A defective finalizer must not prevent the remaining entry scopes from closing.
      const invalidate = (staged: boolean) =>
        Array.from(stage.entries)
          .flatMap(([state, entries]) =>
            Array.from(entries, ([directory, previous]) =>
              state.invalidate(directory, staged ? stage.generation : previous),
            ),
          )
          .reduce((effect, invalidate) => Effect.ensuring(effect, invalidate), Effect.void)

      return yield* Effect.gen(function* () {
        const exit = yield* restore(
          Effect.forEach(
            contexts,
            (ctx) =>
              Effect.forEach(
                reloadables,
                (state) =>
                  Effect.flatMap(state.has(ctx.directory), (cached) => (cached ? state.load(ctx) : Effect.void)),
                { discard: true },
              ),
            { discard: true },
          ).pipe(Effect.provideService(staging, stage), Effect.provideService(reloading, true)),
        ).pipe(Effect.exit)
        stage.active = false
        if (Exit.isFailure(exit)) return yield* exit.pipe(Effect.ensuring(invalidate(true)))

        // No effects or scheduler yields may split publication across states or directories.
        yield* Effect.sync(() => {
          stage.commits.forEach((commit) => commit())
          stage.entries.forEach((entries, state) => {
            entries.forEach((_, directory) => state.generations.set(directory, stage.generation))
          })
        }).pipe(Effect.onError(() => invalidate(true)))
        // Publication cannot be rolled back after closing old scopes; cleanup defects are diagnostic only.
        yield* invalidate(false).pipe(
          Effect.catchCause(() => Effect.logError("Failed to close previous InstanceState generation")),
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stage.active = false
            stage.entries.clear()
            stage.directories.clear()
            stage.commits.clear()
          }),
        ),
      )
    }),
  )

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, key(self, yield* directory, yield* staging))
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, key(self, yield* directory, yield* staging))
  })

const generationKey = (directory: string, generation: number) => JSON.stringify([directory, generation])

function key<A, E, R>(self: InstanceState<A, E, R>, directory: string, stage?: Stage) {
  const reloadable = self[ReloadableId]
  if (!reloadable) return directory
  return generationKey(
    directory,
    stage?.active && stage.directories.has(directory) ? stage.generation : (reloadable.generations.get(directory) ?? 0),
  )
}

export * as InstanceState from "./instance-state"
