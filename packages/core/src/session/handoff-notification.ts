export * as SessionHandoffNotification from "./handoff-notification"

import { Effect, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { SessionHandoffStore } from "./handoff-store"
import { SessionHandoffRecovery } from "./handoff-recovery"

const Owner = Schema.Struct({
  ownerLineage: Schema.NonEmptyString,
  ownerInstance: Schema.NonEmptyString,
  fence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type Owner = typeof Owner.Type
export const Link = Schema.Struct({
  parentSessionID: Schema.NonEmptyString,
  parentMessageID: Schema.NonEmptyString,
  parentCallID: Schema.NonEmptyString,
  childSessionID: Schema.NonEmptyString,
  childUserMessageID: Schema.NonEmptyString,
  childResultMessageID: Schema.NonEmptyString,
  childExecution: Schema.Struct({ id: Schema.NonEmptyString, ...Owner.fields }),
})
export type Link = typeof Link.Type

export class NotificationError extends Schema.TaggedErrorClass<NotificationError>()("SessionHandoffNotificationError", {
  code: Schema.Literals(["ambiguous_lineage", "notification_conflict"]),
}) {}

export const link = Effect.fn("SessionHandoffNotification.link")(function* (
  database: SessionHandoffStore.Connection,
  input: Omit<Link, "childExecution">,
) {
  const row = yield* database.db.get<{ id: string; owner_lineage: string; owner_instance: string; fence: number }>(
    sql`SELECT id, owner_lineage, owner_instance, fence FROM runtime_execution WHERE session_id = ${input.childSessionID}`,
  )
  if (!row) return yield* new NotificationError({ code: "ambiguous_lineage" })
  return {
    ...input,
    childExecution: {
      id: row.id,
      ownerLineage: row.owner_lineage,
      ownerInstance: row.owner_instance,
      fence: row.fence,
    },
  }
})

type Root = {
  reservation: string
  state: string
  queue_id: string
  user_message_id: string
  source: string
  enrolled_request_id: string | null
}
type Record = {
  message_id: string
  session_id: string
  reservation: string | null
  classification: string
  user_message_id: string | null
  after_message_id: string | null
  data: string
}
const Selection = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
})
const Task = Schema.Struct({
  parentSessionId: Schema.String,
  parentMessageID: Schema.String,
  parentCallID: Schema.String,
  messageID: Schema.String,
  model: Selection,
  variant: Schema.optional(Schema.String),
})
const User = Schema.Struct({ role: Schema.Literal("user"), agent: Schema.String, model: Selection })
const Assistant = Schema.Struct({
  role: Schema.Literal("assistant"),
  parentID: Schema.String,
  time: Schema.Struct({ completed: Schema.optional(Schema.Number) }),
})

/** Strict proof belongs to enrolled generations, not every ordinary Task notification. */
export const required = Effect.fn("SessionHandoffNotification.required")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  messageID?: string,
  parentMessageID?: string,
) {
  if (yield* SessionHandoffRecovery.held(database, sessionID)) return true
  return !!(yield* database.db.get(sql`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM session_handoff_root WHERE session_id = ${sessionID} AND state = 'active' AND enrolled_request_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM session_handoff_notification WHERE session_id = ${sessionID} AND message_id = ${messageID ?? null})
    OR EXISTS (SELECT 1 FROM session_handoff_assistant WHERE session_id = ${sessionID} AND message_id = ${parentMessageID ?? null})
    OR EXISTS (SELECT 1 FROM session_handoff_root r JOIN message m ON m.session_id = r.session_id
      WHERE r.session_id = ${sessionID} AND r.enrolled_request_id IS NOT NULL AND m.id = ${parentMessageID ?? null}
        AND (json_extract(m.data, '$.parentID') = r.user_message_id
          OR EXISTS (SELECT 1 FROM session_handoff_notification n WHERE n.session_id = r.session_id AND n.reservation = r.reservation AND n.classification = 'in_action' AND n.message_id = json_extract(m.data, '$.parentID'))
          OR EXISTS (SELECT 1 FROM session_handoff_compaction c WHERE c.session_id = r.session_id AND c.reservation = r.reservation AND c.kind IN ('request','continuation') AND c.message_id = json_extract(m.data, '$.parentID'))))`))
})

