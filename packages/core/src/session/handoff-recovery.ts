export * as SessionHandoffRecovery from "./handoff-recovery"

import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { SessionHandoffStore } from "./handoff-store"
import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"

export type Connection = SessionHandoffStore.Connection
export type RootAdmission = {
  sessionID: string
  reservation: string
  ownerLineage: string
  ownerInstance: string
  fence: number
  controlData: string
}
export const CurrentRootAdmission = Context.Reference<RootAdmission | undefined>(
  "SessionHandoffRecovery/RootAdmission",
  {
    defaultValue: () => undefined,
  },
)
export const CurrentNewTask = Context.Reference<
  | {
      sessionID: string
      parentMessageID: string
      parentCallID: string
      parentFence: number
    }
  | undefined
>("SessionHandoffRecovery/NewTask", { defaultValue: () => undefined })
export type Liveness = "live" | "dead" | "unknown"
export type TaskLink = {
  parentSessionID: string
  parentAssistantMessageID: string
  parentCallID: string
  childSessionID: string
  childUserMessageID: string
  mode: "foreground" | "background"
}
export type ChildExpectation = {
  link: TaskLink
  inputDigest: string
  ownerLineage: string
  ownerInstance: string
  fence: number
  recoveryRevision: number
}
export type InterruptedResource = {
  assistantMessageID: string
  partID: string
  callID: string
  tool: string
  resourceKind: "process" | "task" | "output" | "other" | "unknown"
  resourceRef: string | null
  liveness: Liveness | "not_applicable"
  effect: "uncertain"
  evidence: string | null
}
export type TaskDescendant = {
  link: TaskLink | null
  childSessionID: string
  parentSessionID: string | null
  proof: "verified" | "ambiguous_lineage" | "ambiguous_input" | "unsupported_child"
  state: "active" | "held" | "terminal" | "ambiguous"
  selection: { providerID: string; modelID: string; variant: string } | null
  agent: string | null
  inputDigest: string | null
  ownerLineage: string | null
  ownerInstance: string | null
  fence: number | null
  recoveryRevision: number | null
  ownerLiveness: Liveness
  resultAssistantMessageID: string | null
  resultState: "none" | "completed" | "error" | "uncertain"
  interruptedResources: InterruptedResource[]
}
export type ChildRecoveryStatus = {
  link: TaskLink
  priorFence: number
  recoveryFence: number
  state: "claimed" | "reconciling" | "continuing" | "terminal" | "held" | "failed"
  resultAssistantMessageID: string | null
  resultState: TaskDescendant["resultState"]
  interruptedResources: InterruptedResource[]
}
export type RuntimeOwner = {
  lineage: string
  instance: string
  process?: { host: string; machineID: string; bootID: string; pidNamespace: string; pid: number; startTime: string }
}
export const ResourceProcessIdentity = Schema.Struct({
  host: Schema.String,
  machineID: Schema.String,
  bootID: Schema.String,
  pidNamespace: Schema.String,
  pid: Schema.Int,
  startTime: Schema.String,
})
export type ResourceProbe = (identity: typeof ResourceProcessIdentity.Type) => Liveness
type Runtime = {
  session_id: string
  directory: string
  owner_lineage: string
  owner_instance: string
  fence: number
  state: string
  desired_active: number
  parent_session_id: string | null
  parent_message_id: string | null
  parent_call_id: string | null
  parent_mode: string | null
  parent_notification_state: string | null
  recovery_attempts: number
  recovery_preparation_attempts: number
}
type Session = {
  id: string
  parent_id: string | null
  directory: string
  project_id: string
  workspace_id: string | null
  metadata: string | null
  permission: string | null
  agent: string | null
  model: string | null
}
type Message = { id: string; session_id: string; data: string; time_created: number }
type Part = { id: string; message_id: string; session_id: string; data: string; time_created: number }
type Generation = { session_id: string; reservation: string; state: string; user_message_id: string | null }
type Graph = {
  sessions: Session[]
  runtimes: Runtime[]
  messages: Message[]
  parts: Part[]
  queues: (Record<string, unknown> & { session_id: string })[]
  queueStates: (Record<string, unknown> & { session_id: string })[]
}
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown)
function object(value: unknown): Record<string, unknown> {
  return Option.getOrElse(Schema.decodeUnknownOption(ObjectValue)(value), () => ({}))
}
function json(value: string | null) {
  return value === null ? null : Option.getOrNull(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value))
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
function digest(value: unknown) {
  return `sha256:v1:${createHash("sha256").update(canonical(value)).digest("hex")}`
}

export class RecoveryError extends Schema.TaggedErrorClass<RecoveryError>()("SessionHandoffRecoveryError", {
  code: Schema.Literals([
    "history_unavailable",
    "not_enrolled",
    "stale_context",
    "stale_fence",
    "owner_live",
    "owner_unknown",
    "ambiguous_lineage",
    "ambiguous_input",
    "unsupported_child",
    "unresolved_resource",
  ]),
}) {}

