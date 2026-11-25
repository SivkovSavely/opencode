export * as SessionHandoffRecovery from "./handoff-recovery"

import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Context, Effect, Option, Schema } from "effect"
import { SessionHandoffStore } from "./handoff-store"
import { SessionHandoffNotification } from "./handoff-notification"
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
  commandSHA256?: string
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
export type InspectionMetrics = {
  candidatePartVisits: number
  lineageMessageVisits: number
  messageDecodeVisits: number
  partDecodeVisits: number
}
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
type Message = { id: string; session_id: string; data: string; time_created: number; position: number }
type Part = { id: string; message_id: string; session_id: string; data: string; time_created: number }
type Generation = { session_id: string; reservation: string; state: string; user_message_id: string | null }
type Lineage = {
  sessions: Pick<Session, "id" | "parent_id" | "metadata">[]
  runtimes: Pick<Runtime, "session_id" | "parent_session_id" | "parent_message_id">[]
  messages: Pick<Message, "id" | "session_id" | "data">[]
  parts: Pick<Part, "message_id" | "session_id" | "data">[]
}
type Graph = {
  sessions: Session[]
  runtimes: Runtime[]
  messages: Message[]
  parts: Part[]
  queues: (Record<string, unknown> & { session_id: string })[]
  queueStates: (Record<string, unknown> & { session_id: string })[]
}
type IndexedMessage = { row: Message; value: Record<string, unknown> }
type IndexedPart = {
  row: Part
  value: Record<string, unknown>
  state: Record<string, unknown>
  metadata: Record<string, unknown>
  input: Record<string, unknown>
}
type InspectionIndex = {
  messages: Map<string, IndexedMessage>
  dataMessages: Map<string, IndexedMessage>
  messagesBySession: Map<string, IndexedMessage[]>
  dataMessagesBySession: Map<string, IndexedMessage[]>
  latestUserMessageBySession: Map<string, IndexedMessage>
  assistantsByParent: Map<string, IndexedMessage[]>
  parts: Map<string, IndexedPart>
  partsBySession: Map<string, IndexedPart[]>
  dataPartsBySession: Map<string, IndexedPart[]>
  dataPartsByMessage: Map<string, IndexedPart[]>
  partsByMessage: Map<string, IndexedPart[]>
  taskPartsByChild: Map<string, IndexedPart[]>
  taskPartsByChildInput: Map<string, IndexedPart[]>
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

const graphScope = Effect.fnUntraced(function* (database: Connection, roots: readonly string[]) {
  // Scope the large tables by parent before extracting any Task JSON. Session
  // metadata has no parent index; extract those edges once, not at each step.
  // Keep SQLite's text extraction of arrays/objects, as in the full graph:
  // duplicate keys can turn an ambiguous SQL edge into a string in JSON.parse.
  const ids = yield* database.db.all<{ id: string }>(sql`
    WITH RECURSIVE metadata_edges(parent, child) AS MATERIALIZED (
      SELECT json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.task.parentSessionId'), id
      FROM session WHERE metadata IS NOT NULL AND typeof(id) = 'text'
    ), potential(id) AS (
      SELECT value FROM json_each(${JSON.stringify(roots)})
      UNION SELECT s.id FROM potential a CROSS JOIN session s ON s.parent_id = a.id WHERE typeof(s.id) = 'text'
      UNION SELECT e.session_id FROM potential a CROSS JOIN runtime_execution e ON e.parent_session_id = a.id
        WHERE typeof(e.session_id) = 'text'
      UNION SELECT m.child FROM potential a CROSS JOIN metadata_edges m ON m.parent = a.id
      UNION SELECT CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.state.metadata.sessionId') END
        FROM potential a CROSS JOIN part p ON p.session_id = a.id
        WHERE CASE WHEN json_valid(p.data) THEN
          json_extract(p.data, '$.type') = 'tool' AND json_extract(p.data, '$.tool') = 'task'
          AND typeof(json_extract(p.data, '$.state.metadata.sessionId')) = 'text' END
    ) SELECT id FROM potential`)
  return sql`(SELECT value FROM json_each(${JSON.stringify(ids.map((row) => row.id))}))`
})

const graph = Effect.fnUntraced(function* (database: Connection, roots: readonly string[]) {
  const scope = yield* graphScope(database, roots)
  const sessions = yield* database.db.all<Session>(
    sql`SELECT id, parent_id, directory, project_id, workspace_id, metadata, permission, agent, model FROM session WHERE id IN ${scope} ORDER BY id`,
  )
  const runtimes = yield* database.db.all<Runtime>(
    sql`SELECT * FROM runtime_execution WHERE session_id IN ${scope} ORDER BY session_id`,
  )
  const messages = yield* database.db.all<Message>(
    sql`SELECT id, session_id, data, time_created, rowid AS position FROM message WHERE session_id IN ${scope} ORDER BY time_created, id`,
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
  return { sessions, runtimes, messages, parts, queues, queueStates } satisfies Graph
})

function indexGraph(data: Graph, full: Graph, ids: readonly string[], metrics?: InspectionMetrics): InspectionIndex {
  const messages = new Map<string, IndexedMessage>()
  const messagesBySession = new Map<string, IndexedMessage[]>()
  for (const row of full.messages) {
    if (metrics) metrics.messageDecodeVisits++
    const item = { row, value: object(json(row.data)) }
    messages.set(canonical([row.session_id, row.id]), item)
    const list = messagesBySession.get(row.session_id)
    if (list) list.push(item)
    else messagesBySession.set(row.session_id, [item])
  }
  const dataMessagesBySession = new Map<string, IndexedMessage[]>()
  const dataMessages = new Map<string, IndexedMessage>()
  for (const row of data.messages) {
    const item = messages.get(canonical([row.session_id, row.id]))
    if (!item) continue
    dataMessages.set(indexKey(row.session_id, row.id), item)
    const list = dataMessagesBySession.get(row.session_id)
    if (list) list.push(item)
    else dataMessagesBySession.set(row.session_id, [item])
  }
  const latestUserMessageBySession = new Map<string, IndexedMessage>()
  for (const [sessionID, list] of dataMessagesBySession) {
    const latest = list.reduce<IndexedMessage | undefined>(
      (value, message) =>
        message.value.role === "user" && (!value || message.row.position > value.row.position) ? message : value,
      undefined,
    )
    if (latest) latestUserMessageBySession.set(sessionID, latest)
  }
  const assistantsByParent = new Map<string, IndexedMessage[]>()
  for (const item of messages.values()) {
    if (item.value.role !== "assistant" || item.value.summary === true || typeof item.value.parentID !== "string")
      continue
    const key = canonical([item.row.session_id, item.value.parentID])
    const list = assistantsByParent.get(key)
    if (list) list.push(item)
    else assistantsByParent.set(key, [item])
  }
  const idSet = new Set(ids)
  const parts = new Map<string, IndexedPart>()
  const partsBySession = new Map<string, IndexedPart[]>()
  const partsByMessage = new Map<string, IndexedPart[]>()
  const taskPartsByChild = new Map<string, IndexedPart[]>()
  const taskPartsByChildInput = new Map<string, IndexedPart[]>()
  for (const row of full.parts) {
    if (metrics) metrics.partDecodeVisits++
    const value = object(json(row.data))
    const state = object(value.state)
    const metadata = object(state.metadata)
    const item = { row, value, state, metadata, input: object(state.input) }
    parts.set(row.id, item)
    const sessionParts = partsBySession.get(row.session_id)
    if (sessionParts) sessionParts.push(item)
    else partsBySession.set(row.session_id, [item])
    const messageKey = canonical([row.session_id, row.message_id])
    const messageParts = partsByMessage.get(messageKey)
    if (messageParts) messageParts.push(item)
    else partsByMessage.set(messageKey, [item])
    if (value.type !== "tool" || value.tool !== "task" || typeof metadata.sessionId !== "string")
      continue
    if (typeof metadata.messageID === "string") {
      const key = canonical([metadata.sessionId, metadata.messageID])
      const invocationParts = taskPartsByChildInput.get(key)
      if (invocationParts) invocationParts.push(item)
      else taskPartsByChildInput.set(key, [item])
    }
    if (idSet.has(row.session_id)) {
      const childParts = taskPartsByChild.get(metadata.sessionId)
      if (childParts) childParts.push(item)
      else taskPartsByChild.set(metadata.sessionId, [item])
    }
  }
  const dataPartsBySession = new Map<string, IndexedPart[]>()
  const dataPartsByMessage = new Map<string, IndexedPart[]>()
  for (const row of data.parts) {
    const item = parts.get(row.id)
    if (!item) continue
    const list = dataPartsBySession.get(row.session_id)
    if (list) list.push(item)
    else dataPartsBySession.set(row.session_id, [item])
    const messageKey = canonical([row.session_id, row.message_id])
    const messageParts = dataPartsByMessage.get(messageKey)
    if (messageParts) messageParts.push(item)
    else dataPartsByMessage.set(messageKey, [item])
  }
  return {
    messages,
    dataMessages,
    messagesBySession,
    dataMessagesBySession,
    latestUserMessageBySession,
    assistantsByParent,
    parts,
    partsBySession,
    dataPartsBySession,
    dataPartsByMessage,
    partsByMessage,
    taskPartsByChild,
    taskPartsByChildInput,
  }
}

function indexKey(sessionID: string, id: string) {
  return canonical([sessionID, id])
}

// Potential links intentionally include incomplete and contradictory evidence.
function closure(data: Lineage, root: string, excluded = new Set<string>()) {
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

function generation<T extends Lineage>(data: T, root: Generation, roots: readonly Generation[]) {
  if (!root.user_message_id) return { data, ids: closure(data, root.session_id) }
  const otherUsers = new Set(
    roots
      .filter((item) => item.session_id === root.session_id && item.user_message_id !== root.user_message_id)
      .map((item) => item.user_message_id)
      .filter((id) => id !== null),
  )
  if (otherUsers.size === 0) return { data, ids: closure(data, root.session_id) }
  const otherMessages = new Set(
    data.messages
      .filter((message) => {
        if (message.session_id !== root.session_id) return false
        const value = object(json(message.data))
        return value.role === "assistant" && typeof value.parentID === "string" && otherUsers.has(value.parentID)
      })
      .map((message) => message.id),
  )
  if (otherMessages.size === 0) return { data, ids: closure(data, root.session_id) }
  // Exclude another generation only when every retained direct link agrees on
  // its original parent assistant. Index those links once instead of decoding
  // the root transcript for each candidate. Unknown links still count.
  const directParents = new Map<string, Set<unknown>>()
  const add = (child: string, parent: unknown) => {
    const parents = directParents.get(child)
    if (parents) parents.add(parent)
    else directParents.set(child, new Set([parent]))
  }
  for (const row of data.runtimes)
    if (row.parent_session_id === root.session_id) add(row.session_id, row.parent_message_id)
  for (const part of data.parts) {
    if (part.session_id !== root.session_id) continue
    // Even non-Task parts can contradict the original parent assistant.
    const child = object(object(object(json(part.data)).state).metadata).sessionId
    if (typeof child === "string") add(child, part.message_id)
  }
  const excluded = new Set(
    data.sessions
      .filter((session) => {
        const task = object(object(json(session.metadata)).task)
        if (session.parent_id === root.session_id || task.parentSessionId === root.session_id)
          add(session.id, task.parentMessageID)
        const parents = directParents.get(session.id)
        const parent = parents?.values().next().value
        return parents?.size === 1 && typeof parent === "string" && otherMessages.has(parent)
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
  const diagnostics = process.env.OPENCODE_STARTUP_RECOVERY_DIAGNOSTICS === "1"
  const started = diagnostics ? performance.now() : 0
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
        if (diagnostics)
          yield* Effect.logInfo("recovery hold graph loaded", {
            elapsedMs: performance.now() - started,
            generations: roots.length,
            sessions: data.sessions.length,
            executions: data.runtimes.length,
            messages: data.messages.length,
            parts: data.parts.length,
          })
        const protectedIDs = new Set<string>()
        const scanStarted = diagnostics ? performance.now() : 0
        let ownerChecks = 0
        let holdAttempts = 0
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
          const ownerIDs = closure(data, root.session_id)
          ownerChecks += ownerIDs.length
          const owners = yield* Effect.forEach(ownerIDs, (id) =>
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
          holdAttempts += ids.length
          for (const id of ids)
            yield* tx.run(sql`
       INSERT OR IGNORE INTO session_handoff_recovery_hold (root_session_id, reservation, session_id)
       VALUES (${root.session_id}, ${root.reservation}, ${id})`)
        }
        if (diagnostics)
          yield* Effect.logInfo("recovery hold generation scan complete", {
            elapsedMs: performance.now() - scanStarted,
            protectedSessions: protectedIDs.size,
            ownerChecks,
            holdAttempts,
          })
        return [...protectedIDs].sort()
      }),
    { behavior: "immediate" },
  )
})

export const held = Effect.fn("SessionHandoffRecovery.held")(function* (database: Connection, sessionID: string) {
  // Use one read snapshot, including when the caller already owns an admission transaction.
  return yield* database.db
    .transaction((tx) =>
      Effect.gen(function* () {
        if (yield* tx.get(sql`SELECT 1 FROM session_handoff_recovery_hold WHERE session_id = ${sessionID} LIMIT 1`))
          return true
        const roots = yield* tx.all<{ root_session_id: string; reservation: string }>(
          sql`SELECT DISTINCT root_session_id, reservation FROM session_handoff_recovery_hold`,
        )
        if (roots.length === 0) return false
        // Discover new descendants on every call. Generation checks need only
        // lineage fields, not the transcripts or queue state used by inspect().
        const rootIDs = sql`(SELECT DISTINCT root_session_id FROM session_handoff_recovery_hold)`
        const scope = yield* graphScope(
          { db: tx },
          roots.map((root) => root.root_session_id),
        )
        const sessions = yield* tx.all<Lineage["sessions"][number]>(
          sql`SELECT id, parent_id, metadata FROM session WHERE id IN ${scope}`,
        )
        const runtimes = yield* tx.all<Lineage["runtimes"][number]>(
          sql`SELECT session_id, parent_session_id, parent_message_id FROM runtime_execution WHERE session_id IN ${scope}`,
        )
        // This is a prefilter, not a JSON interpretation. Even non-Task parts
        // can contradict generation proof, and escaped or duplicate keys must
        // still use the same decoder as full inspection. Escaped letters are
        // in the \u0040 to \u007f range, unlike ANSI escapes such as \u001b.
        const parts = yield* tx.all<Lineage["parts"][number]>(sql`
        SELECT message_id, session_id, data FROM part WHERE session_id IN ${scope}
        AND (instr(data, '"sessionId"') > 0 OR data GLOB ${String.raw`*\u00[4-7]*`})`)
        const generations = yield* tx.all<Generation>(sql`
        SELECT session_id, reservation, state, user_message_id FROM session_handoff_root
        WHERE session_id IN ${rootIDs} AND enrolled_request_id IS NOT NULL`)
        const needsMessages = generations.some(
          (item) =>
            item.user_message_id &&
            generations.some(
              (other) =>
                other.session_id === item.session_id &&
                other.user_message_id !== null &&
                other.user_message_id !== item.user_message_id,
            ),
        )
        const parentMessages = needsMessages
          ? new Set([
              ...sessions.flatMap((session) => {
                const id = object(object(json(session.metadata)).task).parentMessageID
                return typeof id === "string" ? [id] : []
              }),
              ...runtimes.flatMap((row) => (row.parent_message_id === null ? [] : [row.parent_message_id])),
              ...parts.map((part) => part.message_id),
            ])
          : new Set<string>()
        const messages =
          parentMessages.size > 0
            ? yield* tx.all<Lineage["messages"][number]>(sql`
            SELECT id, session_id, data FROM message
            WHERE id IN (SELECT value FROM json_each(${JSON.stringify([...parentMessages])}))
            AND session_id IN ${rootIDs}`)
            : []
        return roots.some((root) =>
          generation(
            { sessions, runtimes, messages, parts },
            generations.find(
              (item) => item.session_id === root.root_session_id && item.reservation === root.reservation,
            ) ?? {
              session_id: root.root_session_id,
              reservation: root.reservation,
              state: "invalidated",
              user_message_id: null,
            },
            generations,
          ).ids.includes(sessionID),
        )
      }),
    )
    .pipe(
      Effect.catchTag(
        "SqlError",
        (cause) => new EffectDrizzleQueryError({ query: "Recovery hold read transaction", params: [], cause }),
      ),
    )
})

function resources(parts: readonly IndexedPart[], probe?: ResourceProbe): InterruptedResource[] {
  return parts.flatMap((part) => {
      const tool = part.value
      const state = part.state
      const metadata = part.metadata
      const input = part.input
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
          assistantMessageID: part.row.message_id,
          partID: part.row.id,
          callID: typeof tool.callID === "string" ? tool.callID : part.row.id,
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
          ...(typeof input.command === "string"
            ? { commandSHA256: createHash("sha256").update(input.command).digest("hex") }
            : {}),
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
  metrics?: InspectionMetrics,
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
  const members = yield* database.db.all<{
    message_id: string
    session_id: string
    queue_id: string
    user_message_id: string
    data: string
  }>(
    sql`SELECT * FROM session_handoff_assistant WHERE session_id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) ORDER BY position`,
  )
  const notifications = yield* database.db.all<{
    session_id: string
    reservation: string
    classification: string
    user_message_id: string
    message_id: string
    data: string
  }>(sql`SELECT * FROM session_handoff_notification WHERE session_id=${rootSessionID} ORDER BY rowid`)
  const compactions = yield* database.db.all<{
    session_id: string
    reservation: string
    queue_id: string
    user_message_id: string
    kind: string
    message_id: string
    data: string
  }>(sql`SELECT * FROM session_handoff_compaction WHERE session_id=${rootSessionID} ORDER BY rowid`)
  const history =
    key && ids.length > 1
      ? yield* SessionHandoffStore.lookup(database, { ...key, sessionID: rootSessionID }).pipe(
          Effect.mapError(() => new RecoveryError({ code: "history_unavailable" })),
        )
      : undefined
  const index = indexGraph(data, full, ids, metrics)
  const currentBoundary = key ? index.messages.get(indexKey(rootSessionID, key.userMessageID)) : undefined
  const historyAssistantByMessage = new Map(history?.assistants.map((record) => [record.messageID, record]))
  const memberByMessage = new Map(members.map((row) => [row.message_id, row]))
  const notificationsByMessage = new Map<string, typeof notifications>()
  for (const row of notifications) {
    const list = notificationsByMessage.get(row.message_id)
    if (list) list.push(row)
    else notificationsByMessage.set(row.message_id, [row])
  }
  const compactionsByMessage = new Map<string, typeof compactions>()
  const compactionInputs = new Map(compactions.map((row) => [row.message_id, object(json(row.data)).messageData]))
  for (const row of compactions) {
    const list = compactionsByMessage.get(row.message_id)
    if (list) list.push(row)
    else compactionsByMessage.set(row.message_id, [row])
  }
  const deliveredPromptsByMessage = new Map<string, Graph["queues"]>()
  for (const queue of full.queues) {
    if (
      queue.session_id !== rootSessionID ||
      queue.id === key?.queueID ||
      queue.state !== "delivered" ||
      object(json(typeof queue.payload === "string" ? queue.payload : null)).kind !== "prompt" ||
      typeof queue.message_id !== "string"
    )
      continue
    const list = deliveredPromptsByMessage.get(queue.message_id)
    if (list) list.push(queue)
    else deliveredPromptsByMessage.set(queue.message_id, [queue])
  }
  const callers = new Map<string, "current" | "historical">()
  for (const message of index.messagesBySession.get(rootSessionID) ?? []) {
    if (metrics) metrics.lineageMessageVisits++
    const info = message.value
    if (info.role !== "assistant" || info.summary === true) continue
    if (!key) {
      callers.set(indexKey(rootSessionID, message.row.id), "current")
      continue
    }
    const record = historyAssistantByMessage.get(message.row.id)
    const notificationsForParent =
      typeof info.parentID === "string" ? (notificationsByMessage.get(info.parentID) ?? []) : []
    const authorized =
      info.parentID === key.userMessageID ||
      notificationsForParent.some(
        (row) =>
          row.reservation === action?.reservation &&
          row.classification === "in_action" &&
          row.user_message_id === key.userMessageID &&
          row.message_id === info.parentID,
      ) ||
      (typeof info.parentID === "string" ? (compactionsByMessage.get(info.parentID) ?? []) : []).some((row) => {
        const frozen = compactionInputs.get(row.message_id)
        const actual = index.messages.get(indexKey(rootSessionID, row.message_id))
        return (
          row.reservation === action?.reservation &&
          row.queue_id === key.queueID &&
          row.user_message_id === key.userMessageID &&
          ["request", "continuation"].includes(row.kind) &&
          row.message_id === info.parentID &&
          typeof frozen === "string" &&
          !!actual &&
          SessionHandoffNotification.inputData(frozen) === SessionHandoffNotification.inputData(actual.row.data)
        )
      })
    if (
      record &&
      authorized &&
      record.parentUserMessageID === info.parentID &&
      record.authorizationUserMessageID === key.userMessageID
    ) {
      callers.set(indexKey(rootSessionID, message.row.id), "current")
      continue
    }
    // A separate delivered ordinary input proves history, never current authority.
    // Missing current membership or an authorized synthetic input is not history.
    const parent =
      typeof info.parentID === "string" ? index.messages.get(indexKey(rootSessionID, info.parentID)) : undefined
    const queue = typeof info.parentID === "string" ? (deliveredPromptsByMessage.get(info.parentID) ?? []) : []
    const declared = memberByMessage.get(message.row.id)
    const prior = object(json(declared?.data ?? null))
    if (
      !record &&
      !authorized &&
      parent &&
      parent.value.role === "user" &&
      currentBoundary?.value.role === "user" &&
      parent.row.time_created < currentBoundary.row.time_created &&
      message.row.time_created < currentBoundary.row.time_created &&
      queue.length === 1 &&
      notificationsForParent.length === 0 &&
      (typeof info.parentID !== "string" || (compactionsByMessage.get(info.parentID) ?? []).length === 0) &&
      (!declared ||
        (declared.queue_id === queue[0]?.id &&
          declared.user_message_id === info.parentID &&
          prior.kind === "ordinary" &&
          prior.messageID === message.row.id &&
          prior.parentUserMessageID === info.parentID &&
          prior.authorizationUserMessageID === info.parentID))
    ) {
      callers.set(indexKey(rootSessionID, message.row.id), "historical")
    }
  }
  // Descendant callers inherit only an exact frozen invocation's membership.
  const ambiguousCallers = new Set<string>()
  const callerQueue = (index.messagesBySession.get(rootSessionID) ?? []).filter((message) =>
    callers.has(indexKey(rootSessionID, message.row.id)),
  )
  for (let cursor = 0; cursor < callerQueue.length; cursor++) {
    const message = callerQueue[cursor]
    if (!message) continue
    if (metrics) metrics.lineageMessageVisits++
    const key = indexKey(message.row.session_id, message.row.id)
    const membership = callers.get(key)
    if (!membership) continue
    for (const link of index.partsByMessage.get(key) ?? []) {
      const value = link.value
      const frozen = link.metadata
      if (
        value.type !== "tool" ||
        value.tool !== "task" ||
        typeof frozen.sessionId !== "string" ||
        typeof frozen.messageID !== "string"
      )
        continue
      const childInputID = frozen.messageID
      const input = index.messages.get(indexKey(frozen.sessionId, childInputID))
      if (input?.value.role !== "user") continue
      const links = index.taskPartsByChildInput.get(indexKey(frozen.sessionId, childInputID)) ?? []
      if (
        links.length !== 1 ||
        links[0]?.row.id !== link.row.id ||
        frozen.parentSessionId !== message.row.session_id ||
        frozen.parentMessageID !== message.row.id ||
        frozen.parentCallID !== value.callID
      )
        continue
      for (const childAssistant of index.assistantsByParent.get(indexKey(frozen.sessionId, childInputID)) ?? []) {
        const childKey = indexKey(childAssistant.row.session_id, childAssistant.row.id)
        if (ambiguousCallers.has(childKey)) continue
        const existing = callers.get(childKey)
        if (existing === undefined) {
          callers.set(childKey, membership)
          callerQueue.push(childAssistant)
          continue
        }
        if (existing !== membership) {
          callers.delete(childKey)
          ambiguousCallers.add(childKey)
        }
      }
    }
  }
  const revisions = yield* database.db.all<{ session_id: string; recovery_revision: number }>(
    sql`SELECT session_id, recovery_revision FROM session_handoff_recovery_child`,
  )
  const revisionsBySession = new Map(revisions.map((revision) => [revision.session_id, revision.recovery_revision]))
  const sessionsByID = new Map(data.sessions.map((session) => [session.id, session]))
  const runtimesBySession = new Map(data.runtimes.map((runtime) => [runtime.session_id, runtime]))
  const tasksBySession = new Map(
    data.sessions.map((session) => [session.id, object(object(json(session.metadata)).task)]),
  )
  const queuesBySession = new Map<string, Graph["queues"]>()
  for (const queue of data.queues) {
    const list = queuesBySession.get(queue.session_id)
    if (list) list.push(queue)
    else queuesBySession.set(queue.session_id, [queue])
  }
  const queueStatesBySession = new Map<string, Graph["queueStates"]>()
  for (const state of data.queueStates) {
    const list = queueStatesBySession.get(state.session_id)
    if (list) list.push(state)
    else queueStatesBySession.set(state.session_id, [state])
  }
  const descendants: TaskDescendant[] = []
  for (const id of ids.filter((id) => id !== rootSessionID)) {
    const session = sessionsByID.get(id)
    const runtime = runtimesBySession.get(id)
    const task = tasksBySession.get(id) ?? {}
    const allCandidates = index.taskPartsByChild.get(id) ?? []
    if (metrics) metrics.candidatePartVisits += allCandidates.length
    const current = allCandidates.filter((part) => {
      const tool = part.value
      const metadata = part.metadata
      return (
        runtime?.parent_session_id === part.row.session_id &&
        runtime.parent_message_id === part.row.message_id &&
        runtime.parent_call_id === tool.callID &&
        runtime.parent_mode === (metadata.background === true ? "background" : "foreground")
      )
    })
    const latestInput = index.latestUserMessageBySession.get(id)?.row
    const history = index.dataMessagesBySession.get(id) ?? []
    const historyParts = index.dataPartsBySession.get(id) ?? []
    const historyByID = new Map(history.map((message) => [message.row.id, message]))
    const candidates = allCandidates.filter((candidate) => {
      if (
        candidate.state.status !== "error" ||
        candidate.metadata.interrupted === true ||
        candidate.metadata.handoffRecovery === true
      )
        return true
      const input =
        typeof candidate.metadata.messageID === "string"
          ? historyByID.get(candidate.metadata.messageID)
          : undefined
      return input?.value.role === "user"
    })
    const historyData = history.map((message) => message.row)
    const historyPartData = historyParts.map((part) => part.row)
    const interruptedResources = resources(historyParts, probe)
    const ownerLiveness = runtime ? yield* liveness(id) : "unknown"
    const queues = queuesBySession.get(id) ?? []
    const queueStates = queueStatesBySession.get(id) ?? []
    const resultsByInput = new Map<string, IndexedMessage>()
    for (const message of history) {
      if (message.value.role !== "assistant" || message.value.summary === true || typeof message.value.parentID !== "string")
        continue
      const result = resultsByInput.get(message.value.parentID)
      if (!result || message.row.position > result.row.position) resultsByInput.set(message.value.parentID, message)
    }
    const terminalInputs = new Set(
      history
        .filter((message) => message.value.role === "user")
        .filter((message) => {
          const result = resultsByInput.get(message.row.id)
          const info = result?.value ?? {}
          return !!(
            result &&
            object(info.time).completed !== undefined &&
            (info.error || info.finish === "stop" || info.structured !== undefined) &&
            !queues.some((queue) => ["pending", "claimed", "uncertain"].includes(String(queue.state))) &&
            !queueStates.some((queue) => queue.paused || queue.blocked)
          )
        })
        .map((message) => message.row.id),
    )
    const selected = candidates.filter(
      (part) => part.metadata.messageID === latestInput?.id && callers.get(indexKey(part.row.session_id, part.row.message_id)) === "current",
    )
    const historical = candidates.filter(
      (part) => part.metadata.messageID === latestInput?.id && callers.get(indexKey(part.row.session_id, part.row.message_id)) === "historical",
    )
    const historicalPart =
      historical.length === 1 && current.length === 1 && historical[0] === current[0] ? historical[0] : undefined
    const historicalInput =
      typeof historicalPart?.metadata.messageID === "string"
        ? historyByID.get(historicalPart.metadata.messageID)
        : undefined
    const part =
      selected.length === 1
        ? selected[0]
        : historicalPart ?? (candidates.length === 1 && historical.length === 0 ? candidates[0] : undefined)
    const tool = part?.value ?? {}
    const metadata = part?.metadata ?? {}
    const parent = part && sessionsByID.get(part.row.session_id)
    const mode = metadata.background === true ? "background" : "foreground"
    const inputID = typeof metadata.messageID === "string" ? metadata.messageID : null
    const input = inputID ? index.dataMessages.get(indexKey(id, inputID)) : undefined
    const user = input?.value ?? {}
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
            parentSessionID: part.row.session_id,
            parentAssistantMessageID: part.row.message_id,
            parentCallID: tool.callID,
            childSessionID: id,
            childUserMessageID: inputID,
            mode,
          }
        : null
    const parentMessage = part && index.messages.get(indexKey(part.row.session_id, part.row.message_id))
    const lineageFacts = !!(
      link &&
      session &&
      parent &&
      runtime &&
      current.length === 1 &&
      parentMessage?.value.role === "assistant" &&
      session.parent_id === link.parentSessionID &&
      metadata.parentSessionId === link.parentSessionID &&
      metadata.parentMessageID === link.parentAssistantMessageID &&
      metadata.parentCallID === link.parentCallID &&
      session.directory === parent.directory &&
      runtime.directory === session.directory &&
      session.project_id === parent.project_id &&
      session.workspace_id === parent.workspace_id
    )
    // Frozen Task parts describe invocations; session.metadata.task describes
    // creation only. A reused child has one current runtime, not one input.
    const invocations = candidates.map((candidate) => {
      const value = candidate.value
      const state = candidate.state
      const frozen = candidate.metadata
      const caller = index.messages.get(indexKey(candidate.row.session_id, candidate.row.message_id))
      const parent = sessionsByID.get(candidate.row.session_id)
      const input =
        typeof frozen.messageID === "string" ? historyByID.get(frozen.messageID) : undefined
      const user = input?.value ?? {}
      const model = object(user.model)
      const selected = object(frozen.model)
      const request = candidate.input
      const variant = typeof user.variant === "string" ? user.variant : (model.variant ?? "default")
      return {
        candidate,
        frozen,
        caller,
        input,
        user,
        variant,
        returned: state.status === "completed" || state.status === "error",
        terminalResult: typeof frozen.messageID === "string" && terminalInputs.has(frozen.messageID),
        membership: callers.get(indexKey(candidate.row.session_id, candidate.row.message_id)),
        lineage: !!(
          typeof value.callID === "string" &&
          typeof frozen.messageID === "string" &&
          caller?.value.role === "assistant" &&
          session?.parent_id === candidate.row.session_id &&
          frozen.parentSessionId === candidate.row.session_id &&
          frozen.parentMessageID === candidate.row.message_id &&
          frozen.parentCallID === value.callID &&
          parent &&
          session &&
          session.directory === parent.directory &&
          session.project_id === parent.project_id &&
          session.workspace_id === parent.workspace_id
        ),
        validInput: !!(
          input &&
          user.role === "user" &&
          typeof user.agent === "string" &&
          typeof model.providerID === "string" &&
          typeof model.modelID === "string" &&
          selected.providerID === model.providerID &&
          selected.modelID === model.modelID &&
          (typeof selected.variant !== "string" || selected.variant === variant) &&
          (typeof frozen.variant !== "string" || frozen.variant === variant) &&
          (request.task_id === undefined || request.task_id === id) &&
          request.subagent_type === user.agent &&
          typeof request.prompt === "string" &&
          input &&
          (index.dataPartsByMessage.get(indexKey(id, input.row.id)) ?? [])
            .map((part) => part.value)
            .filter((part) => part.type === "text" && part.synthetic !== true)
            .map((part) => part.text)
            .join("\n") === request.prompt
        ),
      }
    })
    const origin = invocations.filter(
      (invocation) =>
        invocation.frozen.parentSessionId === task.parentSessionId &&
        invocation.frozen.parentMessageID === task.parentMessageID &&
        invocation.frozen.parentCallID === task.parentCallID &&
        invocation.frozen.messageID === task.messageID,
    )
    const originModel = object(origin[0]?.user.model)
    const taskModel = object(task.model)
    const users = history.filter((message) => message.value.role === "user")
    const invocationIDs = new Set(invocations.map((invocation) => invocation.frozen.messageID))
    const invocationLineage =
      invocations.every((invocation) => invocation.lineage && invocation.membership !== undefined) &&
      new Set(
        invocations.map((invocation) =>
          canonical([
            invocation.candidate.row.session_id,
            invocation.candidate.row.message_id,
            invocation.frozen.parentCallID,
          ]),
        ),
      ).size === invocations.length &&
      invocationIDs.size === invocations.length &&
      invocations.every((invocation) => invocation.candidate === part || invocation.returned)
    const validInput = !!(
      input &&
      user.role === "user" &&
      selection &&
      typeof user.agent === "string" &&
      user.agent === session?.agent &&
      invocations.every((invocation) => invocation.validInput) &&
      origin.length === 1 &&
      taskModel.providerID === originModel.providerID &&
      taskModel.modelID === originModel.modelID &&
      (typeof task.variant !== "string" || task.variant === origin[0]?.variant) &&
      users.length === invocations.length &&
      latestInput?.id === inputID &&
      history.every(
        (message) =>
          message.value.role === "user" ||
          (message.value.role === "assistant" && invocationIDs.has(message.value.parentID)),
      ) &&
      historyParts.every((part) =>
        historyByID.has(part.row.message_id) &&
        (part.value.type !== "tool" || historyByID.get(part.row.message_id)?.value.role === "assistant"),
      )
    )
    const latest = history.reduce<IndexedMessage | undefined>(
      (latest, message) =>
        message.value.role === "assistant" &&
        message.value.summary !== true &&
        message.value.parentID === inputID &&
        (!latest || message.row.position > latest.row.position)
          ? message
          : latest,
      undefined,
    )
    const result = latest && object(latest.value.time).completed !== undefined ? latest : undefined
    const resultInfo = result?.value ?? {}
    const allReturned =
      metadata.handoffRecovery !== true &&
      invocations.length > 0 &&
      invocations.every((invocation) => invocation.returned)
    const settledInput = !!(
      result &&
      (resultInfo.error || resultInfo.finish === "stop" || resultInfo.structured !== undefined) &&
      !(queuesBySession.get(id) ?? []).some(
        (queue) => queue.session_id === id && ["pending", "claimed", "uncertain"].includes(String(queue.state)),
      ) &&
      !(queueStatesBySession.get(id) ?? []).some((queue) => queue.paused || queue.blocked)
    )
    const historicalTerminal = !!(
      historicalPart &&
      historicalPart === part &&
      historicalPart === current[0] &&
      historical.length === 1 &&
      selected.length === 0 &&
      current.length === 1 &&
      currentBoundary?.value.role === "user" &&
      historicalInput?.value.role === "user" &&
      historicalInput.row.time_created < currentBoundary.row.time_created &&
      lineageFacts &&
      invocationLineage &&
      validInput &&
      allReturned &&
      settledInput &&
      invocations.length > 0 &&
      invocations.every(
        (invocation) =>
          invocation.returned &&
          invocation.terminalResult &&
          invocation.membership === "historical" &&
          invocation.caller &&
          invocation.caller.row.time_created < currentBoundary.row.time_created &&
          invocation.input?.value.role === "user" &&
          invocation.input.row.time_created < currentBoundary.row.time_created &&
          invocation.frozen.background !== true &&
          invocation.frozen.handoffRecovery !== true,
      ) &&
      allCandidates.every(
        (candidate) =>
          (candidate.state.status === "completed" || candidate.state.status === "error") &&
          candidate.metadata.interrupted !== true &&
          candidate.metadata.handoffRecovery !== true,
      ) &&
      ownerLiveness === "dead" &&
      mode === "foreground" &&
      interruptedResources.length === 0
    )
    const lineage = lineageFacts && (selected.length === 1 || historicalTerminal)
    const observedInvocation = invocations.find((invocation) => invocation.candidate === current[0])
    const runtimeCorroborated =
      current[0] === part ||
      (current.length === 1 && allReturned && settledInput && observedInvocation?.frozen.handoffRecovery !== true)
    const returned =
      lineage &&
      invocationLineage &&
      runtimeCorroborated &&
      validInput &&
      allReturned &&
      settledInput &&
      mode === "foreground" &&
      ownerLiveness === "dead"
    const terminal = runtime?.state === "completed" || runtime?.state === "cancelled" || returned
    descendants.push({
      link,
      childSessionID: id,
      parentSessionID: session?.parent_id ?? runtime?.parent_session_id ?? null,
      proof:
        !lineage || !invocationLineage || !runtimeCorroborated
          ? "ambiguous_lineage"
          : !validInput || (allReturned && !settledInput && ownerLiveness === "dead")
            ? "ambiguous_input"
            : "verified",
      state: terminal ? "terminal" : (yield* held(database, id)) ? "held" : "active",
      // Report the model default only after verifying the original sentinel against Task metadata.
      selection: selection?.variant === "" ? { ...selection, variant: "default" } : selection,
      agent: typeof user.agent === "string" ? user.agent : null,
      inputDigest: digest({
        input: input?.row,
        session,
        history: historyData,
        parts: historyPartData,
        queues: queuesBySession.get(id) ?? [],
        queueState: queueStatesBySession.get(id) ?? [],
      }),
      ownerLineage: runtime?.owner_lineage ?? null,
      ownerInstance: runtime?.owner_instance ?? null,
      fence: runtime?.fence ?? null,
      recoveryRevision: revisions.find((revision) => revision.session_id === id)?.recovery_revision ?? 0,
      ownerLiveness,
      resultAssistantMessageID: result?.row.id ?? null,
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
  const interruptedResources = resources(index.dataPartsBySession.get(rootSessionID) ?? [], probe)
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
      parts: full.parts.filter((part) => ids.includes(part.session_id)),
      members,
      notifications,
      compactions,
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
    requestID?: string
    recoveryRevision?: number
    legacyResourceReconciliations?: readonly SessionHandoffV1.LegacyResourceReconciliation[]
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
        const resources = [
          ...snapshot.interruptedResources.map((resource) => ({ sessionID: input.sessionID, resource })),
          ...snapshot.descendants.flatMap((child) =>
            child.interruptedResources.map((resource) => ({ sessionID: child.childSessionID, resource })),
          ),
        ]
        const unknownShells = resources.filter(
          ({ resource }) =>
            resource.resourceKind === "process" &&
            resource.liveness === "unknown" &&
            ["bash", "shell"].includes(resource.tool),
        )
        const reconciliations = input.legacyResourceReconciliations ?? []
        if (unknownShells.length !== reconciliations.length)
          return yield* new RecoveryError({ code: "unresolved_resource" })
        for (const { sessionID, resource } of unknownShells) {
          const matches = reconciliations.filter(
            (item) =>
              item.sessionID === sessionID &&
              item.assistantMessageID === resource.assistantMessageID &&
              item.partID === resource.partID &&
              (item.resourceRef ?? null) === resource.resourceRef &&
              item.callID === resource.callID &&
              item.tool === resource.tool &&
              item.commandSHA256 === resource.commandSHA256 &&
              item.requestID === input.requestID &&
              item.recoveryRevision === input.recoveryRevision &&
              item.descendantDigest === input.expectedDescendantDigest,
          )
          if (matches.length !== 1) return yield* new RecoveryError({ code: "unresolved_resource" })
        }
        for (const { resource } of resources) {
          if (
            resource.resourceKind === "task" &&
            !snapshot.descendants.some(
              (child) =>
                child.link?.parentAssistantMessageID === resource.assistantMessageID &&
                child.link.parentCallID === resource.callID,
            )
          )
            return yield* new RecoveryError({ code: "ambiguous_lineage" })
          if (
            resource.resourceKind !== "task" &&
            resource.liveness !== "dead" &&
            !unknownShells.some((item) => item.resource.partID === resource.partID)
          )
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
          if (unknownShells.some((item) => item.resource.partID === resource.partID)) continue
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
  input: SessionHandoffStore.ActionKey & {
    expectedDescendantDigest: string
    requestID?: string
    recoveryRevision?: number
    legacyResourceReconciliations?: readonly SessionHandoffV1.LegacyResourceReconciliation[]
  },
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
        const resources = [
          ...snapshot.interruptedResources.map((resource) => ({ sessionID: input.sessionID, resource })),
          ...snapshot.descendants.flatMap((child) =>
            child.interruptedResources.map((resource) => ({ sessionID: child.childSessionID, resource })),
          ),
        ]
        const unknownShells = resources.filter(
          ({ resource }) =>
            resource.resourceKind === "process" &&
            resource.liveness === "unknown" &&
            ["bash", "shell"].includes(resource.tool),
        )
        const reconciliations = input.legacyResourceReconciliations ?? []
        if (unknownShells.length !== reconciliations.length)
          return yield* new RecoveryError({ code: "unresolved_resource" })
        for (const { sessionID, resource } of unknownShells)
          if (
            reconciliations.filter(
              (item) =>
                item.sessionID === sessionID &&
                item.assistantMessageID === resource.assistantMessageID &&
                item.partID === resource.partID &&
                (item.resourceRef ?? null) === resource.resourceRef &&
                item.callID === resource.callID &&
                item.tool === resource.tool &&
                item.commandSHA256 === resource.commandSHA256 &&
                item.requestID === input.requestID &&
                item.recoveryRevision === input.recoveryRevision &&
                item.descendantDigest === input.expectedDescendantDigest,
            ).length !== 1
          )
            return yield* new RecoveryError({ code: "unresolved_resource" })
        for (const child of snapshot.descendants) {
          if (child.proof !== "verified") return yield* new RecoveryError({ code: child.proof })
          if (child.state !== "terminal") return yield* new RecoveryError({ code: "unresolved_resource" })
        }
        for (const { resource } of resources) {
          if (
            resource.resourceKind === "task" &&
            !snapshot.descendants.some(
              (child) =>
                child.link?.parentAssistantMessageID === resource.assistantMessageID &&
                child.link.parentCallID === resource.callID,
            )
          )
            return yield* new RecoveryError({ code: "ambiguous_lineage" })
          if (
            resource.resourceKind !== "task" &&
            resource.liveness !== "dead" &&
            !unknownShells.some((item) => item.resource.partID === resource.partID)
          )
            return yield* new RecoveryError({ code: "unresolved_resource" })
          const part = yield* tx.get<Part>(sql`SELECT * FROM part WHERE id = ${resource.partID}`)
          if (!part) continue
          const value = object(json(part.data))
          const state = object(value.state)
          if (state.status !== "running" && state.status !== "pending") continue
          if (unknownShells.some((item) => item.resource.partID === resource.partID)) continue
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
