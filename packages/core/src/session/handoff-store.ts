export * as SessionHandoffStore from "./handoff-store"

import { sql } from "drizzle-orm"
import { Effect, Schedule, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Database } from "../database/database"

// Lifecycle callers must validate owner/fence, context, terminality and dispatch in their enclosing transaction.
const ID = Schema.NonEmptyString
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Selection = Schema.Struct({ providerID: ID, modelID: ID, variant: ID })
const SummarySelection = Schema.Struct({ providerID: ID, modelID: ID, variant: Schema.NullOr(ID) })
const Key = Schema.Struct({ sessionID: ID, queueID: ID, userMessageID: ID })
const Action = Schema.Struct({ ...Key.fields, directory: ID, baselineSelection: Selection, createdAt: Sequence })
const Request = Schema.Struct({
  ...Key.fields,
  requestID: ID,
  directory: ID,
  kind: Schema.Literals(["enrollment", "model_control", "recovery"]),
  payload: Schema.Record(Schema.String, Schema.Json),
})
const Boundary = Schema.Struct({
  sequence: Sequence,
  requestID: ID,
  kind: Schema.Literals(["model_control", "recovery"]),
  priorSelection: Selection,
  selection: Selection,
  afterAssistantMessageID: Schema.NullOr(ID),
  appliedAt: Sequence,
})
const Dispatch = Schema.Literals(["none", "prepared", "started_or_unknown", "completed", "unknown"])
const Ordinary = Schema.Struct({
  kind: Schema.Literal("ordinary"),
  messageID: ID,
  parentUserMessageID: ID,
  authorizationUserMessageID: ID,
  epochSequence: Sequence,
  controlRequestID: Schema.NullOr(ID),
  selection: Selection,
  selectionEvidence: Schema.Literals(["persisted_message", "normalized_dispatch"]),
  dispatch: Dispatch,
})
const Summary = Schema.Struct({
  kind: Schema.Literal("summary"),
  messageID: ID,
  parentUserMessageID: ID,
  epochSequence: Sequence,
  configuredCompactionSelection: Schema.NullOr(SummarySelection),
  dispatchSelection: Schema.NullOr(SummarySelection),
  selectionEvidence: Schema.Literals(["persisted_message", "normalized_dispatch", "unknown"]),
  dispatch: Dispatch,
})
const Assistant = Schema.Union([Ordinary, Summary])

export type ActionKey = typeof Key.Type
export type ActionRecord = typeof Action.Type
export type RequestIdentity = typeof Request.Type
export type BoundaryRecord = typeof Boundary.Type
export type AssistantRecord = typeof Assistant.Type
export type Receipt = { readonly [key: string]: Schema.Json }
// Enclosing read/write transactions must begin IMMEDIATE before guard reads; savepoints cannot upgrade a snapshot.
export interface Connection {
  db: Pick<Database.Interface["db"], "get" | "all" | "run" | "transaction">
}
export interface History {
  action: ActionRecord
  boundaries: (BoundaryRecord & { firstOrdinaryAssistantMessageID: string | null })[]
  assistants: (typeof Ordinary.Type)[]
  summaries: (typeof Summary.Type)[]
}

export class StoreError extends Schema.TaggedErrorClass<StoreError>()("SessionHandoffStoreError", {
  code: Schema.Literals([
    "request_id_conflict",
    "immutable_conflict",
    "invalid_provenance",
    "not_found",
    "history_unavailable",
  ]),
}) {}

