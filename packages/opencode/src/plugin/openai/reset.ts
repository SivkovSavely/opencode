import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { withProcessLock } from "../../util/process-lock"
import { writePrivateJson } from "../../util/private-file"
import { CodexUsage } from "./usage"

const Attempt = Schema.Struct({
  credit_id: Schema.String.check(Schema.isNonEmpty()),
  redeem_request_id: Schema.String.check(Schema.isUUID(4)),
  created_at: Schema.String,
  expires_at: Schema.optional(Schema.String),
  code: Schema.optional(CodexUsage.ConsumptionSchema.fields.code),
  windows_reset: Schema.optional(Schema.Number),
  completed_at: Schema.optional(Schema.String),
})
const State = Schema.Struct({
  version: Schema.Literal(1),
  account_id: Schema.String,
  attempts: Schema.Array(Attempt),
})
type State = typeof State.Type

export type Preview = {
  accountID: string
  credit: CodexUsage.Credit & { id: string }
  usage: CodexUsage.Usage
  reason: string
  retry: boolean
}

export class ResetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexResetError"
  }
}

export async function redeem(input: {
  api: Pick<ReturnType<typeof CodexUsage.create>, "credits" | "usage" | "consume">
  accountID: string
  creditID?: string
  dryRun?: boolean
  yes?: boolean
  interactive: boolean
  confirm: (preview: Preview) => Promise<boolean>
  directory?: string
  now?: () => number
}): Promise<{ preview: Preview; response?: CodexUsage.Consumption }> {
  if (!input.accountID.trim()) throw new ResetError("A ChatGPT account ID is required.")
  if (!input.dryRun && !input.yes && !input.interactive)
    throw new ResetError("Noninteractive redemption requires explicit authorization with --yes.")
  const directory = input.directory ?? path.join(Global.Path.data, "openai-reset-redemptions")
  const identity = createHash("sha256").update(input.accountID).digest("hex")
  const file = path.join(directory, `${identity}.json`)
  const now = input.now ?? Date.now

  const run = async () => {
    const credits = await input.api.credits()
    const state = await readState(file, input.accountID)
    const pending = state.attempts.find((attempt) => attempt.code === undefined)
    if (pending && input.creditID !== undefined && input.creditID !== pending.credit_id)
      throw new ResetError(
        "An unresolved redemption is pending for another credit. Reconcile it before selecting a new one.",
      )
    // A replay must use the original ID even if the first request removed it from the list.
    const selected = pending
      ? { id: pending.credit_id, expires_at: pending.expires_at }
      : CodexUsage.select(credits.credits, input.creditID, now())
    if (
      !pending &&
      state.attempts.some((attempt) => attempt.credit_id === selected.id && attempt.code !== "nothing_to_reset")
    )
      throw new ResetError("This credit already has a completed redemption attempt. No new request was sent.")
    const preview: Preview = {
      accountID: input.accountID,
      credit: selected,
      usage: await input.api.usage(),
      retry: pending !== undefined,
      reason: pending
        ? "Reconcile the unresolved attempt using its persisted credit ID and the same request UUID; never select a second credit."
        : input.creditID !== undefined
          ? "Exact --credit-id match, available Codex reset, supported by plan, with a future expiration."
          : "Earliest-expiring eligible Codex reset credit, supported by plan, with a future expiration.",
    }
    if (input.dryRun) return { preview }
    if (!input.yes && (await input.confirm(preview)) !== true)
      throw new ResetError("Redemption cancelled. No request was sent.")
    if (!pending) CodexUsage.select(credits.credits, selected.id, now())

    const attempt: typeof Attempt.Type = pending ?? {
      credit_id: selected.id,
      redeem_request_id: randomUUID(),
      created_at: new Date(now()).toISOString(),
      ...(selected.expires_at && { expires_at: selected.expires_at }),
    }
    const prepared = pending ? state : { ...state, attempts: [...state.attempts, attempt] }
    // Persist before the first POST. An absent outcome is deliberately indeterminate,
    // including a crash after preparation but before the request reaches the backend.
    if (!pending) await writePrivateJson(file, prepared)
    const response = await input.api.consume(attempt.credit_id, attempt.redeem_request_id).catch((error: unknown) => {
      const detail = error instanceof CodexUsage.RequestError ? ` ${error.message}.` : ""
      throw new ResetError(
        `Redemption outcome is indeterminate.${detail} Retry this command to reconcile the same credit and request UUID; do not redeem another credit.`,
      )
    })
    const decoded = Schema.decodeUnknownOption(CodexUsage.ConsumptionSchema)(response)
    if (Option.isNone(decoded))
      throw new ResetError("Redemption outcome is indeterminate. Retry this command with the persisted request UUID.")
    await writePrivateJson(file, {
      ...prepared,
      attempts: prepared.attempts.map((entry) =>
        entry.redeem_request_id !== attempt.redeem_request_id
          ? entry
          : {
              ...entry,
              ...decoded.value,
              completed_at: new Date(now()).toISOString(),
            },
      ),
    }).catch(() => {
      throw new ResetError(
        "Could not persist the redemption outcome. It remains indeterminate locally; retry to reconcile the same request UUID.",
      )
    })
    return { preview, response: decoded.value }
  }

  try {
    if (input.dryRun) return await run()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory())
      throw new ResetError("Redemption state must be a private directory, not a symlink.")
    await chmod(directory, 0o700)
    return await withProcessLock(`openai-reset:${identity}`, run, { directory })
  } catch (error) {
    if (error instanceof ResetError) throw error
    if (error instanceof CodexUsage.RequestError) throw new ResetError(error.message)
    throw new ResetError(
      "Unable to access private redemption state or complete the reset operation. No successful reset is confirmed.",
    )
  }
}

async function readState(file: string, accountID: string): Promise<State> {
  const content = await readFile(file, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (content === undefined) return { version: 1, account_id: accountID, attempts: [] }
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(State))(content)
  if (Option.isNone(decoded)) throw new ResetError("Invalid redemption state. Refusing to create a new attempt.")
  const state = decoded.value
  if (
    state.account_id !== accountID ||
    state.attempts.filter((attempt) => attempt.code === undefined).length > 1 ||
    new Set(state.attempts.map((attempt) => attempt.redeem_request_id)).size !== state.attempts.length
  )
    throw new ResetError("Inconsistent redemption state. Refusing to create a new attempt.")
  return state
}

export * as CodexReset from "./reset"
