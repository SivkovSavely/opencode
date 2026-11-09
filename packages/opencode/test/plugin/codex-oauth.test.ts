import { expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { CodexOAuth } from "../../src/plugin/openai/oauth"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

for (const change of ["logout", "login"] as const) {
  it.live(`does not restore stale OAuth at the ${change} commit boundary`, () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const key = `synthetic-oauth-race-${change}`
      const initial: Auth.Oauth = {
        type: "oauth",
        access: "synthetic-expired-access",
        refresh: "synthetic-old-refresh",
        expires: 0,
      }
      const newer: Auth.Oauth = {
        type: "oauth",
        access: "synthetic-new-login-access",
        refresh: "synthetic-new-login-refresh",
        accountId: "synthetic-new-account",
        expires: Date.now() + 60_000,
      }
      yield* auth.set(key, initial)
      const result = yield* Effect.promise(() =>
        CodexOAuth.resolve(
          () => Effect.runPromise(auth.get(key)),
          async (expected, next) => {
            await Effect.runPromise(change === "logout" ? auth.remove(key) : auth.set(key, newer))
            return Effect.runPromise(auth.compareAndSet(key, expected, next))
          },
          {
            fetch: async () =>
              Response.json({ access_token: "synthetic-stale-access", refresh_token: "synthetic-stale-refresh" }),
          },
        ),
      )
      expect(yield* auth.get(key)).toEqual(change === "logout" ? undefined : newer)
      expect(result).toEqual(change === "logout" ? undefined : newer)
    }),
  )
}

it.live("uses internal auth CAS by default and returns only persisted refresh credentials", () =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* auth.set("openai", {
      type: "oauth",
      access: "synthetic-default-expired-access",
      refresh: "synthetic-default-old-refresh",
      expires: 0,
    })
    const result = yield* Effect.promise(() =>
      CodexOAuth.resolve(() => Effect.runPromise(auth.get("openai")), undefined, {
        fetch: async () =>
          Response.json({ access_token: "synthetic-default-access", refresh_token: "synthetic-default-refresh" }),
      }),
    )
    expect(result?.access).toBe("synthetic-default-access")
    expect(result?.refresh).toBe("synthetic-default-refresh")
    expect(yield* auth.get("openai")).toEqual(result)
  }),
)

test("resolves fresh OAuth only and refuses expired credentials without refresh", async () => {
  const auth = { type: "oauth" as const, access: "access", refresh: "refresh", expires: Date.now() + 60_000 }
  let calls = 0
  const fetcher = async () => {
    calls++
    throw new Error("unexpected request")
  }
  expect(
    await CodexOAuth.resolve(
      async () => auth,
      async () => true,
      { allowRefresh: false, fetch: fetcher },
    ),
  ).toEqual(auth)
  expect(
    await CodexOAuth.resolve(
      async () => ({ type: "api", key: "key" }),
      async () => true,
      { fetch: fetcher },
    ),
  ).toBeUndefined()
  await expect(
    CodexOAuth.resolve(
      async () => ({ ...auth, expires: 0 }),
      async () => true,
      { allowRefresh: false, fetch: fetcher },
    ),
  ).rejects.toThrow("expired")
  expect(calls).toBe(0)
})

test("derives a missing account ID from the current access token", async () => {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
  ).toString("base64url")
  const auth = { type: "oauth" as const, access: `a.${payload}.c`, refresh: "refresh", expires: Date.now() + 60_000 }
  expect(
    (
      await CodexOAuth.resolve(
        async () => auth,
        async () => true,
        {
          allowRefresh: false,
          fetch: async () => {
            throw new Error("unexpected request")
          },
        },
      )
    )?.accountId,
  ).toBe("account")
  expect(auth).not.toHaveProperty("accountId")
})

