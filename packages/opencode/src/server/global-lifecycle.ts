import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { withInstanceReload } from "@/effect/instance-registry"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { InstanceStore } from "@/project/instance-store"
import { Effect } from "effect"
import { Event } from "./event"
import type { RuntimeLifecycle } from "./runtime-lifecycle"

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? store.disposeAll().pipe(Effect.catchCause((cause) => Effect.logWarning("global disposal failed", { cause })))
        : store.disposeAll()
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

export const reloadConfig = Effect.fn("Server.reloadConfig")(function* (
  runtime: RuntimeLifecycle.Interface,
  update?: Parameters<Config.Interface["updateGlobal"]>[0],
) {
  const config = yield* Config.Service
  const store = yield* InstanceStore.Service
  const mcp = yield* MCP.Service
  return yield* withInstanceReload(
    runtime.withConfigReload(
      Effect.gen(function* () {
        const contexts = yield* store.list()
        yield* Effect.forEach(contexts, (ctx) => mcp.assertReloadable().pipe(Effect.provideService(InstanceRef, ctx)))
        const result = update === undefined ? undefined : yield* config.updateGlobal(update, { deferInvalidate: true })
        yield* config.reload(InstanceState.reload(contexts))
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: "config.reloaded", properties: {} },
        })
        return result?.info
      }).pipe(Effect.uninterruptible),
    ),
  )
})

export * as GlobalLifecycle from "./global-lifecycle"
