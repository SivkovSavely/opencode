export * as SessionHandoffEnrollment from "./handoff-enrollment"

import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SessionHandoffStore } from "./handoff-store"
import { SessionHandoffNotification } from "./handoff-notification"
import { SessionHandoffControl } from "./handoff-control"
import { SessionHandoffRecovery } from "./handoff-recovery"

const ID = Schema.NonEmptyString
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Owner = Schema.Struct({ ownerLineage: ID, ownerInstance: ID, fence: Sequence })
const Request = Schema.Struct({
  requestID: ID,
  queueID: ID,
  userMessageID: ID,
  ...Owner.fields,
  historyDigest: ID,
})
const User = Schema.Struct({
  role: Schema.Literal("user"),
  agent: ID,
  model: Schema.Struct({ providerID: ID, modelID: ID, variant: Schema.optional(ID) }),
})
const Assistant = Schema.Struct({
  role: Schema.Literal("assistant"),
  parentID: ID,
  providerID: ID,
  modelID: ID,
  variant: Schema.optional(ID),
  summary: Schema.optional(Schema.Boolean),
  finish: Schema.optional(Schema.String),
  structured: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.Json),
  time: Schema.Struct({ completed: Schema.optional(Schema.Number) }),
})
const Tool = Schema.Struct({
  type: Schema.Literal("tool"),
  metadata: Schema.optional(Schema.Struct({ providerExecuted: Schema.optional(Schema.Boolean) })),
  state: Schema.Struct({ status: Schema.Literals(["pending", "running", "completed", "error"]) }),
})
type Owner = typeof Owner.Type
type Root = {
  reservation: string
  state: string
  queue_id: string | null
  user_message_id: string | null
  source: string | null
  enrolled_request_id: string | null
}
type Message = { id: string; data: string; time_created: number }
type Queue = {
  id: string
  delivery: string
  state: string
  message_id: string | null
  payload: string
  submission: string
}
type Runtime = {
  owner_lineage: string
  owner_instance: string
  fence: number
  state: string
  desired_active: number
  directory: string
}

export class EnrollmentError extends Schema.TaggedErrorClass<EnrollmentError>()("SessionHandoffEnrollmentError", {
  code: Schema.Literals([
    "not_enrolled",
    "wrong_directory",
    "wrong_queue",
    "wrong_user",
    "stale_fence",
    "stale_context",
    "terminal_action",
    "invalidated",
    "ambiguous_history",
    "pending_conflict",
  ]),
}) {}

