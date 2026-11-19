import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { InstanceReloadBusyError } from "@/effect/instance-registry"
import { MCP } from "@/mcp"
import { InstanceStore } from "@/project/instance-store"
import { EventV2 } from "@opencode-ai/core/event"
import { EventDiagnostics, type SubscriberHandle } from "@opencode-ai/core/event-diagnostics"
import { ServerEvent } from "@opencode-ai/schema/server-event"
import { Installation } from "@/installation"
import { GlobalProjectList } from "@/server/global-project-list"
import { disposeAllInstancesAndEmitGlobalDisposed, reloadConfig } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Cause, Effect, Option, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import {
  ConfigReloadInvalidError,
  ConfigReloadBusyError,
  ConfigReloadInternalError,
  GlobalUpgradeInput,
} from "../groups/global"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { HttpApiError } from "effect/unstable/httpapi"
import { ManagedWorkspace } from "@/server/managed-workspace"

function configReloadError(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  if (error instanceof InstanceReloadBusyError || error instanceof RuntimeLifecycle.ConfigReloadBusyError)
    return new ConfigReloadBusyError({
      message: "Configuration reload requires an idle runtime. Try again when work has finished.",
    })
  if (
    error instanceof ConfigErrorV1.JsonError ||
    error instanceof ConfigErrorV1.InvalidError ||
    error instanceof ConfigErrorV1.FrontmatterError
  ) {
    const source = /^https?:\/\//i.test(error.data.path) ? "remote configuration" : error.data.path
    const fields =
      error instanceof ConfigErrorV1.InvalidError
        ? error.data.issues?.flatMap((issue: { path: readonly string[] }) =>
            issue.path.length ? [issue.path.join(".")] : [],
          )
        : undefined
    return new ConfigReloadInvalidError({
      message: `Invalid configuration in ${source}${fields?.length ? ` (${fields.join(", ")})` : ""}`,
    })
  }
  return new ConfigReloadInternalError({
    message: "Configuration reload failed. Previous configuration remains active.",
  })
}

function globalEventType(data: unknown) {
  if (!data || typeof data !== "object" || !("payload" in data)) return "unknown"
  const payload = data.payload
  if (!payload || typeof payload !== "object" || !("type" in payload) || typeof payload.type !== "string")
    return "unknown"
  return payload.type
}

function eventData(data: unknown, subscriberID: SubscriberHandle | undefined): Sse.Event {
  const serialized = JSON.stringify(data)
  if (EventDiagnostics.enabled) {
    EventDiagnostics.serialized(subscriberID, globalEventType(data), serialized.length, Buffer.byteLength(serialized))
  }
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: serialized,
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    let subscriberID: Parameters<typeof EventDiagnostics.serialized>[0]
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      return Effect.acquireRelease(
        Effect.sync(() => {
          subscriberID = EventDiagnostics.connectSubscriber({ transport: "global-event" })
          const handler = (event: GlobalBusEvent) => {
            if (ManagedWorkspace.directory && (event.directory !== ManagedWorkspace.directory || event.workspace))
              return
            EventDiagnostics.queueOffer(subscriberID, globalEventType(event))
            Queue.offerUnsafe(queue, event)
          }
          GlobalBus.on("event", handler)
          return { handler }
        }),
        ({ handler }) =>
          Effect.sync(() => {
            GlobalBus.off("event", handler)
            EventDiagnostics.disconnectSubscriber(subscriberID)
          }),
      )
    }).pipe(Stream.map((event) => (EventDiagnostics.queueDrain(subscriberID, globalEventType(event)), event)))
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map((event) => eventData(event, subscriberID)),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const projectList = yield* GlobalProjectList.Service
    const store = yield* Effect.serviceOption(InstanceStore.Service)
    const mcp = yield* Effect.serviceOption(MCP.Service)
    const runtime = Option.getOrElse(
      yield* Effect.serviceOption(RuntimeLifecycle.Service),
      () => RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable(),
    )

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const reload = Effect.fn("GlobalHttpApi.reload")(function* (
      update?: Parameters<Config.Interface["updateGlobal"]>[0],
    ) {
      if (Option.isNone(store) || Option.isNone(mcp))
        return yield* new ConfigReloadInternalError({ message: "Configuration reload is unavailable." })
      return yield* reloadConfig(runtime, update).pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(InstanceStore.Service, store.value),
        Effect.provideService(MCP.Service, mcp.value),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.fail(configReloadError(cause)),
        ),
      )
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      return (yield* reload(ctx.payload)) ?? ctx.payload
    })

    const configReload = Effect.fn("GlobalHttpApi.configReload")(function* () {
      yield* reload()
      return true as const
    })

    const projectsList = Effect.fn("GlobalHttpApi.projectsList")(function* () {
      const projects = yield* projectList.list().pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return { projects }
    })

    const projectsUpdate = Effect.fn("GlobalHttpApi.projectsUpdate")(function* (ctx: {
      payload: GlobalProjectList.Operation
    }) {
      const projects = yield* projectList
        .apply(ctx.payload)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: ServerEvent.ProjectsUpdated.type,
          properties: { projects },
        },
      })
      return { projects }
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    const runtimeStatus = Effect.fn("GlobalHttpApi.runtimeStatus")(function* () {
      return yield* runtime.status()
    })

    const runtimeRequest = Effect.fn("GlobalHttpApi.runtimeRequest")(function* (action: "restart" | "shutdown") {
      if (action === "restart" && !runtime.identity.restartSupported) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* runtime.request(action)
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("configReload", configReload)
      .handle("projectsList", projectsList)
      .handle("projectsUpdate", projectsUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
      .handle("runtime", runtimeStatus)
      .handle("runtimeRestart", () => runtimeRequest("restart"))
      .handle("runtimeShutdown", () => runtimeRequest("shutdown"))
  }),
)
