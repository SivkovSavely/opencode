export * as SessionHandoffControl from "./handoff-control"

import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SessionHandoffStore } from "./handoff-store"
import { SessionHandoffNotification } from "./handoff-notification"
import { SessionHandoffRecovery } from "./handoff-recovery"
import { SessionHandoffRecoveryQueue } from "./handoff-recovery-queue"
import { SessionCooperativePause } from "./cooperative-pause"

const ID = Schema.NonEmptyString
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Selection = Schema.Struct({ providerID: ID, modelID: ID, variant: ID })
export type Selection = typeof Selection.Type
export const Owner = Schema.Struct({ ownerLineage: ID, ownerInstance: ID, fence: Sequence })
export type Owner = typeof Owner.Type
export const Identity = Schema.Struct({
  queueID: ID,
  userMessageID: ID,
  ...Owner.fields,
  revision: Sequence,
  contextDigest: ID,
})
export type Identity = typeof Identity.Type
export const Request = Schema.Struct({ requestID: ID, expected: Identity, target: Selection })
export type Request = typeof Request.Type
export const preparedAssistant = Effect.fn("SessionHandoffControl.preparedAssistant")(function* (
  database: SessionHandoffStore.Connection,
  key: SessionHandoffStore.ActionKey,
  messageID: string,
  parentUserMessageID: string,
) {
  const context = yield* SessionHandoffNotification.context(database, key.sessionID, parentUserMessageID)
  if (
    !context?.enrolled ||
    context.queueID !== key.queueID ||
    context.userMessageID !== key.userMessageID ||
    context.epochSequence === 0
  )
    return yield* new ControlError({ code: "ambiguous_history" })
  yield* persistedAssistant(database, key.sessionID, messageID, parentUserMessageID, context.selection, false)
  yield* attempt(database, key, {
    kind: "ordinary",
    messageID,
    parentUserMessageID,
    authorizationUserMessageID: key.userMessageID,
    epochSequence: context.epochSequence,
    controlRequestID: context.controlRequestID,
    selection: context.selection,
    selectionEvidence: "persisted_message",
    dispatch: "none",
  })
  const history = yield* SessionHandoffStore.lookup(database, key)
  const epoch = history?.boundaries.find((item) => item.sequence === context.epochSequence)
  if (!epoch) return yield* new ControlError({ code: "history_unavailable" })
  const first = yield* database.db.get<{
    message_id: string
  }>(sql`SELECT message_id FROM session_handoff_attempt WHERE ${where(key)}
    AND json_extract(data, '$.kind') = 'ordinary' AND json_extract(data, '$.epochSequence') = ${context.epochSequence} ORDER BY position LIMIT 1`)
  if (epoch.firstOrdinaryAssistantMessageID || first?.message_id !== messageID) return
  const request = yield* storedRequest(database, epoch.requestID)
  const prior = yield* SessionHandoffStore.receipt(database, key.sessionID, epoch.requestID)
  if (!prior) return yield* new ControlError({ code: "history_unavailable" })
  const pointer = Schema.decodeUnknownOption(
    Schema.Struct({ boundary: Schema.Struct({ firstOrdinaryAssistantMessageID: Schema.NullOr(ID) }) }),
  )(prior)
  if (pointer._tag === "Some" && pointer.value.boundary.firstOrdinaryAssistantMessageID === messageID) return
  yield* SessionHandoffStore.appendReceipt(database, request, prior, {
    ...prior,
    boundary: { ...epoch, firstOrdinaryAssistantMessageID: messageID },
    updatedAt: Date.now(),
  })
})
const Ordinary = Schema.Struct({
  kind: Schema.Literal("ordinary"),
  messageID: ID,
  parentUserMessageID: ID,
  authorizationUserMessageID: ID,
  epochSequence: Sequence,
  controlRequestID: Schema.NullOr(ID),
  selection: Selection,
  selectionEvidence: Schema.Literals(["persisted_message", "normalized_dispatch"]),
  dispatch: Schema.Literals(["none", "prepared", "started_or_unknown", "completed", "unknown"]),
})
export const Summary = Schema.Struct({
  kind: Schema.Literal("summary"),
  messageID: ID,
  parentUserMessageID: ID,
  epochSequence: Sequence,
  configuredCompactionSelection: Schema.NullOr(
    Schema.Struct({ providerID: ID, modelID: ID, variant: Schema.NullOr(ID) }),
  ),
  dispatchSelection: Schema.NullOr(Schema.Struct({ providerID: ID, modelID: ID, variant: Schema.NullOr(ID) })),
  selectionEvidence: Schema.Literals(["persisted_message", "normalized_dispatch", "unknown"]),
  dispatch: Schema.Literals(["none", "prepared", "started_or_unknown", "completed", "unknown"]),
})
export const compaction = Effect.fn("SessionHandoffControl.compaction")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  parentUserMessageID: string,
  messageID: string,
  kind: "request" | "continuation",
) {
  const context = yield* SessionHandoffNotification.context(database, sessionID, parentUserMessageID)
  if (!context) return
  const root = yield* database.db.get<{ reservation: string }>(
    sql`SELECT reservation FROM session_handoff_root WHERE session_id = ${sessionID} AND queue_id = ${context.queueID} AND user_message_id = ${context.userMessageID} AND state = 'active'`,
  )
  const message = yield* database.db.get<{ data: string }>(
    sql`SELECT data FROM message WHERE session_id = ${sessionID} AND id = ${messageID} AND json_extract(data, '$.role') = 'user'`,
  )
  const marker = yield* database.db
    .get(sql`SELECT 1 FROM part WHERE session_id = ${sessionID} AND message_id = ${messageID} AND
    ((${kind} = 'request' AND json_extract(data, '$.type') = 'compaction' AND json_extract(data, '$.auto') = 1)
    OR (${kind} = 'continuation' AND json_extract(data, '$.type') = 'text' AND json_extract(data, '$.synthetic') = 1 AND json_extract(data, '$.metadata.compaction_continue') = 1))`)
  if (!root || !message || !marker) return yield* new ControlError({ code: "ambiguous_history" })
  yield* database.db
    .run(sql`INSERT INTO session_handoff_compaction (message_id,session_id,reservation,queue_id,user_message_id,parent_user_message_id,kind,epoch_sequence,data)
    VALUES (${messageID},${sessionID},${root.reservation},${context.queueID},${context.userMessageID},${parentUserMessageID},${kind},${context.epochSequence},${canonical({ messageData: message.data })})`)
  yield* SessionHandoffRecoveryQueue.compacted(database, sessionID, messageID)
})