/** Admission authority is local to the claimed root runner and one freshly created Task, never a hold exemption. */
export const newTaskAllowed = Effect.fn("SessionHandoffEnrollment.newTaskAllowed")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  caller?: { ownerLineage: string; ownerInstance: string },
) {
  const root = yield* SessionHandoffRecovery.CurrentRootAdmission
  const task = yield* SessionHandoffRecovery.CurrentNewTask
  if (!root || !task || task.sessionID !== sessionID || task.parentFence !== root.fence || sessionID === root.sessionID)
    return false
  if (caller && (caller.ownerLineage !== root.ownerLineage || caller.ownerInstance !== root.ownerInstance)) return false
  const proof = yield* database.db.get<Root>(sql`
    SELECT r.* FROM session_handoff_root r
    JOIN runtime_execution x ON x.session_id=r.session_id
    JOIN session_handoff_control c ON c.session_id=r.session_id AND c.reservation=r.reservation
    WHERE r.session_id=${root.sessionID} AND r.reservation=${root.reservation} AND r.state='active'
      AND r.enrolled_request_id IS NOT NULL AND c.state='active' AND c.data=${root.controlData}
      AND json_extract(c.data,'$.recoveryRevision')>0
      AND x.state='active' AND x.desired_active=1 AND x.owner_lineage=${root.ownerLineage}
      AND x.owner_instance=${root.ownerInstance} AND x.fence=${root.fence}
      AND r.rowid=(SELECT MAX(rowid) FROM session_handoff_root WHERE session_id=r.session_id AND state!='aborted')
      AND NOT EXISTS (SELECT 1 FROM session_handoff_recovery_hold WHERE session_id=${sessionID})
      AND NOT EXISTS (SELECT 1 FROM session_handoff_recovery_hold WHERE root_session_id=r.session_id AND reservation!=r.reservation)
  `)
  if (!proof?.source || !proof.queue_id || !proof.user_message_id) return false
  const source = yield* sourceSnapshot(database, root.sessionID, proof.queue_id, proof.user_message_id)
  const stored = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ input: Schema.Record(Schema.String, Schema.Json) })),
  )(proof.source)
  if (!source || stored._tag === "None") return false
  const user = Schema.decodeUnknownOption(Schema.Struct({ id: ID, data: Schema.String, time_created: Schema.Number }))(
    stored.value.input.user,
  )
  if (
    user._tag === "None" ||
    canonical({ ...source, user: { ...source.user, data: SessionHandoffNotification.inputData(source.user.data) } }) !==
      canonical({
        ...stored.value.input,
        user: { ...user.value, data: SessionHandoffNotification.inputData(user.value.data) },
      })
  )
    return false
  return !!(yield* database.db.get(sql`
    SELECT 1 FROM session child JOIN session parent ON parent.id=child.parent_id
    JOIN message m ON m.session_id=parent.id AND m.id=${task.parentMessageID}
    JOIN part p ON p.message_id=m.id AND p.session_id=parent.id
    JOIN session_handoff_assistant a ON a.message_id=m.id AND a.session_id=parent.id
    JOIN session_handoff_boundary b ON b.session_id=a.session_id AND b.queue_id=a.queue_id
      AND b.user_message_id=a.user_message_id AND b.sequence=json_extract(a.data,'$.epochSequence')
    WHERE child.id=${sessionID} AND parent.id=${root.sessionID}
      AND child.directory=parent.directory AND child.project_id=parent.project_id AND child.workspace_id IS parent.workspace_id
      AND json_extract(child.metadata,'$.task.parentSessionId')=parent.id
      AND json_extract(child.metadata,'$.task.parentMessageID')=m.id
      AND json_extract(child.metadata,'$.task.parentCallID')=${task.parentCallID}
      AND json_extract(m.data,'$.role')='assistant' AND json_extract(p.data,'$.type')='tool'
      AND json_extract(p.data,'$.tool')='task' AND json_extract(p.data,'$.callID')=${task.parentCallID}
      AND json_extract(p.data,'$.state.status')='running'
      AND json_extract(p.data,'$.state.metadata.sessionId')=child.id
      AND COALESCE(json_extract(p.data,'$.state.metadata.background'),0)=0
      AND json_extract(p.data,'$.state.metadata.messageID')=json_extract(child.metadata,'$.task.messageID')
      AND json_extract(p.data,'$.state.input.subagent_type')=child.agent
      AND json_extract(a.data,'$.selectionEvidence')='normalized_dispatch'
      AND json_extract(a.data,'$.controlRequestID')=b.request_id AND json_extract(b.data,'$.kind')='recovery'
      AND b.queue_id=${proof.queue_id} AND b.user_message_id=${proof.user_message_id}
      AND b.sequence=(SELECT MAX(sequence) FROM session_handoff_boundary WHERE session_id=b.session_id AND queue_id=b.queue_id AND user_message_id=b.user_message_id)
      AND NOT EXISTS (SELECT 1 FROM session_handoff_recovery_child WHERE session_id=child.id)
      AND NOT EXISTS (SELECT 1 FROM message WHERE session_id=child.id AND json_extract(data,'$.role')='user' AND id!=json_extract(child.metadata,'$.task.messageID'))
      AND NOT EXISTS (SELECT 1 FROM runtime_execution WHERE session_id=child.id AND
        (owner_lineage!=${root.ownerLineage} OR owner_instance!=${root.ownerInstance} OR fence!=0 OR desired_active!=1))
  `))
})

