import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "../../../src/session/session"
import {
  InstanceContextMiddleware,
  instanceContextLayer,
} from "../../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  workspaceRoutingLayer,
} from "../../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { workspaceLayerWithRuntimeFlags } from "../../fixture/workspace"
import { managedWorkspaceMiddleware } from "../../../src/server/routes/instance/httpapi/middleware/managed-workspace"
import { testEffect } from "../../lib/effect"

const api = HttpApi.make("managed-probe").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("get", "/probe", { query: WorkspaceRoutingQuery, success: Schema.Boolean }),
      HttpApiEndpoint.get("session", "/session/:sessionID/prompt_async", {
        params: { sessionID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: Schema.Boolean,
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)
const it = testEffect(
  Layer.mergeAll(
    NodeHttpServer.layerTest,
    NodeServices.layer,
    workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true }),
  ),
)

test("production route tree denies host routes and filters global events", async () => {
  const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
  const { GlobalBus } = await import("../../../src/bus/global")
  const app = HttpApiApp.webHandler()
  const context = Context.empty() as Context.Context<unknown>
  const config = process.env.OPENCODE_CONFIG_CONTENT
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    provider: { openai: { options: { apiKey: "managed-provider-secret-sentinel" } } },
  })
  for (const path of ["/provider", "/config/providers"]) {
    const response = await app.handler(new Request(`http://localhost${path}`), context)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain("managed-provider-secret-sentinel")
  }
  if (config === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
  else process.env.OPENCODE_CONFIG_CONTENT = config
  for (const [method, path] of [
    ["GET", "/global/config"],
    ["PATCH", "/global/config"],
    ["PUT", "/auth/provider"],
    ["GET", "/vcs"],
    ["POST", "/experimental/worktree/reset"],
    ["GET", "/"],
    ["HEAD", "/global/health"],
    ["OPTIONS", "/session"],
  ]) {
    expect((await app.handler(new Request(`http://localhost${path}`, { method }), context)).status).toBe(403)
  }
  expect((await app.handler(new Request("http://localhost/global/health"), context)).status).toBe(200)
  const controller = new AbortController()
  const response = await app.handler(
    new Request("http://localhost/global/event", { signal: controller.signal }),
    context,
  )
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected")
    const count = GlobalBus.listenerCount("event")
    const next = reader.read()
    for (let i = 0; i < 100 && GlobalBus.listenerCount("event") === count; i++) await new Promise(setImmediate)
    expect(GlobalBus.listenerCount("event")).toBeGreaterThan(count)
    GlobalBus.emit("event", { directory: process.env.TEST_OTHER, payload: { type: "foreign", properties: {} } })
    GlobalBus.emit("event", {
      directory: process.env.OPENCODE_MANAGED_WORKSPACE,
      workspace: "remote",
      payload: { type: "remote", properties: {} },
    })
    GlobalBus.emit("event", {
      directory: process.env.OPENCODE_MANAGED_WORKSPACE,
      payload: { type: "local", properties: {} },
    })
    const event = new TextDecoder().decode((await next).value)
    expect(event).toContain("local")
    expect(event).not.toContain("foreign")
    expect(event).not.toContain("remote")
  } finally {
    controller.abort()
    await reader.cancel().catch(() => {})
  }
}, 30_000)

