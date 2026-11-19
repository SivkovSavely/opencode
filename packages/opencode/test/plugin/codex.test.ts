import { describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage } from "node:http"
import { type AddressInfo } from "node:net"
import { WebSocketServer } from "ws"
import type { Auth } from "../../src/auth"
import {
  CodexAuthPlugin,
  controlledTransport,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  extractResidency,
  renderOAuthError,
  type IdTokenClaims,
} from "../../src/plugin/openai/codex"
import { DispatchTransport } from "../../src/provider/dispatch-transport"
import { isRecord } from "../../src/util/record"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  test("controlled built-in websocket preserves headers and request-local targets across reuse and reconnect", async () => {
    await using server = await createCodexWebSocketServer()
    const access = createTestJwt({ chatgpt_account_id: "synthetic-account", chatgpt_compute_residency: "eu" })
    const hooks = await CodexAuthPlugin({} as never, { codexApiEndpoint: server.url, experimentalWebSockets: true })
    try {
      const loaded = await hooks.auth!.loader!(
        async () => ({ type: "oauth", access, refresh: "synthetic-reuse-refresh", expires: Date.now() + 60_000 }),
        {} as never,
      )
      const transport = controlledTransport(loaded.fetch)
      if (!transport) throw new Error("Built-in transport was not recognized")
      expect(controlledTransport(async () => new Response("opaque"))).toBeUndefined()
      const prepared: string[] = []
      const bun = await import("bun")
      const request = async (model: string, effort: string, previous?: string) => {
        const state: { ready?: Promise<void> } = {}
        const validate = (value: unknown) => {
          if (typeof value !== "string") throw new DispatchTransport.UnsupportedDispatch()
          const body: unknown = JSON.parse(value)
          if (!isRecord(body) || body.model !== model || !isRecord(body.reasoning) || body.reasoning.effort !== effort)
            throw new DispatchTransport.UnsupportedDispatch()
        }
        const response = await transport.bind(
          {
            validateHttp: validate,
            validateFrame: validate,
            prepared: () =>
              (state.ready ??= Promise.resolve().then(() => {
                prepared.push(model)
              })),
          },
          bun.fetch,
        )(server.url.replace("/backend-api/codex/responses", "/v1/responses"), {
          method: "POST",
          headers: {
            "session-id": "same-session",
            "x-plugin-proof": "retained",
            authorization: "Bearer synthetic-sdk-key",
          },
          body: JSON.stringify({
            stream: true,
            model,
            reasoning: { effort },
            ...(previous ? { previous_response_id: previous } : {}),
          }),
        })
        expect(await response.text()).toContain("data: [DONE]")
      }
      await request("gpt-6.1-sol", "xhigh", "resp-parent")
      await request("gpt-6.1-terra", "max", "resp_123")
      expect(server.connections()).toBe(1)
      await server.dropConnections()
      await request("gpt-6.1-sol", "high")
      expect(server.connections()).toBe(2)
      expect(server.frames).toEqual([
        {
          type: "response.create",
          model: "gpt-6.1-sol",
          reasoning: { effort: "xhigh" },
          previous_response_id: "resp-parent",
        },
        {
          type: "response.create",
          model: "gpt-6.1-terra",
          reasoning: { effort: "max" },
          previous_response_id: "resp_123",
        },
        { type: "response.create", model: "gpt-6.1-sol", reasoning: { effort: "high" } },
      ])
      expect(prepared).toEqual(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.1-sol"])
      expect(server.headers()?.authorization === `Bearer ${access}`).toBe(true)
      expect(server.headers()?.["chatgpt-account-id"] === "synthetic-account").toBe(true)
      expect(server.headers()?.["x-openai-internal-codex-residency"] === "eu").toBe(true)
      expect(server.headers()?.["x-plugin-proof"]).toBe("retained")
    } finally {
      await hooks.dispose?.()
    }
  })

  for (const websocket of [false, true]) {
    test(`controlled HTTP final check follows prepared with websocket=${websocket}`, async () => {
      let requests = 0
      using server = Bun.serve({
        port: 0,
        fetch() {
          requests++
          return new Response("{}")
        },
      })
      const hooks = await CodexAuthPlugin({} as never, {
        issuer: server.url.origin,
        codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
        experimentalWebSockets: websocket,
      })
      try {
        const loaded = await hooks.auth!.loader!(
          async () => ({
            type: "oauth",
            access: "synthetic-final-check-access",
            refresh: "synthetic-final-check-refresh",
            expires: Date.now() + 60_000,
          }),
          {} as never,
        )
        const transport = controlledTransport(loaded.fetch)
        if (!transport) throw new Error("Built-in transport was not recognized")
        const state = { prepared: false }
        const bun = await import("bun")
        const request = transport.bind(
          {
            validateHttp() {
              if (state.prepared) throw new DispatchTransport.UnsupportedDispatch()
            },
            validateFrame() {
              throw new Error("Title request must use HTTP")
            },
            async prepared() {
              state.prepared = true
            },
          },
          bun.fetch,
        )(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: { "x-opencode-title": "true" },
          body: JSON.stringify({ stream: true, model: "target", reasoning: { effort: "xhigh" } }),
        })
        await expect(request).rejects.toBeInstanceOf(DispatchTransport.UnsupportedDispatch)
        expect(requests).toBe(0)
      } finally {
        await hooks.dispose?.()
      }
    })
  }

  test("controlled OAuth HTTP aborts during prepared without invoking its leaf", async () => {
    let requests = 0
    using server = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response("{}")
      },
    })
    const hooks = await CodexAuthPlugin({} as never, {
      codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
    })
    try {
      const loaded = await hooks.auth!.loader!(
        async () => ({
          type: "oauth",
          access: "synthetic-cancel-access",
          refresh: "synthetic-cancel-refresh",
          expires: Date.now() + 60_000,
        }),
        {} as never,
      )
      const transport = controlledTransport(loaded.fetch)
      if (!transport) throw new Error("Built-in transport was not recognized")
      const started = Promise.withResolvers<void>()
      const ready = Promise.withResolvers<void>()
      const abort = new AbortController()
      const bun = await import("bun")
      let leaves = 0
      const request = transport.bind(
        {
          validateHttp() {},
          validateFrame() {},
          prepared() {
            started.resolve()
            return ready.promise
          },
        },
        (input, init) => {
          leaves++
          return bun.fetch(input, init)
        },
      )(new URL("/v1/responses", server.url), {
        method: "POST",
        signal: abort.signal,
        body: JSON.stringify({ stream: true, model: "target", reasoning: { effort: "max" } }),
      })
      await started.promise
      abort.abort()
      ready.resolve()
      await expect(request).rejects.toHaveProperty("name", "AbortError")
      expect(leaves).toBe(0)
      expect(requests).toBe(0)
    } finally {
      await hooks.dispose?.()
    }
  })

  test("escapes provider errors in callback HTML", () => {
    const error = `</div><script>alert("xss" & 'more')</script>`
    const html = renderOAuthError(error)

    expect(html).toContain("&lt;/div&gt;&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;more&#39;)&lt;/script&gt;")
    expect(html).not.toContain(error)
  })

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })

    test("ignores malformed claim types", () => {
      const claims = parseJwtClaims(createTestJwt({ chatgpt_account_id: 123, organizations: "invalid" }))
      expect(claims && extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })

  describe("extractResidency", () => {
    test("extracts compute residency from the namespaced auth claims", () => {
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" },
          }),
        ),
      ).toBe("eu")
    })

    test("falls back to a root compute residency claim", () => {
      expect(extractResidency(createTestJwt({ chatgpt_compute_residency: "us" }))).toBe("us")
    })

    test("supports compute residency values without maintaining a region list", () => {
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "ae" },
          }),
        ),
      ).toBe("ae")
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "future-region_1" },
          }),
        ),
      ).toBe("future-region_1")
    })

    test("ignores unconstrained and data residency values", () => {
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "no_constraint" },
          }),
        ),
      ).toBeUndefined()
      expect(
        extractResidency(
          createTestJwt({
            "https://api.openai.com/auth": { chatgpt_data_residency: "gb" },
          }),
        ),
      ).toBeUndefined()
      expect(extractResidency(createTestJwt({ chatgpt_compute_residency: "" }))).toBeUndefined()
      expect(extractResidency("not-a-jwt")).toBeUndefined()
    })

    test("prefers a namespaced unconstrained value over a root residency", () => {
      expect(
        extractResidency(
          createTestJwt({
            chatgpt_compute_residency: "eu",
            "https://api.openai.com/auth": { chatgpt_compute_residency: "no_constraint" },
          }),
        ),
      ).toBeUndefined()
    })
  })

  test("installs websocket transport only when experimental websockets are enabled", async () => {
    const disabled = await CodexAuthPlugin({} as never)
    const enabled = await CodexAuthPlugin({} as never, { experimentalWebSockets: true })

    const disabledOptions = await disabled.auth!.loader!(
      async () => ({ type: "api", key: "sk-test" }) as never,
      {} as never,
    )
    const enabledOptions = await enabled.auth!.loader!(
      async () => ({ type: "api", key: "sk-test" }) as never,
      {} as never,
    )

    expect(disabledOptions.fetch).toBeUndefined()
    expect(enabledOptions.fetch).toBeFunction()
    await enabled.dispose?.()
  })

  test("sends token residency only to the ChatGPT Codex backend", async () => {
    const requests: Array<{ path: string; residency: string | null }> = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          residency: request.headers.get("x-openai-internal-codex-residency"),
        })
        return new Response("{}")
      },
    })
    const hooks = await CodexAuthPlugin({} as never, {
      issuer: server.url.origin,
      codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
    })
    const loaded = await hooks.auth!.loader!(
      async () =>
        ({
          type: "oauth",
          refresh: "refresh",
          access: createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" },
          }),
          expires: Date.now() + 60_000,
        }) as never,
      {} as never,
    )

    await loaded.fetch!(new URL("/v1/responses", server.url))
    await loaded.fetch!(new URL("/other", server.url))

    expect(requests).toEqual([
      { path: "/backend-api/codex/responses", residency: "eu" },
      { path: "/other", residency: null },
    ])
  })

  test("sends token residency through the WebSocket transport", async () => {
    await using server = await createCodexWebSocketServer()
    const hooks = await CodexAuthPlugin({} as never, {
      issuer: new URL(server.url).origin,
      codexApiEndpoint: server.url,
      experimentalWebSockets: true,
    })
    const loaded = await hooks.auth!.loader!(
      async () =>
        ({
          type: "oauth",
          refresh: "refresh",
          access: createTestJwt({
            "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" },
          }),
          expires: Date.now() + 60_000,
        }) as never,
      {} as never,
    )

    const response = await loaded.fetch!(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "session-id": "session-1" },
      body: JSON.stringify({ stream: true, input: "hi" }),
    })

    expect(await response.text()).toContain("data: [DONE]")
    expect(server.headers()?.["x-openai-internal-codex-residency"]).toBe("eu")
    await hooks.dispose?.()
  })

  test("filters unsupported modes and uses Codex context limits for OAuth GPT models", async () => {
    const hooks = await CodexAuthPlugin({} as never)
    const limit = { context: 1_050_000, input: 922_000, output: 128_000 }
    const provider = {
      models: {
        ...Object.fromEntries(
          ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.7-pro"].map((id) => [
            id,
            { id, api: { id }, limit, cost: {}, options: {} },
          ]),
        ),
        "gpt-5.4-pro": {
          id: "gpt-5.4-pro",
          api: { id: "gpt-5.4" },
          limit,
          cost: {},
          options: { reasoningMode: "pro" },
        },
        "gpt-5.6-sol-high": {
          id: "gpt-5.6-sol-high",
          api: { id: "gpt-5.6-sol" },
          limit,
          cost: {},
          options: { reasoningEffort: "high" },
        },
      },
    }

    const models = await hooks.provider!.models!(provider as never, { auth: { type: "oauth" } } as never)

    expect(models["gpt-5.4"]?.limit).toEqual(limit)
    expect(models["gpt-5.5"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(models["gpt-5.6-sol"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(models["gpt-5.6-terra"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(models["gpt-5.6-luna"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(models["gpt-5.4-pro"]).toBeUndefined()
    expect(models["gpt-5.7-pro"]).toBeDefined()
    expect(models["gpt-5.6-sol-high"]).toBeDefined()
    expect(await hooks.provider!.models!(provider as never, { auth: { type: "api" } } as never)).toBe(
      provider.models as never,
    )
  })

  test.each([
    ["gpt-6-astra", true],
    ["gpt-6", true],
    ["gpt-6.0-astra", true],
    ["gpt-7", true],
    ["gpt-10", true],
    ["gpt-5.5-astra", true],
    ["gpt-5.9", true],
    ["gpt-5.10", true],
    ["gpt-5.10-astra", true],
    ["gpt-5.40", true],
    ["gpt-5", false],
    ["gpt-5.4-astra", false],
    ["gpt-5.04-astra", false],
    ["gpt-4.1", false],
    ["gpt-4.99", false],
    ["gpt-5.5-pro", false],
    ["gpt-5.6", false],
    ["gpt-6garbage", true],
    ["gpt-6.", true],
    ["gpt-6.1.2", true],
    ["not-a-gpt-model", false],
  ])("filters OAuth model %s by GPT major and minor versions", async (id, allowed) => {
    const hooks = await CodexAuthPlugin({} as never)
    const provider = {
      models: {
        [id]: { id, api: { id }, limit: {}, cost: {}, options: {} },
      },
    }

    const models = await hooks.provider!.models!(provider as never, { auth: { type: "oauth" } } as never)

    expect(Object.keys(models)).toEqual(allowed ? [id] : [])
  })

  test("deduplicates concurrent Codex token refreshes", async () => {
    const refreshedAccess = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" },
    })
    let auth: Auth.Oauth = {
      type: "oauth",
      refresh: "refresh-old",
      access: "",
      expires: 0,
    }
    const authUpdates: Auth.Oauth[] = []
    const refreshStarted = Promise.withResolvers<void>()
    const refreshReady = Promise.withResolvers<void>()
    let refreshRequests = 0
    const apiRequests: { authorization: string | null; accountId: string | null; residency: string | null }[] = []

    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/oauth/token") {
          expect(await request.text()).toContain("refresh_token=refresh-old")
          refreshRequests += 1
          refreshStarted.resolve()
          await refreshReady.promise
          return Response.json({
            id_token: createTestJwt({ chatgpt_account_id: "acc-123" }),
            access_token: refreshedAccess,
            refresh_token: "refresh-new",
            expires_in: 3600,
          })
        }

        if (url.pathname === "/backend-api/codex/responses") {
          apiRequests.push({
            authorization: request.headers.get("authorization"),
            accountId: request.headers.get("ChatGPT-Account-Id"),
            residency: request.headers.get("x-openai-internal-codex-residency"),
          })
          return new Response("{}", { status: 200 })
        }

        return new Response("unexpected request", { status: 500 })
      },
    })

    const hooks = await CodexAuthPlugin({} as never, {
      issuer: server.url.origin,
      codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
      async compareAndSet(expected, next) {
        expect(auth).toEqual(expected)
        authUpdates.push(next)
        auth = next
        return true
      },
    })
    const loaded = await hooks.auth!.loader!(async () => auth as never, {} as never)

    const first = loaded.fetch!(new URL("/v1/responses", server.url))
    const second = loaded.fetch!(new URL("/v1/responses", server.url))

    await refreshStarted.promise
    expect(apiRequests).toHaveLength(0)

    refreshReady.resolve()
    await Promise.all([first, second])

    expect(refreshRequests).toBe(1)
    expect(authUpdates).toHaveLength(1)
    expect(authUpdates[0]?.refresh).toBe("refresh-new")
    expect(authUpdates[0]?.access).toBe(refreshedAccess)
    expect(authUpdates[0]?.accountId).toBe("acc-123")
    expect(apiRequests).toEqual([
      { authorization: `Bearer ${refreshedAccess}`, accountId: "acc-123", residency: "eu" },
      { authorization: `Bearer ${refreshedAccess}`, accountId: "acc-123", residency: "eu" },
    ])
  })
})

async function createCodexWebSocketServer() {
  let headers: IncomingMessage["headers"] | undefined
  let connections = 0
  const frames: Record<string, unknown>[] = []
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  sockets.on("connection", (socket, request) => {
    connections++
    headers = request.headers
    socket.on("message", (data) => {
      const body: unknown = JSON.parse(data.toString())
      if (!isRecord(body)) throw new Error("Unexpected synthetic request")
      frames.push(body)
      socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_123" } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
    headers: () => headers,
    frames,
    connections: () => connections,
    dropConnections: () =>
      Promise.all(
        Array.from(
          sockets.clients,
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once("close", () => resolve())
              socket.close(1000, "synthetic reconnect")
            }),
        ),
      ),
    async [Symbol.asyncDispose]() {
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
      server.close()
    },
  }
}
