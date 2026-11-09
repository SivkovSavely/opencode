import { confirm } from "@clack/prompts"
import { Effect } from "effect"
import { Auth } from "../../auth"
import { CodexOAuth } from "../../plugin/openai/oauth"
import { CodexUsage } from "../../plugin/openai/usage"
import { CodexReset } from "../../plugin/openai/reset"
import { effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"

export function formatUsage(usage: CodexUsage.Usage, now = Date.now()) {
  const lines = [`Plan: ${usage.plan_type || "Unknown"}`]
  const rate = usage.rate_limit
  if (!rate) {
    lines.push("Rate limit status: unknown")
  } else {
    lines.push(`Allowed: ${rate.allowed ?? "unknown"}`, `Limit reached: ${rate.limit_reached ?? "unknown"}`)
    for (const [label, window] of [
      ["Primary", rate.primary_window],
      ["Secondary", rate.secondary_window],
    ] as const) {
      if (!window) continue
      const percent =
        window.used_percent != null && window.used_percent >= 0 && window.used_percent <= 100
          ? window.used_percent
          : undefined
      const remaining = percent == null ? undefined : 100 - percent
      lines.push(`${label} window:`)
      lines.push(`  Used: ${percent == null ? "unknown" : `${percent}%`}`)
      lines.push(`  Remaining: ${remaining == null ? "unknown" : `${remaining}%`}`)
      lines.push(`  Duration: ${duration(window.limit_window_seconds)}`)
      lines.push(`  Resets: ${resetTime(window.reset_at, window.reset_after_seconds, now)}`)
    }
  }
  lines.push(`Banked reset credits: ${usage.rate_limit_reset_credits?.available_count ?? "unknown"}`)
  if (usage.rate_limit_reset_credits?.applicable_available_count != null)
    lines.push(`Applicable banked reset credits: ${usage.rate_limit_reset_credits.applicable_available_count}`)
  lines.push(
    "Manual redemption guidance: at least one covered allowance must have less than 80% remaining. The applicable count is not a manual redemption gate.",
  )
  return lines.join("\n")
}

export function formatCredits(credits: CodexUsage.Credits, now = Date.now()) {
  const lines = [`Available banked reset credits: ${credits.available_count ?? "unknown"}`]
  for (const credit of credits.credits) {
    lines.push(
      "",
      `${credit.title || "Untitled credit"} [${credit.id || "no ID"}]`,
      `  Status: ${credit.status || "unknown"}`,
      `  Supported by plan: ${credit.is_supported_by_plan ?? "unknown"}`,
      `  Expires: ${credit.expires_at && Number.isFinite(Date.parse(credit.expires_at)) ? `${credit.expires_at} (${remainingTime(credit.expires_at, now)})` : "unknown"}`,
    )
  }
  if (!credits.credits.length) lines.push("", "No credits returned.")
  return lines.join("\n")
}

export const OpenAICommand = cmd({
  command: "openai",
  describe: "manage ChatGPT Codex usage and reset credits",
  builder: (yargs) => yargs.command(UsageCommand).command(ResetCommand).demandCommand(),
  async handler() {},
})

const UsageCommand = effectCmd({
  command: "usage",
  describe: "show ChatGPT Codex usage",
  instance: false,
  builder: (yargs) => yargs.option("json", { describe: "output JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.openai.usage")(function* (args) {
    const connection = yield* connectionForOpenAI()
    const usage = yield* Effect.tryPromise({ try: () => connection.api.usage(), catch: (error) => error }).pipe(
      Effect.catch((error) =>
        fail(error instanceof CodexUsage.RequestError ? error.message : "Unable to load Codex usage."),
      ),
    )
    console.log(args.json ? JSON.stringify(usage, null, 2) : formatUsage(usage))
  }),
})

const ResetCommand = cmd({
  command: "reset",
  describe: "manage banked Codex reset credits",
  builder: (yargs) => yargs.command(ResetListCommand).command(ResetRedeemCommand).demandCommand(),
  async handler() {},
})

const ResetListCommand = effectCmd({
  command: "list",
  describe: "list banked Codex reset credits",
  instance: false,
  builder: (yargs) => yargs.option("json", { describe: "output JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.openai.reset.list")(function* (args) {
    const connection = yield* connectionForOpenAI()
    const credits = yield* Effect.tryPromise({ try: () => connection.api.credits(), catch: (error) => error }).pipe(
      Effect.catch((error) =>
        fail(error instanceof CodexUsage.RequestError ? error.message : "Unable to load Codex reset credits."),
      ),
    )
    console.log(args.json ? JSON.stringify(credits, null, 2) : formatCredits(credits))
  }),
})

const ResetRedeemCommand = effectCmd({
  command: "redeem",
  describe: "preview or redeem a banked Codex reset credit",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("credit-id", { describe: "credit ID to redeem", type: "string" })
      .option("dry-run", { describe: "preview without redeeming", type: "boolean", default: false })
      .option("yes", { describe: "confirm without an interactive prompt", type: "boolean", default: false }),
  handler: Effect.fn("Cli.openai.reset.redeem")(function* (args) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
    if (!args.dryRun && !args.yes && !interactive)
      return yield* fail("Noninteractive redemption requires explicit authorization with --yes.")
    const connection = yield* connectionForOpenAI()
    const result = yield* Effect.tryPromise({
      try: () =>
        CodexReset.redeem({
          api: connection.api,
          accountID: connection.accountID,
          creditID: args.creditId,
          dryRun: args.dryRun,
          yes: args.yes,
          interactive,
          confirm: async (preview) => {
            console.log(formatPreview(preview))
            return (
              (await confirm({
                message: "Redeem this banked reset credit?",
                initialValue: false,
              })) === true
            )
          },
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        fail(error instanceof CodexReset.ResetError ? error.message : "Codex reset operation failed safely."),
      ),
    )
    if (args.dryRun || args.yes) console.log(formatPreview(result.preview))
    if (!result.response) return
    if (result.response.code === "reset") {
      console.log(
        `Reset completed${result.response.windows_reset === undefined ? "" : ` (${result.response.windows_reset} windows reset)`}.`,
      )
      return
    }
    if (result.response.code === "nothing_to_reset") {
      console.log("Nothing to reset; no credit was consumed. A later attempt may succeed.")
      return
    }
    return yield* fail(`Credit was not reset (${result.response.code}); no successful reset is confirmed.`)
  }),
})

function connectionForOpenAI() {
  return Effect.gen(function* () {
    const auth = yield* Auth.Service
    const resolved = yield* Effect.tryPromise({
      try: () =>
        CodexOAuth.resolve(
          () => Effect.runPromise(auth.get("openai")),
          (expected, next) => Effect.runPromise(auth.compareAndSet("openai", expected, next)),
        ),
      catch: () => undefined,
    }).pipe(
      Effect.catch(() =>
        fail("Unable to refresh ChatGPT login. Run `opencode provider login --provider openai` and try again."),
      ),
    )
    if (!resolved) return yield* fail("ChatGPT login is required. Run `opencode provider login --provider openai`.")
    if (!resolved.accountId)
      return yield* fail(
        "ChatGPT login with an account ID is required. Run `opencode provider login --provider openai`.",
      )
    return {
      accountID: resolved.accountId,
      api: CodexUsage.create({ access: resolved.access, accountId: resolved.accountId }),
    }
  })
}

export function formatPreview(preview: CodexReset.Preview) {
  return [
    `Selected credit: ${preview.credit.title || "Untitled credit"} [${preview.credit.id}]`,
    `Expires: ${preview.credit.expires_at ?? "unknown (persisted attempt)"}`,
    `Account: ${preview.accountID}`,
    formatUsage(preview.usage),
    `Reason: ${preview.reason}`,
    "Warning: redemption can restart the covered allowance's refresh period.",
  ].join("\n")
}

function duration(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "unknown"
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${seconds}s`
}

function resetTime(at?: number | null, after?: number | null, now = Date.now()) {
  const timestamp = at != null ? at * 1000 : after != null ? now + after * 1000 : NaN
  const absolute =
    Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? new Date(timestamp).toISOString() : undefined
  const relative = after == null || after < 0 ? undefined : duration(after)
  if (absolute && relative) return `${absolute} (in ${relative})`
  if (absolute) return absolute
  if (relative) return `in ${relative}`
  return "unknown"
}

function remainingTime(value: string, now: number) {
  const milliseconds = Date.parse(value) - now
  return milliseconds <= 0 ? "expired" : `${duration(Math.floor(milliseconds / 1000))} remaining`
}