export const admissionHeld = Effect.fn("SessionHandoffEnrollment.admissionHeld")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
) {
  return (yield* SessionHandoffRecovery.held(database, sessionID)) && !(yield* newTaskAllowed(database, sessionID))
})

/** Every unfinished preparation remains a blocker, even across a later queue delivery. */
export const reserve = Effect.fn("SessionHandoffEnrollment.reserve")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  reservation: string,
) {
  yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        if (yield* admissionHeld({ db: tx }, sessionID)) return yield* new EnrollmentError({ code: "invalidated" })
        const prior = yield* tx.get(
          sql`SELECT 1 FROM session_handoff_root WHERE session_id = ${sessionID} AND reservation = ${reservation}`,
        )
        if (prior) return
        yield* tx.run(
          sql`INSERT INTO session_handoff_root (session_id, reservation, state) VALUES (${sessionID}, ${reservation}, 'reserved')`,
        )
      }),
    { behavior: "immediate" },
  )
})

export const close = Effect.fn("SessionHandoffEnrollment.close")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  state: "terminal" | "invalidated" | "competing",
) {
  yield* database.db.run(sql`UPDATE session_handoff_root SET state = ${state}
    WHERE session_id = ${sessionID} AND state = 'active'`)
})

/** Enter the side-effecting phase. Only pristine rejection may preserve the prior root. */
export const preparing = Effect.fn("SessionHandoffEnrollment.preparing")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  reservation: string,
) {
  yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        if (yield* admissionHeld({ db: tx }, sessionID)) return yield* new EnrollmentError({ code: "invalidated" })
        const root = yield* tx.get<Root>(
          sql`SELECT * FROM session_handoff_root WHERE session_id = ${sessionID} AND reservation = ${reservation}`,
        )
        if (root?.state !== "reserved") return yield* new EnrollmentError({ code: "ambiguous_history" })
        yield* close({ db: tx }, sessionID, "competing")
        yield* tx.run(
          sql`UPDATE session_handoff_root SET source = 'preparing' WHERE session_id = ${sessionID} AND reservation = ${reservation}`,
        )
      }),
    { behavior: "immediate" },
  )
})

export const abort = Effect.fn("SessionHandoffEnrollment.abort")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  reservation: string,
) {
  yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const root = yield* tx.get<Root>(
          sql`SELECT * FROM session_handoff_root WHERE session_id = ${sessionID} AND reservation = ${reservation}`,
        )
        if (root?.state !== "reserved") return
        if (root.source !== null) yield* close({ db: tx }, sessionID, "competing")
        yield* tx.run(
          sql`UPDATE session_handoff_root SET state = 'aborted' WHERE session_id = ${sessionID} AND reservation = ${reservation} AND state = 'reserved'`,
        )
      }),
    { behavior: "immediate" },
  )
})

/** Non-queue admission ends the blocker in the same transaction as its user/selection writes. */
export const committed = Effect.fn("SessionHandoffEnrollment.committed")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  reservation: string,
) {
  yield* preparing(database, sessionID, reservation)
  yield* database.db.run(
    sql`UPDATE session_handoff_root SET state = 'competing' WHERE session_id = ${sessionID} AND reservation = ${reservation} AND state = 'reserved'`,
  )
})

