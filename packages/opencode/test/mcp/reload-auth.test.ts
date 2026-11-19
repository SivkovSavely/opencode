import path from "node:path"
import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger } from "effect"
import { Config } from "../../src/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { withInstanceReload } from "../../src/effect/instance-registry"
import { InstanceState } from "../../src/effect/instance-state"
import { MCP } from "../../src/mcp"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { InstanceStore } from "../../src/project/instance-store"
import { reloadConfig } from "../../src/server/global-lifecycle"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([MCP.node, McpAuth.node, Config.node, FSUtil.node, CrossSpawnSpawner.node]), [
      [Npm.node, Layer.mock(Npm.Service)({ install: () => Effect.void })],
    ]),
    testInstanceStoreLayer,
  ),
)

const prepare = Effect.gen(function* () {
  const store = yield* InstanceStore.Service
  const first = yield* store.load({ directory: yield* tmpdirScoped() })
  const second = yield* store.load({ directory: yield* tmpdirScoped() })
  yield* Effect.addFinalizer(() => store.dispose(first))
  yield* Effect.addFinalizer(() => store.dispose(second))
  const config = yield* Config.Service
  yield* config.get().pipe(Effect.provideService(InstanceRef, second))
  return { first, second, config }
})

function oauthServer(prefix: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const state = {
        accessToken: `${prefix}-private-access`,
        refreshToken: `${prefix}-private-refresh`,
        headers: [] as string[],
        grants: [] as URLSearchParams[],
        registrations: 0,
      }
      const sessions = new Map<
        string,
        {
          protocol: Server
          transport: WebStandardStreamableHTTPServerTransport
          stream: ReturnType<typeof Promise.withResolvers<void>>
        }
      >()
      let pauseToken: { reached: () => void; wait: Promise<void> } | undefined
      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          const authorization = request.headers.get("authorization")
          if (authorization) state.headers.push(authorization)
          if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
            return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] })
          if (url.pathname === "/.well-known/oauth-authorization-server")
            return Response.json({
              issuer: url.origin,
              authorization_endpoint: `${url.origin}/authorize`,
              token_endpoint: `${url.origin}/token`,
              registration_endpoint: `${url.origin}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              token_endpoint_auth_methods_supported: ["none"],
              code_challenge_methods_supported: ["S256"],
            })
          if (url.pathname === "/register") {
            state.registrations++
            return Response.json({ ...(await request.json()), client_id: `${prefix}-client` }, { status: 201 })
          }
          if (url.pathname === "/token") {
            const grant = new URLSearchParams(await request.text())
            state.grants.push(grant)
            const pause = pauseToken
            pauseToken = undefined
            pause?.reached()
            if (pause) await pause.wait
            if (grant.get("grant_type") === "refresh_token" && grant.get("refresh_token") === state.refreshToken) {
              state.accessToken = `${prefix}-rotated-access`
              state.refreshToken = `${prefix}-rotated-refresh`
              return Response.json({
                access_token: state.accessToken,
                refresh_token: state.refreshToken,
                token_type: "Bearer",
              })
            }
            if (grant.get("code") === "valid-code")
              return Response.json({
                access_token: state.accessToken,
                refresh_token: state.refreshToken,
                token_type: "Bearer",
              })
            return Response.json({ error: "invalid_grant" }, { status: 400 })
          }
          if (authorization !== `Bearer ${state.accessToken}`)
            return new Response("Unauthorized", {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
              },
            })
          const session = sessions.get(request.headers.get("mcp-session-id") ?? "")
          if (session) {
            const response = await session.transport.handleRequest(request)
            if (request.method === "GET" && response.status === 200) session.stream.resolve()
            return response
          }
          if (request.method !== "POST") return new Response(null, { status: 405 })
          const protocol = new Server(
            { name: prefix, version: "1" },
            { capabilities: { tools: { listChanged: true }, resources: {} } },
          )
          protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{ name: "tool", inputSchema: { type: "object" } }],
          }))
          protocol.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: [{ name: prefix, uri: `docs://${prefix}` }],
          }))
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
          })
          await protocol.connect(transport)
          const response = await transport.handleRequest(request)
          if (transport.sessionId)
            sessions.set(transport.sessionId, { protocol, transport, stream: Promise.withResolvers<void>() })
          return response
        },
      })
      return {
        state,
        sessions,
        url: new URL("/mcp", http.url).toString(),
        pauseToken() {
          const reached = Promise.withResolvers<void>()
          const wait = Promise.withResolvers<void>()
          pauseToken = { reached: () => reached.resolve(), wait: wait.promise }
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

const remote = (url: string) => ({ type: "remote" as const, url })
const originalCredentials = {
  tokens: { accessToken: "original-private-access", refreshToken: "original-private-refresh" },
  clientInfo: { clientId: "original-client", clientSecret: "original-private-secret" },
}

it.live(
  "failed OAuth URL replacement never sends source credentials or changes live authentication, then retries",
  () => {
    const logs: unknown[] = []
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))
      const { first, second } = yield* prepare
      const original = yield* oauthServer("original")
      const replacement = yield* oauthServer("replacement")
      const auth = yield* McpAuth.Service
      const fs = yield* FSUtil.Service
      const mcp = yield* MCP.Service
      const name = `reload-auth-${crypto.randomUUID()}`
      yield* auth.set(name, originalCredentials, original.url)
      const beforeAuth = yield* auth.get(name)
      yield* fs.writeJson(path.join(first.directory, "opencode.json"), { mcp: { [name]: remote(original.url) } })
      const before = (yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first)))[name]
      expect(before).toBeDefined()
      yield* fs.writeJson(path.join(first.directory, "opencode.json"), { mcp: { [name]: remote(replacement.url) } })
      yield* fs.writeFileString(path.join(second.directory, "opencode.json"), "{invalid")

      const exit = yield* reloadConfig(RuntimeLifecycle.unavailable()).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(replacement.state.registrations).toBe(1)
      expect(replacement.state.grants).toEqual([])
      expect(replacement.state.headers).not.toContain("Bearer original-private-access")
      expect(yield* auth.get(name)).toEqual(beforeAuth)
      expect(yield* mcp.getAuthStatus(name).pipe(Effect.provideService(InstanceRef, first))).toBe("authenticated")
      expect((yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first)))[name]).toBe(before)
      expect(Object.keys(yield* mcp.resources(name).pipe(Effect.provideService(InstanceRef, first)))).toEqual([
        `${name}:docs://original`,
      ])
      const output = Bun.inspect({ exit, logs }, { depth: 20 })
      expect(output).not.toContain("original-private-")
      expect(output).not.toContain("replacement-private-")

      yield* fs.writeJson(path.join(second.directory, "opencode.json"), {})
      yield* reloadConfig(RuntimeLifecycle.unavailable())
      expect((yield* mcp.status().pipe(Effect.provideService(InstanceRef, first)))[name]).toEqual({
        status: "needs_auth",
      })
      expect(yield* auth.get(name)).toEqual(beforeAuth)
      expect(before?.transport).toBeUndefined()

      const started = yield* mcp.startAuth(name).pipe(Effect.provideService(InstanceRef, first))
      expect(yield* auth.get(name)).toEqual(beforeAuth)
      expect(
        (yield* mcp.finishAuth(name, "valid-code", started.oauthState).pipe(Effect.provideService(InstanceRef, first)))
          .status,
      ).toBe("connected")
      expect(yield* auth.getForUrl(name, replacement.url)).toMatchObject({
        tokens: { accessToken: "replacement-private-access", refreshToken: "replacement-private-refresh" },
        clientInfo: { clientId: "replacement-client" },
      })
      expect(yield* auth.get(`${name}:${started.oauthState}`)).toBeUndefined()
      expect(replacement.state.grants.map((grant) => grant.get("refresh_token"))).toEqual([null])
    }).pipe(Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry.message))])))
  },
)