export const Evidence = Schema.Struct({
  // A settled action cannot recapture a reused child's later execution.
  sealed: Schema.optional(Schema.Boolean),
  descendants: Schema.Array(SessionHandoffV1.TaskDescendant),
  descendantDigest: Schema.String,
  interruptedResources: Schema.Array(SessionHandoffV1.InterruptedResource),
})
export type Evidence = typeof Evidence.Type

/** Read retained evidence only. Never consult a reused child's current metadata. */
export const retained = Effect.fn("SessionHandoffRecovery.retained")(function* (
  database: Connection,
  key: SessionHandoffStore.ActionKey,
) {
  const row = yield* database.db.get<{ data: string }>(
    sql`SELECT data FROM session_handoff_recovery_history WHERE session_id=${key.sessionID} AND queue_id=${key.queueID} AND user_message_id=${key.userMessageID} ORDER BY revision DESC LIMIT 1`,
  )
  if (!row) return undefined
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Evidence))(row.data).pipe(
    Effect.mapError(() => new RecoveryError({ code: "history_unavailable" })),
  )
})

/** Caller captures/validates this action before competing input can be admitted. */
export const retain = Effect.fn("SessionHandoffRecovery.retain")(function* (
  database: Connection,
  key: SessionHandoffStore.ActionKey,
  snapshot: Evidence,
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        if (
          !(yield* tx.get(
            sql`SELECT 1 FROM session_handoff_action WHERE session_id=${key.sessionID} AND queue_id=${key.queueID} AND user_message_id=${key.userMessageID}`,
          ))
        )
          return yield* new RecoveryError({ code: "history_unavailable" })
        const current = yield* tx.get<{ queue_id: string; user_message_id: string }>(
          sql`SELECT queue_id,user_message_id FROM session_handoff_root WHERE session_id=${key.sessionID} AND state != 'aborted' ORDER BY rowid DESC LIMIT 1`,
        )
        if (current?.queue_id !== key.queueID || current.user_message_id !== key.userMessageID)
          return yield* new RecoveryError({ code: "stale_context" })
        const value = yield* Schema.decodeUnknownEffect(Evidence)(snapshot)
        const prior = yield* tx.get<{ data: string; revision: number }>(
          sql`SELECT data,revision FROM session_handoff_recovery_history WHERE session_id=${key.sessionID} AND queue_id=${key.queueID} AND user_message_id=${key.userMessageID} ORDER BY revision DESC LIMIT 1`,
        )
        if (prior) {
          const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Evidence))(prior.data)
          if (stored.sealed) return stored
        }
        if (prior?.data === canonical(value)) return value
        yield* tx.run(
          sql`INSERT INTO session_handoff_recovery_history (session_id,queue_id,user_message_id,revision,data) VALUES (${key.sessionID},${key.queueID},${key.userMessageID},${(prior?.revision ?? -1) + 1},${canonical(value)})`,
        )
        return value
      }),
    { behavior: "immediate" },
  )
})

/** Called under the runtime admission lock before a completed owner is released. */
export const captureCurrent = Effect.fn("SessionHandoffRecovery.captureCurrent")(function* (
  database: Connection,
  sessionID: string,
  liveness: (sessionID: string) => Effect.Effect<Liveness>,
  probe?: ResourceProbe,
) {
  yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const roots = yield* tx.all<{
          session_id: string
          queue_id: string
          user_message_id: string
        }>(sql`WITH RECURSIVE ancestors(id) AS (
      SELECT ${sessionID} UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id=a.id WHERE s.parent_id IS NOT NULL
      UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id=a.id WHERE e.parent_session_id IS NOT NULL)
      SELECT r.session_id,r.queue_id,r.user_message_id FROM session_handoff_root r JOIN session_handoff_action a ON a.session_id=r.session_id AND a.queue_id=r.queue_id AND a.user_message_id=r.user_message_id
      WHERE r.session_id IN (SELECT id FROM ancestors) AND r.enrolled_request_id IS NOT NULL AND r.state IN ('active','terminal')
      AND r.reservation=(SELECT reservation FROM session_handoff_root WHERE session_id=r.session_id AND state!='aborted' ORDER BY rowid DESC LIMIT 1)`)
        for (const root of roots) {
          const key = { sessionID: root.session_id, queueID: root.queue_id, userMessageID: root.user_message_id }
          if ((yield* retained({ db: tx }, key))?.sealed) continue
          yield* retain({ db: tx }, key, yield* inspect({ db: tx }, root.session_id, liveness, probe, key))
        }
      }),
    { behavior: "immediate" },
  )
})