/** Revalidate before preparation and again in the message writer transaction. Never infer a call from a child-only ID. */
export const verify = Effect.fn("SessionHandoffNotification.verify")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  messageID: string,
  input: Link,
  activeOwner?: Owner,
) {
  const link = yield* Schema.decodeUnknownEffect(Link)(input, { onExcessProperty: "error" })
  if (link.parentSessionID !== sessionID || messageID !== `msg_task_notification_${link.childSessionID}`)
    return yield* new NotificationError({ code: "ambiguous_lineage" })
  const prior = yield* database.db.get<Record>(
    sql`SELECT * FROM session_handoff_notification WHERE message_id = ${messageID}`,
  )
  if (prior) {
    const evidence = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ link: Link })))(prior.data)
    // Delivery claims advance a fence; retry identity is the exact call, input, result, and execution ID.
    if (
      prior.session_id !== sessionID ||
      canonical(evidence.link) !==
        canonical({ ...link, childExecution: { ...evidence.link.childExecution, id: link.childExecution.id } })
    )
      return yield* new NotificationError({ code: "notification_conflict" })
    return { prior, link: evidence.link, evidence: prior.data }
  }
  const sessions = yield* database.db.all<{
    id: string
    parent_id: string | null
    directory: string
    workspace_id: string | null
    metadata: string | null
    agent: string | null
    permission: string | null
  }>(
    sql`SELECT id, parent_id, directory, workspace_id, metadata, agent, permission FROM session WHERE id IN (${sessionID}, ${link.childSessionID})`,
  )
  const parent = sessions.find((row) => row.id === sessionID)
  const child = sessions.find((row) => row.id === link.childSessionID)
  const runtime = yield* database.db.get<{
    id: string
    parent_session_id: string
    parent_message_id: string
    parent_call_id: string
    parent_mode: string
    parent_notification_state: string
    directory: string
    state: string
    fence: number
    owner_lineage: string
    owner_instance: string
  }>(sql`SELECT * FROM runtime_execution WHERE session_id = ${link.childSessionID}`)
  const messages = yield* database.db.all<{ id: string; session_id: string; data: string }>(
    sql`SELECT id, session_id, data FROM message WHERE session_id IN (${sessionID}, ${link.childSessionID}) ORDER BY rowid`,
  )
  const parts = yield* database.db.all<{ id: string; message_id: string; session_id: string; data: string }>(
    sql`SELECT id, message_id, session_id, data FROM part WHERE session_id IN (${sessionID}, ${link.childSessionID}) ORDER BY id`,
  )
  const task = decode(Schema.Struct({ task: Task }), child?.metadata)?.task
  const childHistory = messages.filter((row) => row.session_id === link.childSessionID)
  const users = childHistory.filter((row) => decode(Schema.Struct({ role: Schema.Literal("user") }), row.data))
  const user = decode(User, users[0]?.data)
  const result = decode(
    Assistant,
    messages.find((row) => row.id === link.childResultMessageID && row.session_id === link.childSessionID)?.data,
  )
  const assistant = decode(
    Assistant,
    messages.find((row) => row.id === link.parentMessageID && row.session_id === sessionID)?.data,
  )
  const latest = messages.findLast((row) => row.session_id === link.childSessionID && decode(Assistant, row.data))
  const recovering =
    runtime?.state === "active" &&
    runtime.parent_notification_state === "delivering" &&
    activeOwner &&
    canonical(activeOwner) ===
      canonical({ ownerLineage: runtime.owner_lineage, ownerInstance: runtime.owner_instance, fence: runtime.fence })
  const calls = parts.flatMap((part) => {
    const value = decode(
      Schema.Struct({
        type: Schema.Literal("tool"),
        tool: Schema.Literal("task"),
        callID: Schema.optional(Schema.Json),
      }),
      part.data,
    )
    const metadata = decode(
      Schema.Struct({ state: Schema.Struct({ metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)) }) }),
      part.data,
    )?.state.metadata
    return value &&
      (value.callID === link.parentCallID || metadata?.sessionId === link.childSessionID) &&
      part.session_id === sessionID
      ? [{ ...part, value, metadata }]
      : []
  })
  const call = calls[0]
  const metadata = Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.Struct({ ...Task.fields, sessionId: Schema.String, background: Schema.optional(Schema.Boolean) }),
    )(call?.metadata),
  )
  if (
    !parent ||
    !child ||
    child.parent_id !== sessionID ||
    child.directory !== parent.directory ||
    child.workspace_id !== parent.workspace_id ||
    !runtime ||
    runtime.directory !== parent.directory ||
    runtime.parent_session_id !== sessionID ||
    runtime.parent_message_id !== link.parentMessageID ||
    runtime.parent_call_id !== link.parentCallID ||
    runtime.parent_mode !== "background" ||
    (!recovering && !["completed", "cancelled", "recovery_needed"].includes(runtime.state)) ||
    canonical(link.childExecution) !==
      canonical({
        id: runtime.id,
        ownerLineage: runtime.owner_lineage,
        ownerInstance: runtime.owner_instance,
        fence: runtime.fence,
      }) ||
    !task ||
    task.parentSessionId !== sessionID ||
    task.parentMessageID !== link.parentMessageID ||
    task.parentCallID !== link.parentCallID ||
    task.messageID !== link.childUserMessageID ||
    users.length !== 1 ||
    users[0]?.id !== link.childUserMessageID ||
    childHistory.some(
      (row) => row.id !== link.childUserMessageID && decode(Assistant, row.data)?.parentID !== link.childUserMessageID,
    ) ||
    !user ||
    (child.agent !== null && child.agent !== user.agent) ||
    canonical({ ...task.model, variant: task.variant ?? "default" }) !==
      canonical({ ...user.model, variant: user.model.variant ?? "default" }) ||
    !result ||
    result.parentID !== link.childUserMessageID ||
    result.time.completed === undefined ||
    latest?.id !== link.childResultMessageID ||
    !assistant ||
    calls.length !== 1 ||
    call?.message_id !== link.parentMessageID ||
    call.value.callID !== link.parentCallID ||
    !metadata ||
    metadata.sessionId !== link.childSessionID ||
    metadata.background !== true ||
    canonical(task) !==
      canonical({
        parentSessionId: metadata.parentSessionId,
        parentMessageID: metadata.parentMessageID,
        parentCallID: metadata.parentCallID,
        messageID: metadata.messageID,
        model: metadata.model,
        variant: metadata.variant,
      })
  )
    return yield* new NotificationError({ code: "ambiguous_lineage" })
  return {
    prior: undefined,
    link,
    evidence: canonical({
      link,
      child,
      runtime,
      taskPart: call,
      messages: messages.filter((row) => row.session_id === link.childSessionID),
      parts: parts.filter((row) => row.session_id === link.childSessionID),
      parentAssistant: messages.find((row) => row.id === link.parentMessageID),
    }),
  }
})