it.live("same-URL OAuth reload preserves credentials and enables live refresh only after publication", () =>
  Effect.gen(function* () {
    const { first } = yield* prepare
    const server = yield* oauthServer("original")
    const auth = yield* McpAuth.Service
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const name = `reload-auth-${crypto.randomUUID()}`
    yield* auth.set(name, originalCredentials, server.url)
    const beforeAuth = yield* auth.get(name)
    yield* fs.writeJson(path.join(first.directory, "opencode.json"), { mcp: { [name]: remote(server.url) } })
    const before = (yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first)))[name]

    yield* reloadConfig(RuntimeLifecycle.unavailable())

    expect((yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first)))[name]).not.toBe(before)
    expect(yield* auth.get(name)).toEqual(beforeAuth)
    expect(server.state.registrations).toBe(0)
    expect(server.state.grants).toEqual([])
    server.state.accessToken = "expired-access"
    expect(Object.keys(yield* mcp.resources(name).pipe(Effect.provideService(InstanceRef, first)))).toEqual([
      `${name}:docs://original`,
    ])
    expect(server.state.grants.map((grant) => grant.get("refresh_token"))).toEqual(["original-private-refresh"])
    expect(yield* auth.getForUrl(name, server.url)).toMatchObject({
      tokens: { accessToken: "original-rotated-access", refreshToken: "original-rotated-refresh" },
    })
  }),
)