const graph = Effect.fnUntraced(function* (database: Connection, roots: readonly string[]) {
  const ids = yield* database.db.all<{ id: string }>(sql`
    WITH RECURSIVE edges(parent, child) AS (
      SELECT parent_id, id FROM session WHERE parent_id IS NOT NULL
      UNION SELECT parent_session_id, session_id FROM runtime_execution WHERE parent_session_id IS NOT NULL
      UNION SELECT json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.task.parentSessionId'), id FROM session
      UNION SELECT session_id, json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.state.metadata.sessionId') FROM part
        WHERE json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.type') = 'tool'
          AND json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.tool') = 'task'
    ), potential(id) AS (
      SELECT value FROM json_each(${JSON.stringify(roots)})
      UNION SELECT child FROM edges JOIN potential ON edges.parent = potential.id WHERE typeof(child) = 'text'
    ) SELECT id FROM potential ORDER BY id`)
  const scope = sql`(SELECT value FROM json_each(${JSON.stringify(ids.map((row) => row.id))}))`
  const sessions = yield* database.db.all<Session>(
    sql`SELECT id, parent_id, directory, project_id, workspace_id, metadata, permission, agent, model FROM session WHERE id IN ${scope} ORDER BY id`,
  )
  const runtimes = yield* database.db.all<Runtime>(
    sql`SELECT * FROM runtime_execution WHERE session_id IN ${scope} ORDER BY session_id`,
  )
  const messages = yield* database.db.all<Message>(
    sql`SELECT id, session_id, data, time_created FROM message WHERE session_id IN ${scope} ORDER BY time_created, id`,
  )
  const parts = yield* database.db.all<Part>(
    sql`SELECT id, message_id, session_id, data, time_created FROM part WHERE session_id IN ${scope} ORDER BY time_created, id`,
  )
  const queues = yield* database.db.all<Record<string, unknown> & { session_id: string }>(
    sql`SELECT * FROM session_queue WHERE session_id IN ${scope} ORDER BY session_id, position, id`,
  )
  const queueStates = yield* database.db.all<Record<string, unknown> & { session_id: string }>(
    sql`SELECT * FROM session_queue_state WHERE session_id IN ${scope} ORDER BY session_id`,
  )
  return { sessions, runtimes, messages, parts, queues, queueStates }
})

// Potential links intentionally include incomplete and contradictory evidence.
function closure(data: Graph, root: string, excluded = new Set<string>()) {
  const ids = new Set([root])
  while (true) {
    const size = ids.size
    for (const session of data.sessions) {
      if (excluded.has(session.id)) continue
      const task = object(object(json(session.metadata)).task)
      if (
        (session.parent_id && ids.has(session.parent_id)) ||
        (typeof task.parentSessionId === "string" && ids.has(task.parentSessionId))
      )
        ids.add(session.id)
    }
    for (const runtime of data.runtimes)
      if (!excluded.has(runtime.session_id) && runtime.parent_session_id && ids.has(runtime.parent_session_id))
        ids.add(runtime.session_id)
    for (const part of data.parts) {
      const tool = object(json(part.data))
      const metadata = object(object(tool.state).metadata)
      if (
        ids.has(part.session_id) &&
        tool.type === "tool" &&
        tool.tool === "task" &&
        typeof metadata.sessionId === "string" &&
        !excluded.has(metadata.sessionId)
      )
        ids.add(metadata.sessionId)
    }
    if (ids.size === size) return [...ids].sort()
  }
}

function generation(data: Graph, root: Generation, roots: readonly Generation[]) {
  if (!root.user_message_id) return { data, ids: closure(data, root.session_id) }
  const otherUsers = new Set(
    roots
      .filter((item) => item.session_id === root.session_id && item.user_message_id !== root.user_message_id)
      .map((item) => item.user_message_id)
      .filter((id) => id !== null),
  )
  const otherMessages = new Set(
    data.messages
      .filter((message) => {
        const value = object(json(message.data))
        return (
          message.session_id === root.session_id &&
          value.role === "assistant" &&
          typeof value.parentID === "string" &&
          otherUsers.has(value.parentID)
        )
      })
      .map((message) => message.id),
  )
  // Exclude another generation only when every retained direct link agrees on
  // its original parent assistant. Missing or contradictory links remain held.
  const excluded = new Set(
    data.sessions
      .filter((session) => {
        const task = object(object(json(session.metadata)).task)
        const parents = [
          ...(session.parent_id === root.session_id || task.parentSessionId === root.session_id
            ? [task.parentMessageID]
            : []),
          ...data.runtimes
            .filter((row) => row.session_id === session.id && row.parent_session_id === root.session_id)
            .map((row) => row.parent_message_id),
          ...data.parts
            .filter(
              (part) =>
                part.session_id === root.session_id &&
                object(object(object(json(part.data)).state).metadata).sessionId === session.id,
            )
            .map((part) => part.message_id),
        ]
        return (
          parents.length > 0 &&
          new Set(parents).size === 1 &&
          parents.every((id) => typeof id === "string" && otherMessages.has(id))
        )
      })
      .map((session) => session.id),
  )
  const scoped = { ...data, parts: data.parts.filter((part) => !otherMessages.has(part.message_id)) }
  return { data: scoped, ids: closure(scoped, root.session_id, excluded) }
}

