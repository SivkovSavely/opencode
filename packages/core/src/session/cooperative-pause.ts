export * as SessionCooperativePause from "./cooperative-pause"

import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SessionHandoffStore } from "./handoff-store"

type Connection = SessionHandoffStore.Connection
type Owner = { ownerLineage: string; ownerInstance: string; fence: number }
type PauseRow = {
  session_id: string
  queue_id: string
  user_message_id: string
  request_id: string
  revision: number
  state: string
}
const State = Schema.Struct({
  directory: Schema.String,
  identity: SessionHandoffV1.Identity,
  recoveryRevision: Schema.Number,
  retiredFrom: Schema.optional(SessionHandoffV1.Identity),
})

export const active = Effect.fn("SessionCooperativePause.active")(function* (database: Connection, sessionID: string) {
  return !!(yield* pending(database, sessionID))
})

export const pending = Effect.fn("SessionCooperativePause.pending")(function* (
  database: Connection,
  sessionID: string,
) {
  return yield* database.db.get<PauseRow>(
    sql`SELECT * FROM session_cooperative_pause WHERE session_id = ${sessionID} AND state IN ('accepted','draining','paused')`,
  )
})

export const admit = Effect.fn("SessionCooperativePause.admit")(function* (
  database: Connection,
  sessionID: string,
  directory: string,
  request: SessionHandoffV1.PauseRequest,
  owner: Owner,
) {
  const identity = requestIdentity(sessionID, directory, request, "cooperative_pause")
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const retry = yield* SessionHandoffStore.retryRequest(connection, identity)
        if (retry) return yield* Schema.decodeUnknownEffect(SessionHandoffV1.CooperativePauseReceipt)(retry)
        const control = yield* tx.get<{
          data: string
          state: string
          pending_request_id: string | null
          reservation: string
        }>(sql`SELECT * FROM session_handoff_control
      WHERE session_id=${sessionID} AND queue_id=${request.expected.queueID} AND user_message_id=${request.expected.userMessageID}`)
        const state = control && Schema.decodeUnknownSync(Schema.fromJsonString(State))(control.data)
        const runtime = yield* tx.get<{
          owner_lineage: string
          owner_instance: string
          fence: number
          state: string
          desired_active: number
        }>(sql`SELECT * FROM runtime_execution WHERE session_id=${sessionID}`)
        const prior = yield* pending(connection, sessionID)
        const conflicting = yield* tx.get(
          sql`SELECT 1 FROM session_queue WHERE session_id=${sessionID} AND state IN ('pending','claimed') LIMIT 1`,
        )
        const latest = yield* tx.get<{ reservation: string }>(
          sql`SELECT reservation FROM session_handoff_root WHERE session_id=${sessionID} AND state!='aborted' ORDER BY rowid DESC LIMIT 1`,
        )
        const reason = control?.pending_request_id
          ? ("pending_control" as const)
          : prior || conflicting
            ? ("conflicting_input" as const)
            : !state ||
                !control ||
                !["active", "terminal"].includes(control.state) ||
                directory !== request.expectedDirectory ||
                state.directory !== directory ||
                canonical(state.identity) !== canonical(request.expected) ||
                state.recoveryRevision !== request.expectedRecoveryRevision ||
                latest?.reservation !== control?.reservation ||
                !runtime ||
                runtime.owner_lineage !== owner.ownerLineage ||
                runtime.owner_instance !== owner.ownerInstance ||
                runtime.fence !== owner.fence ||
                runtime.fence !== request.expected.fence ||
                runtime.owner_instance !== request.expected.ownerInstance ||
                runtime.owner_lineage !== request.expected.ownerLineage ||
                runtime.desired_active !== 1
              ? ("stale_action" as const)
              : runtime.state !== "active"
                ? ("not_quiet" as const)
                : null
        const previous = yield* tx.get<{ revision: number }>(
          sql`SELECT revision FROM session_cooperative_pause WHERE session_id=${sessionID}`,
        )
        const now = Date.now()
        const receipt: SessionHandoffV1.CooperativePauseReceipt = {
          kind: "cooperative_pause",
          version: "cooperative-execution-pause/1",
          requestID: request.requestID,
          sessionID,
          directory,
          expected: request.expected,
          expectedRecoveryRevision: request.expectedRecoveryRevision,
          pauseRevision: (previous?.revision ?? 0) + 1,
          state: control?.state === "terminal" && !reason ? "terminal" : reason ? "refused" : "accepted",
          boundaryAssistantMessageID: null,
          reason,
          createdAt: now,
          updatedAt: now,
        }
        yield* SessionHandoffStore.recordRequest(connection, identity, receipt)
        if (receipt.state === "accepted")
          yield* tx.run(sql`INSERT INTO session_cooperative_pause (session_id,queue_id,user_message_id,request_id,revision,state)
      VALUES (${sessionID},${request.expected.queueID},${request.expected.userMessageID},${request.requestID},${receipt.pauseRevision},'accepted')
      ON CONFLICT(session_id) DO UPDATE SET queue_id=excluded.queue_id,user_message_id=excluded.user_message_id,request_id=excluded.request_id,revision=excluded.revision,state='accepted'`)
        return receipt
      }),
    { behavior: "immediate" },
  )
})

