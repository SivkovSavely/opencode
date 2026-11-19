import path from "node:path"
import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { Cause, Effect, Exit, Fiber, Layer, Logger } from "effect"
import { Config } from "../../src/config/config"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceRef } from "../../src/effect/instance-ref"
import { withInstanceReload } from "../../src/effect/instance-registry"
import { MCP } from "../../src/mcp"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { InstanceStore } from "../../src/project/instance-store"
import { requireInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([MCP.node, Config.node, FSUtil.node, CrossSpawnSpawner.node]), [
    [Npm.node, Layer.mock(Npm.Service)({ install: () => Effect.void })],
  ]),
)

// Store.provide holds an activity lease; reload tests must release it before taking the exclusive gate.
const inInstance = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const store = yield* InstanceStore.Service
    const ctx = yield* store.load({ directory })
    yield* Effect.addFinalizer(() => store.dispose(ctx))
    return yield* effect.pipe(Effect.provideService(InstanceRef, ctx))
  }).pipe(Effect.provide(testInstanceStoreLayer))

function reloadServer(oauth = false) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const sessions = new Map<
        string,
        {
          protocol: Server
          transport: WebStandardStreamableHTTPServerTransport
          toolLists: number
          stream: ReturnType<typeof Promise.withResolvers<void>>
        }
      >()
      const state = { version: "before", requests: 0, unavailable: false, aborted: 0 }
      let latest: Server | undefined
      let pause: { method: string; reached: () => void; wait: Promise<void> } | undefined
      const wait = async (method: string) => {
        if (pause?.method !== method) return
        const current = pause
        pause = undefined
        current.reached()
        await current.wait
      }
      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          state.requests++
          request.signal.addEventListener("abort", () => state.aborted++)
          const url = new URL(request.url)
          if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
            return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] })
          if (url.pathname === "/.well-known/oauth-authorization-server")
            return Response.json({
              issuer: url.origin,
              authorization_endpoint: `${url.origin}/authorize`,
              token_endpoint: `${url.origin}/token`,
              registration_endpoint: `${url.origin}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code"],
              token_endpoint_auth_methods_supported: ["none"],
              code_challenge_methods_supported: ["S256"],
            })
          if (url.pathname === "/register")
            return Response.json({ ...(await request.json()), client_id: "reload-client" }, { status: 201 })
          if (url.pathname === "/token") return Response.json({ access_token: "reload-token", token_type: "Bearer" })
          if (state.unavailable) return new Response("Unavailable", { status: 503 })
          if (oauth && request.headers.get("authorization") !== "Bearer reload-token")
            return new Response("Unauthorized", {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
              },
            })
          const session = request.headers.get("mcp-session-id")
          if (session) {
            const current = sessions.get(session)
            if (!current) return new Response("Unknown session", { status: 404 })
            if (request.method === "GET") await wait("stream")
            const response = await current.transport.handleRequest(request)
            if (request.method === "GET" && response.status === 200) current.stream.resolve()
            return response
          }
          if (request.method !== "POST") return new Response(null, { status: 405 })
          const protocol = new Server(
            { name: "reload", version: "1" },
            {
              capabilities: { tools: { listChanged: true }, resources: {}, prompts: {}, logging: {} },
              instructions: `Use ${state.version}.`,
            },
          )
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
          })
          const current = { protocol, transport, toolLists: 0, stream: Promise.withResolvers<void>() }
          protocol.setRequestHandler(ListToolsRequestSchema, async () => {
            current.toolLists++
            await wait("tools")
            return { tools: [{ name: state.version, inputSchema: { type: "object" } }] }
          })
          protocol.setRequestHandler(ListPromptsRequestSchema, async () => {
            await wait("prompts")
            return { prompts: [{ name: state.version }] }
          })
          protocol.setRequestHandler(ListResourcesRequestSchema, async () => {
            await wait("resources")
            return { resources: [{ name: state.version, uri: `docs://${state.version}` }] }
          })
          protocol.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
            await wait("resourceTemplates")
            return { resourceTemplates: [{ name: state.version, uriTemplate: `docs://${state.version}/{id}` }] }
          })
          protocol.setRequestHandler(GetPromptRequestSchema, async () => {
            await wait("getPrompt")
            return { messages: [{ role: "user", content: { type: "text", text: state.version } }] }
          })
          protocol.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            await wait("readResource")
            return { contents: [{ uri: request.params.uri, text: state.version }] }
          })
          await protocol.connect(transport)
          const response = await transport.handleRequest(request)
          if (transport.sessionId) sessions.set(transport.sessionId, current)
          latest = protocol
          return response
        },
      })
      return {
        state,
        url: new URL("/mcp", http.url).toString(),
        sessions,
        async log(data: string) {
          if (!latest) throw new Error("MCP server is not initialized")
          await latest.sendLoggingMessage({ level: "error", logger: data, data })
          await latest.listRoots()
        },
        async notifyToolsChanged() {
          const current = Array.from(sessions.values()).find((session) => session.protocol === latest)
          if (!current) throw new Error("MCP server is not initialized")
          await current.stream.promise
          await current.protocol.sendToolListChanged()
        },
        pause(method: string) {
          const reached = Promise.withResolvers<void>()
          const wait = Promise.withResolvers<void>()
          pause = { method, reached: () => reached.resolve(), wait: wait.promise }
          return { reached: reached.promise, release: () => wait.resolve() }
        },
        close: async () => {
          await Promise.all(Array.from(sessions.values(), (session) => session.protocol.close()))
          await http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

const remote = (url: string) => ({ type: "remote" as const, url, oauth: false as const })

const reload = Effect.gen(function* () {
  const config = yield* Config.Service
  const mcp = yield* MCP.Service
  const ctx = yield* requireInstance
  yield* withInstanceReload(
    Effect.gen(function* () {
      yield* mcp.assertReloadable()
      yield* config.reload(InstanceState.reload([ctx]))
    }),
  )
})

it.live("reload preflight does not initialize uncached MCP state", () =>
  Effect.gen(function* () {
    const server = yield* reloadServer()
    const ctx = yield* requireInstance
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), { mcp: { cold: remote(server.url) } })
    yield* reload
    expect(server.state.requests).toBe(0)
    expect(yield* mcp.status()).toEqual({ cold: { status: "connected" } })
    expect(server.state.requests).toBeGreaterThan(0)
  }).pipe(inInstance),
)