export const installStartupHolds = Effect.fn("SessionHandoffRecovery.installStartupHolds")(function* (
  database: Connection,
  currentInstance: string,
  liveness?: (sessionID: string) => Effect.Effect<Liveness>,
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        // Closing root input does not settle its Task dependencies or their pending delivery.
        const roots = yield* tx.all<Generation>(sql`
       SELECT h.session_id, h.reservation, h.state, h.user_message_id FROM session_handoff_root h
       WHERE h.enrolled_request_id IS NOT NULL`)
        if (roots.length === 0) return []
        const data = yield* graph(
          { db: tx },
          roots.map((root) => root.session_id),
        )
        const protectedIDs = new Set<string>()
        for (const root of roots) {
          const scoped = generation(data, root, roots)
          const ids = scoped.ids
          if (
            root.state !== "active" &&
            !ids.some(
              (id) =>
                id !== root.session_id &&
                !["completed", "cancelled"].includes(
                  data.runtimes.find((row) => row.session_id === id)?.state ?? "missing",
                ),
            ) &&
            !data.runtimes.some(
              (row) =>
                ids.includes(row.session_id) &&
                row.session_id !== root.session_id &&
                row.parent_mode === "background" &&
                row.parent_notification_state !== "delivered",
            ) &&
            !scoped.data.parts.some((part) => {
              const tool = object(json(part.data))
              const state = object(tool.state)
              const metadata = object(state.metadata)
              return (
                ids.includes(part.session_id) &&
                tool.type === "tool" &&
                (state.status === "pending" ||
                  state.status === "running" ||
                  (metadata.interrupted === true && metadata.handoffRecovery !== true))
              )
            })
          )
            continue
          for (const id of ids) protectedIDs.add(id)
          // Generations share the root admission boundary. A live child of an
          // older generation must not be disrupted by a hold on a newer one.
          const owners = yield* Effect.forEach(closure(data, root.session_id), (id) =>
            liveness
              ? liveness(id)
              : Effect.succeed(
                  data.runtimes.find((row) => row.session_id === id)?.owner_instance === currentInstance
                    ? ("live" as const)
                    : ("unknown" as const),
                ),
          )
          // A second server must not install admission barriers into another live owner's execution tree.
          // The returned closure still excludes this tree from every automatic startup mutation.
          if (owners.includes("live")) continue
          for (const id of ids)
            yield* tx.run(sql`
       INSERT OR IGNORE INTO session_handoff_recovery_hold (root_session_id, reservation, session_id)
       VALUES (${root.session_id}, ${root.reservation}, ${id})`)
        }
        return [...protectedIDs].sort()
      }),
    { behavior: "immediate" },
  )
})

export const held = Effect.fn("SessionHandoffRecovery.held")(function* (database: Connection, sessionID: string) {
  const row = yield* database.db.get(
    sql`SELECT 1 FROM session_handoff_recovery_hold WHERE session_id = ${sessionID} LIMIT 1`,
  )
  if (row) return true
  // New ambiguous descendants of an already held root are protected immediately, before another startup scan.
  const roots = yield* database.db.all<{ root_session_id: string; reservation: string }>(
    sql`SELECT DISTINCT root_session_id, reservation FROM session_handoff_recovery_hold`,
  )
  if (roots.length === 0) return false
  const data = yield* graph(
    database,
    roots.map((root) => root.root_session_id),
  )
  const generations = yield* database.db.all<Generation>(
    sql`SELECT session_id,reservation,state,user_message_id FROM session_handoff_root WHERE enrolled_request_id IS NOT NULL`,
  )
  return roots.some((root) =>
    generation(
      data,
      generations.find((item) => item.session_id === root.root_session_id && item.reservation === root.reservation) ?? {
        session_id: root.root_session_id,
        reservation: root.reservation,
        state: "invalidated",
        user_message_id: null,
      },
      generations,
    ).ids.includes(sessionID),
  )
})

function resources(data: Graph, sessionID: string, probe?: ResourceProbe): InterruptedResource[] {
  return data.parts
    .filter((part) => part.session_id === sessionID)
    .flatMap((part) => {
      const tool = object(json(part.data))
      const state = object(tool.state)
      const metadata = object(state.metadata)
      if (
        tool.type !== "tool" ||
        (state.status !== "running" && state.status !== "pending" && metadata.interrupted !== true)
      )
        return []
      const task = tool.tool === "task"
      const process =
        tool.tool === "bash" || tool.tool === "shell" || metadata.pid !== undefined || metadata.processID !== undefined
      const identity = Option.getOrNull(Schema.decodeUnknownOption(ResourceProcessIdentity)(metadata.processIdentity))
      const liveness = task ? ("not_applicable" as const) : identity && probe ? probe(identity) : ("unknown" as const)
      return [
        {
          assistantMessageID: part.message_id,
          partID: part.id,
          callID: typeof tool.callID === "string" ? tool.callID : part.id,
          tool: typeof tool.tool === "string" ? tool.tool : "unknown",
          resourceKind: task ? ("task" as const) : process ? ("process" as const) : ("unknown" as const),
          resourceRef: typeof metadata.outputPath === "string" ? metadata.outputPath : null,
          liveness,
          effect: "uncertain" as const,
          evidence: task
            ? "Task result is reported separately; interrupted parent call cannot become successful"
            : identity && probe
              ? `verified process identity: ${liveness}`
              : null,
        },
      ]
    })
}

