import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { ManagedAuthorization, ManagedHandle } from "@/server/runtime-lifecycle"
import { ManagedWorkspace } from "@/server/managed-workspace"

export const TOOL_NAMES = Object.freeze([
  "wq_ping",
  "wq_get_work",
  "wq_get_checkout_work",
  "wq_list_eligible_work",
  "wq_search_issues",
  "wq_list_issue_fields",
  "wq_check_invariants",
  "wq_create_work",
  "wq_claim_work",
  "wq_claim_next_work",
  "wq_update_progress",
  "wq_block_work",
  "wq_resume_work",
  "wq_requeue_work",
  "wq_ready_to_integrate",
  "wq_mark_done",
  "wq_release_checkout",
  "wq_reopen_work",
  "wq_move_work",
  "wq_add_dependency",
  "wq_remove_dependency",
  "wq_add_comment",
  "wq_list_comments",
  "wq_request_owner_decision",
])
const READ_ONLY = new Set([
  "wq_ping",
  "wq_get_work",
  "wq_get_checkout_work",
  "wq_list_eligible_work",
  "wq_search_issues",
  "wq_list_issue_fields",
  "wq_check_invariants",
  "wq_list_comments",
])
const environment = process.env.OPENCODE_MANAGED_WORK_QUEUE
const MAX_BYTES = 1024 * 1024
const TIMEOUT = 40_000

export type Policy = Readonly<{
  url: string
  project: string
  directory: string
  tools: readonly string[]
  issueId?: string
}>
export type Result = { cleanup: "confirmed" | "failed"; result?: CallToolResult; error?: string }

/** Only the server operator may supply this value, never workspace config or tool arguments. */
export async function loadPolicy(raw = environment): Promise<Policy | undefined> {
  if (raw === undefined) return
  const value: unknown = JSON.parse(raw)
  if (
    !object(value) ||
    !["directory,project,tools,url", "directory,issueId,project,tools,url"].includes(Object.keys(value).sort().join())
  )
    throw new Error("Invalid managed WorkQueue operator policy")
  if (typeof value.project !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.project))
    throw new Error("Invalid managed WorkQueue project")
  if (typeof value.url !== "string") throw new Error("Invalid managed WorkQueue URL")
  const url = new URL(value.url)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/mcp" ||
    url.search !== `?project=${value.project}` ||
    value.url !== url.href
  )
    throw new Error("Managed WorkQueue requires an exact project-bound 127.0.0.1 HTTP URL")
  if (typeof value.directory !== "string" || !path.isAbsolute(value.directory))
    throw new Error("Managed WorkQueue requires an absolute workspace directory")
  if (!(await stat(value.directory)).isDirectory()) throw new Error("Managed WorkQueue workspace must be a directory")
  if (
    value.issueId !== undefined &&
    (typeof value.issueId !== "string" || !new RegExp(`^${value.project}-[1-9][0-9]*$`).test(value.issueId))
  )
    throw new Error("Invalid managed WorkQueue issue binding")
  if (ManagedWorkspace.directory && (!ManagedWorkspace.allows(value.directory) || !value.issueId))
    throw new Error("Dedicated managed WorkQueue requires the exact workspace and issue binding")
  if (
    !Array.isArray(value.tools) ||
    value.tools.length === 0 ||
    value.tools.some((name) => typeof name !== "string" || !TOOL_NAMES.includes(name)) ||
    new Set(value.tools).size !== value.tools.length
  )
    throw new Error("Managed WorkQueue tools must be an explicit subset of the known gateway catalog")
  return Object.freeze({
    url: url.href,
    project: value.project,
    directory: await realpath(value.directory),
    tools: Object.freeze(value.tools as string[]),
    ...(typeof value.issueId === "string" ? { issueId: value.issueId } : {}),
  })
}

export function isReadOnly(name: string) {
  return READ_ONLY.has(name)
}

/** Metadata only. Caller must hold its execution lease during discovery. */
export async function discover(policy: Policy, directory: string): Promise<Tool[]> {
  await boundDirectory(policy, directory)
  const connection = connect(policy)
  try {
    await connection.client.connect(connection.transport)
    return await catalog(connection.client, policy)
  } finally {
    await connection.client.close()
  }
}