/** Caller holds runtime's synchronized state, and owns the root's provider boundary. */
export const boundary = Effect.fn("SessionCooperativePause.boundary")(function* (
  database: Connection,
  sessionID: string,
  owner: Owner,
  terminal = false,
  quiet?: (connection: Connection, row: PauseRow) => Effect.Effect<boolean>,
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const row = yield* pending(connection, sessionID)
        if (!row) return "none" as const
        const prior = yield* SessionHandoffStore.receipt(connection, sessionID, row.request_id)
        const receipt = yield* Schema.decodeUnknownEffect(SessionHandoffV1.CooperativePauseReceipt)(prior)
        const runtime = yield* tx.get<{
          state: string
        }>(sql`SELECT state FROM runtime_execution WHERE session_id=${sessionID}
      AND owner_lineage=${owner.ownerLineage} AND owner_instance=${owner.ownerInstance} AND fence=${owner.fence} AND desired_active=1`)
        const root = yield* tx.get<{ state: string }>(
          sql`SELECT state FROM session_handoff_root WHERE session_id=${sessionID} AND queue_id=${row.queue_id} AND user_message_id=${row.user_message_id}`,
        )
        const control = yield* tx.get<{ data: string; pending_request_id: string | null; reservation: string }>(
          sql`SELECT * FROM session_handoff_control WHERE session_id=${sessionID} AND queue_id=${row.queue_id} AND user_message_id=${row.user_message_id}`,
        )
        const action = control && Schema.decodeUnknownSync(Schema.fromJsonString(State))(control.data)
        const latest = yield* tx.get<{ reservation: string }>(
          sql`SELECT reservation FROM session_handoff_root WHERE session_id=${sessionID} AND state!='aborted' ORDER BY rowid DESC LIMIT 1`,
        )
        const finished = terminal || root?.state === "terminal"
        if (receipt.state === "paused") {
          if (!finished) return "paused" as const
          // Acknowledgement is immutable history; cancellation retires the resumable checkpoint, not its receipt.
          yield* tx.run(
            sql`UPDATE session_cooperative_pause SET state='terminal' WHERE session_id=${sessionID} AND request_id=${row.request_id}`,
          )
          return "terminal" as const
        }
        if (!runtime && !finished) return "waiting" as const
        if (
          !action ||
          canonical(finished ? (action.retiredFrom ?? action.identity) : action.identity) !==
            canonical(receipt.expected) ||
          action.directory !== receipt.directory ||
          action.recoveryRevision !== receipt.expectedRecoveryRevision ||
          control?.pending_request_id ||
          latest?.reservation !== control?.reservation
        )
          return "waiting" as const
        // Descendants may continue dispatching while the root waits at this boundary.
        const work =
          yield* tx.get(sql`WITH RECURSIVE tree(id) AS (SELECT ${sessionID} UNION SELECT r.session_id FROM runtime_execution r JOIN tree t ON r.parent_session_id=t.id)
      SELECT 1 FROM runtime_execution WHERE session_id IN (SELECT id FROM tree) AND session_id!=${sessionID}
       AND (state NOT IN ('completed','cancelled') OR (parent_mode='background' AND parent_notification_state IN ('pending','delivering'))
         OR EXISTS (SELECT 1 FROM part WHERE part.session_id=runtime_execution.session_id AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.state.status') IN ('pending','running'))) LIMIT 1`)
        const tools = yield* tx.get(
          sql`SELECT 1 FROM part WHERE session_id=${sessionID} AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.state.status') IN ('pending','running') LIMIT 1`,
        )
        const assistant = yield* tx.get<{
          id: string
        }>(sql`SELECT id FROM message WHERE session_id=${sessionID} AND json_extract(data,'$.role')='assistant'
       AND COALESCE(json_extract(data,'$.summary'),0)!=1 AND (json_extract(data,'$.parentID')=${row.user_message_id}
         OR json_extract(data,'$.parentID') IN (SELECT message_id FROM session_handoff_notification WHERE session_id=${sessionID} AND user_message_id=${row.user_message_id} AND classification='in_action')) ORDER BY rowid DESC LIMIT 1`)
        if (!finished && (work || tools)) return "waiting" as const
        if (!finished && quiet && !(yield* quiet(connection, row))) return "waiting" as const
        const next: SessionHandoffV1.CooperativePauseReceipt = {
          ...receipt,
          state: finished ? "terminal" : "paused",
          boundaryAssistantMessageID: finished ? null : (assistant?.id ?? null),
          updatedAt: Date.now(),
        }
        yield* SessionHandoffStore.appendReceipt(
          connection,
          requestIdentity(
            sessionID,
            receipt.directory,
            {
              requestID: receipt.requestID,
              expectedDirectory: receipt.directory,
              expected: receipt.expected,
              expectedRecoveryRevision: receipt.expectedRecoveryRevision,
            },
            "cooperative_pause",
          ),
          receipt,
          next,
        )
        yield* tx.run(sql`UPDATE session_cooperative_pause SET state=${next.state} WHERE session_id=${sessionID}`)
        if (!finished)
          yield* tx.run(
            sql`UPDATE runtime_execution SET state='cooperative_paused',time_updated=${Date.now()} WHERE session_id=${sessionID} AND fence=${owner.fence}`,
          )
        return finished ? ("terminal" as const) : ("paused" as const)
      }),
    { behavior: "immediate" },
  )
})