test("serializes refreshes and persists the extracted account", async () => {
  let auth: Auth.Oauth = { type: "oauth", access: "old", refresh: "old-refresh", expires: 0, accountId: "old-account" }
  let calls = 0
  const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls++
    expect(init?.redirect).toBe("error")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("old-refresh")
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: "new-account" })).toString("base64url")
    return Response.json({ access_token: `a.${payload}.c`, refresh_token: "new-refresh", expires_in: 3600 })
  }
  const get = async () => ({ ...auth })
  const save = async (expected: typeof auth, next: typeof auth) => {
    expect(auth).toEqual(expected)
    auth = next
    return true
  }
  const [first, second] = await Promise.all([
    CodexOAuth.resolve(get, save, { fetch: fetcher }),
    CodexOAuth.resolve(get, save, { fetch: fetcher }),
  ])
  expect(calls).toBe(1)
  expect(first).toEqual(second)
  expect(auth.accountId).toBe("new-account")
  expect(auth.refresh).toBe("new-refresh")
})

test("does not overwrite credentials changed during refresh", async () => {
  let auth = { type: "oauth" as const, access: "old", refresh: "old-refresh", expires: 0 }
  const newer = { type: "oauth" as const, access: "newer", refresh: "newer-refresh", expires: Date.now() + 60_000 }
  const result = await CodexOAuth.resolve(
    async () => ({ ...auth }),
    async () => false,
    {
      fetch: async () => {
        auth = newer
        return Response.json({ access_token: "stale", refresh_token: "stale-refresh" })
      },
    },
  )
  expect(result).toEqual(newer)
  expect(auth).toEqual(newer)
})

test("does not expose refresh transport errors", async () => {
  await expect(
    CodexOAuth.resolve(
      async () => ({ type: "oauth", access: "", refresh: "secret-refresh", expires: 0 }),
      async () => true,
      {
        fetch: async () => {
          throw new Error("secret-refresh")
        },
      },
    ),
  ).rejects.toThrow("Token refresh failed")
  await expect(
    CodexOAuth.resolve(
      async () => ({ type: "oauth", access: "", refresh: "secret-refresh", expires: 0 }),
      async () => true,
      {
        fetch: async () => {
          throw new Error("secret-refresh")
        },
      },
    ),
  ).rejects.toEqual(new Error("Token refresh failed"))
})

test("rejects malformed refresh responses without exposing their contents", async () => {
  await expect(
    CodexOAuth.resolve(
      async () => ({ type: "oauth", access: "", refresh: "secret-refresh", expires: 0 }),
      async () => true,
      { fetch: async () => Response.json({ access_token: "secret-access" }) },
    ),
  ).rejects.toEqual(new Error("Invalid token refresh response"))
  await expect(
    CodexOAuth.resolve(
      async () => ({ type: "oauth", access: "", refresh: "secret-refresh", expires: 0 }),
      async () => true,
      { fetch: async () => new Response("secret-refresh", { status: 200 }) },
    ),
  ).rejects.toEqual(new Error("Invalid token refresh response"))
  await expect(
    CodexOAuth.resolve(
      async () => ({ type: "oauth", access: "", refresh: "secret-refresh", expires: 0 }),
      async () => true,
      { fetch: async () => new Response("secret-refresh", { status: 401 }) },
    ),
  ).rejects.toEqual(new Error("Token refresh failed: 401"))
})

test("does not expose persistence failures or return a discarded refresh for a changed expired login", async () => {
  const initial: Auth.Oauth = {
    type: "oauth",
    access: "synthetic-expired-access",
    refresh: "synthetic-refresh-secret",
    expires: 0,
  }
  const fetcher = async () =>
    Response.json({ access_token: "synthetic-access-secret", refresh_token: "synthetic-next-refresh-secret" })
  await expect(
    CodexOAuth.resolve(
      async () => initial,
      async () => {
        throw new Error("synthetic-refresh-secret synthetic-access-secret")
      },
      { fetch: fetcher },
    ),
  ).rejects.toEqual(new Error("Failed to save ChatGPT OAuth credentials"))
  let auth = initial
  await expect(
    CodexOAuth.resolve(
      async () => auth,
      async () => {
        auth = { ...initial, refresh: "synthetic-new-expired-login-refresh" }
        return false
      },
      { fetch: fetcher },
    ),
  ).rejects.toEqual(new Error("ChatGPT OAuth credentials changed during refresh"))
  expect(auth.access).toBe("synthetic-expired-access")
  expect(auth.refresh).toBe("synthetic-new-expired-login-refresh")
})
