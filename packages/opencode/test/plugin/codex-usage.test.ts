import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { type AddressInfo } from "node:net"
import { CodexUsage } from "../../src/plugin/openai/usage"

const credentials = { access: "synthetic-access-secret", accountId: "synthetic-account" }

describe("plugin.codex-usage", () => {
  test("both read-only operations use only their GET URL with account auth and no redirect following", async () => {
    const requests: string[] = []
    const api = CodexUsage.create(credentials, async (url, init) => {
      requests.push(url)
      expect(init.method).toBe("GET")
      expect(init.body).toBeUndefined()
      expect(init.redirect).toBe("error")
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-access-secret")
      expect(new Headers(init.headers).get("ChatGPT-Account-Id")).toBe("synthetic-account")
      return Response.json({})
    })
    await api.usage()
    await api.credits()
    expect(requests).toEqual([
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ])
  })

  test("projects weekly-only, dual-window, nullable, missing, and future fields", async () => {
    const payload = {
      plan_type: "unknown_future_plan",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 4, limit_window_seconds: 604800, reset_after_seconds: null, reset_at: null },
        secondary_window: null,
        future_field: "ignored",
      },
      rate_limit_reset_credits: { available_count: 0, applicable_available_count: null, future_field: 1 },
    }
    const api = CodexUsage.create(credentials, async () => Response.json(payload))
    expect(await api.usage()).toEqual({
      plan_type: "unknown_future_plan",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 4, limit_window_seconds: 604800, reset_after_seconds: null, reset_at: null },
        secondary_window: null,
      },
      rate_limit_reset_credits: { available_count: 0, applicable_available_count: null },
    })
    expect(
      await CodexUsage.create(credentials, async () =>
        Response.json({ rate_limit: { primary_window: { used_percent: 20 } } }),
      ).usage(),
    ).toEqual({
      rate_limit: { primary_window: { used_percent: 20 } },
    })
    expect(
      await CodexUsage.create(credentials, async () =>
        Response.json({ rate_limit: { primary_window: null, secondary_window: null } }),
      ).usage(),
    ).toEqual({
      rate_limit: { primary_window: null, secondary_window: null },
    })
    const dual = {
      plan_type: "pro",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 100 },
        secondary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: 1900000000 },
      },
    }
    expect(await CodexUsage.create(credentials, async () => Response.json(dual)).usage()).toEqual(dual)
    expect(
      await CodexUsage.create(credentials, async () =>
        Response.json({ plan_type: "prolite", rate_limit: null }),
      ).usage(),
    ).toEqual({ plan_type: "prolite", rate_limit: null })
  })

  test("normalizes malformed credit entries and sorts valid expirations first", async () => {
    const api = CodexUsage.create(credentials, async () =>
      Response.json({
        credits: [
          null,
          42,
          { id: "late", expires_at: "2030-02-01" },
          { id: "bad-date", expires_at: "never" },
          { id: "early", expires_at: "2030-01-01" },
        ],
      }),
    )
    const credits = await api.credits()
    expect(credits.credits.map((credit) => credit.id)).toEqual(["early", "late", "bad-date"])
    expect(await CodexUsage.create(credentials, async () => Response.json({ credits: null })).credits()).toEqual({
      credits: [],
    })
    expect(await CodexUsage.create(credentials, async () => Response.json({})).credits()).toEqual({ credits: [] })
  })

  test("sends authenticated safe requests and explicit synthetic consume body to a local server", async () => {
    const received: Array<{ method: string; path: string; auth: string | null; account: string | null; body: string }> =
      []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      received.push({
        method: request.method ?? "",
        path: request.url ?? "",
        auth: request.headers.authorization ?? null,
        account: request.headers["chatgpt-account-id"]?.toString() ?? null,
        body: Buffer.concat(chunks).toString(),
      })
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ code: "reset", windows_reset: 2 }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address() as AddressInfo
      const api = CodexUsage.create(credentials, (url, init) =>
        fetch(url.replace("https://chatgpt.com", `http://127.0.0.1:${address.port}`), init),
      )
      expect(await api.consume("synthetic-credit", "synthetic-request")).toEqual({ code: "reset", windows_reset: 2 })
      expect(received).toEqual([
        {
          method: "POST",
          path: "/backend-api/wham/rate-limit-reset-credits/consume",
          auth: "Bearer synthetic-access-secret",
          account: "synthetic-account",
          body: JSON.stringify({ credit_id: "synthetic-credit", redeem_request_id: "synthetic-request" }),
        },
      ])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("requires account identity and sanitizes HTTP, network, and malformed response errors", async () => {
    expect(() => CodexUsage.create({ access: "secret" })).toThrow(CodexUsage.RequestError)
    const transports: Array<(url: string, init: RequestInit) => Promise<Response>> = [
      async () => new Response("body has synthetic-access-secret", { status: 503 }),
      async (_url: string, init: RequestInit) => {
        expect(init.redirect).toBe("error")
        return new Response("redirect body", { status: 302 })
      },
      async () => {
        throw new Error("transport leaked synthetic-access-secret")
      },
      async () => new Response("not-json synthetic-access-secret"),
    ]
    for (const transport of transports) {
      const api = CodexUsage.create(credentials, transport)
      const error = await api.usage().then(
        () => undefined,
        (failure) => failure,
      )
      expect(error).toBeInstanceOf(CodexUsage.RequestError)
      expect(String(error)).not.toContain("synthetic-access-secret")
      expect(String(error)).not.toContain("body has")
    }
  })

  test("marks unexpected consume responses indeterminate and does not retry", async () => {
    const transports: Array<(url: string, init: RequestInit) => Promise<Response>> = [
      async () => new Response("secret body", { status: 401 }),
      async () => new Response(JSON.stringify({ code: "unknown" })),
      async () => {
        throw new Error("secret network failure")
      },
    ]
    for (const transport of transports) {
      let calls = 0
      const api = CodexUsage.create(credentials, async (url, init) => {
        calls += 1
        return transport(url, init)
      })
      const error = await api.consume("credit", "request").then(
        () => undefined,
        (failure) => failure,
      )
      expect(error).toBeInstanceOf(CodexUsage.RequestError)
      expect(String(error).toLowerCase()).toContain("indeterminate")
      expect(String(error)).not.toContain("secret")
      expect(calls).toBe(1)
    }
  })

  test("selects only uniquely eligible credits and rejects ties or unsafe explicit choices", () => {
    const valid = (id: string, expires_at: string, extra = {}) => ({
      id,
      expires_at,
      status: "available",
      reset_type: "codex_rate_limits",
      is_supported_by_plan: true,
      ...extra,
    })
    const now = Date.parse("2030-01-01T00:00:00Z")
    const credits = [
      valid("later", "2030-03-01"),
      valid("early", "2030-02-01"),
      valid("used", "2030-01-20", { status: "redeemed" }),
    ]
    expect(CodexUsage.select(credits, undefined, now).id).toBe("early")
    expect(CodexUsage.select(credits, "later", now).id).toBe("later")
    expect(() => CodexUsage.select([valid("a", "2030-02-01"), valid("b", "2030-02-01")], undefined, now)).toThrow(
      /--credit-id/,
    )
    expect(() => CodexUsage.select(credits, "used", now)).toThrow()
    expect(() => CodexUsage.select([valid("duplicate", "2030-02-01"), { id: "duplicate" }], "duplicate", now)).toThrow()
    expect(() => CodexUsage.select([valid("bad", "invalid"), valid("expired", "2030-01-01")], undefined, now)).toThrow()
    expect(() => CodexUsage.select([valid("", "2030-02-01")], undefined, now)).toThrow()
    expect(() => CodexUsage.select([valid("   ", "2030-02-01")], undefined, now)).toThrow()
    expect(() =>
      CodexUsage.select(
        [
          valid("wrong-type", "2030-02-01", { reset_type: "other" }),
          valid("wrong-plan", "2030-03-01", { is_supported_by_plan: false }),
        ],
        undefined,
        now,
      ),
    ).toThrow()
  })
})