/** Caller owns the same IMMEDIATE transaction as the notification message and queue admission. */
export const admit = Effect.fn("SessionHandoffNotification.admit")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  messageID: string,
  link: Link,
  activeOwner?: Owner,
) {
  const proof = yield* verify(database, sessionID, messageID, link, activeOwner)
  if (proof.prior)
    return {
      classification: proof.prior.classification,
      reservation: proof.prior.reservation,
      userMessageID: proof.prior.user_message_id,
    }
  if (yield* SessionHandoffRecovery.held(database, sessionID))
    return yield* new NotificationError({ code: "ambiguous_lineage" })
  const parent = yield* database.db.get<{ data: string }>(
    sql`SELECT data FROM message WHERE id = ${link.parentMessageID} AND session_id = ${sessionID}`,
  )
  const parentInfo = decode(Assistant, parent?.data)
  const roots = yield* database.db.all<Root>(
    sql`SELECT * FROM session_handoff_root WHERE session_id = ${sessionID} AND source IS NOT NULL AND user_message_id IS NOT NULL ORDER BY rowid`,
  )
  const notifications = yield* records(database, sessionID)
  const compactions = yield* database.db.all<{ reservation: string; message_id: string }>(
    sql`SELECT reservation,message_id FROM session_handoff_compaction WHERE session_id = ${sessionID} AND kind IN ('request','continuation')`,
  )
  const matches = roots.filter((root) => {
    const source = decode(Schema.Struct({ previousMessageIDs: Schema.Array(Schema.String) }), root.source)
    return (
      source &&
      !source.previousMessageIDs.includes(link.parentMessageID) &&
      (parentInfo?.parentID === root.user_message_id ||
        compactions.some((row) => row.reservation === root.reservation && row.message_id === parentInfo?.parentID) ||
        notifications.some(
          (row) =>
            row.reservation === root.reservation &&
            row.classification === "in_action" &&
            row.message_id === parentInfo?.parentID,
        ))
    )
  })
  if (matches.length > 1) return yield* new NotificationError({ code: "ambiguous_lineage" })
  const root = matches[0]
  const blockers = yield* database.db.get(
    sql`SELECT 1 FROM session_handoff_root WHERE session_id = ${sessionID} AND state = 'reserved' LIMIT 1`,
  )
  if (root?.state === "active") {
    if (blockers) return yield* new NotificationError({ code: "ambiguous_lineage" })
    yield* rootContext(database, sessionID, root)
    if (root.enrolled_request_id) {
      const history = yield* SessionHandoffStore.lookup(database, {
        sessionID,
        queueID: root.queue_id,
        userMessageID: root.user_message_id,
      })
      if (
        !history?.assistants.some(
          (record) =>
            record.messageID === link.parentMessageID &&
            record.parentUserMessageID === parentInfo?.parentID &&
            record.authorizationUserMessageID === root.user_message_id,
        )
      )
        return yield* new NotificationError({ code: "ambiguous_lineage" })
    }
  }
  const live = yield* database.db.get<{ state: string; desired_active: number }>(
    sql`SELECT state, desired_active FROM runtime_execution WHERE session_id = ${sessionID}`,
  )
  const classification =
    root?.state === "active" &&
    !blockers &&
    live?.desired_active === 1 &&
    ["active", "waiting_child", "retry_wait"].includes(live.state)
      ? "in_action"
      : "later"
  if (classification === "later")
    yield* database.db.run(
      sql`UPDATE session_handoff_root SET state = 'competing' WHERE session_id = ${sessionID} AND state = 'active'`,
    )
  const after = yield* database.db.get<{ id: string }>(
    sql`SELECT id FROM message WHERE session_id = ${sessionID} AND id != ${messageID} ORDER BY rowid DESC LIMIT 1`,
  )
  yield* database.db.run(
    sql`INSERT INTO session_handoff_notification (message_id, session_id, reservation, classification, user_message_id, after_message_id, data) VALUES (${messageID}, ${sessionID}, ${root?.reservation ?? null}, ${classification}, ${root?.user_message_id ?? null}, ${after?.id ?? null}, ${proof.evidence})`,
  )
  return { classification, reservation: root?.reservation ?? null, userMessageID: root?.user_message_id ?? null }
})

