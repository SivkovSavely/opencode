import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit, Fiber } from "effect"
import { Config } from "../../src/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { McpAuth } from "../../src/mcp/auth"
import { MCP } from "../../src/mcp/index"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { McpOAuthPendingProvider, McpOAuthProvider, OAUTH_CALLBACK_PORT } from "../../src/mcp/oauth-provider"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const mcpTest = testEffect(
  LayerNode.compile(
    LayerNode.group([MCP.node, McpAuth.node, EventV2Bridge.node, Config.node, CrossSpawnSpawner.node, FSUtil.node]),
  ),
)

interface OAuthMcpOptions {
  capabilities?: "tools" | "resources"
}

function serveOAuthMcp(options: OAuthMcpOptions = {}) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const capabilities = options.capabilities ?? "tools"
      const protocol = new Server(
        { name: "oauth-auto-connect", version: "1.0.0" },
        { capabilities: capabilities === "tools" ? { tools: {} } : { resources: {} } },
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      let listToolsCalls = 0
      let mcpRequests = 0
      let requiresAuth = true
      let nextDiscovery:
        | {
            reached: () => void
            wait: Promise<void>
          }
        | undefined

      if (capabilities === "tools") {
        protocol.setRequestHandler(ListToolsRequestSchema, () => {
          listToolsCalls++
          return Promise.resolve({ tools: [{ name: "test_tool", inputSchema: { type: "object" } }] })
        })
      }
      if (capabilities === "resources") {
        protocol.setRequestHandler(ListResourcesRequestSchema, () =>
          Promise.resolve({ resources: [{ name: "docs", uri: "docs://readme" }] }),
        )
      }

      await protocol.connect(transport)
      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          const origin = url.origin
          const mcpUrl = `${origin}/mcp`

          if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
            const pause = nextDiscovery
            nextDiscovery = undefined
            pause?.reached()
            if (pause) await pause.wait
            return Response.json({
              resource: mcpUrl,
              authorization_servers: [origin],
              scopes_supported: ["mcp"],
            })
          }
          if (url.pathname === "/.well-known/oauth-protected-resource") {
            const pause = nextDiscovery
            nextDiscovery = undefined
            pause?.reached()
            if (pause) await pause.wait
            return Response.json({
              resource: mcpUrl,
              authorization_servers: [origin],
              scopes_supported: ["mcp"],
            })
          }
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            return Response.json({
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              registration_endpoint: `${origin}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              token_endpoint_auth_methods_supported: ["none"],
              code_challenge_methods_supported: ["S256"],
              scopes_supported: ["mcp"],
            })
          }
          if (url.pathname === "/register") {
            const metadata = (await request.json()) as Record<string, unknown>
            return Response.json({ ...metadata, client_id: "replacement-client" }, { status: 201 })
          }
          if (url.pathname === "/token") {
            const body = new URLSearchParams(await request.text())
            if (body.get("code") !== "valid-code") {
              return Response.json(
                { error: "invalid_grant", error_description: "Token exchange failed" },
                { status: 400 },
              )
            }
            return Response.json({ access_token: "replacement-token", token_type: "Bearer" })
          }
          if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })
          mcpRequests++

          if (request.method === "GET") return new Response(null, { status: 405 })
          if (requiresAuth && request.headers.get("authorization") !== "Bearer replacement-token") {
            return new Response("Unauthorized", {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="mcp"`,
              },
            })
          }
          return transport.handleRequest(request)
        },
      })

      return {
        url: new URL("/mcp", http.url).toString(),
        allowAnonymous: () => {
          requiresAuth = false
        },
        requireAuth: () => {
          requiresAuth = true
        },
        listToolsCalls: () => listToolsCalls,
        mcpRequests: () => mcpRequests,
        pauseNextDiscovery: () => {
          let reached!: () => void
          let release!: () => void
          const started = new Promise<void>((resolve) => (reached = resolve))
          const wait = new Promise<void>((resolve) => (release = resolve))
          nextDiscovery = { reached, wait }
          return { started, release }
        },
        close: async () => {
          await http.stop(true)
          await protocol.close()
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

const remote = (url: string, enabled = true) => ({
  type: "remote" as const,
  url,
  enabled,
})

const stopOAuthCallback = Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))