it.live("reload refreshes MCP clients, definitions, resources and removed servers", () =>
  Effect.gen(function* () {
    const server = yield* reloadServer()
    const removed = yield* reloadServer()
    const added = yield* reloadServer()
    const ctx = yield* requireInstance
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), {
      mcp: { retained: remote(server.url), removed: remote(removed.url) },
    })
    const previous = yield* mcp.clients()
    expect(Object.keys(yield* mcp.tools()).sort()).toEqual(["removed_before", "retained_before"])
    expect(Object.keys(yield* mcp.resources("retained"))).toEqual(["retained:docs://before"])
    server.state.version = "after"
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), {
      mcp: { retained: remote(server.url), added: remote(added.url) },
    })
    yield* reload
    expect(yield* mcp.status()).toEqual({ retained: { status: "connected" }, added: { status: "connected" } })
    expect(Object.keys(yield* mcp.tools()).sort()).toEqual(["added_before", "retained_after"])
    expect(Object.keys(yield* mcp.prompts()).sort()).toEqual(["added:before", "retained:after"])
    expect(Object.keys(yield* mcp.resources()).sort()).toEqual(["added:docs://before", "retained:docs://after"])
    expect(Object.keys(yield* mcp.resourceTemplates()).sort()).toEqual([
      "added:docs://before/{id}",
      "retained:docs://after/{id}",
    ])
    expect((yield* mcp.instructions()).find((entry) => entry.name === "retained")?.instructions).toBe("Use after.")
    expect((yield* mcp.clients()).retained).not.toBe(previous.retained)
    expect(previous.retained?.transport).toBeUndefined()
    expect(previous.removed?.transport).toBeUndefined()
    expect((yield* mcp.readResource("retained", "docs://after"))?.contents).toEqual([
      { uri: "docs://after", text: "after" },
    ])
    server.state.version = "notified"
    yield* awaitWithTimeout(Effect.promise(server.notifyToolsChanged), "MCP tool notification was not sent")
    yield* pollWithTimeout(
      Effect.map(mcp.tools(), (tools) => (tools.retained_notified ? true : undefined)),
      "reloaded MCP client did not refresh tool definitions",
    )
    expect(Object.keys(yield* mcp.tools()).sort()).toEqual(["added_before", "retained_notified"])
  }).pipe(inInstance),
)