it.live("failed same-URL OAuth staging cannot rotate the original refresh token", () =>
  Effect.gen(function* () {
    const { first, second } = yield* prepare
    const server = yield* oauthServer("original")
    const auth = yield* McpAuth.Service
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const name = `reload-auth-${crypto.randomUUID()}`
    yield* auth.set(name, originalCredentials, server.url)
    const beforeAuth = yield* auth.get(name)
    yield* fs.writeJson(path.join(first.directory, "opencode.json"), { mcp: { [name]: remote(server.url) } })
    const before = (yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first)))[name]
    server.state.accessToken = "expired-access"
    yield* fs.writeFileString(path.join(second.directory, "opencode.json"), "{invalid")

    expect(Exit.isFailure(yield* reloadConfig(RuntimeLifecycle.unavailable()).pipe(Effect.exit))).toBe(true)

    expect(server.state.grants).toEqual([])
    expect(yield* auth.get(name)).toEqual(beforeAuth)
    expect((yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first)))[name]).toBe(before)
    expect(Object.keys(yield* mcp.resources(name).pipe(Effect.provideService(InstanceRef, first)))).toEqual([
      `${name}:docs://original`,
    ])
    expect(server.state.grants.map((grant) => grant.get("refresh_token"))).toEqual(["original-private-refresh"])
  }),
)

it.live("OAuth reload requires an exact URL match even for another path on the same origin", () =>
  Effect.gen(function* () {
    const { first } = yield* prepare
    const server = yield* oauthServer("original")
    const auth = yield* McpAuth.Service
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const name = `reload-auth-${crypto.randomUUID()}`
    yield* auth.set(name, originalCredentials, server.url)
    const beforeAuth = yield* auth.get(name)
    yield* fs.writeJson(path.join(first.directory, "opencode.json"), { mcp: { [name]: remote(server.url) } })
    yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first))
    server.state.headers.length = 0
    yield* fs.writeJson(path.join(first.directory, "opencode.json"), {
      mcp: { [name]: remote(`${server.url}/replacement`) },
    })

    yield* reloadConfig(RuntimeLifecycle.unavailable())

    expect(server.state.registrations).toBe(1)
    expect(server.state.headers).not.toContain("Bearer original-private-access")
    expect(server.state.grants).toEqual([])
    expect(yield* auth.get(name)).toEqual(beforeAuth)
    expect((yield* mcp.status().pipe(Effect.provideService(InstanceRef, first)))[name]).toEqual({
      status: "needs_auth",
    })
  }),
)

it.live("OAuth reload defers a required refresh until a public reconnect after publication", () =>
  Effect.gen(function* () {
    const { first } = yield* prepare
    const server = yield* oauthServer("original")
    const auth = yield* McpAuth.Service
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const name = `reload-auth-${crypto.randomUUID()}`
    yield* auth.set(name, originalCredentials, server.url)
    const beforeAuth = yield* auth.get(name)
    yield* fs.writeJson(path.join(first.directory, "opencode.json"), { mcp: { [name]: remote(server.url) } })
    yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first))
    server.state.accessToken = "expired-access"

    yield* reloadConfig(RuntimeLifecycle.unavailable())

    expect((yield* mcp.status().pipe(Effect.provideService(InstanceRef, first)))[name]).toEqual({
      status: "needs_auth",
    })
    expect(server.state.grants).toEqual([])
    expect(yield* auth.get(name)).toEqual(beforeAuth)
    expect(yield* mcp.ensureConnected(name).pipe(Effect.provideService(InstanceRef, first))).toEqual({
      status: "connected",
    })
    expect(server.state.grants.map((grant) => grant.get("refresh_token"))).toEqual(["original-private-refresh"])
  }),
)