/** Summary provenance is separate from ordinary target epochs and may precede enrollment. */
export const summary = Effect.fn("SessionHandoffControl.summary")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  messageID: string,
  parentUserMessageID: string,
  configuredCompactionSelection: { providerID: string; modelID: string; variant: string | null } | null,
  dispatchSelection: { providerID: string; modelID: string; variant: string | null },
  normalized: boolean,
) {
  const context = yield* SessionHandoffNotification.context(database, sessionID, parentUserMessageID)
  if (!context) return yield* new ControlError({ code: "invalidated" })
  yield* persistedAssistant(
    database,
    sessionID,
    messageID,
    parentUserMessageID,
    { ...dispatchSelection, variant: dispatchSelection.variant ?? "default" },
    true,
  )
  const root = yield* database.db.get<{ reservation: string }>(
    sql`SELECT reservation FROM session_handoff_root WHERE session_id = ${sessionID} AND queue_id = ${context.queueID} AND user_message_id = ${context.userMessageID} AND state = 'active'`,
  )
  if (!root) return yield* new ControlError({ code: "ambiguous_history" })
  const record = {
    kind: "summary" as const,
    messageID,
    parentUserMessageID,
    epochSequence: context.epochSequence,
    configuredCompactionSelection,
    dispatchSelection,
    selectionEvidence: normalized ? ("normalized_dispatch" as const) : ("persisted_message" as const),
    dispatch: normalized ? ("started_or_unknown" as const) : ("unknown" as const),
  }
  if (context.enrolled && normalized) {
    const prepared = yield* database.db.get<{ data: string }>(
      sql`SELECT data FROM session_handoff_attempt WHERE message_id = ${messageID}`,
    )
    const proof = prepared && decode(Summary, prepared.data)
    if (
      !proof ||
      proof.epochSequence !== context.epochSequence ||
      proof.parentUserMessageID !== parentUserMessageID ||
      canonical(proof.dispatchSelection) !== canonical(dispatchSelection)
    )
      return yield* new ControlError({ code: "stale_context" })
  }
  if (context.enrolled && !normalized) {
    yield* attempt(database, context, { ...record, dispatch: "none" })
    return
  }
  const prior = yield* database.db.get<{ data: string }>(
    sql`SELECT data FROM session_handoff_compaction WHERE message_id = ${messageID}`,
  )
  if (prior) {
    if (prior.data !== canonical(record)) return yield* new ControlError({ code: "ambiguous_history" })
    return
  }
  yield* database.db
    .run(sql`INSERT INTO session_handoff_compaction (message_id,session_id,reservation,queue_id,user_message_id,parent_user_message_id,kind,epoch_sequence,data)
    VALUES (${messageID},${sessionID},${root.reservation},${context.queueID},${context.userMessageID},${parentUserMessageID},'summary',${context.epochSequence},${canonical(record)})`)
  if (context.enrolled) yield* SessionHandoffStore.appendAssistant(database, context, record)
})
const State = Schema.Struct({
  directory: ID,
  identity: Identity,
  selection: Selection,
  recoveryRevision: Sequence,
  retiredFrom: Schema.optional(Identity),
})
type Row = {
  session_id: string
  queue_id: string
  user_message_id: string
  reservation: string
  state: string
  pending_request_id: string | null
  data: string
}
type State = typeof State.Type