export const inspect = Effect.fn("SessionHandoffRecovery.inspect")(function* (
  database: Connection,
  rootSessionID: string,
  liveness: (sessionID: string) => Effect.Effect<Liveness>,
  probe?: ResourceProbe,
  key?: Pick<SessionHandoffStore.ActionKey, "queueID" | "userMessageID">,
) {
  const full = yield* graph(database, [rootSessionID])
  const action = key
    ? yield* database.db.get<Generation>(
        sql`SELECT session_id,reservation,state,user_message_id FROM session_handoff_root WHERE session_id=${rootSessionID} AND queue_id=${key.queueID} AND user_message_id=${key.userMessageID} AND enrolled_request_id IS NOT NULL`,
      )
    : undefined
  if (key && !action) return yield* new RecoveryError({ code: "history_unavailable" })
  const roots = action
    ? yield* database.db.all<Generation>(
        sql`SELECT session_id,reservation,state,user_message_id FROM session_handoff_root WHERE session_id=${rootSessionID} AND enrolled_request_id IS NOT NULL`,
      )
    : []
  const scoped = action ? generation(full, action, roots) : { data: full, ids: closure(full, rootSessionID) }
  const data = scoped.data
  const ids = scoped.ids
  const revisions = yield* database.db.all<{ session_id: string; recovery_revision: number }>(
    sql`SELECT session_id, recovery_revision FROM session_handoff_recovery_child`,
  )
  const descendants: TaskDescendant[] = []
  for (const id of ids.filter((id) => id !== rootSessionID)) {
    const session = data.sessions.find((session) => session.id === id)
    const runtime = data.runtimes.find((runtime) => runtime.session_id === id)
    const task = object(object(json(session?.metadata ?? null)).task)
    const candidates = data.parts.filter((part) => {
      const tool = object(json(part.data))
      return (
        tool.type === "tool" &&
        tool.tool === "task" &&
        object(object(tool.state).metadata).sessionId === id &&
        ids.includes(part.session_id)
      )
    })
    const part = candidates.length === 1 ? candidates[0] : undefined
    const tool = object(json(part?.data ?? null))
    const metadata = object(object(tool.state).metadata)
    const parent = data.sessions.find((session) => session.id === part?.session_id)
    const mode = metadata.background === true ? "background" : "foreground"
    const inputID = typeof metadata.messageID === "string" ? metadata.messageID : null
    const input = data.messages.find((message) => message.session_id === id && message.id === inputID)
    const user = object(json(input?.data ?? null))
    const model = object(user.model)
    const selection =
      typeof model.providerID === "string" && typeof model.modelID === "string"
        ? {
            providerID: model.providerID,
            modelID: model.modelID,
            variant:
              typeof user.variant === "string"
                ? user.variant
                : typeof model.variant === "string"
                  ? model.variant
                  : "default",
          }
        : null
    const link: TaskLink | null =
      part && inputID && typeof tool.callID === "string"
        ? {
            parentSessionID: part.session_id,
            parentAssistantMessageID: part.message_id,
            parentCallID: tool.callID,
            childSessionID: id,
            childUserMessageID: inputID,
            mode,
          }
        : null
    const parentMessage = data.messages.find(
      (message) => message.id === part?.message_id && message.session_id === part?.session_id,
    )
    const lineage = !!(
      link &&
      session &&
      parent &&
      runtime &&
      candidates.length === 1 &&
      object(json(parentMessage?.data ?? null)).role === "assistant" &&
      session.parent_id === link.parentSessionID &&
      runtime.parent_session_id === link.parentSessionID &&
      runtime.parent_message_id === link.parentAssistantMessageID &&
      runtime.parent_call_id === link.parentCallID &&
      runtime.parent_mode === mode &&
      task.parentSessionId === link.parentSessionID &&
      task.parentMessageID === link.parentAssistantMessageID &&
      task.parentCallID === link.parentCallID &&
      metadata.parentSessionId === link.parentSessionID &&
      metadata.parentMessageID === link.parentAssistantMessageID &&
      metadata.parentCallID === link.parentCallID &&
      session.directory === parent.directory &&
      runtime.directory === session.directory &&
      session.project_id === parent.project_id &&
      session.workspace_id === parent.workspace_id
    )
    const history = data.messages.filter((message) => message.session_id === id)
    const historyParts = data.parts.filter((part) => part.session_id === id)
    const selectedModel = object(metadata.model)
    const taskInput = object(object(tool.state).input)
    const taskModel = object(task.model)
    const inputParts = historyParts.filter((part) => part.message_id === inputID).map((part) => object(json(part.data)))
    const validInput = !!(
      input &&
      user.role === "user" &&
      selection &&
      typeof user.agent === "string" &&
      user.agent === session?.agent &&
      selectedModel.providerID === selection.providerID &&
      selectedModel.modelID === selection.modelID &&
      task.messageID === inputID &&
      taskModel.providerID === selection.providerID &&
      taskModel.modelID === selection.modelID &&
      taskInput.subagent_type === user.agent &&
      typeof taskInput.prompt === "string" &&
      inputParts
        .filter((part) => part.type === "text" && part.synthetic !== true)
        .map((part) => part.text)
        .join("\n") === taskInput.prompt &&
      (typeof metadata.variant !== "string" || metadata.variant === selection.variant) &&
      (typeof task.variant !== "string" || task.variant === selection.variant) &&
      history.filter((message) => object(json(message.data)).role === "user").length === 1 &&
      history.every((message) => {
        const info = object(json(message.data))
        return info.role === "user" || (info.role === "assistant" && info.parentID === inputID)
      }) &&
      historyParts.every((part) =>
        history.some(
          (message) =>
            message.id === part.message_id &&
            (object(json(part.data)).type !== "tool" || object(json(message.data)).role === "assistant"),
        ),
      )
    )
    const interruptedResources = resources(data, id, probe)
    const terminal = runtime?.state === "completed" || runtime?.state === "cancelled"
    const latest = history.findLast((message) => {
      const info = object(json(message.data))
      return info.role === "assistant" && info.parentID === inputID
    })
    const result = latest && object(object(json(latest.data)).time).completed !== undefined ? latest : undefined
    const resultInfo = object(json(result?.data ?? null))
    descendants.push({
      link,
      childSessionID: id,
      parentSessionID: session?.parent_id ?? runtime?.parent_session_id ?? null,
      proof: !lineage ? "ambiguous_lineage" : !validInput ? "ambiguous_input" : "verified",
      state: terminal ? "terminal" : (yield* held(database, id)) ? "held" : "active",
      // Report the model default only after verifying the original sentinel against Task metadata.
      selection: selection?.variant === "" ? { ...selection, variant: "default" } : selection,
      agent: typeof user.agent === "string" ? user.agent : null,
      inputDigest: digest({
        input,
        session,
        history,
        parts: historyParts,
        queues: data.queues.filter((queue) => queue.session_id === id),
        queueState: data.queueStates.filter((queue) => queue.session_id === id),
      }),
      ownerLineage: runtime?.owner_lineage ?? null,
      ownerInstance: runtime?.owner_instance ?? null,
      fence: runtime?.fence ?? null,
      recoveryRevision: revisions.find((revision) => revision.session_id === id)?.recovery_revision ?? 0,
      ownerLiveness: runtime ? yield* liveness(id) : "unknown",
      resultAssistantMessageID: result?.id ?? null,
      resultState: !result
        ? "none"
        : interruptedResources.some(
              (resource) => resource.liveness !== "dead" && resource.liveness !== "not_applicable",
            )
          ? "uncertain"
          : resultInfo.error
            ? "error"
            : typeof resultInfo.finish === "string" &&
                (!["tool-calls", "unknown"].includes(resultInfo.finish) || resultInfo.structured !== undefined)
              ? "completed"
              : "uncertain",
      interruptedResources,
    })
  }
  const interruptedResources = resources(data, rootSessionID, probe)
  return {
    sealed:
      data.runtimes.some(
        (runtime) => runtime.session_id === rootSessionID && ["completed", "cancelled"].includes(runtime.state),
      ) &&
      descendants.every((child) => child.state === "terminal" && child.proof === "verified") &&
      [...interruptedResources, ...descendants.flatMap((child) => child.interruptedResources)].every(
        (resource) => resource.liveness === "dead" || resource.liveness === "not_applicable",
      ),
    descendants,
    descendantDigest: digest({
      version: 1,
      rootSessionID,
      ids,
      descendants,
      sessions: data.sessions.filter((session) => ids.includes(session.id)),
      runtimes: data.runtimes.filter((runtime) => ids.includes(runtime.session_id)),
      messages: data.messages.filter((message) => ids.includes(message.session_id)),
      parts: data.parts.filter((part) => ids.includes(part.session_id)),
      queues: data.queues.filter((queue) => ids.includes(queue.session_id)),
      queueStates: data.queueStates.filter((queue) => ids.includes(queue.session_id)),
    }),
    interruptedResources,
  }
})