mcpTest.instance("first connect to OAuth server shows needs_auth instead of failed", () =>
  Effect.gen(function* () {
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("test-oauth", remote(server.url))

    expect((result.status as Record<string, { status: string }>)["test-oauth"]).toEqual({ status: "needs_auth" })
  }),
)

mcpTest.instance("state() generates and persists a new state when none is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-gen",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    expect((yield* auth.get("test-state-gen"))?.oauthState).toBeUndefined()

    const state = yield* Effect.promise(() => provider.state())
    expect(state).toHaveLength(64)
    expect((yield* auth.get("test-state-gen"))?.oauthState).toBe(state)
  }),
)

mcpTest.instance("state() returns existing state when one is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-existing",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    yield* auth.updateOAuthState("test-state-existing", "pre-saved-state-value")
    expect(yield* Effect.promise(() => provider.state())).toBe("pre-saved-state-value")
  }),
)

mcpTest.instance("pending provider does not expose or overwrite existing credentials before commit", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const name = "test-pending-credentials"
    const url = "https://example.com/mcp"
    const provider = new McpOAuthPendingProvider(name, url, {}, { onRedirect: async () => {} }, auth)

    yield* auth.updateClientInfo(name, { clientId: "old-client" }, url)
    yield* auth.updateTokens(name, { accessToken: "old-token" }, url)

    expect(yield* Effect.promise(() => provider.clientInformation())).toBeUndefined()
    expect(yield* Effect.promise(() => provider.tokens())).toBeUndefined()
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("old-token")
    expect((yield* auth.get(name))?.clientInfo?.clientId).toBe("old-client")
  }),
)

mcpTest.instance("failed reauthentication preserves existing credentials", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const name = "test-reauth-failure"

    yield* auth.updateClientInfo(name, { clientId: "dynamic-client", clientSecret: "dynamic-secret" }, server.url)
    yield* auth.updateTokens(name, { accessToken: "working-token" }, server.url)
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")

    expect(yield* mcp.finishAuth(name, "invalid-code", started.oauthState)).toEqual({
      status: "failed",
      error: "OAuth completion failed: Token exchange failed",
    })
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("working-token")
    expect((yield* auth.get(name))?.clientInfo).toMatchObject({
      clientId: "dynamic-client",
      clientSecret: "dynamic-secret",
    })

    const requests = server.mcpRequests()
    expect(yield* mcp.ensureConnected(name)).toEqual({ status: "needs_auth" })
    expect(server.mcpRequests()).toBeGreaterThan(requests)
  }),
)

mcpTest.instance("successful reauthentication commits replacement credentials", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const name = "test-reauth-success"

    yield* auth.updateClientInfo(name, { clientId: "old-client" }, server.url)
    yield* auth.updateTokens(name, { accessToken: "old-token" }, server.url)
    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")
    expect((yield* auth.get(name))?.tokens?.accessToken).toBe("old-token")

    expect((yield* mcp.finishAuth(name, "valid-code", started.oauthState)).status).toBe("connected")
    const entry = yield* auth.get(name)
    expect(entry?.tokens?.accessToken).toBe("replacement-token")
    expect(entry?.clientInfo?.clientId).toBe("replacement-client")
    expect(entry?.serverUrl).toBe(server.url)
  }),
)

mcpTest.instance("lazy activation during explicit OAuth reuses the pending authentication flow", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-lazy-activation"

    expect((yield* mcp.add(name, remote(server.url))).status).toMatchObject({ [name]: { status: "needs_auth" } })
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")

    const requests = server.mcpRequests()
    expect(yield* mcp.ensureConnected(name)).toEqual({ status: "needs_auth" })
    expect(server.mcpRequests()).toBe(requests)
    expect((yield* mcp.finishAuth(name, "valid-code", started.oauthState)).status).toBe("connected")

    const connectedRequests = server.mcpRequests()
    expect(yield* mcp.ensureConnected(name)).toEqual({ status: "connected" })
    expect(server.mcpRequests()).toBe(connectedRequests)
  }),
)