it.live("reload applies unavailable MCP configuration with failed status", () =>
  Effect.gen(function* () {
    const server = yield* reloadServer()
    const unavailable = yield* reloadServer()
    const ctx = yield* requireInstance
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), { mcp: { test: remote(server.url) } })
    const previous = (yield* mcp.clients()).test
    unavailable.state.unavailable = true
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), { mcp: { test: remote(unavailable.url) } })
    yield* reload
    expect((yield* config.get()).mcp?.test).toMatchObject(remote(unavailable.url))
    expect((yield* mcp.status()).test?.status).toBe("failed")
    expect(yield* mcp.tools()).toEqual({})
    expect(previous?.transport).toBeUndefined()
  }).pipe(inInstance),
)

it.live("a later staging failure keeps the previous MCP connection usable", () =>
  Effect.gen(function* () {
    const server = yield* reloadServer()
    const ctx = yield* requireInstance
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), { mcp: { test: remote(server.url) } })
    const previous = (yield* mcp.clients()).test
    const connected = server.sessions.size
    const failing = yield* InstanceState.make(
      Effect.fnUntraced(function* () {
        if (yield* InstanceState.reloading) return yield* Effect.die(new Error("later staging failure"))
      }),
      { reloadable: true },
    )
    yield* InstanceState.get(failing)
    const exit = yield* reload.pipe(Effect.exit)
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
      message: "later staging failure",
    })
    expect(server.sessions.size).toBe(connected + 1)
    expect((yield* mcp.clients()).test).toBe(previous)
    expect(previous?.transport).toBeDefined()
    expect((yield* mcp.readResource("test", "docs://before"))?.contents).toEqual([
      { uri: "docs://before", text: "before" },
    ])
  }).pipe(inInstance),
)

it.live("MCP server logs omit unpublished staging payloads and resume after publication", () => {
  const logs: unknown[] = []
  return Effect.gen(function* () {
    const server = yield* reloadServer()
    const ctx = yield* requireInstance
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), { mcp: { test: remote(server.url) } })
    yield* mcp.clients()
    const notify = yield* InstanceState.make(
      Effect.fnUntraced(function* () {
        if (yield* InstanceState.reloading) yield* Effect.promise(() => server.log("staged-config-secret"))
      }),
      { reloadable: true },
    )
    yield* InstanceState.get(notify)
    yield* reload
    expect(JSON.stringify(logs)).not.toContain("staged-config-secret")
    yield* Effect.promise(() => server.log("published-server-output"))
    expect(JSON.stringify(logs)).toContain("published-server-output")
  }).pipe(inInstance, Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry.message))])))
})

it.live("cancelled MCP staging closes replacement clients without disconnecting previous clients", () =>
  Effect.gen(function* () {
    const server = yield* reloadServer()
    const pending = yield* reloadServer()
    const ctx = yield* requireInstance
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), {
      mcp: { ready: remote(server.url), pending: remote(pending.url) },
    })
    const previous = yield* mcp.clients()
    const initial = yield* pollWithTimeout(
      Effect.sync(() => Array.from(server.sessions.values()).at(0)),
      "initial MCP session was not initialized",
    )
    yield* awaitWithTimeout(Effect.promise(() => initial.stream.promise), "initial MCP stream was not ready")
    const aborted = server.state.aborted
    // Delay the SSE channel so readiness cannot depend on a server-to-client probe.
    const stream = server.pause("stream")
    const paused = pending.pause("tools")
    yield* Effect.addFinalizer(() => Effect.sync(stream.release))
    yield* Effect.addFinalizer(() => Effect.sync(paused.release))
    const reloading = yield* reload.pipe(Effect.forkScoped)
    yield* awaitWithTimeout(
      Effect.promise(() => paused.reached),
      "MCP staging did not start",
    )
    yield* awaitWithTimeout(
      Effect.promise(() => stream.reached),
      "replacement MCP stream did not start",
    )
    const replacement = yield* pollWithTimeout(
      Effect.sync(() => Array.from(server.sessions.values()).at(1)),
      "replacement MCP session was not initialized",
    )
    stream.release()
    yield* awaitWithTimeout(
      Effect.promise(() => replacement.stream.promise),
      "replacement MCP stream was not ready",
    )
    yield* pollWithTimeout(
      Effect.gen(function* () {
        yield* Effect.promise(() => replacement.protocol.sendToolListChanged())
        return replacement.toolLists > 1 ? true : undefined
      }),
      "replacement MCP client was not stored",
    )
    yield* Fiber.interrupt(reloading)
    yield* pollWithTimeout(
      Effect.sync(() => (server.state.aborted > aborted ? true : undefined)),
      "replacement MCP client was not closed",
    )
    expect((yield* mcp.clients()).ready).toBe(previous.ready)
    expect(previous.ready?.transport).toBeDefined()
    expect(previous.pending?.transport).toBeDefined()
    expect((yield* mcp.readResource("ready", "docs://before"))?.contents).toEqual([
      { uri: "docs://before", text: "before" },
    ])
  }).pipe(inInstance),
)

