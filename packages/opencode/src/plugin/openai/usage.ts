import { Schema } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

const BASE_URL = "https://chatgpt.com/backend-api"
const TIMEOUT_MS = 10_000

const Window = Schema.Struct({
  used_percent: Schema.optional(Schema.NullOr(Schema.Number)),
  limit_window_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_after_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
})

export const UsageSchema = Schema.Struct({
  plan_type: Schema.optional(Schema.NullOr(Schema.String)),
  rate_limit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        allowed: Schema.optional(Schema.NullOr(Schema.Boolean)),
        limit_reached: Schema.optional(Schema.NullOr(Schema.Boolean)),
        primary_window: Schema.optional(Schema.NullOr(Window)),
        secondary_window: Schema.optional(Schema.NullOr(Window)),
      }),
    ),
  ),
  rate_limit_reset_credits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        available_count: Schema.optional(Schema.NullOr(Schema.Number)),
        applicable_available_count: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
})
export type Usage = typeof UsageSchema.Type

export const CreditSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  reset_type: Schema.optional(Schema.NullOr(Schema.String)),
  is_supported_by_plan: Schema.optional(Schema.NullOr(Schema.Boolean)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  expires_at: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  granted_at: Schema.optional(Schema.NullOr(Schema.String)),
  redeem_started_at: Schema.optional(Schema.NullOr(Schema.String)),
  redeemed_at: Schema.optional(Schema.NullOr(Schema.String)),
})
export type Credit = typeof CreditSchema.Type

const CreditsSchema = Schema.Struct({
  credits: Schema.Array(CreditSchema),
  available_count: Schema.optional(Schema.NullOr(Schema.Number)),
  applicable_available_count: Schema.optional(Schema.NullOr(Schema.Number)),
  total_earned_count: Schema.optional(Schema.NullOr(Schema.Number)),
  immediate_reset_purchase_eligible: Schema.optional(Schema.NullOr(Schema.Boolean)),
  history_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
})
export type Credits = typeof CreditsSchema.Type

export const ConsumptionSchema = Schema.Struct({
  code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
  windows_reset: Schema.optional(Schema.Number),
})
export type Consumption = typeof ConsumptionSchema.Type

export type EligibleCredit = Credit & { id: string; expires_at: string }

export class RequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexUsageError"
  }
}

export function create(
  credentials: { access: string; accountId?: string },
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const accountId = credentials.accountId?.trim()
  if (!accountId) throw new RequestError("Codex usage requires an account ID")

  const request = async (path: string, method: "GET" | "POST", body?: unknown) => {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${credentials.access}`,
        "ChatGPT-Account-Id": accountId,
        "User-Agent": `opencode/${InstallationVersion}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
    let response: Response
    try {
      response = await transport(`${BASE_URL}${path}`, init)
    } catch {
      throw new RequestError(
        method === "POST"
          ? "Codex credit consumption is indeterminate after a network failure"
          : "Codex usage request failed due to a network or response error",
      )
    }
    if (!response.ok) throw new RequestError(`${method} Codex usage request failed with HTTP ${response.status}`)
    try {
      return await response.json()
    } catch {
      throw new RequestError(
        method === "POST"
          ? "Codex credit consumption is indeterminate after an invalid response"
          : "Codex usage response was malformed",
      )
    }
  }

  return {
    async usage(): Promise<Usage> {
      try {
        return Schema.decodeUnknownSync(UsageSchema)(await request("/wham/usage", "GET"))
      } catch (error) {
        if (error instanceof RequestError) throw error
        throw new RequestError("Codex usage response was malformed")
      }
    },
    async credits(): Promise<Credits> {
      const raw = await request("/wham/rate-limit-reset-credits", "GET")
      try {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error()
        const input = raw as Record<string, unknown>
        const metadata = Schema.decodeUnknownSync(
          Schema.Struct({
            available_count: Schema.optional(Schema.NullOr(Schema.Number)),
            applicable_available_count: Schema.optional(Schema.NullOr(Schema.Number)),
            total_earned_count: Schema.optional(Schema.NullOr(Schema.Number)),
            immediate_reset_purchase_eligible: Schema.optional(Schema.NullOr(Schema.Boolean)),
            history_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
          }),
        )(input)
        const credits = Array.isArray(input.credits)
          ? input.credits.flatMap((credit) => {
              const decoded = Schema.decodeUnknownOption(CreditSchema)(credit)
              return decoded._tag === "Some" ? [decoded.value] : []
            })
          : []
        return { ...metadata, credits: credits.sort((a, b) => expiration(a.expires_at) - expiration(b.expires_at)) }
      } catch {
        throw new RequestError("Codex credits response was malformed")
      }
    },
    async consume(creditID: string, requestID: string): Promise<Consumption> {
      try {
        const raw = await request("/wham/rate-limit-reset-credits/consume", "POST", {
          credit_id: creditID,
          redeem_request_id: requestID,
        })
        return Schema.decodeUnknownSync(ConsumptionSchema)(raw)
      } catch (error) {
        const status = error instanceof RequestError && error.message.includes("HTTP ") ? ` (${error.message})` : ""
        throw new RequestError(`Codex credit consumption is indeterminate${status}; do not retry with a new request ID`)
      }
    },
  }
}

export function select(credits: readonly Credit[], id?: string, now = Date.now()): EligibleCredit {
  if (
    credits.some(
      (credit, index) =>
        typeof credit.id === "string" && credits.findIndex((candidate) => candidate.id === credit.id) !== index,
    )
  ) {
    throw new RequestError("Duplicate credit IDs are ambiguous")
  }
  const eligible = credits.filter((credit): credit is EligibleCredit => {
    const expires = credit.expires_at ? Date.parse(credit.expires_at) : NaN
    return (
      typeof credit.id === "string" &&
      credit.id.trim().length > 0 &&
      credit.status === "available" &&
      credit.reset_type === "codex_rate_limits" &&
      credit.is_supported_by_plan === true &&
      Number.isFinite(expires) &&
      expires > now
    )
  })
  if (id !== undefined) {
    if (credits.filter((credit) => credit.id === id).length !== 1)
      throw new RequestError("Credit ID is missing or ambiguous")
    const selected = eligible.find((credit) => credit.id === id)
    if (!selected) throw new RequestError("Selected credit is not eligible")
    return selected
  }
  eligible.sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))
  const selected = eligible[0]
  if (!selected) throw new RequestError("No eligible Codex reset credits are available")
  if (eligible[1] && Date.parse(selected.expires_at) === Date.parse(eligible[1].expires_at)) {
    throw new RequestError("Multiple credits share the earliest expiration; specify --credit-id")
  }
  return selected
}

function expiration(value?: string | null) {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

export * as CodexUsage from "./usage"