/** An unacknowledged intent is not a checkpoint. Convert its barrier to an ordinary recovery hold. */
export const ownerLost = Effect.fn("SessionCooperativePause.ownerLost")(function* (
  database: Connection,
  sessionID: string,
  liveness: (connection: Connection, sessionID: string) => Effect.Effect<"live" | "dead" | "unknown">,
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const row = yield* pending(connection, sessionID)
        if (!row || row.state === "paused") return
        if ((yield* liveness(connection, sessionID)) !== "dead") return
        // A live descendant prevents a tree-wide startup hold, but must not strand the dead root's intent.
        yield* tx.run(sql`INSERT OR IGNORE INTO session_handoff_recovery_hold (root_session_id,reservation,session_id)
          SELECT session_id,reservation,session_id FROM session_handoff_root
          WHERE session_id=${sessionID} AND queue_id=${row.queue_id} AND user_message_id=${row.user_message_id}`)
        const held = yield* tx.get(sql`SELECT 1 FROM session_handoff_recovery_hold h JOIN session_handoff_root r
      ON r.session_id=h.root_session_id AND r.reservation=h.reservation
      WHERE h.session_id=${sessionID} AND r.session_id=${sessionID} AND r.queue_id=${row.queue_id} AND r.user_message_id=${row.user_message_id}`)
        if (!held) return
        const prior = yield* Schema.decodeUnknownEffect(SessionHandoffV1.CooperativePauseReceipt)(
          yield* SessionHandoffStore.receipt(connection, sessionID, row.request_id),
        )
        const next: SessionHandoffV1.CooperativePauseReceipt = {
          ...prior,
          state: "refused",
          reason: "not_quiet",
          boundaryAssistantMessageID: null,
          updatedAt: Date.now(),
        }
        yield* SessionHandoffStore.appendReceipt(
          connection,
          requestIdentity(
            sessionID,
            prior.directory,
            {
              requestID: prior.requestID,
              expectedDirectory: prior.directory,
              expected: prior.expected,
              expectedRecoveryRevision: prior.expectedRecoveryRevision,
            },
            "cooperative_pause",
          ),
          prior,
          next,
        )
        yield* tx.run(
          sql`UPDATE session_cooperative_pause SET state='refused' WHERE session_id=${sessionID} AND request_id=${row.request_id}`,
        )
      }),
    { behavior: "immediate" },
  )
})

