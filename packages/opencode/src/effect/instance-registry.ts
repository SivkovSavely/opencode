import { Context, Effect, References, Semaphore } from "effect"

const gate = Semaphore.makeUnsafe(1)
const lease = Context.Reference<{ active: boolean } | undefined>("~opencode/InstanceActivity", {
  defaultValue: () => undefined,
})
let active = 0

export class InstanceReloadBusyError extends Error {
  readonly _tag = "InstanceReloadBusyError"
  constructor() {
    super("Instance reload is busy")
  }
}

const withPermit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.service(References.PreventSchedulerYield), (prevent) =>
    gate
      .withPermit(effect.pipe(Effect.provideService(References.PreventSchedulerYield, prevent)))
      .pipe(Effect.provideService(References.PreventSchedulerYield, true)),
  )

export const withInstanceActivity = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(lease, (current) => {
    if (current?.active) return effect
    return Effect.flatMap(Effect.service(References.PreventSchedulerYield), (prevent) =>
      Effect.acquireUseRelease(
        withPermit(
          Effect.sync(() => {
            active++
            return { active: true }
          }),
        ),
        () => effect.pipe(Effect.provideService(References.PreventSchedulerYield, prevent)),
        (token) =>
          Effect.sync(() => {
            token.active = false
            active--
          }),
      ).pipe(Effect.provideService(References.PreventSchedulerYield, true)),
    )
  })

export const withInstanceReload = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withPermit(
    Effect.gen(function* () {
      if (active) return yield* Effect.fail(new InstanceReloadBusyError())
      const token = { active: true }
      return yield* effect.pipe(
        Effect.provideService(lease, token),
        Effect.ensuring(
          Effect.sync(() => {
            token.active = false
          }),
        ),
      )
    }),
  )

const disposers = new Set<(directory: string) => Promise<void>>()

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string) {
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
}