export const records = Effect.fn("SessionHandoffNotification.records")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
) {
  return yield* database.db.all<Record>(
    sql`SELECT * FROM session_handoff_notification WHERE session_id = ${sessionID} ORDER BY rowid`,
  )
})

/** The transcript parent remains the notification. Only authorization fields come from this original user. */
export const context = Effect.fn("SessionHandoffNotification.context")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  messageID: string,
) {
  const root = yield* database.db.get<Root>(sql`SELECT r.* FROM session_handoff_root r
    WHERE r.session_id = ${sessionID} AND r.state = 'active' AND
    (r.user_message_id = ${messageID} OR EXISTS (SELECT 1 FROM session_handoff_notification n WHERE n.session_id = r.session_id AND n.reservation = r.reservation AND n.classification = 'in_action' AND n.message_id = ${messageID})
    OR EXISTS (SELECT 1 FROM session_handoff_compaction c WHERE c.session_id = r.session_id AND c.reservation = r.reservation AND c.kind IN ('request', 'continuation') AND c.message_id = ${messageID}))`)
  if (!root) return
  const compaction = yield* database.db.get<{ data: string; actual: string | null }>(sql`SELECT c.data, m.data AS actual
    FROM session_handoff_compaction c LEFT JOIN message m ON m.id = c.message_id AND m.session_id = c.session_id
    WHERE c.session_id = ${sessionID} AND c.reservation = ${root.reservation} AND c.message_id = ${messageID} AND c.kind IN ('request','continuation')`)
  if (compaction) {
    const proof = decode(Schema.Struct({ messageData: Schema.String }), compaction.data)
    if (!proof || !compaction.actual || inputData(proof.messageData) !== inputData(compaction.actual))
      return yield* new NotificationError({ code: "ambiguous_lineage" })
  }
  const original = yield* rootContext(database, sessionID, root)
  const key = { sessionID, queueID: root.queue_id, userMessageID: root.user_message_id }
  const history = root.enrolled_request_id ? yield* SessionHandoffStore.lookup(database, key) : undefined
  if (root.enrolled_request_id && !history) return yield* new NotificationError({ code: "ambiguous_lineage" })
  const epoch = history?.boundaries.at(-1)
  return {
    ...key,
    selection: epoch?.selection ??
      history?.action.baselineSelection ?? { ...original.model, variant: original.model.variant ?? "default" },
    epochSequence: epoch?.sequence ?? 0,
    controlRequestID: epoch?.requestID ?? null,
    enrolled: root.enrolled_request_id !== null,
  }
})