export const claim = Effect.fn("SessionHandoffRecovery.claim")(function* <A, E>(
  database: Connection,
  input: {
    sessionID: string
    expectedDescendantDigest: string
    children: readonly ChildExpectation[]
    owner: RuntimeOwner
  },
  liveness: (sessionID: string) => Effect.Effect<Liveness>,
  rootTransition: (database: Connection) => Effect.Effect<A, E>,
  probe?: ResourceProbe,
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const enrolled = yield* tx.get<{
          reservation: string
          state: string
          queue_id: string
          user_message_id: string
        }>(
          sql`SELECT reservation, state, queue_id, user_message_id FROM session_handoff_root WHERE session_id = ${input.sessionID} AND state IN ('active', 'terminal') AND enrolled_request_id IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
        )
        if (!enrolled) return yield* new RecoveryError({ code: "not_enrolled" })
        // A current-only recovery must not adopt unresolved work held by a
        // different enrolled generation of this same Session.
        if (
          yield* tx.get(
            sql`SELECT 1 FROM session_handoff_recovery_hold WHERE root_session_id = ${input.sessionID} AND reservation != ${enrolled.reservation} LIMIT 1`,
          )
        )
          return yield* new RecoveryError({ code: "stale_context" })
        const terminalRoot = enrolled.state === "terminal"
        if (terminalRoot) {
          const runtime = yield* tx.get<Runtime>(
            sql`SELECT * FROM runtime_execution WHERE session_id = ${input.sessionID}`,
          )
          if (!runtime || !["completed", "cancelled"].includes(runtime.state))
            return yield* new RecoveryError({ code: "stale_context" })
        }
        const snapshot = yield* inspect(connection, input.sessionID, liveness, probe, {
          queueID: enrolled.queue_id,
          userMessageID: enrolled.user_message_id,
        })
        if (snapshot.descendantDigest !== input.expectedDescendantDigest)
          return yield* new RecoveryError({ code: "stale_context" })
        for (const child of snapshot.descendants)
          if (child.proof !== "verified") return yield* new RecoveryError({ code: child.proof })
        const children = snapshot.descendants.filter((child) => child.state !== "terminal")
        if (
          children.length !== input.children.length ||
          new Set(input.children.map((child) => child.link.childSessionID)).size !== children.length
        )
          return yield* new RecoveryError({ code: "stale_context" })
        for (const child of children) {
          const expected = input.children.find((expected) => expected.link.childSessionID === child.childSessionID)
          if (
            !expected ||
            canonical(expected) !==
              canonical({
                link: child.link,
                inputDigest: child.inputDigest,
                ownerLineage: child.ownerLineage,
                ownerInstance: child.ownerInstance,
                fence: child.fence,
                recoveryRevision: child.recoveryRevision,
              })
          )
            return yield* new RecoveryError({ code: "stale_context" })
        }
        const ids = [input.sessionID, ...children.map((child) => child.childSessionID)]
        for (const id of ids) {
          const state = yield* liveness(id)
          if (state !== "dead")
            return yield* new RecoveryError({ code: state === "live" ? "owner_live" : "owner_unknown" })
        }
        for (const resource of [
          ...snapshot.interruptedResources,
          ...snapshot.descendants.flatMap((child) => child.interruptedResources),
        ]) {
          if (
            resource.resourceKind === "task" &&
            !snapshot.descendants.some(
              (child) =>
                child.link?.parentAssistantMessageID === resource.assistantMessageID &&
                child.link.parentCallID === resource.callID,
            )
          )
            return yield* new RecoveryError({ code: "ambiguous_lineage" })
          if (resource.resourceKind !== "task" && resource.liveness !== "dead")
            return yield* new RecoveryError({ code: "unresolved_resource" })
        }
        const records: Runtime[] = []
        const statuses: ChildRecoveryStatus[] = []
        for (const id of ids.filter((id) => !terminalRoot || id !== input.sessionID)) {
          const previous = yield* tx.get<Runtime>(sql`SELECT * FROM runtime_execution WHERE session_id = ${id}`)
          if (!previous) return yield* new RecoveryError({ code: "stale_fence" })
          const row = yield* tx.get<Runtime>(sql`UPDATE runtime_execution SET
        owner_lineage = ${input.owner.lineage}, owner_instance = ${input.owner.instance},
        owner_host = ${input.owner.process?.host ?? null}, owner_machine_id = ${input.owner.process?.machineID ?? null},
        owner_boot_id = ${input.owner.process?.bootID ?? null}, owner_pid_namespace = ${input.owner.process?.pidNamespace ?? null},
        owner_pid = ${input.owner.process?.pid ?? null}, owner_start_time = ${input.owner.process?.startTime ?? null},
        fence = fence + 1, state = 'active', desired_active = 1, retry_at = NULL, time_updated = ${Date.now()}
        WHERE session_id = ${id} AND fence = ${previous.fence} AND owner_instance = ${previous.owner_instance} RETURNING *`)
          if (!row) return yield* new RecoveryError({ code: "stale_fence" })
          records.push(row)
          const child = children.find((child) => child.childSessionID === id)
          if (child?.link && child.inputDigest) {
            yield* tx.run(sql`INSERT INTO session_handoff_recovery_child (session_id, recovery_revision, link, input_digest, prior_fence, recovery_fence)
          VALUES (${id}, ${(child.recoveryRevision ?? 0) + 1}, ${canonical(child.link)}, ${child.inputDigest}, ${previous.fence}, ${row.fence})
          ON CONFLICT (session_id) DO UPDATE SET recovery_revision = excluded.recovery_revision, link = excluded.link,
            input_digest = excluded.input_digest, prior_fence = excluded.prior_fence, recovery_fence = excluded.recovery_fence`)
            statuses.push({
              link: child.link,
              priorFence: previous.fence,
              recoveryFence: row.fence,
              state: "claimed",
              resultAssistantMessageID: child.resultAssistantMessageID,
              resultState: child.resultState,
              interruptedResources: child.interruptedResources,
            })
          }
        }
        // Reconcile locally interrupted Task calls once. Never replace this evidence with a later child success.
        for (const resource of [
          ...snapshot.interruptedResources,
          ...children.flatMap((child) => child.interruptedResources),
        ]) {
          const part = yield* tx.get<Part>(sql`SELECT * FROM part WHERE id = ${resource.partID}`)
          if (!part) continue
          const value = object(json(part.data))
          const state = object(value.state)
          if (state.status !== "running" && state.status !== "pending") continue
          yield* tx.run(
            sql`UPDATE part SET data = ${JSON.stringify({ ...value, state: { status: "error", input: state.input ?? {}, error: resource.resourceKind === "task" ? "Interrupted Task execution; child result is reported separately" : "Interrupted tool execution; effects remain uncertain", metadata: { ...object(state.metadata), interrupted: true, handoffRecovery: true }, time: { ...object(state.time), end: Date.now() } } })}, time_updated = ${Date.now()} WHERE id = ${part.id}`,
          )
        }
        const root = yield* rootTransition(connection)
        return {
          root,
          children: statuses,
          records: records.map((row) => ({
            sessionID: row.session_id,
            directory: row.directory,
            ownerLineage: row.owner_lineage,
            ownerInstance: row.owner_instance,
            fence: row.fence,
            state: "active" as const,
            parentSessionID: row.parent_session_id ?? undefined,
            parentMessageID: row.parent_message_id ?? undefined,
            parentCallID: row.parent_call_id ?? undefined,
            parentMode:
              row.parent_mode === "background"
                ? ("background" as const)
                : row.parent_mode === "foreground"
                  ? ("foreground" as const)
                  : undefined,
            recoveryAttempts: row.recovery_attempts,
            recoveryPreparationAttempts: row.recovery_preparation_attempts,
            handoffReservation: enrolled.reservation,
            handoffRootSessionID: input.sessionID,
          })),
        }
      }),
    { behavior: "immediate" },
  )
})

/** Terminal evidence authorizes no continuation and never advances a runtime fence. */
export const reconcileTerminal = Effect.fn("SessionHandoffRecovery.reconcileTerminal")(function* <A, E>(
  database: Connection,
  input: SessionHandoffStore.ActionKey & { expectedDescendantDigest: string },
  liveness: (sessionID: string) => Effect.Effect<Liveness>,
  recordExpiredReceipt: (database: Connection) => Effect.Effect<A, E>,
  probe?: ResourceProbe,
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const root = yield* tx.get<{
          reservation: string
          state: string
        }>(sql`SELECT reservation, state FROM session_handoff_root
      WHERE session_id = ${input.sessionID} AND queue_id = ${input.queueID} AND user_message_id = ${input.userMessageID} AND enrolled_request_id IS NOT NULL`)
        if (!root) return yield* new RecoveryError({ code: "not_enrolled" })
        const runtime = yield* tx.get<Runtime>(
          sql`SELECT * FROM runtime_execution WHERE session_id = ${input.sessionID}`,
        )
        if (root.state !== "terminal" || !runtime || !["completed", "cancelled"].includes(runtime.state))
          return yield* new RecoveryError({ code: "stale_context" })
        const snapshot = yield* inspect(connection, input.sessionID, liveness, probe, input)
        if (snapshot.descendantDigest !== input.expectedDescendantDigest)
          return yield* new RecoveryError({ code: "stale_context" })
        const owner = yield* liveness(input.sessionID)
        if (owner !== "dead")
          return yield* new RecoveryError({ code: owner === "live" ? "owner_live" : "owner_unknown" })
        for (const child of snapshot.descendants) {
          if (child.proof !== "verified") return yield* new RecoveryError({ code: child.proof })
          if (child.state !== "terminal") return yield* new RecoveryError({ code: "unresolved_resource" })
        }
        for (const resource of [
          ...snapshot.interruptedResources,
          ...snapshot.descendants.flatMap((child) => child.interruptedResources),
        ]) {
          if (
            resource.resourceKind === "task" &&
            !snapshot.descendants.some(
              (child) =>
                child.link?.parentAssistantMessageID === resource.assistantMessageID &&
                child.link.parentCallID === resource.callID,
            )
          )
            return yield* new RecoveryError({ code: "ambiguous_lineage" })
          if (resource.resourceKind !== "task" && resource.liveness !== "dead")
            return yield* new RecoveryError({ code: "unresolved_resource" })
          const part = yield* tx.get<Part>(sql`SELECT * FROM part WHERE id = ${resource.partID}`)
          if (!part) continue
          const value = object(json(part.data))
          const state = object(value.state)
          if (state.status !== "running" && state.status !== "pending") continue
          yield* tx.run(
            sql`UPDATE part SET data = ${JSON.stringify({ ...value, state: { status: "error", input: state.input ?? {}, error: "Interrupted execution; terminal child result is reported separately", metadata: { ...object(state.metadata), interrupted: true, handoffRecovery: true }, time: { ...object(state.time), end: Date.now() } } })}, time_updated = ${Date.now()} WHERE id = ${part.id}`,
          )
        }
        const receipt = yield* recordExpiredReceipt(connection)
        // Terminal reconciliation cannot adopt a block from an earlier recovery.
        // Only the exact claimed batch's completion transaction may release startup protection.
        return receipt
      }),
    { behavior: "immediate" },
  )
})