/** Runtime must coordinate this transaction with local lease state before scheduling the original loop. */
export const resume = Effect.fn("SessionCooperativePause.resume")(function* (
  database: Connection,
  sessionID: string,
  directory: string,
  request: SessionHandoffV1.ResumeRequest,
  owner: Owner,
) {
  const identity = requestIdentity(sessionID, directory, request, "cooperative_resume")
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const retry = yield* SessionHandoffStore.retryRequest(connection, identity)
        if (retry) return yield* Schema.decodeUnknownEffect(SessionHandoffV1.CooperativeResumeReceipt)(retry)
        const row = yield* tx.get<PauseRow>(sql`SELECT * FROM session_cooperative_pause WHERE session_id=${sessionID}`)
        const pause = row && (yield* SessionHandoffStore.receipt(connection, sessionID, row.request_id))
        const original = pause && (yield* Schema.decodeUnknownEffect(SessionHandoffV1.CooperativePauseReceipt)(pause))
        const runtime = yield* tx.get<{
          owner_lineage: string
          owner_instance: string
          fence: number
          state: string
          desired_active: number
        }>(sql`SELECT * FROM runtime_execution WHERE session_id=${sessionID}`)
        const control = yield* tx.get<{ state: string; pending_request_id: string | null; data: string }>(
          sql`SELECT * FROM session_handoff_control WHERE session_id=${sessionID} AND queue_id=${request.expected.queueID} AND user_message_id=${request.expected.userMessageID}`,
        )
        const current = control && Schema.decodeUnknownSync(Schema.fromJsonString(State))(control.data)
        const finished = row?.state === "terminal" && control?.state === "terminal"
        const conflicting = yield* tx.get(
          sql`SELECT 1 FROM session_queue WHERE session_id=${sessionID} AND state IN ('pending','claimed') LIMIT 1`,
        )
        const lost =
          runtime?.owner_lineage !== owner.ownerLineage ||
          runtime.owner_instance !== owner.ownerInstance ||
          runtime.fence !== owner.fence ||
          runtime.owner_lineage !== request.expected.ownerLineage ||
          runtime.owner_instance !== request.expected.ownerInstance ||
          runtime.fence !== request.expected.fence
        const interruptedIntent =
          lost &&
          (row?.state === "accepted" ||
            row?.state === "draining" ||
            (row?.state === "refused" && original?.reason === "not_quiet"))
        const stale =
          !original ||
          (row?.state !== "paused" && !interruptedIntent && !finished) ||
          row.request_id !== request.pauseRequestID ||
          row.revision !== request.expectedPauseRevision ||
          original.directory !== directory ||
          request.expectedDirectory !== directory ||
          canonical(original.expected) !== canonical(request.expected) ||
          canonical(finished ? (current?.retiredFrom ?? current?.identity) : current?.identity) !==
            canonical(request.expected)
        const reason = stale
          ? ("stale_action" as const)
          : finished
            ? original?.state === "paused" && runtime?.state === "cancelled"
              ? ("owner_lost" as const)
              : ("terminal_action" as const)
            : control?.pending_request_id
              ? ("pending_control" as const)
              : conflicting
                ? ("conflicting_input" as const)
                : lost
                  ? ("owner_lost" as const)
                  : runtime?.state !== "cooperative_paused" || runtime.desired_active !== 1
                    ? ("stale_action" as const)
                    : null
        const now = Date.now()
        const receipt: SessionHandoffV1.CooperativeResumeReceipt = {
          kind: "cooperative_resume",
          version: "cooperative-execution-pause/1",
          requestID: request.requestID,
          pauseRequestID: request.pauseRequestID,
          sessionID,
          directory,
          expected: request.expected,
          expectedPauseRevision: request.expectedPauseRevision,
          state:
            reason === "terminal_action"
              ? "terminal"
              : reason === "owner_lost"
                ? "recovery_required"
                : reason
                  ? "refused"
                  : "resumed",
          resumeFence: reason ? null : owner.fence,
          reason,
          createdAt: now,
          updatedAt: now,
        }
        yield* SessionHandoffStore.recordRequest(connection, identity, receipt)
        if (receipt.state === "resumed") {
          yield* tx.run(
            sql`UPDATE runtime_execution SET state='active',time_updated=${now} WHERE session_id=${sessionID}`,
          )
          yield* tx.run(sql`UPDATE session_cooperative_pause SET state='resumed' WHERE session_id=${sessionID}`)
        }
        return receipt
      }),
    { behavior: "immediate" },
  )
})

function requestIdentity(
  sessionID: string,
  directory: string,
  request: SessionHandoffV1.PauseRequest | SessionHandoffV1.ResumeRequest,
  kind: "cooperative_pause" | "cooperative_resume",
) {
  return {
    sessionID,
    directory,
    queueID: request.expected.queueID,
    userMessageID: request.expected.userMessageID,
    requestID: request.requestID,
    kind,
    payload: { ...request },
  }
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    !item || typeof item !== "object" || Array.isArray(item)
      ? item
      : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))),
  )
}