export class ControlError extends Schema.TaggedErrorClass<ControlError>()("SessionHandoffControlError", {
  code: Schema.Literals([
    "not_enrolled",
    "not_found",
    "history_unavailable",
    "wrong_directory",
    "wrong_queue",
    "wrong_user",
    "stale_context",
    "stale_fence",
    "terminal_action",
    "invalidated",
    "pending_conflict",
    "ambiguous_history",
  ]),
}) {}

/** Called only by enrollment's writer transaction. The initial discovery identity is retained verbatim. */
export const initialize = Effect.fn("SessionHandoffControl.initialize")(function* (
  database: SessionHandoffStore.Connection,
  key: SessionHandoffStore.ActionKey,
  reservation: string,
  directory: string,
  identity: Identity,
  selection: Selection,
) {
  const state = { directory, identity, selection, recoveryRevision: 0 }
  yield* database.db
    .run(sql`INSERT INTO session_handoff_control (session_id,queue_id,user_message_id,reservation,state,data)
    VALUES (${key.sessionID},${key.queueID},${key.userMessageID},${reservation},'active',${canonical(state)})`)
  yield* retain(database, key, state)
})

/** Read-only. Current discovery never falls back to a prior generation. */
export const execution = Effect.fn("SessionHandoffControl.execution")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  directory: string,
  key?: { queueID: string; userMessageID: string },
) {
  return yield* database.db.transaction((tx) =>
    Effect.gen(function* () {
      const row = yield* tx.get<Row>(
        key
          ? sql`SELECT * FROM session_handoff_control WHERE session_id = ${sessionID} AND queue_id = ${key.queueID} AND user_message_id = ${key.userMessageID}`
          : sql`SELECT c.* FROM session_handoff_control c WHERE c.session_id = ${sessionID} AND c.reservation =
            (SELECT reservation FROM session_handoff_root WHERE session_id = ${sessionID} AND state != 'aborted' ORDER BY rowid DESC LIMIT 1)`,
      )
      if (!row) {
        if (key) return yield* new ControlError({ code: "not_found" })
        return undefined
      }
      const state = decode(State, row.data)
      if (state.directory !== directory) return yield* new ControlError({ code: "wrong_directory" })
      const retained = yield* SessionHandoffStore.lookup({ db: tx }, actionKey(row))
      if (!retained) return yield* new ControlError({ code: "history_unavailable" })
      const attempts = (yield* tx.all<{ data: string }>(
        sql`SELECT data FROM session_handoff_attempt WHERE ${where(actionKey(row))} ORDER BY position`,
      )).map((item) => decode(Schema.Union([Ordinary, Summary]), item.data))
      const attempted = new Set(attempts.map((item) => item.messageID))
      const assistants = [
        ...retained.assistants.filter((item) => !attempted.has(item.messageID)),
        ...attempts
          .filter((item) => item.kind === "ordinary")
          .map((item) => retained.assistants.find((proof) => proof.messageID === item.messageID) ?? item),
      ]
      const history = {
        ...retained,
        boundaries: retained.boundaries.map((boundary) => ({
          ...boundary,
          firstOrdinaryAssistantMessageID:
            assistants.find((item) => item.epochSequence === boundary.sequence)?.messageID ?? null,
        })),
        assistants,
        summaries: [
          ...retained.summaries.filter((item) => !attempted.has(item.messageID)),
          ...attempts
            .filter((item) => item.kind === "summary")
            .map((item) => retained.summaries.find((proof) => proof.messageID === item.messageID) ?? item),
        ],
      }
      const latest = yield* tx.get<{ reservation: string }>(
        sql`SELECT reservation FROM session_handoff_root WHERE session_id = ${sessionID} AND state != 'aborted' ORDER BY rowid DESC LIMIT 1`,
      )
      return {
        sessionID,
        directory,
        enrolled: true,
        identity: state.identity,
        state:
          row.state === "active"
            ? (yield* SessionHandoffRecovery.held({ db: tx }, sessionID)) ||
              (yield* SessionCooperativePause.pending({ db: tx }, sessionID))?.state === "paused"
              ? ("held" as const)
              : ("active" as const)
            : row.state === "terminal"
              ? ("terminal" as const)
              : ("invalidated" as const),
        recoveryRevision: state.recoveryRevision,
        effectiveSelection: state.selection,
        baselineSelection: history.action.baselineSelection,
        pendingRequestID: row.pending_request_id,
        history,
        boundaries: history.boundaries,
        assistants: history.assistants,
        summaries: history.summaries,
        viewKind: key ? ("historical" as const) : ("current" as const),
        isCurrent: latest?.reservation === row.reservation,
      }
    }),
  )
})