it.live("pending and active MCP OAuth reject reload without interrupting authentication", () =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))
    const server = yield* reloadServer(true)
    const ctx = yield* requireInstance
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), {
      mcp: { oauth: { type: "remote", url: server.url } },
    })
    expect((yield* mcp.status()).oauth?.status).toBe("needs_auth")
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), { mcp: {} })
    const requests = server.state.requests
    const pending = yield* reload.pipe(Effect.exit)
    expect(Exit.isFailure(pending) ? Cause.squash(pending.cause) : undefined).toMatchObject({
      _tag: "InstanceReloadBusyError",
    })
    expect(server.state.requests).toBe(requests)
    expect((yield* config.get()).mcp?.oauth).toBeDefined()
    const started = yield* mcp.startAuth("oauth")
    const active = yield* reload.pipe(Effect.exit)
    expect(Exit.isFailure(active) ? Cause.squash(active.cause) : undefined).toMatchObject({
      _tag: "InstanceReloadBusyError",
    })
    expect((yield* mcp.finishAuth("oauth", "valid-code", started.oauthState)).status).toBe("connected")
    yield* reload
    expect(yield* mcp.status()).toEqual({})
  }).pipe(inInstance),
)

for (const method of ["prompts", "resources", "resourceTemplates", "getPrompt", "readResource"] as const) {
  it.live(`a non-HTTP MCP ${method} request blocks reload for its full lifetime`, () =>
    Effect.gen(function* () {
      const server = yield* reloadServer()
      const mcp = yield* MCP.Service
      yield* mcp.add("test", remote(server.url))
      const paused = server.pause(method)
      yield* Effect.addFinalizer(() => Effect.sync(paused.release))
      const request = yield* (
        method === "getPrompt"
          ? mcp.getPrompt("test", "before").pipe(
              Effect.tap((result) =>
                Effect.sync(() =>
                  expect(result?.messages).toEqual([{ role: "user", content: { type: "text", text: "before" } }]),
                ),
              ),
              Effect.asVoid,
            )
          : method === "readResource"
            ? mcp.readResource("test", "docs://before").pipe(
                Effect.tap((result) =>
                  Effect.sync(() => expect(result?.contents).toEqual([{ uri: "docs://before", text: "before" }])),
                ),
                Effect.asVoid,
              )
            : mcp[method]().pipe(
                Effect.map(Object.keys),
                Effect.tap((keys) =>
                  Effect.sync(() =>
                    expect(keys).toEqual([
                      method === "prompts"
                        ? "test:before"
                        : method === "resources"
                          ? "test:docs://before"
                          : "test:docs://before/{id}",
                    ]),
                  ),
                ),
                Effect.asVoid,
              )
      ).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(
        Effect.promise(() => paused.reached),
        "MCP request did not start",
      )
      const exit = yield* withInstanceReload(Effect.void).pipe(Effect.exit)
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
        _tag: "InstanceReloadBusyError",
      })
      paused.release()
      yield* awaitWithTimeout(Fiber.join(request), "MCP request did not finish")
      yield* withInstanceReload(Effect.void)
    }).pipe(inInstance),
  )
}