/** Storage only. The caller must prove enrollment eligibility in the same enclosing transaction. */
export const persistAction = Effect.fn("SessionHandoffStore.persistAction")(function* (
  database: Connection,
  input: ActionRecord,
) {
  const action = yield* Schema.decodeUnknownEffect(Action)(input)
  const data = JSON.stringify(action)
  yield* database.db.run(sql`INSERT INTO session_handoff_action (session_id, queue_id, user_message_id, data)
    SELECT ${action.sessionID}, ${action.queueID}, ${action.userMessageID}, ${data}
    WHERE NOT EXISTS (SELECT 1 FROM session_handoff_action WHERE ${where(action)})`)
  const row = yield* database.db.get<{ data: string }>(
    sql`SELECT data FROM session_handoff_action WHERE ${where(action)}`,
  )
  if (row?.data !== data) return yield* new StoreError({ code: "immutable_conflict" })
})

/** Include every decoded wire field in payload. Never pass only a hash or a guard subset. */
export const recordRequest = Effect.fn("SessionHandoffStore.recordRequest")(function* (
  database: Connection,
  input: RequestIdentity,
  initialReceipt: Receipt,
) {
  const request = yield* Schema.decodeUnknownEffect(Request)(input)
  const identity = canonical(request)
  const data = canonical(yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(initialReceipt))
  return yield* database.db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          // Compare globally before action/directory guards, including after later lifecycle changes.
          const prior = yield* tx.get<{ identity: string }>(
            sql`SELECT identity FROM session_handoff_request WHERE request_id = ${request.requestID}`,
          )
          if (prior) {
            if (prior.identity !== identity) return yield* new StoreError({ code: "request_id_conflict" })
            const current = yield* receipt({ db: tx }, request.sessionID, request.requestID)
            if (!current) return yield* new StoreError({ code: "history_unavailable" })
            return current
          }
          const action = yield* tx.get<{ data: string }>(
            sql`SELECT data FROM session_handoff_action WHERE ${where(request)}`,
          )
          if (!action) return yield* new StoreError({ code: "not_found" })
          if (decode(Action, action.data).directory !== request.directory)
            return yield* new StoreError({ code: "invalid_provenance" })
          yield* tx.run(sql`INSERT INTO session_handoff_request (request_id, session_id, queue_id, user_message_id, identity, data)
      VALUES (${request.requestID}, ${request.sessionID}, ${request.queueID}, ${request.userMessageID}, ${identity}, ${data})`)
          return decodeReceipt(data)
        }),
      { behavior: "immediate" },
    )
    .pipe(
      Effect.retry({
        while: (error) => error instanceof SqlError && error.reason._tag === "LockTimeoutError",
        times: 50,
        schedule: Schedule.spaced("10 millis"),
      }),
    )
})

export const receipt = Effect.fn("SessionHandoffStore.receipt")(function* (
  database: Connection,
  sessionID: string,
  requestID: string,
) {
  const row = yield* database.db.get<{ data: string }>(
    sql`SELECT COALESCE(
      (SELECT data FROM session_handoff_receipt WHERE request_id = r.request_id ORDER BY revision DESC LIMIT 1),
      r.data) AS data FROM session_handoff_request r WHERE session_id = ${sessionID} AND request_id = ${requestID}`,
  )
  return row ? decodeReceipt(row.data) : undefined
})

/** Compare a complete request before lifecycle guards, in the caller's writer transaction. */
export const retryRequest = Effect.fn("SessionHandoffStore.retryRequest")(function* (
  database: Connection,
  input: RequestIdentity,
) {
  const request = yield* Schema.decodeUnknownEffect(Request)(input)
  const prior = yield* database.db.get<{ identity: string }>(
    sql`SELECT identity FROM session_handoff_request WHERE request_id = ${request.requestID}`,
  )
  if (!prior) return undefined
  if (prior.identity !== canonical(request)) return yield* new StoreError({ code: "request_id_conflict" })
  const current = yield* receipt(database, request.sessionID, request.requestID)
  if (!current) return yield* new StoreError({ code: "history_unavailable" })
  return current
})

/** Append a receipt snapshot by value-CAS. Lifecycle/dispatch transition validity is caller-owned.
 * Callers with enclosing transactions must acquire their writer reservation before reading.
 */