/** Reconcile retries and authentic retired contexts before consulting configuration. Never admits live work. */
export const reconcileObsolete = Effect.fn("SessionHandoffControl.reconcileObsolete")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  directory: string,
  input: Request,
) {
  const request = yield* Schema.decodeUnknownEffect(Request)(input, { onExcessProperty: "error" })
  const key = { sessionID, queueID: request.expected.queueID, userMessageID: request.expected.userMessageID }
  const identity = requestIdentity(key, directory, request)
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const retry = yield* SessionHandoffStore.retryRequest(connection, identity)
        if (retry) return retry
        const row = yield* read(connection, key)
        const state = decode(State, row.data)
        if (state.directory !== directory) return yield* new ControlError({ code: "wrong_directory" })
        const retained = yield* tx.get<{
          retired_reason: string | null
        }>(sql`SELECT retired_reason FROM session_handoff_context
      WHERE identity = ${canonical({ sessionID, directory, identity: request.expected })} AND session_id = ${sessionID} AND queue_id = ${key.queueID} AND user_message_id = ${key.userMessageID}`)
        if (!retained)
          return yield* new ControlError({
            code: request.expected.fence !== state.identity.fence ? "stale_fence" : "stale_context",
          })
        const retired = retained.retired_reason
        if (retired && ["stale_fence", "terminal_action", "invalidated"].includes(retired))
          return yield* SessionHandoffStore.recordRequest(
            connection,
            identity,
            initialReceipt(identity, request, "expired", retired),
          )
      }),
    { behavior: "immediate" },
  )
})

/** Configured-model/variant/adapter validation belongs to the local admission service before this call. */
export const admit = Effect.fn("SessionHandoffControl.admit")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  directory: string,
  input: Request,
) {
  const request = yield* Schema.decodeUnknownEffect(Request)(input, { onExcessProperty: "error" })
  const key = { sessionID, queueID: request.expected.queueID, userMessageID: request.expected.userMessageID }
  const identity = requestIdentity(key, directory, request)
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const reconciled = yield* reconcileObsolete(connection, sessionID, directory, request)
        if (reconciled) return reconciled
        if (yield* SessionCooperativePause.active(connection, sessionID))
          return yield* new ControlError({ code: "pending_conflict" })
        const row = yield* read(connection, key)
        const state = decode(State, row.data)
        if (row.state !== "active")
          return yield* new ControlError({ code: row.state === "terminal" ? "terminal_action" : "invalidated" })
        if (row.pending_request_id) return yield* new ControlError({ code: "pending_conflict" })
        if (yield* SessionHandoffRecovery.held(connection, sessionID))
          return yield* new ControlError({ code: "invalidated" })
        if (canonical(state.identity) !== canonical(request.expected))
          return yield* new ControlError({ code: "stale_context" })
        yield* guard(connection, row, state)
        const noEffect = canonical(state.selection) === canonical(request.target)
        const receipt = yield* SessionHandoffStore.recordRequest(
          connection,
          identity,
          initialReceipt(identity, request, noEffect ? "no_effect" : "pending", null),
        )
        if (!noEffect) {
          yield* tx.run(
            sql`UPDATE session_handoff_control SET pending_request_id = ${request.requestID} WHERE ${where(key)}`,
          )
          yield* advance(connection, row, state, state.selection)
        }
        return receipt
      }),
    { behavior: "immediate" },
  )
})