it.live("cancelled OAuth staging discards candidate registration and preserves live credentials", () =>
  Effect.gen(function* () {
    const { first, config } = yield* prepare
    const original = yield* oauthServer("original")
    const replacement = yield* oauthServer("replacement")
    const auth = yield* McpAuth.Service
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const name = `reload-auth-${crypto.randomUUID()}`
    const unrelated = `${name}-unrelated`
    yield* auth.set(name, originalCredentials, original.url)
    yield* auth.set(unrelated, { tokens: { accessToken: "before-unrelated" } }, original.url)
    const beforeAuth = yield* auth.get(name)
    yield* fs.writeJson(path.join(first.directory, "opencode.json"), { mcp: { [name]: remote(original.url) } })
    const before = (yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first)))[name]
    const started = yield* Deferred.make<void>()
    const blocker = yield* InstanceState.make(
      () =>
        Effect.gen(function* () {
          if (!(yield* InstanceState.reloading)) return
          yield* auth.set(unrelated, { tokens: { accessToken: "during-preparation" } }, replacement.url)
          yield* Deferred.succeed(started, undefined)
          yield* Effect.never
        }),
      { reloadable: true },
    )
    yield* InstanceState.get(blocker).pipe(Effect.provideService(InstanceRef, first))
    yield* fs.writeJson(path.join(first.directory, "opencode.json"), { mcp: { [name]: remote(replacement.url) } })
    const fiber = yield* withInstanceReload(config.reload(InstanceState.reload([first]))).pipe(Effect.forkScoped)
    yield* awaitWithTimeout(Deferred.await(started), "OAuth staging did not reach later preparation")
    yield* Fiber.interrupt(fiber)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(replacement.state.registrations).toBe(1)
    expect(replacement.state.grants).toEqual([])
    expect(yield* auth.get(name)).toEqual(beforeAuth)
    expect(yield* auth.getForUrl(unrelated, replacement.url)).toMatchObject({
      tokens: { accessToken: "during-preparation" },
    })
    expect((yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first)))[name]).toBe(before)
    expect(before?.transport).toBeDefined()
    expect(Object.keys(yield* mcp.resources(name).pipe(Effect.provideService(InstanceRef, first)))).toEqual([
      `${name}:docs://original`,
    ])
  }),
)

it.live("MCP tool notifications hold the reload activity lease through automatic OAuth refresh", () =>
  Effect.gen(function* () {
    const { first, second } = yield* prepare
    const server = yield* oauthServer("original")
    const auth = yield* McpAuth.Service
    const fs = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const name = `reload-auth-${crypto.randomUUID()}`
    yield* auth.set(name, originalCredentials, server.url)
    yield* fs.writeJson(path.join(first.directory, "opencode.json"), { mcp: { [name]: remote(server.url) } })
    yield* mcp.clients().pipe(Effect.provideService(InstanceRef, first))
    const session = Array.from(server.sessions.values())[0]
    if (!session) throw new Error("MCP session was not initialized")
    yield* awaitWithTimeout(
      Effect.promise(() => session.stream.promise),
      "MCP notification stream was not ready",
    )
    const pause = server.pauseToken()
    yield* Effect.addFinalizer(() => Effect.sync(pause.release))
    server.state.accessToken = "expired-access"
    yield* Effect.promise(() => session.protocol.sendToolListChanged())
    yield* awaitWithTimeout(
      Effect.promise(() => pause.reached),
      "MCP notification did not refresh OAuth tokens",
    )
    yield* fs.writeFileString(path.join(second.directory, "opencode.json"), "{invalid")

    const exit = yield* reloadConfig(RuntimeLifecycle.unavailable()).pipe(Effect.exit)

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
      _tag: "InstanceReloadBusyError",
    })
    pause.release()
    yield* pollWithTimeout(
      Effect.map(auth.get(name), (entry) =>
        entry?.tokens?.refreshToken === "original-rotated-refresh" ? true : undefined,
      ),
      "MCP notification did not persist refreshed credentials",
    )
  }),
)

it.instance("live OAuth registration for a new exact URL cannot rebind source tokens", () =>
  Effect.gen(function* () {
    const original = yield* oauthServer("original")
    const replacement = yield* oauthServer("replacement")
    const auth = yield* McpAuth.Service
    const mcp = yield* MCP.Service
    const name = `reload-auth-${crypto.randomUUID()}`
    yield* auth.set(name, originalCredentials, original.url)

    yield* mcp.add(name, remote(replacement.url))

    expect(replacement.state.grants).toEqual([])
    expect(replacement.state.headers).not.toContain("Bearer original-private-access")
    expect((yield* auth.getForUrl(name, replacement.url))?.tokens).toBeUndefined()
  }),
)

it.live("stale OAuth providers cannot invalidate credentials for another exact URL", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const name = `reload-auth-${crypto.randomUUID()}`
    const original = new McpOAuthProvider(
      name,
      "https://example.com/original",
      {},
      { onRedirect: async () => {} },
      auth,
    )
    yield* auth.set(name, originalCredentials, "https://example.com/replacement")
    const before = yield* auth.get(name)

    for (const type of ["client", "tokens", "all"] as const) {
      yield* Effect.promise(() => original.invalidateCredentials(type))
      expect(yield* auth.get(name)).toEqual(before)
    }
  }),
)
