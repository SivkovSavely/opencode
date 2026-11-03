export * as SessionActiveSelection from "./active-selection"

import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { SessionSchema } from "./schema"

type Parent = { readonly token: symbol; readonly model: ModelV2.Ref }

/** Only the live, process-owned parent turn can provide implicit inheritance. */
export class Service extends Context.Service<
  Service,
  {
    readonly get: (sessionID: SessionSchema.ID) => ModelV2.Ref | undefined
    readonly parent: (sessionID: SessionSchema.ID) => Parent | undefined
    readonly set: (sessionID: SessionSchema.ID, model: ModelV2.Ref) => symbol
    readonly update: (sessionID: SessionSchema.ID, parent: Parent, model: ModelV2.Ref) => void
    readonly clear: (sessionID: SessionSchema.ID) => void
    readonly end: (sessionID: SessionSchema.ID, token: symbol) => Effect.Effect<void>
    readonly admission: <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    readonly transition: <A, E, R>(
      sessionID: SessionSchema.ID,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>
  }
>()("@opencode/SessionActiveSelection") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const active = new Map<SessionSchema.ID, Parent>()
    const locks = new Map<
      SessionSchema.ID,
      { admission: Semaphore.Semaphore; transition: Semaphore.Semaphore; users: number }
    >()
    const lock = <A, E, R>(
      id: SessionSchema.ID,
      kind: "admission" | "transition",
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const existing = locks.get(id)
        const entry = existing ?? { admission: Semaphore.makeUnsafe(1), transition: Semaphore.makeUnsafe(1), users: 0 }
        locks.set(id, entry)
        entry.users++
        return entry[kind].withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (--entry.users === 0) locks.delete(id)
            }),
          ),
        )
      })
    return Service.of({
      get: (id) => active.get(id)?.model,
      parent: (id) => active.get(id),
      set: (id, model) => {
        const token = Symbol()
        active.set(id, { token, model })
        return token
      },
      update: (id, parent, model) => {
        if (active.get(id) === parent) active.set(id, { token: parent.token, model })
      },
      clear: (id) => {
        active.delete(id)
      },
      end: (id, token) =>
        lock(
          id,
          "transition",
          Effect.sync(() => {
            if (active.get(id)?.token === token) active.delete(id)
          }),
        ),
      admission: (id, effect) => lock(id, "admission", effect),
      transition: (id, effect) => lock(id, "transition", effect),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