/** Pass directly as runManagedCommand's prepare callback, with preparation: "process-free". */
export async function prepare(
  policy: Policy,
  directory: string,
  name: string,
  args: Record<string, unknown>,
  authorize: ManagedAuthorization,
  signal?: AbortSignal,
): Promise<ManagedHandle<Result>> {
  if (!policy.tools.includes(name)) throw new Error("WorkQueue tool is not allowed by operator policy")
  // Snapshot before any await: neither the model nor another caller may mutate the admitted arguments.
  const input: Record<string, unknown> = JSON.parse(JSON.stringify(args))
  const state: { cancelled: boolean; dispatched: boolean; pending?: Promise<Result> } = {
    cancelled: signal?.aborted ?? false,
    dispatched: false,
  }
  const cancel = () => {
    state.cancelled = true
  }
  signal?.addEventListener("abort", cancel, { once: true })
  const connection = connect(policy, async (open) => {
    if (state.dispatched || state.cancelled) throw new Error("WorkQueue dispatch is cancelled or already attempted")
    const allowed = await authorize(() => {
      if (state.cancelled) return
      state.dispatched = true
      open()
    })
    if (!allowed || !state.dispatched) throw new Error("WorkQueue dispatch denied by execution fence")
  })
  try {
    await boundDirectory(policy, directory)
    await scopeArguments(policy, name, input)
    await connection.client.connect(connection.transport)
    const tools = await catalog(connection.client, policy)
    const tool = tools.find((tool) => tool.name === name)!
    const validation = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(input)
    if (!validation.valid) throw new Error(`Invalid WorkQueue arguments: ${validation.errorMessage}`)
  } catch (error) {
    state.cancelled = true
    signal?.removeEventListener("abort", cancel)
    await connection.client.close()
    throw error
  }
  const run = (): Promise<Result> =>
    (state.pending ??= (async () => {
      try {
        if (state.cancelled) return { cleanup: "confirmed", error: "WorkQueue cancelled before dispatch" }
        const result = await connection.client.callTool({ name, arguments: input }, CallToolResultSchema, {
          timeout: TIMEOUT,
          resetTimeoutOnProgress: false,
        })
        // MCP errors may hide a partial write. Only a valid successful inline response confirms completion.
        if (result.isError)
          return {
            cleanup: "failed",
            result,
            error: "WorkQueue outcome is unknown; inspect queue state before retrying. No automatic retry was made.",
          }
        return { cleanup: "confirmed", result }
      } catch (error) {
        // SDK deadlines may settle before transport.send's pending authorization does.
        // Close the synchronous open callback before confirming that no dispatch occurred.
        state.cancelled = true
        return {
          cleanup: state.dispatched ? "failed" : "confirmed",
          error: state.dispatched
            ? "WorkQueue outcome is unknown; inspect queue state before retrying. No automatic retry was made."
            : error instanceof Error
              ? error.message
              : String(error),
        }
      } finally {
        state.cancelled = true
        signal?.removeEventListener("abort", cancel)
        await connection.client.close()
      }
    })())
  return {
    start: run,
    cancel: () => {
      state.cancelled = true
      // Do not abort HTTP, notify remote cancellation, or DELETE a session as proof of operation completion.
      return run()
    },
  }
}