/** Caller checks terminal/error FIRST. This commits the marker before model resolution/overflow/compaction. */
export const beforeTurn = Effect.fn("SessionHandoffControl.beforeTurn")(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  directory: string,
  userMessageID: string,
  observed?: Effect.Success<ReturnType<typeof SessionHandoffNotification.boundary>>,
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        if (
          observed &&
          canonical(observed) !== canonical(yield* SessionHandoffNotification.boundary(connection, sessionID))
        )
          return null
        const context = yield* SessionHandoffNotification.context(connection, sessionID, userMessageID)
        if (!context?.enrolled) return context
        const row = yield* read(connection, context)
        const state = decode(State, row.data)
        if (state.directory !== directory) return yield* new ControlError({ code: "wrong_directory" })
        if (row.state !== "active") return undefined
        const assistant = yield* tx.get<{
          id: string
          data: string
        }>(sql`SELECT m.id,m.data FROM message m WHERE m.session_id = ${sessionID}
      AND json_extract(m.data, '$.role') = 'assistant'
      AND (json_extract(m.data, '$.parentID') = ${context.userMessageID}
        OR EXISTS (SELECT 1 FROM session_handoff_notification n WHERE n.session_id = ${sessionID} AND n.reservation = ${row.reservation}
          AND n.classification = 'in_action' AND n.message_id = json_extract(m.data, '$.parentID'))
        OR EXISTS (SELECT 1 FROM session_handoff_compaction c WHERE c.session_id = ${sessionID} AND c.reservation = ${row.reservation}
          AND c.kind IN ('request','continuation') AND c.message_id = json_extract(m.data, '$.parentID')))
      AND COALESCE(json_extract(m.data, '$.summary'), 0) = 0 ORDER BY m.rowid DESC LIMIT 1`)
        if (assistant) {
          const data = decode(
            Schema.Struct({
              parentID: ID,
              finish: Schema.optional(Schema.String),
              error: Schema.optional(Schema.Json),
              structured: Schema.optional(Schema.Json),
            }),
            assistant.data,
          )
          const history = yield* SessionHandoffStore.lookup(connection, context)
          const epoch = history?.boundaries.at(-1)
          const attempted = yield* tx.get<{ data: string }>(
            sql`SELECT data FROM session_handoff_attempt WHERE message_id = ${assistant.id} AND ${where(context)}`,
          )
          const membership =
            history?.assistants.find((item) => item.messageID === assistant.id) ??
            (attempted ? decode(Ordinary, attempted.data) : undefined)
          const authorizedRecovery =
            epoch?.kind === "recovery" && membership !== undefined && membership.epochSequence < epoch.sequence
          const localTool =
            yield* tx.get(sql`SELECT 1 FROM part WHERE session_id = ${sessionID} AND message_id = ${assistant.id}
        AND json_extract(data, '$.type') = 'tool' AND COALESCE(json_extract(data, '$.metadata.providerExecuted'), 0) = 0
        AND (json_extract(data, '$.state.status') IN ('pending', 'running', 'completed')
          OR (json_extract(data, '$.state.status') = 'error'
            AND COALESCE(json_extract(data, '$.state.metadata.interrupted'), 0) = 0
            AND COALESCE(json_extract(data, '$.state.metadata.crashInterrupted'), 0) = 0))
        AND json_extract(data, '$.tool') != 'StructuredOutput' LIMIT 1`)
          if (
            !authorizedRecovery &&
            (data.error ||
              data.structured !== undefined ||
              (data.finish && !["tool-calls", "unknown"].includes(data.finish) && !localTool))
          ) {
            const notification =
              yield* tx.get(sql`SELECT 1 FROM session_handoff_notification WHERE session_id = ${sessionID}
              AND reservation = ${row.reservation} AND classification = 'in_action' AND message_id = ${userMessageID}`)
            if (notification && data.parentID !== userMessageID) {
              yield* guard(connection, row, state)
              if (row.pending_request_id) {
                yield* retirePending(connection, row, "terminal_action")
                yield* tx.run(sql`UPDATE session_handoff_control SET pending_request_id = NULL WHERE ${where(context)}`)
                yield* advance(connection, row, state, state.selection)
              }
              return { ...context, selection: state.selection }
            }
            yield* tx.run(
              sql`UPDATE session_handoff_root SET state = 'terminal' WHERE session_id = ${sessionID} AND reservation = ${row.reservation} AND state = 'active'`,
            )
            return undefined
          }
        }
        yield* guard(connection, row, state)
        if (!row.pending_request_id) return { ...context, selection: state.selection }
        const stored = yield* storedRequest(connection, row.pending_request_id)
        const request = decode(Request, canonical(stored.payload))
        const history = yield* SessionHandoffStore.lookup(connection, context)
        if (!history) return yield* new ControlError({ code: "history_unavailable" })
        const boundary = {
          sequence: history.boundaries.length + 1,
          requestID: request.requestID,
          kind: "model_control" as const,
          priorSelection: state.selection,
          selection: request.target,
          afterAssistantMessageID: history.assistants.at(-1)?.messageID ?? null,
          appliedAt: Date.now(),
        }
        yield* SessionHandoffStore.appendBoundary(connection, context, boundary)
        const prior = yield* SessionHandoffStore.receipt(connection, sessionID, request.requestID)
        if (!prior) return yield* new ControlError({ code: "history_unavailable" })
        yield* SessionHandoffStore.appendReceipt(connection, stored, prior, {
          ...prior,
          state: "applied",
          boundary: { ...boundary, firstOrdinaryAssistantMessageID: null },
          updatedAt: Date.now(),
        })
        yield* tx.run(sql`UPDATE session_handoff_control SET pending_request_id = NULL WHERE ${where(context)}`)
        yield* advance(connection, row, state, request.target)
        return {
          ...context,
          selection: request.target,
          epochSequence: boundary.sequence,
          controlRequestID: boundary.requestID,
        }
      }),
    { behavior: "immediate" },
  )
})