it.live("blocks host-wide routes before their handlers", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const routes = HttpRouter.use((router) =>
      router.add("*", "/*", (request) =>
        Effect.sync(() => {
          calls.push(request.url)
          return HttpServerResponse.text("ok")
        }),
      ),
    ).pipe(Layer.provide(managedWorkspaceMiddleware))
    yield* routes.pipe(HttpRouter.serve, Layer.build)
    for (const request of [
      HttpClientRequest.post("/api/session").pipe(
        HttpClientRequest.bodyJsonUnsafe({ location: { directory: process.env.TEST_OTHER } }),
      ),
      HttpClientRequest.get("/api/session/ses_other"),
      HttpClientRequest.get("/api/fs?location%5Bdirectory%5D=/tmp"),
      HttpClientRequest.post("/experimental/worktree"),
      HttpClientRequest.delete("/experimental/worktree").pipe(
        HttpClientRequest.bodyJsonUnsafe({ directory: process.env.TEST_OTHER }),
      ),
      HttpClientRequest.post("/experimental/worktree/reset").pipe(
        HttpClientRequest.bodyJsonUnsafe({ directory: process.env.TEST_OTHER }),
      ),
      HttpClientRequest.post("/experimental/workspace/warp"),
      HttpClientRequest.post("/experimental/control-plane/move-session"),
      HttpClientRequest.get("/global/transcript/search/facets"),
      HttpClientRequest.get("/global/projects"),
      HttpClientRequest.get("/project/other/directories"),
      HttpClientRequest.post("/sync/replay"),
      HttpClientRequest.post("/pty"),
      HttpClientRequest.get("/global/config"),
      HttpClientRequest.patch("/global/config"),
      HttpClientRequest.put("/auth/provider"),
      HttpClientRequest.post("/provider/example/oauth/authorize"),
      HttpClientRequest.get("/vcs"),
      HttpClientRequest.post("/vcs/apply"),
      HttpClientRequest.get("/file/content?path=/etc/passwd"),
      HttpClientRequest.post("/session/ses_test/shell"),
      HttpClientRequest.post("/session/ses_test/command"),
      HttpClientRequest.delete("/session/ses_test"),
      HttpClientRequest.post("/session/ses_test/message/msg_test"),
      HttpClientRequest.get("/session/ses_test/message/msg_test/part"),
      HttpClientRequest.get("/"),
      HttpClientRequest.get("/assets/app.js"),
    ])
      expect((yield* HttpClient.execute(request)).status).toBe(403)
    expect(calls).toEqual([])
    const profile = process.env.OPENCODE_MANAGED_PROFILE
    const workspace = process.env.OPENCODE_MANAGED_WORKSPACE
    process.env.OPENCODE_MANAGED_PROFILE = "0"
    delete process.env.OPENCODE_MANAGED_WORKSPACE
    expect((yield* HttpClient.get("/global/config")).status).toBe(403)
    process.env.OPENCODE_MANAGED_PROFILE = profile
    process.env.OPENCODE_MANAGED_WORKSPACE = workspace
    for (const request of [
      HttpClientRequest.get("/global/health"),
      HttpClientRequest.get("/global/event"),
      HttpClientRequest.get("/session"),
      HttpClientRequest.get("/session/status"),
      HttpClientRequest.get("/session/ses_test"),
      HttpClientRequest.get("/session/ses_test/children"),
      HttpClientRequest.get("/session/ses_test/message"),
      HttpClientRequest.get("/session/ses_test/message/msg_test"),
      HttpClientRequest.post("/session"),
      HttpClientRequest.post("/session/ses_test/prompt_async"),
      HttpClientRequest.post("/session/ses_test/message"),
      HttpClientRequest.post("/session/ses_test/retire"),
      HttpClientRequest.get("/agent"),
      HttpClientRequest.get("/skill"),
      HttpClientRequest.get("/path"),
      HttpClientRequest.get("/permission"),
      HttpClientRequest.post("/permission/per_test/reply"),
      HttpClientRequest.post("/question/que_test/reject"),
      HttpClientRequest.get("/maintenance/historical-fence/identity"),
      HttpClientRequest.post("/maintenance/historical-fence"),
    ])
      expect((yield* HttpClient.execute(request)).status).toBe(200)
    expect(calls).toHaveLength(20)
  }),
)
const handlers = HttpApiBuilder.group(api, "probe", (group) =>
  group.handle("get", () => Effect.succeed(true)).handle("session", () => Effect.succeed(true)),
)

it.live("denies cross-slot hints and workspace routing before instance loading", () =>
  Effect.gen(function* () {
    const slot = process.env.OPENCODE_MANAGED_WORKSPACE!
    const other = process.env.TEST_OTHER!
    const alias = process.env.TEST_ALIAS!
    const loads: string[] = []
    const routes = HttpApiBuilder.layer(api).pipe(
      Layer.provide(handlers),
      Layer.provide(
        Layer.mergeAll(
          instanceContextLayer,
          workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        ),
      ),
      Layer.provide(
        Layer.mock(InstanceStore.Service)({
          load: (input) =>
            Effect.sync(() => {
              loads.push(input.directory)
              return { directory: input.directory, worktree: input.directory, project: { id: "global" } } as never
            }),
        }),
      ),
      Layer.provide(Layer.mock(Session.Service)({ get: () => Effect.succeed({ directory: other } as never) })),
    )
    yield* routes.pipe(HttpRouter.serve, Layer.build)
    for (const request of [
      HttpClientRequest.get(`/probe?directory=${encodeURIComponent(other)}`),
      HttpClientRequest.get(`/probe?directory=${encodeURIComponent(slot)}`).pipe(
        HttpClientRequest.setHeader("x-opencode-directory", other),
      ),
      HttpClientRequest.get(`/probe?directory=${encodeURIComponent(slot)}&directory=${encodeURIComponent(other)}`),
      HttpClientRequest.get(`/probe?workspace=invalid&directory=${encodeURIComponent(slot)}`),
      HttpClientRequest.get(`/session/ses_test/prompt_async?directory=${encodeURIComponent(slot)}`),
    ]) {
      expect((yield* HttpClient.execute(request)).status).toBe(403)
    }
    expect(loads).toEqual([])
    expect((yield* HttpClient.get(`/probe?directory=${encodeURIComponent(alias)}`)).status).toBe(200)
    expect(loads).toEqual([slot])
  }),
)