/** Called inside the same writer transaction that persists the user, parts, and queue delivery. */
export const delivered = Effect.fn("SessionHandoffEnrollment.delivered")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  reservation: string,
  queueID: string,
  userMessageID: string,
) {
  const root = yield* database.db.get<Root>(
    sql`SELECT * FROM session_handoff_root WHERE session_id = ${sessionID} AND reservation = ${reservation}`,
  )
  if (root?.reservation !== reservation || root.state !== "reserved") return
  yield* preparing(database, sessionID, reservation)
  const source = yield* sourceSnapshot(database, sessionID, queueID, userMessageID)
  if (!source) return
  const previousMessageIDs = (yield* database.db.all<{ id: string }>(
    sql`SELECT id FROM message WHERE session_id = ${sessionID} AND id != ${userMessageID} ORDER BY id`,
  )).map((message) => message.id)
  const previousSteers = (yield* database.db.all<{ id: string }>(
    sql`SELECT id FROM session_queue WHERE session_id = ${sessionID} AND delivery = 'steer' AND state = 'delivered' ORDER BY id`,
  )).map((entry) => entry.id)
  yield* database.db.run(sql`UPDATE session_handoff_root SET state = 'active', queue_id = ${queueID},
    user_message_id = ${userMessageID}, source = ${canonical({ input: source, previousMessageIDs, previousSteers })}
    WHERE session_id = ${sessionID} AND reservation = ${reservation} AND state = 'reserved'`)
})

/** Read-only discovery, including on an old database with no instrumented reservation. */
export const candidate = Effect.fn("SessionHandoffEnrollment.candidate")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  directory: string,
  owner: Owner,
) {
  return yield* database.db.transaction((tx) =>
    inspect({ db: tx }, sessionID, directory, owner).pipe(
      Effect.map((snapshot) => snapshot.candidate),
      Effect.catchTag("SessionHandoffEnrollmentError", () => Effect.succeed(null)),
    ),
  )
})

export const enroll = Effect.fn("SessionHandoffEnrollment.enroll")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  directory: string,
  owner: Owner,
  input: typeof Request.Type,
) {
  const request = yield* Schema.decodeUnknownEffect(Request)(input, { onExcessProperty: "error" })
  const identity = {
    sessionID,
    directory,
    queueID: request.queueID,
    userMessageID: request.userMessageID,
    requestID: request.requestID,
    kind: "enrollment" as const,
    payload: request,
  }
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const retry = yield* SessionHandoffStore.retryRequest(connection, identity)
        if (retry) return retry
        const snapshot = yield* inspect(connection, sessionID, directory, owner)
        if (snapshot.candidate.queueID !== request.queueID) return yield* new EnrollmentError({ code: "wrong_queue" })
        if (snapshot.candidate.userMessageID !== request.userMessageID)
          return yield* new EnrollmentError({ code: "wrong_user" })
        if (
          request.ownerLineage !== owner.ownerLineage ||
          request.ownerInstance !== owner.ownerInstance ||
          request.fence !== owner.fence
        )
          return yield* new EnrollmentError({ code: "stale_fence" })
        if (snapshot.candidate.historyDigest !== request.historyDigest)
          return yield* new EnrollmentError({ code: "stale_context" })
        const createdAt = Date.now()
        const key = { sessionID, queueID: request.queueID, userMessageID: request.userMessageID }
        yield* SessionHandoffStore.persistAction(connection, {
          ...key,
          directory,
          baselineSelection: snapshot.selection,
          createdAt,
        })
        yield* Effect.forEach(snapshot.assistants, (assistant) =>
          SessionHandoffStore.appendAssistant(connection, key, {
            kind: "ordinary",
            messageID: assistant.id,
            parentUserMessageID: assistant.parentID,
            authorizationUserMessageID: request.userMessageID,
            epochSequence: 0,
            controlRequestID: null,
            selection: snapshot.selection,
            selectionEvidence: "persisted_message",
            dispatch: "unknown",
          }),
        )
        yield* Effect.forEach(snapshot.summaries, (summary) =>
          SessionHandoffStore.appendAssistant(connection, key, summary),
        )
        const receipt = yield* SessionHandoffStore.recordRequest(connection, identity, {
          kind: "enrollment",
          requestID: request.requestID,
          ...key,
          directory,
          state: "enrolled",
          identity: {
            queueID: request.queueID,
            userMessageID: request.userMessageID,
            ...owner,
            revision: 0,
            contextDigest: request.historyDigest,
          },
          createdAt,
        })
        yield* tx.run(
          sql`UPDATE session_handoff_root SET enrolled_request_id = ${request.requestID} WHERE session_id = ${sessionID} AND reservation = ${snapshot.reservation}`,
        )
        yield* SessionHandoffControl.initialize(
          connection,
          key,
          snapshot.reservation,
          directory,
          {
            queueID: request.queueID,
            userMessageID: request.userMessageID,
            ...owner,
            revision: 0,
            contextDigest: request.historyDigest,
          },
          snapshot.selection,
        )
        return receipt
      }),
    { behavior: "immediate" },
  )
})