function connect(policy: Policy, dispatch?: (open: () => void) => Promise<void>) {
  const client = new Client({ name: "opencode-managed-workqueue", version: "1" }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(policy.url), {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (url, init) => {
      if (String(url) !== policy.url) throw new Error("Unexpected WorkQueue endpoint")
      // The trusted gateway buffers POST replies. Standalone SSE subscriptions and session recovery are not needed.
      if (init?.method === "GET") return new Response(null, { status: 405 })
      if (init?.method !== "POST" || typeof init.body !== "string") throw new Error("Unexpected WorkQueue transport")
      const message: unknown = JSON.parse(init.body)
      if (!object(message) || typeof message.method !== "string") throw new Error("Unexpected WorkQueue message")
      if (message.method === "notifications/cancelled") return new Response(null, { status: 202 })
      if (!["initialize", "notifications/initialized", "tools/list", "tools/call"].includes(message.method))
        throw new Error("Unsupported WorkQueue method")
      const request = () =>
        fetch(policy.url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT - 1000),
        })
      const response =
        message.method === "tools/call"
          ? await (async () => {
              if (!dispatch) throw new Error("WorkQueue discovery cannot dispatch tools")
              const sent: { response?: Promise<Response> } = {}
              await dispatch(() => {
                sent.response = request()
              })
              if (!sent.response) throw new Error("WorkQueue dispatch denied")
              return sent.response
            })()
          : await request()
      // Prevent SDK 404 session recovery/replay. A tool request is never automatically retried.
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`WorkQueue HTTP ${response.status}`)
      }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > MAX_BYTES) throw new Error("WorkQueue response exceeds 1 MiB")
            chunks.push(chunk.value)
          }
        } finally {
          await reader.cancel()
        }
      }
      return new Response(size ? Buffer.concat(chunks) : null, { status: response.status, headers: response.headers })
    },
  })
  return { client, transport }
}

async function catalog(client: Client, policy: Policy) {
  const result = await client.listTools({}, { timeout: TIMEOUT })
  if (result.nextCursor) throw new Error("Unexpected paginated WorkQueue catalog")
  const names = new Set<string>()
  const validator = new AjvJsonSchemaValidator()
  for (const tool of result.tools) {
    if (!TOOL_NAMES.includes(tool.name) || names.has(tool.name)) throw new Error("Unexpected WorkQueue tool catalog")
    names.add(tool.name)
    if (tool.execution?.taskSupport && tool.execution.taskSupport !== "forbidden")
      throw new Error("WorkQueue detached tasks are unsupported")
    if (
      tool.inputSchema.type !== "object" ||
      !object(tool.inputSchema.properties) ||
      tool.inputSchema.additionalProperties !== false ||
      containsProjectSchema(tool.inputSchema)
    )
      throw new Error("Invalid project-bound WorkQueue input schema")
    validator.getValidator(tool.inputSchema)
  }
  if (policy.tools.some((name) => !names.has(name))) throw new Error("Operator-allowed WorkQueue tool is missing")
  return result.tools
    .filter((tool) => policy.tools.includes(tool.name))
    .map((tool) => ({
      ...tool,
      annotations: { ...tool.annotations, readOnlyHint: isReadOnly(tool.name) },
    }))
}

function containsProjectSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProjectSchema)
  if (!object(value)) return false
  return Object.entries(value).some(
    ([key, child]) =>
      key === "$ref" ||
      key === "projectKey" ||
      (key === "required" && Array.isArray(child) && child.includes("projectKey")) ||
      containsProjectSchema(child),
  )
}

async function boundDirectory(policy: Policy, directory: string) {
  if (!path.isAbsolute(directory) || (await realpath(directory)) !== policy.directory)
    throw new Error("WorkQueue is bound to a different canonical workspace")
}

async function scopeArguments(policy: Policy, name: string, args: Record<string, unknown>) {
  if (Object.hasOwn(args, "projectKey")) throw new Error("WorkQueue projectKey is connection-bound")
  if (policy.issueId && !isReadOnly(name) && args.issueId !== policy.issueId)
    throw new Error("WorkQueue mutation requires the operator-bound issue ID")
  if (Object.hasOwn(args, "checkoutPath")) {
    if (typeof args.checkoutPath !== "string") throw new Error("Invalid WorkQueue checkoutPath")
    await boundDirectory(policy, args.checkoutPath)
    args.checkoutPath = policy.directory
  }
  for (const [key, value] of Object.entries(args)) {
    if (key === "issueId" || key.endsWith("IssueId") || key === "dependencies") {
      const ids = key === "dependencies" && Array.isArray(value) ? value : [value]
      if (ids.some((id) => typeof id !== "string" || !new RegExp(`^${policy.project}-[1-9][0-9]*$`).test(id)))
        throw new Error("WorkQueue issue IDs must belong to the bound project")
      if (policy.issueId && ids.some((id) => id !== policy.issueId))
        throw new Error("WorkQueue issue belongs to another slot assignment")
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export * as ManagedWorkQueue from "./managed-workqueue"