/** Recovery owns runtime/descendant CAS and request persistence in the enclosing IMMEDIATE transaction. */
export const claimRecovery = Effect.fn("SessionHandoffControl.claimRecovery")(function* (
  database: SessionHandoffStore.Connection,
  key: SessionHandoffStore.ActionKey,
  expected: Identity,
  newOwner: Owner,
  target: Selection,
  requestID: string,
) {
  const row = yield* read(database, key)
  const state = decode(State, row.data)
  if (row.state === "terminal" || row.state === "competing")
    return yield* new ControlError({ code: row.state === "terminal" ? "terminal_action" : "invalidated" })
  if (
    canonical(state.identity) !== canonical(expected) &&
    !(row.state === "invalidated" && canonical(state.retiredFrom) === canonical(expected))
  )
    return yield* new ControlError({ code: "stale_context" })
  const runtime = yield* database.db.get<{ owner_lineage: string; owner_instance: string; fence: number }>(
    sql`SELECT owner_lineage,owner_instance,fence FROM runtime_execution WHERE session_id = ${key.sessionID}`,
  )
  if (
    !runtime ||
    runtime.owner_lineage !== newOwner.ownerLineage ||
    runtime.owner_instance !== newOwner.ownerInstance ||
    runtime.fence !== newOwner.fence ||
    newOwner.fence <= expected.fence
  )
    return yield* new ControlError({ code: "stale_fence" })
  const history = yield* SessionHandoffStore.lookup(database, key)
  if (!history) return yield* new ControlError({ code: "history_unavailable" })
  yield* database.db.run(sql`UPDATE session_handoff_root SET state = 'active', source = json_set(source,
    '$.input.owner', json(${canonical(newOwner)})) WHERE session_id = ${key.sessionID} AND reservation = ${row.reservation}`)
  yield* guard(database, row, state)
  yield* retirePending(database, row, "stale_fence")
  yield* database.db.run(sql`UPDATE session_handoff_context SET retired_reason = 'stale_fence' WHERE ${where(key)}`)
  const boundary = {
    sequence: history.boundaries.length + 1,
    requestID,
    kind: "recovery" as const,
    priorSelection: state.selection,
    selection: target,
    afterAssistantMessageID: history.assistants.at(-1)?.messageID ?? null,
    appliedAt: Date.now(),
  }
  yield* SessionHandoffStore.appendBoundary(database, key, boundary)
  const next = yield* advance(
    database,
    row,
    { ...state, recoveryRevision: state.recoveryRevision + 1, identity: { ...state.identity, ...newOwner } },
    target,
  )
  yield* database.db.run(
    sql`UPDATE session_handoff_control SET state = 'active', pending_request_id = NULL WHERE ${where(key)}`,
  )
  return {
    ...boundary,
    firstOrdinaryAssistantMessageID: null,
    identity: next.identity,
    recoveryRevision: next.recoveryRevision,
  }
})

/** This callback is invoked ONLY after the LLM seam validates its final normalized request. */
export const normalizedDispatch = Effect.fn("SessionHandoffControl.normalizedDispatch")(function* (
  database: SessionHandoffStore.Connection,
  key: SessionHandoffStore.ActionKey,
  messageID: string,
  parentUserMessageID: string,
) {
  yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const row = yield* read(connection, key)
        const state = decode(State, row.data)
        yield* guard(connection, row, state)
        const history = yield* SessionHandoffStore.lookup(connection, key)
        const epoch = history?.boundaries.at(-1)
        if (!epoch) return yield* new ControlError({ code: "ambiguous_history" })
        const prepared = yield* tx.get<{ data: string }>(
          sql`SELECT data FROM session_handoff_attempt WHERE message_id = ${messageID} AND ${where(key)}`,
        )
        const proof = prepared && decode(Ordinary, prepared.data)
        if (
          !proof ||
          proof.epochSequence !== epoch.sequence ||
          proof.controlRequestID !== epoch.requestID ||
          proof.parentUserMessageID !== parentUserMessageID
        )
          return yield* new ControlError({ code: "stale_context" })
        yield* persistedAssistant(connection, key.sessionID, messageID, parentUserMessageID, epoch.selection, false)
        yield* SessionHandoffStore.appendAssistant(connection, key, {
          kind: "ordinary",
          messageID,
          parentUserMessageID,
          authorizationUserMessageID: key.userMessageID,
          epochSequence: epoch.sequence,
          controlRequestID: epoch.requestID,
          selection: epoch.selection,
          selectionEvidence: "normalized_dispatch",
          dispatch: "started_or_unknown",
        })
        const request = yield* storedRequest(connection, epoch.requestID)
        const receipt = yield* SessionHandoffStore.receipt(connection, key.sessionID, epoch.requestID)
        if (!receipt) return yield* new ControlError({ code: "history_unavailable" })
        const first = yield* tx.get<{
          message_id: string
        }>(sql`SELECT message_id FROM session_handoff_attempt WHERE ${where(key)}
          AND json_extract(data, '$.kind') = 'ordinary' AND json_extract(data, '$.epochSequence') = ${epoch.sequence} ORDER BY position LIMIT 1`)
        yield* SessionHandoffStore.appendReceipt(connection, request, receipt, {
          ...receipt,
          dispatch: "started_or_unknown",
          boundary: {
            ...epoch,
            firstOrdinaryAssistantMessageID: first?.message_id ?? epoch.firstOrdinaryAssistantMessageID ?? messageID,
          },
          updatedAt: Date.now(),
        })
      }),
    { behavior: "immediate" },
  )
})