const sourceSnapshot = Effect.fnUntraced(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  queueID: string,
  userMessageID: string,
) {
  const session = yield* database.db.get<{
    directory: string
    permission: string | null
    parent_id: string | null
    workspace_id: string | null
  }>(sql`SELECT directory, permission, parent_id, workspace_id FROM session WHERE id = ${sessionID}`)
  const runtime = yield* database.db.get<Runtime>(sql`SELECT * FROM runtime_execution WHERE session_id = ${sessionID}`)
  const queue = yield* database.db.get<Queue>(
    sql`SELECT id, delivery, state, message_id, payload, submission FROM session_queue WHERE session_id = ${sessionID} AND id = ${queueID}`,
  )
  const user = yield* database.db.get<Message>(
    sql`SELECT id, data, time_created FROM message WHERE session_id = ${sessionID} AND id = ${userMessageID}`,
  )
  const parts = yield* database.db.all<{ id: string; data: string }>(
    sql`SELECT id, data FROM part WHERE session_id = ${sessionID} AND message_id = ${userMessageID} ORDER BY id`,
  )
  if (
    !session ||
    session.parent_id ||
    !runtime ||
    !queue ||
    !user ||
    queue.delivery !== "queue" ||
    queue.state !== "delivered" ||
    queue.message_id !== userMessageID
  )
    return
  const submission = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ delivery: Schema.Literal("queue"), payload: Schema.Json })),
  )(queue.submission)
  const payload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(queue.payload)
  if (
    submission._tag === "None" ||
    payload._tag === "None" ||
    !Schema.is(Schema.Struct({ kind: Schema.Literal("prompt") }))(payload.value) ||
    canonical(submission.value.payload) !== canonical(payload.value)
  )
    return
  return {
    session,
    user,
    parts,
    queue,
    owner: { ownerLineage: runtime.owner_lineage, ownerInstance: runtime.owner_instance, fence: runtime.fence },
  }
})