const rootContext = Effect.fnUntraced(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  root: Root,
) {
  const stored = decode(
    Schema.Struct({
      input: Schema.Struct({ user: Schema.Struct({ data: Schema.String }), session: Schema.Json, owner: Schema.Json }),
    }),
    root.source,
  )
  const user = yield* database.db.get<{ data: string }>(
    sql`SELECT data FROM message WHERE session_id = ${sessionID} AND id = ${root.user_message_id}`,
  )
  const session = yield* database.db.get<{
    directory: string
    permission: string | null
    parent_id: string | null
    workspace_id: string | null
  }>(sql`SELECT directory, permission, parent_id, workspace_id FROM session WHERE id = ${sessionID}`)
  const runtime = yield* database.db.get<{
    owner_lineage: string
    owner_instance: string
    fence: number
    directory: string
    state: string
    desired_active: number
  }>(
    sql`SELECT owner_lineage, owner_instance, fence, directory, state, desired_active FROM runtime_execution WHERE session_id = ${sessionID}`,
  )
  const original = decode(User, user?.data)
  if (
    !stored ||
    !original ||
    inputData(stored.input.user.data) !== inputData(user?.data) ||
    canonical(stored.input.session) !== canonical(session) ||
    !runtime ||
    runtime.directory !== session?.directory ||
    runtime.desired_active !== 1 ||
    !["active", "waiting_child", "retry_wait"].includes(runtime.state) ||
    canonical(stored.input.owner) !==
      canonical({ ownerLineage: runtime.owner_lineage, ownerInstance: runtime.owner_instance, fence: runtime.fence })
  )
    return yield* new NotificationError({ code: "ambiguous_lineage" })
  return original
})

export const boundary = Effect.fn("SessionHandoffNotification.boundary")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
) {
  const root = yield* database.db.get<{ reservation: string }>(
    sql`SELECT reservation FROM session_handoff_root WHERE session_id = ${sessionID} AND state = 'active' ORDER BY rowid DESC LIMIT 1`,
  )
  const rows = yield* records(database, sessionID)
  return { reservation: root?.reservation ?? null, notifications: rows.map((row) => row.message_id) }
})

export const terminalize = Effect.fn("SessionHandoffNotification.terminalize")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  observed: Effect.Success<ReturnType<typeof boundary>>,
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const current = yield* boundary({ db: tx }, sessionID)
        if (canonical(current) !== canonical(observed)) return false
        if (observed.reservation)
          yield* tx.run(
            sql`UPDATE session_handoff_root SET state = 'terminal' WHERE session_id = ${sessionID} AND reservation = ${observed.reservation} AND state = 'active'`,
          )
        return true
      }),
    { behavior: "immediate" },
  )
})

function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  data: string | null | undefined,
): S["Type"] | undefined {
  if (!data) return undefined
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(data)
  return result._tag === "Some" ? result.value : undefined
}

/** SessionSummary may update only these derived diffs without changing the admitted input. */
export function inputData(data: string | undefined) {
  const value = decode(Schema.Record(Schema.String, Schema.Json), data)
  if (!value) return data
  const summary = value.summary
  if (!Schema.is(Schema.Record(Schema.String, Schema.Json))(summary) || !Array.isArray(summary.diffs))
    return canonical(value)
  const retained = Object.fromEntries(Object.entries(summary).filter(([key]) => key !== "diffs"))
  return canonical({ ...value, summary: Object.keys(retained).length ? retained : undefined })
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    !item || typeof item !== "object" || Array.isArray(item)
      ? item
      : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))),
  )
}