export const unsupportedDispatch = Effect.fn("SessionHandoffControl.unsupportedDispatch")(function* (
  database: SessionHandoffStore.Connection,
  key: SessionHandoffStore.ActionKey,
) {
  yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const history = yield* SessionHandoffStore.lookup(connection, key)
        const epoch = history?.boundaries.at(-1)
        if (!epoch) return
        const request = yield* storedRequest(connection, epoch.requestID)
        const prior = yield* SessionHandoffStore.receipt(connection, key.sessionID, epoch.requestID)
        if (!prior) return yield* new ControlError({ code: "history_unavailable" })
        yield* SessionHandoffStore.appendReceipt(connection, request, prior, {
          ...prior,
          state: "expired",
          reason: "unsupported_dispatch",
          updatedAt: Date.now(),
        })
      }),
    { behavior: "immediate" },
  )
})

const guard = Effect.fnUntraced(function* (database: SessionHandoffStore.Connection, row: Row, state: State) {
  const key = actionKey(row)
  const active = yield* database.db.get<{ source: string }>(
    sql`SELECT source FROM session_handoff_root WHERE session_id = ${key.sessionID} AND reservation = ${row.reservation} AND state = 'active'`,
  )
  if (!active) return yield* new ControlError({ code: "invalidated" })
  const source = decode(
    Schema.Struct({ input: Schema.Struct({ parts: Schema.Json, queue: Schema.Json }) }),
    active.source,
  )
  const parts = yield* database.db.all<{ id: string; data: string }>(
    sql`SELECT id,data FROM part WHERE session_id = ${key.sessionID} AND message_id = ${key.userMessageID} ORDER BY id`,
  )
  const queue = yield* database.db.get(
    sql`SELECT id,delivery,state,message_id,payload,submission FROM session_queue WHERE session_id = ${key.sessionID} AND id = ${key.queueID}`,
  )
  if (canonical(parts) !== canonical(source.input.parts) || canonical(queue) !== canonical(source.input.queue))
    return yield* new ControlError({ code: "stale_context" })
  const preparation = yield* database.db.get(
    sql`SELECT 1 FROM session_handoff_root WHERE session_id = ${key.sessionID} AND state = 'reserved'`,
  )
  if (preparation) return yield* new ControlError({ code: "ambiguous_history" })
  const context = yield* SessionHandoffNotification.context(database, key.sessionID, key.userMessageID)
  if (!context?.enrolled || canonical(context.selection) !== canonical(state.selection))
    return yield* new ControlError({ code: "stale_context" })
})

const read = Effect.fnUntraced(function* (
  database: SessionHandoffStore.Connection,
  key: SessionHandoffStore.ActionKey,
) {
  const row = yield* database.db.get<Row>(sql`SELECT * FROM session_handoff_control WHERE ${where(key)}`)
  if (!row) return yield* new ControlError({ code: "not_enrolled" })
  return row
})

const attempt = Effect.fnUntraced(function* (
  database: SessionHandoffStore.Connection,
  key: SessionHandoffStore.ActionKey,
  record: SessionHandoffStore.AssistantRecord,
) {
  const prior = yield* database.db.get<{ data: string }>(
    sql`SELECT data FROM session_handoff_attempt WHERE message_id = ${record.messageID}`,
  )
  if (prior) {
    if (prior.data !== canonical(record)) return yield* new ControlError({ code: "ambiguous_history" })
    return
  }
  yield* database.db.run(sql`INSERT INTO session_handoff_attempt (message_id,session_id,queue_id,user_message_id,data)
    VALUES (${record.messageID},${key.sessionID},${key.queueID},${key.userMessageID},${canonical(record)})`)
})