const inspect = Effect.fnUntraced(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  directory: string,
  owner: Owner,
) {
  const pending = yield* database.db.get(
    sql`SELECT 1 FROM session_handoff_root WHERE session_id = ${sessionID} AND state = 'reserved' LIMIT 1`,
  )
  if (pending) return yield* new EnrollmentError({ code: "ambiguous_history" })
  const root = yield* database.db.get<Root>(
    sql`SELECT * FROM session_handoff_root WHERE session_id = ${sessionID} AND state != 'aborted' ORDER BY rowid DESC LIMIT 1`,
  )
  if (!root) return yield* new EnrollmentError({ code: "not_enrolled" })
  if (root.state === "reserved" || root.state === "competing")
    return yield* new EnrollmentError({ code: "ambiguous_history" })
  if (root.state === "invalidated") return yield* new EnrollmentError({ code: "invalidated" })
  if (root.state !== "active") return yield* new EnrollmentError({ code: "terminal_action" })
  if (!root.queue_id || !root.user_message_id || !root.source)
    return yield* new EnrollmentError({ code: "ambiguous_history" })
  if (root.enrolled_request_id) return yield* new EnrollmentError({ code: "pending_conflict" })
  const source = yield* sourceSnapshot(database, sessionID, root.queue_id, root.user_message_id)
  if (!source) return yield* new EnrollmentError({ code: "ambiguous_history" })
  if (source.session.directory !== directory) return yield* new EnrollmentError({ code: "wrong_directory" })
  const runtime = yield* database.db.get<Runtime>(sql`SELECT * FROM runtime_execution WHERE session_id = ${sessionID}`)
  if (
    !runtime ||
    runtime.directory !== directory ||
    !["active", "waiting_child", "retry_wait"].includes(runtime.state) ||
    runtime.desired_active !== 1 ||
    canonical(source.owner) !== canonical(owner)
  )
    return yield* new EnrollmentError({ code: "stale_fence" })
  const stored = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({ input: Schema.Json, previousMessageIDs: Schema.Array(ID), previousSteers: Schema.Array(ID) }),
    ),
  )(root.source)
  if (stored._tag === "None") return yield* new EnrollmentError({ code: "ambiguous_history" })
  const storedInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(stored.value.input)
  if (storedInput._tag === "None") return yield* new EnrollmentError({ code: "ambiguous_history" })
  const storedUser = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(storedInput.value.user)
  if (storedUser._tag === "None" || typeof storedUser.value.data !== "string")
    return yield* new EnrollmentError({ code: "ambiguous_history" })
  if (
    canonical({ ...source, user: { ...source.user, data: SessionHandoffNotification.inputData(source.user.data) } }) !==
    canonical({
      ...storedInput.value,
      user: { ...storedUser.value, data: SessionHandoffNotification.inputData(storedUser.value.data) },
    })
  )
    return yield* new EnrollmentError({ code: "stale_context" })
  const user = Schema.decodeUnknownOption(Schema.fromJsonString(User))(source.user.data)
  if (user._tag === "None") return yield* new EnrollmentError({ code: "ambiguous_history" })
  const selection = { ...user.value.model, variant: user.value.model.variant ?? "default" }
  const messages = yield* database.db.all<Message>(
    sql`SELECT id, data, time_created FROM message WHERE session_id = ${sessionID} ORDER BY time_created, id`,
  )
  const parts = yield* database.db.all<{ id: string; message_id: string; data: string }>(
    sql`SELECT id, message_id, data FROM part WHERE session_id = ${sessionID} ORDER BY message_id, id`,
  )
  const queues = yield* database.db.all<Queue>(
    sql`SELECT id, delivery, state, message_id, payload, submission FROM session_queue WHERE session_id = ${sessionID} ORDER BY id`,
  )
  const queueState = yield* database.db.get<{ blocked: number; paused: number; revision: number }>(
    sql`SELECT blocked, paused, revision FROM session_queue_state WHERE session_id = ${sessionID}`,
  )
  const notifications = (yield* SessionHandoffNotification.records(database, sessionID)).filter(
    (row) => row.reservation === root.reservation && row.classification === "in_action",
  )
  const notificationIDs = new Set(notifications.map((row) => row.message_id))
  const compactions = yield* database.db.all<{
    message_id: string
    parent_user_message_id: string
    kind: string
    data: string
  }>(
    sql`SELECT message_id,parent_user_message_id,kind,data FROM session_handoff_compaction WHERE session_id = ${sessionID} AND reservation = ${root.reservation} ORDER BY rowid`,
  )
  const internalIDs = new Set(compactions.filter((row) => row.kind !== "summary").map((row) => row.message_id))
  const summaries = yield* Effect.forEach(
    compactions.filter((row) => row.kind === "summary"),
    (row) =>
      Effect.gen(function* () {
        const record = Schema.decodeUnknownOption(Schema.fromJsonString(SessionHandoffControl.Summary))(row.data)
        const message = messages.find((message) => message.id === row.message_id)
        const info = message && Schema.decodeUnknownOption(Schema.fromJsonString(Assistant))(message.data)
        if (
          record._tag === "None" ||
          !info ||
          info._tag === "None" ||
          !info.value.summary ||
          info.value.parentID !== row.parent_user_message_id ||
          record.value.epochSequence !== 0 ||
          info.value.error !== undefined ||
          (record.value.dispatchSelection !== null &&
            canonical({
              ...record.value.dispatchSelection,
              variant: record.value.dispatchSelection.variant ?? "default",
            }) !==
              canonical({
                providerID: info.value.providerID,
                modelID: info.value.modelID,
                variant: info.value.variant ?? "default",
              }))
        )
          return yield* new EnrollmentError({ code: "ambiguous_history" })
        return record.value
      }),
  )
  const summaryIDs = new Set(summaries.map((summary) => summary.messageID))
  for (const row of compactions.filter((row) => row.kind !== "summary")) {
    const message = messages.find((message) => message.id === row.message_id)
    const proof = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ messageData: Schema.String })))(
      row.data,
    )
    if (
      !message ||
      proof._tag === "None" ||
      SessionHandoffNotification.inputData(proof.value.messageData) !==
        SessionHandoffNotification.inputData(message.data)
    )
      return yield* new EnrollmentError({ code: "ambiguous_history" })
  }
  if (queueState?.blocked) return yield* new EnrollmentError({ code: "terminal_action" })
  if (
    queues.some(
      (entry) =>
        entry.delivery === "steer" &&
        entry.message_id !== root.user_message_id &&
        !notificationIDs.has(entry.message_id ?? "") &&
        (["pending", "claimed"].includes(entry.state) ||
          (entry.state === "delivered" && !stored.value.previousSteers.includes(entry.id))),
    )
  )
    return yield* new EnrollmentError({ code: "ambiguous_history" })
  const previous = new Set(stored.value.previousMessageIDs)
  const assistants = yield* Effect.forEach(
    messages.filter(
      (message) =>
        message.id !== root.user_message_id &&
        !previous.has(message.id) &&
        !notificationIDs.has(message.id) &&
        !internalIDs.has(message.id) &&
        !summaryIDs.has(message.id),
    ),
    (message) =>
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Assistant))(message.data)
        if (
          decoded._tag === "None" ||
          decoded.value.summary ||
          (decoded.value.parentID !== root.user_message_id &&
            !notificationIDs.has(decoded.value.parentID) &&
            !internalIDs.has(decoded.value.parentID)) ||
          canonical({
            providerID: decoded.value.providerID,
            modelID: decoded.value.modelID,
            variant: decoded.value.variant ?? "default",
          }) !== canonical(selection)
        )
          return yield* new EnrollmentError({ code: "ambiguous_history" })
        const followed = notifications.some((row) => row.after_message_id === message.id)
        if ((decoded.value.structured !== undefined && !followed) || decoded.value.error !== undefined)
          return yield* new EnrollmentError({ code: "terminal_action" })
        const tools = yield* Effect.forEach(
          parts.filter((part) => part.message_id === message.id),
          (part) =>
            Effect.gen(function* () {
              if (
                Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("tool") })))(
                  part.data,
                )._tag === "None"
              )
                return undefined
              const tool = Schema.decodeUnknownOption(Schema.fromJsonString(Tool))(part.data)
              // Error text alone cannot prove that a permission stop permits another provider turn.
              // This also excludes cleanup-marked interrupted orphans from executable local work.
              if (tool._tag === "None" || tool.value.state.status === "error")
                return yield* new EnrollmentError({ code: "ambiguous_history" })
              return tool.value
            }),
        )
        const local = tools.some((tool) => tool !== undefined && !tool.metadata?.providerExecuted)
        if (decoded.value.finish && !["tool-calls", "unknown"].includes(decoded.value.finish) && !local && !followed)
          return yield* new EnrollmentError({ code: "terminal_action" })
        if (decoded.value.finish === "tool-calls" && !local)
          return yield* new EnrollmentError({ code: "ambiguous_history" })
        return { ...message, parentID: decoded.value.parentID }
      }),
  )
  const historyDigest = `sha256:v1:${createHash("sha256").update(canonical({ sessionID, directory, root, source, messages, parts, queues, queueState, selection, notifications, compactions })).digest("hex")}`
  return {
    reservation: root.reservation,
    selection,
    assistants,
    summaries,
    candidate: { queueID: root.queue_id, userMessageID: root.user_message_id, ...owner, historyDigest },
  }
})

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  })
}