export const appendReceipt = Effect.fn("SessionHandoffStore.appendReceipt")(function* (
  database: Connection,
  input: RequestIdentity,
  expected: Receipt,
  value: Receipt,
) {
  const request = yield* Schema.decodeUnknownEffect(Request)(input)
  const before = canonical(yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(expected))
  const data = canonical(yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(value))
  return yield* database.db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const row = yield* tx.get<{ identity: string; data: string }>(
            sql`SELECT identity, data FROM session_handoff_request WHERE request_id = ${request.requestID}`,
          )
          if (!row) return yield* new StoreError({ code: "not_found" })
          if (row.identity !== canonical(request)) return yield* new StoreError({ code: "request_id_conflict" })
          const latest = yield* tx.get<{ revision: number; data: string }>(
            sql`SELECT revision, data FROM session_handoff_receipt WHERE request_id = ${request.requestID} ORDER BY revision DESC LIMIT 1`,
          )
          const current = latest?.data ?? row.data
          if (current === data) return decodeReceipt(current)
          if (current !== before) return yield* new StoreError({ code: "immutable_conflict" })
          yield* tx.run(sql`INSERT INTO session_handoff_receipt (request_id, revision, data)
      VALUES (${request.requestID}, ${(latest?.revision ?? 0) + 1}, ${data})`)
          return decodeReceipt(data)
        }),
      { behavior: "immediate" },
    )
    .pipe(
      Effect.retry({
        while: (error) => error instanceof SqlError && error.reason._tag === "LockTimeoutError",
        times: 50,
        schedule: Schedule.spaced("10 millis"),
      }),
    )
})

export const appendBoundary = Effect.fn("SessionHandoffStore.appendBoundary")(function* (
  database: Connection,
  input: ActionKey,
  value: BoundaryRecord,
) {
  const key = yield* Schema.decodeUnknownEffect(Key)(input)
  const boundary = yield* Schema.decodeUnknownEffect(Boundary)(value)
  yield* database.db.transaction((tx) =>
    Effect.gen(function* () {
      const prior = yield* tx.get<{ data: string }>(
        sql`SELECT data FROM session_handoff_boundary WHERE ${where(key)} AND sequence = ${boundary.sequence}`,
      )
      if (prior) {
        if (canonical(decode(Boundary, prior.data)) !== canonical(boundary))
          return yield* new StoreError({ code: "immutable_conflict" })
        return
      }
      const history = yield* lookup({ db: tx }, key)
      const request = yield* tx.get<{ identity: string }>(
        sql`SELECT identity FROM session_handoff_request WHERE request_id = ${boundary.requestID} AND ${where(key)}`,
      )
      const identity = request ? decode(Request, request.identity) : undefined
      if (
        !history ||
        !identity ||
        identity.kind !== boundary.kind ||
        boundary.sequence !== history.boundaries.length + 1 ||
        canonical(boundary.priorSelection) !==
          canonical(history.boundaries.at(-1)?.selection ?? history.action.baselineSelection) ||
        canonical(boundary.selection) !== canonical(identity.payload.target ?? null) ||
        (boundary.afterAssistantMessageID !== null &&
          !history.assistants.some((x) => x.messageID === boundary.afterAssistantMessageID))
      ) {
        return yield* new StoreError({ code: "invalid_provenance" })
      }
      yield* tx.run(sql`INSERT INTO session_handoff_boundary (session_id, queue_id, user_message_id, sequence, request_id, data)
      VALUES (${key.sessionID}, ${key.queueID}, ${key.userMessageID}, ${boundary.sequence}, ${boundary.requestID}, ${JSON.stringify(boundary)})`)
    }),
  )
})

