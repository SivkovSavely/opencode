import "@opencode-ai/core/global"
import { withProcessLock } from "../../util/process-lock"
import type { Auth } from "../../auth"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"

export interface IdTokenClaims {
  chatgpt_account_id?: string
  chatgpt_compute_residency?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    chatgpt_compute_residency?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString())
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    return value as IdTokenClaims
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  const values = [
    claims.chatgpt_account_id,
    claims["https://api.openai.com/auth"]?.chatgpt_account_id,
    Array.isArray(claims.organizations) ? claims.organizations[0]?.id : undefined,
  ]
  return values.find((value) => typeof value === "string" && value.length > 0)
}

export function extractAccountId(tokens: {
  id_token?: string
  access_token?: string
  refresh_token?: string
}): string | undefined {
  const id = tokens.id_token && parseJwtClaims(tokens.id_token)
  const access = tokens.access_token && parseJwtClaims(tokens.access_token)
  return (id && extractAccountIdFromClaims(id)) || (access && extractAccountIdFromClaims(access)) || undefined
}

export function extractResidency(token: string): string | undefined {
  const claims = parseJwtClaims(token)
  const residency =
    claims?.["https://api.openai.com/auth"]?.chatgpt_compute_residency ?? claims?.chatgpt_compute_residency
  if (typeof residency !== "string" || !residency || residency === "no_constraint") return undefined
  return residency
}

type OAuth = Auth.Oauth
export type CompareAndSet = (expected: OAuth, next: OAuth) => Promise<boolean>
type Options = {
  allowRefresh?: boolean
  issuer?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

function withAccount(auth: OAuth): OAuth {
  const accountId = auth.accountId || extractAccountId({ access_token: auth.access })
  return { ...auth, ...(accountId && { accountId }) }
}

export async function resolve(
  getAuth: () => Promise<Auth.Info | undefined>,
  compareAndSet: CompareAndSet = async (expected, next) => {
    const { Auth } = await import("../../auth")
    const { Effect } = await import("effect")
    const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
    return Effect.runPromise(
      Auth.Service.use((auth) => auth.compareAndSet("openai", expected, next)).pipe(
        Effect.provide(LayerNode.compile(Auth.node)),
      ),
    )
  },
  options: Options = {},
): Promise<OAuth | undefined> {
  const initial = await getAuth()
  if (initial?.type !== "oauth") return undefined
  if (initial.access && initial.expires >= Date.now()) return withAccount(initial)
  if (options.allowRefresh === false) throw new Error("ChatGPT OAuth credentials expired")

  return withProcessLock("openai-oauth-refresh", async () => {
    const current = await getAuth()
    if (current?.type !== "oauth") return undefined
    if (current.access && current.expires >= Date.now()) return withAccount(current)

    const response = await (options.fetch ?? fetch)(`${options.issuer ?? ISSUER}/oauth/token`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh,
        client_id: CLIENT_ID,
      }).toString(),
    }).catch(() => {
      throw new Error("Token refresh failed")
    })
    if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
    const tokens: unknown = await response.json().catch(() => {
      throw new Error("Invalid token refresh response")
    })
    if (
      !tokens ||
      typeof tokens !== "object" ||
      !("access_token" in tokens) ||
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      !("refresh_token" in tokens) ||
      typeof tokens.refresh_token !== "string" ||
      !tokens.refresh_token
    ) {
      throw new Error("Invalid token refresh response")
    }
    const expires =
      "expires_in" in tokens &&
      typeof tokens.expires_in === "number" &&
      Number.isFinite(tokens.expires_in) &&
      tokens.expires_in >= 0
        ? tokens.expires_in
        : 3600
    const id = "id_token" in tokens && typeof tokens.id_token === "string" ? tokens.id_token : undefined
    const accountId = extractAccountId({ id_token: id, access_token: tokens.access_token }) || current.accountId
    const updated = {
      ...current,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + expires * 1000,
      ...(accountId && { accountId }),
    }
    const saved = await compareAndSet(current, updated).catch(() => {
      throw new Error("Failed to save ChatGPT OAuth credentials")
    })
    if (saved) return updated
    const latest = await getAuth()
    if (latest?.type !== "oauth") return undefined
    if (!latest.access || latest.expires < Date.now())
      throw new Error("ChatGPT OAuth credentials changed during refresh")
    return withAccount(latest)
  })
}

export * as CodexOAuth from "./oauth"