const persistedAssistant = Effect.fnUntraced(function* (
  database: SessionHandoffStore.Connection,
  sessionID: string,
  messageID: string,
  parentUserMessageID: string,
  selection: Selection,
  summary: boolean,
) {
  const row = yield* database.db.get<{ data: string }>(
    sql`SELECT data FROM message WHERE session_id = ${sessionID} AND id = ${messageID}`,
  )
  const info =
    row &&
    Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({
          role: Schema.Literal("assistant"),
          parentID: ID,
          providerID: ID,
          modelID: ID,
          variant: Schema.optional(ID),
          summary: Schema.optional(Schema.Boolean),
        }),
      ),
    )(row.data)
  if (
    !info ||
    info._tag === "None" ||
    info.value.parentID !== parentUserMessageID ||
    (info.value.summary === true) !== summary ||
    canonical({
      providerID: info.value.providerID,
      modelID: info.value.modelID,
      variant: info.value.variant ?? "default",
    }) !== canonical(selection)
  )
    return yield* new ControlError({ code: "stale_context" })
})

const advance = Effect.fnUntraced(function* (
  database: SessionHandoffStore.Connection,
  row: Row,
  state: State,
  selection: Selection,
) {
  const next = {
    ...state,
    selection,
    identity: {
      ...state.identity,
      revision: state.identity.revision + 1,
      contextDigest: `sha256:v1:${createHash("sha256")
        .update(canonical({ previous: state.identity, selection, recoveryRevision: state.recoveryRevision }))
        .digest("hex")}`,
    },
  }
  yield* database.db.run(
    sql`UPDATE session_handoff_control SET data = ${canonical(next)} WHERE ${where(actionKey(row))}`,
  )
  yield* retain(database, actionKey(row), next)
  return next
})

const retain = Effect.fnUntraced(function* (
  database: SessionHandoffStore.Connection,
  key: SessionHandoffStore.ActionKey,
  state: State,
) {
  yield* database.db
    .run(sql`INSERT OR IGNORE INTO session_handoff_context (identity,session_id,queue_id,user_message_id)
    VALUES (${canonical({ sessionID: key.sessionID, directory: state.directory, identity: state.identity })},${key.sessionID},${key.queueID},${key.userMessageID})`)
})

const storedRequest = Effect.fnUntraced(function* (database: SessionHandoffStore.Connection, requestID: string) {
  const row = yield* database.db.get<{ identity: string }>(
    sql`SELECT identity FROM session_handoff_request WHERE request_id = ${requestID}`,
  )
  if (!row) return yield* new ControlError({ code: "history_unavailable" })
  return decode(
    Schema.Struct({
      sessionID: ID,
      queueID: ID,
      userMessageID: ID,
      requestID: ID,
      directory: ID,
      kind: Schema.Literals(["enrollment", "model_control", "recovery"]),
      payload: Schema.Record(Schema.String, Schema.Json),
    }),
    row.identity,
  )
})

const retirePending = Effect.fnUntraced(function* (database: SessionHandoffStore.Connection, row: Row, reason: string) {
  if (!row.pending_request_id) return
  const request = yield* storedRequest(database, row.pending_request_id)
  const receipt = yield* SessionHandoffStore.receipt(database, row.session_id, row.pending_request_id)
  if (!receipt) return yield* new ControlError({ code: "history_unavailable" })
  yield* SessionHandoffStore.appendReceipt(database, request, receipt, {
    ...receipt,
    state: "expired",
    reason,
    updatedAt: Date.now(),
  })
})

function requestIdentity(key: SessionHandoffStore.ActionKey, directory: string, request: Request) {
  return { ...key, directory, requestID: request.requestID, kind: "model_control" as const, payload: request }
}
function initialReceipt(
  identity: SessionHandoffStore.RequestIdentity,
  request: Request,
  state: string,
  reason: string | null,
) {
  const createdAt = Date.now()
  return {
    kind: "model_control",
    requestID: request.requestID,
    sessionID: identity.sessionID,
    directory: identity.directory,
    expected: request.expected,
    target: request.target,
    state,
    reason,
    boundary: null,
    dispatch: "none",
    recoveryFence: null,
    interruptedResources: [],
    children: [],
    createdAt,
    updatedAt: createdAt,
  }
}
function actionKey(row: Row) {
  return { sessionID: row.session_id, queueID: row.queue_id, userMessageID: row.user_message_id }
}
function where(key: SessionHandoffStore.ActionKey) {
  return sql`session_id = ${key.sessionID} AND queue_id = ${key.queueID} AND user_message_id = ${key.userMessageID}`
}
function decode<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, data: string): S["Type"] {
  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(data)
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    !item || typeof item !== "object" || Array.isArray(item)
      ? item
      : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))),
  )
}