mcpTest.instance("lazy activation reuses a healthy client during explicit reauthentication", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    server.allowAnonymous()
    const mcp = yield* MCP.Service
    const name = "test-oauth-healthy-reauth"

    expect((yield* mcp.add(name, remote(server.url))).status).toMatchObject({
      [name]: { status: "connected" },
    })
    server.requireAuth()
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")

    const requests = server.mcpRequests()
    expect(yield* mcp.ensureConnected(name)).toEqual({ status: "connected" })
    expect(server.mcpRequests()).toBe(requests)
  }),
)

mcpTest.instance("OAuth cleanup stays scoped to the owning directory", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const name = "test-oauth-instance-cleanup"
    const first = yield* MCP.Service
    yield* first.add(name, remote(server.url))
    const firstStarted = yield* first.startAuth(name)

    const secondDirectory = yield* tmpdirScoped()
    const secondStarted = yield* provideInstance(secondDirectory)(
      Effect.gen(function* () {
        const second = yield* MCP.Service
        yield* second.add(name, remote(server.url))
        return yield* second.startAuth(name)
      }),
    )
    const callback = McpOAuthCallback.waitForCallback(secondStarted.oauthState)

    yield* first.disconnect(name)
    const auth = yield* McpAuth.Service
    expect((yield* auth.get(`${name}:${firstStarted.oauthState}`))?.oauthState).toBeUndefined()
    expect((yield* auth.get(`${name}:${secondStarted.oauthState}`))?.oauthState).toBe(secondStarted.oauthState)

    const callbackUrl = new URL(`http://127.0.0.1:${OAUTH_CALLBACK_PORT}/mcp/oauth/callback`)
    callbackUrl.searchParams.set("code", "valid-code")
    callbackUrl.searchParams.set("state", secondStarted.oauthState)
    expect((yield* Effect.promise(() => fetch(callbackUrl))).ok).toBe(true)
    expect(yield* Effect.promise(() => callback)).toBe("valid-code")

    expect(
      yield* provideInstance(secondDirectory)(
        Effect.gen(function* () {
          const second = yield* MCP.Service
          return yield* second.finishAuth(name, "valid-code", secondStarted.oauthState)
        }),
      ),
    ).toMatchObject({ status: "connected" })
  }),
)

mcpTest.instance("lazy activation cannot race explicit OAuth flow registration", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-registration-race"

    yield* mcp.add(name, remote(server.url))
    const barrier = server.pauseNextDiscovery()
    const start = yield* Effect.forkScoped(mcp.startAuth(name), { startImmediately: true })
    yield* Effect.promise(() => barrier.started)

    const requests = server.mcpRequests()
    expect(yield* mcp.ensureConnected(name)).toEqual({ status: "needs_auth" })
    expect(server.mcpRequests()).toBe(requests)

    barrier.release()
    const started = yield* Fiber.join(start)
    expect(started.authorizationUrl).toContain("/authorize")
    expect((yield* mcp.finishAuth(name, "valid-code", started.oauthState)).status).toBe("connected")
  }),
)

mcpTest.instance("disconnect prevents a starting OAuth flow from registering its transport", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-start-disconnect"

    yield* mcp.add(name, remote(server.url))
    const barrier = server.pauseNextDiscovery()
    const start = yield* Effect.forkScoped(mcp.startAuth(name), { startImmediately: true })
    yield* Effect.promise(() => barrier.started)
    yield* mcp.disconnect(name)
    barrier.release()

    expect(Exit.isFailure(yield* Fiber.await(start))).toBe(true)
    expect(yield* mcp.finishAuth(name, "valid-code", "stale-state")).toEqual({ status: "disabled" })
    expect((yield* mcp.status())[name]?.status).toBe("disabled")
  }),
)