export const appendAssistant = Effect.fn("SessionHandoffStore.appendAssistant")(function* (
  database: Connection,
  input: ActionKey,
  value: AssistantRecord,
) {
  const key = yield* Schema.decodeUnknownEffect(Key)(input)
  const assistant = yield* Schema.decodeUnknownEffect(Assistant)(value)
  yield* database.db.transaction((tx) =>
    Effect.gen(function* () {
      const prior = yield* tx.get<{ session_id: string; queue_id: string; user_message_id: string; data: string }>(
        sql`SELECT * FROM session_handoff_assistant WHERE message_id = ${assistant.messageID}`,
      )
      if (prior) {
        if (
          prior.session_id !== key.sessionID ||
          prior.queue_id !== key.queueID ||
          prior.user_message_id !== key.userMessageID ||
          canonical(decode(Assistant, prior.data)) !== canonical(assistant)
        )
          return yield* new StoreError({ code: "immutable_conflict" })
        return
      }
      const history = yield* lookup({ db: tx }, key)
      const epoch = history?.boundaries.find((x) => x.sequence === assistant.epochSequence)
      if (
        !history ||
        (assistant.epochSequence !== 0 && !epoch) ||
        (assistant.kind === "summary" &&
          assistant.selectionEvidence !== "unknown" &&
          assistant.dispatchSelection === null) ||
        (assistant.kind === "ordinary" &&
          (assistant.authorizationUserMessageID !== key.userMessageID ||
            assistant.controlRequestID !== (epoch?.requestID ?? null) ||
            canonical(assistant.selection) !== canonical(epoch?.selection ?? history.action.baselineSelection) ||
            assistant.selectionEvidence !==
              (assistant.epochSequence === 0 ? "persisted_message" : "normalized_dispatch")))
      )
        return yield* new StoreError({ code: "invalid_provenance" })
      yield* tx.run(sql`INSERT INTO session_handoff_assistant (message_id, session_id, queue_id, user_message_id, data)
      VALUES (${assistant.messageID}, ${key.sessionID}, ${key.queueID}, ${key.userMessageID}, ${JSON.stringify(assistant)})`)
    }),
  )
})

/** Exact historical selector only. No current-action discovery or baseline fallback. */
export const lookup = Effect.fn("SessionHandoffStore.lookup")(function* (database: Connection, input: ActionKey) {
  const key = yield* Schema.decodeUnknownEffect(Key)(input)
  return yield* database.db.transaction((tx) =>
    Effect.gen(function* () {
      const action = yield* tx.get<{ data: string }>(sql`SELECT data FROM session_handoff_action WHERE ${where(key)}`)
      if (!action) return undefined
      const boundaries = (yield* tx.all<{ data: string }>(
        sql`SELECT data FROM session_handoff_boundary WHERE ${where(key)} ORDER BY sequence`,
      )).map((x) => decode(Boundary, x.data))
      if (boundaries.some((x, i) => x.sequence !== i + 1)) return yield* new StoreError({ code: "history_unavailable" })
      const membership = (yield* tx.all<{ data: string }>(
        sql`SELECT data FROM session_handoff_assistant WHERE ${where(key)} ORDER BY position`,
      )).map((x) => decode(Assistant, x.data))
      if (membership.some((x) => x.epochSequence > boundaries.length))
        return yield* new StoreError({ code: "history_unavailable" })
      const assistants = membership.filter((x) => x.kind === "ordinary")
      const history: History = {
        action: decode(Action, action.data),
        boundaries: boundaries.map((x) => ({
          ...x,
          firstOrdinaryAssistantMessageID: assistants.find((a) => a.epochSequence === x.sequence)?.messageID ?? null,
        })),
        assistants,
        summaries: membership.filter((x) => x.kind === "summary"),
      }
      return history
    }),
  )
})

function where(key: ActionKey) {
  return sql`session_id = ${key.sessionID} AND queue_id = ${key.queueID} AND user_message_id = ${key.userMessageID}`
}

function decode<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, data: string): S["Type"] {
  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(data)
}

function decodeReceipt(data: string): Receipt {
  return decode(Schema.Record(Schema.String, Schema.Json), data)
}

function canonical(value: Schema.Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