mcpTest.instance("interrupting a starting OAuth flow releases its connection guard", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-start-cancelled"

    yield* mcp.add(name, remote(server.url))
    const barrier = server.pauseNextDiscovery()
    const start = yield* Effect.forkScoped(mcp.startAuth(name), { startImmediately: true })
    yield* Effect.promise(() => barrier.started)
    yield* Fiber.interrupt(start)

    const requests = server.mcpRequests()
    expect(yield* mcp.ensureConnected(name)).toEqual({ status: "needs_auth" })
    expect(server.mcpRequests()).toBeGreaterThan(requests)
  }),
)

mcpTest.instance("disconnect prevents pending OAuth completion from reconnecting the server", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-disconnect-race"

    yield* mcp.add(name, remote(server.url))
    const started = yield* mcp.startAuth(name)
    expect(started.authorizationUrl).toContain("/authorize")
    yield* mcp.disconnect(name)

    expect(yield* mcp.finishAuth(name, "valid-code", started.oauthState)).toEqual({ status: "disabled" })
    expect((yield* mcp.status())[name]?.status).toBe("disabled")
  }),
)

mcpTest.instance("a stale OAuth callback cannot consume a replacement attempt", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-stale-callback"

    yield* mcp.add(name, remote(server.url))
    const first = yield* mcp.startAuth(name)
    yield* mcp.disconnect(name)
    expect(yield* mcp.ensureConnected(name)).toEqual({ status: "needs_auth" })
    const second = yield* mcp.startAuth(name)

    expect(second.oauthState).not.toBe(first.oauthState)
    expect(yield* mcp.finishAuth(name, "valid-code", first.oauthState)).toEqual({
      status: "failed",
      error: "OAuth state mismatch",
    })
    expect((yield* mcp.finishAuth(name, "valid-code", second.oauthState)).status).toBe("connected")
  }),
)

mcpTest.instance("auth status only reports credentials stored for the configured server URL", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add("test-status-url", remote("https://example.com/mcp", false))
    yield* McpAuth.use.updateTokens("test-status-url", { accessToken: "old-token" }, "https://old.example.com/mcp")

    expect(yield* mcp.getAuthStatus("test-status-url")).toBe("not_authenticated")

    yield* McpAuth.use.updateTokens("test-status-url", { accessToken: "current-token" }, "https://example.com/mcp")
    expect(yield* mcp.getAuthStatus("test-status-url")).toBe("authenticated")

    yield* McpAuth.use.updateTokens(
      "test-status-url",
      { accessToken: "expired-token", expiresAt: 1 },
      "https://example.com/mcp",
    )
    expect(yield* mcp.getAuthStatus("test-status-url")).toBe("expired")
  }),
)

mcpTest.instance("authenticate() stores a connected client when auth completes without redirect", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp()
    const mcp = yield* MCP.Service
    const name = "test-oauth-connect"
    const added = yield* mcp.add(name, remote(server.url))
    expect((added.status as Record<string, { status: string }>)[name]?.status).toBe("needs_auth")

    server.allowAnonymous()
    expect((yield* mcp.authenticate(name)).status).toBe("connected")
    expect((yield* mcp.status())[name]?.status).toBe("connected")
  }),
)

mcpTest.instance("authenticate() connects a resource-only server without listing tools", () =>
  Effect.gen(function* () {
    yield* stopOAuthCallback
    const server = yield* serveOAuthMcp({ capabilities: "resources" })
    const mcp = yield* MCP.Service
    const name = "test-oauth-resources"
    const added = yield* mcp.add(name, remote(server.url))
    expect((added.status as Record<string, { status: string }>)[name]?.status).toBe("needs_auth")

    server.allowAnonymous()
    expect((yield* mcp.authenticate(name)).status).toBe("connected")
    expect(server.listToolsCalls()).toBe(0)
    expect(Object.keys(yield* mcp.resources())).toEqual([`${name}:docs://readme`])
  }),
)
