export * as SessionHandoffRecoveryQueue from "./handoff-recovery-queue"

import { sql } from "drizzle-orm"
import { Context, Effect, Schema } from "effect"
import { SessionHandoffStore } from "./handoff-store"
import { SessionHandoffRecovery } from "./handoff-recovery"

export type Connection = SessionHandoffStore.Connection
type QueryError = Effect.Error<ReturnType<Connection["db"]["run"]>>
export type Frame = {
  root: SessionHandoffStore.ActionKey
  reservation: string
  recoveryRequestID: string
  recoveryRevision: number
  sessionID: string
  ownerLineage: string
  ownerInstance: string
  fence: number
  inputProof: string
}
export const CurrentFrame = Context.Reference<Frame | undefined>("SessionHandoffRecoveryQueue/Frame", {
  defaultValue: () => undefined,
})
type Stamp = {
  session_id: string
  recovery_request_id: string
  root_session_id: string
  queue_id: string
  user_message_id: string
  reservation: string
  recovery_revision: number
  owner_lineage: string
  owner_instance: string
  recovery_fence: number
  queue_revision: number
  input_proof: string
  state: string
  internal_user_id: string | null
}
type Decision = { state: "restored" } | { state: "held"; reason: string }

/** Minted in the guarded claim transaction, never from an existing blocked flag. */
export const frame = Effect.fn("SessionHandoffRecoveryQueue.frame")(function* (
  database: Connection,
  root: SessionHandoffStore.ActionKey,
  recoveryRequestID: string,
  sessionID: string,
): Effect.fn.Return<Frame, SessionHandoffRecovery.RecoveryError | QueryError> {
  const claim = yield* database.db.get<{
    reservation: string
    revision: number
    owner_lineage: string
    owner_instance: string
    fence: number
  }>(sql`SELECT r.reservation,json_extract(c.data,'$.recoveryRevision') AS revision,x.owner_lineage,x.owner_instance,x.fence
    FROM session_handoff_root r JOIN session_handoff_control c ON c.session_id=r.session_id AND c.reservation=r.reservation
    JOIN runtime_execution x ON x.session_id=${sessionID}
    WHERE r.session_id=${root.sessionID} AND r.queue_id=${root.queueID} AND r.user_message_id=${root.userMessageID}
      AND r.enrolled_request_id IS NOT NULL AND r.state IN ('active','terminal') AND x.state='active' AND x.desired_active=1`)
  const receipt = yield* SessionHandoffStore.receipt(database, root.sessionID, recoveryRequestID)
  const record = yield* database.db.get(sql`SELECT 1 FROM session_handoff_request WHERE request_id=${recoveryRequestID}
    AND session_id=${root.sessionID} AND queue_id=${root.queueID} AND user_message_id=${root.userMessageID} AND json_extract(data,'$.kind')='recovery'`)
  const claims = claimed(receipt, root.sessionID)
  if (
    !claim ||
    !receipt ||
    !record ||
    !claims?.some((item) => item.sessionID === sessionID && item.fence === claim.fence) ||
    !Number.isInteger(claim.revision) ||
    claim.revision < 0
  )
    return yield* new SessionHandoffRecovery.RecoveryError({ code: "stale_context" })
  const user = yield* database.db.get<{ id: string }>(
    sql`SELECT id FROM message WHERE session_id=${sessionID} AND json_extract(data,'$.role')='user' ORDER BY time_created DESC,id DESC LIMIT 1`,
  )
  if (!user) return yield* new SessionHandoffRecovery.RecoveryError({ code: "stale_context" })
  if (
    sessionID === root.sessionID &&
    user.id !== root.userMessageID &&
    !(yield* database.db.get(sql`SELECT 1 FROM session_handoff_compaction
    WHERE message_id=${user.id} AND session_id=${root.sessionID} AND queue_id=${root.queueID} AND user_message_id=${root.userMessageID} AND reservation=${claim.reservation}`))
  )
    return yield* new SessionHandoffRecovery.RecoveryError({ code: "stale_context" })
  if (sessionID !== root.sessionID && claims.find((item) => item.sessionID === sessionID)?.userMessageID !== user.id)
    return yield* new SessionHandoffRecovery.RecoveryError({ code: "stale_context" })
  return {
    root,
    reservation: claim.reservation,
    recoveryRequestID,
    recoveryRevision: claim.revision,
    sessionID,
    ownerLineage: claim.owner_lineage,
    ownerInstance: claim.owner_instance,
    fence: claim.fence,
    inputProof: yield* inputProof(database, sessionID),
  }
})

/** Scope and import checks remain in SessionQueue; this function only mutates the supplied transaction. */
export const block = Effect.fn("SessionHandoffRecoveryQueue.block")(function* (database: Connection, frame: Frame) {
  if (!(yield* authentic(database, frame, true))) return "unowned" as const
  const queue = yield* database.db.get<{ revision: number; blocked: number }>(
    sql`SELECT revision,blocked FROM session_queue_state WHERE session_id=${frame.sessionID}`,
  )
  if (!queue) return "unowned" as const
  const prior = yield* stamp(database, frame)
  if (prior) {
    return prior.state === "owned" &&
      queue.blocked === 1 &&
      queue.revision === prior.queue_revision &&
      prior.input_proof === (yield* inputProof(database, frame.sessionID)) &&
      prior.internal_user_id === null
      ? ("owned" as const)
      : ("unowned" as const)
  }
  if (queue.blocked || frame.inputProof !== (yield* inputProof(database, frame.sessionID))) return "unowned" as const
  const changed = yield* database.db.get(sql`UPDATE session_queue_state SET blocked=1,revision=revision+1
    WHERE session_id=${frame.sessionID} AND blocked=0 AND revision=${queue.revision} RETURNING session_id`)
  if (!changed) return "unowned" as const
  const owned = yield* database.db.get(sql`INSERT INTO session_handoff_recovery_queue_block
    (session_id,recovery_request_id,root_session_id,queue_id,user_message_id,reservation,recovery_revision,
      owner_lineage,owner_instance,recovery_fence,queue_revision,input_proof,state)
    VALUES (${frame.sessionID},${frame.recoveryRequestID},${frame.root.sessionID},${frame.root.queueID},${frame.root.userMessageID},${frame.reservation},${frame.recoveryRevision},
      ${frame.ownerLineage},${frame.ownerInstance},${frame.fence},${queue.revision + 1},${frame.inputProof},'owned') RETURNING session_id`)
  if (!owned) return yield* Effect.die("Recovery queue authority was not recorded")
  return "owned" as const
})

/** Every claimed record's actual completion retries this whole-batch guard in its writer transaction. */
export const finish = Effect.fn("SessionHandoffRecoveryQueue.finish")(function* (
  database: Connection,
  frames: readonly Frame[],
  finalizeReceipt: (database: Connection) => Effect.Effect<void>,
  liveness: (sessionID: string) => Effect.Effect<SessionHandoffRecovery.Liveness>,
  probe?: SessionHandoffRecovery.ResourceProbe,
): Effect.fn.Return<Decision, SessionHandoffRecovery.RecoveryError | QueryError> {
  const root = frames[0]
  if (!root) return { state: "held", reason: "no_authority" }
  const claims = claimed(
    yield* SessionHandoffStore.receipt(database, root.root.sessionID, root.recoveryRequestID),
    root.root.sessionID,
  )
  if (
    !claims ||
    claims.length !== frames.length ||
    new Set(frames.map((frame) => frame.sessionID)).size !== frames.length ||
    claims.some((claim) => !frames.some((frame) => frame.sessionID === claim.sessionID && frame.fence === claim.fence))
  )
    return { state: "held", reason: "incomplete_batch" }
  for (const frame of frames) {
    if (
      frame.recoveryRequestID !== root.recoveryRequestID ||
      frame.reservation !== root.reservation ||
      frame.root.sessionID !== root.root.sessionID ||
      !(yield* authentic(database, frame, false))
    )
      return { state: "held", reason: "stale_context" }
    const runtime = yield* database.db.get<{ state: string }>(
      sql`SELECT state FROM runtime_execution WHERE session_id=${frame.sessionID}`,
    )
    if (runtime?.state !== "completed") return { state: "held", reason: "not_ready" }
  }
  // Receipt capture can seal history; it must observe final queue revisions, including on restoration.
  const finalize = (decision: Decision) => finalizeReceipt(database).pipe(Effect.as(decision))
  const managed =
    process.env.OPENCODE_MANAGED_PROFILE === "1" ||
    (yield* database.db
      .get(sql`SELECT 1 FROM managed_command_coverage WHERE root_session_id=${root.root.sessionID} AND state='managed'
    UNION ALL SELECT 1 FROM managed_session_member WHERE root_session_id=${root.root.sessionID}
    UNION ALL SELECT 1 FROM managed_command WHERE root_session_id=${root.root.sessionID} AND execution_generation='managed-execution' LIMIT 1`))
  if (managed) {
    yield* database.db.run(sql`UPDATE session_handoff_recovery_queue_block SET reason='unsupported_managed'
      WHERE root_session_id=${root.root.sessionID} AND recovery_request_id=${root.recoveryRequestID} AND state='owned'`)
    return yield* finalize({ state: "held", reason: "unsupported_managed" })
  }
  const snapshot = yield* SessionHandoffRecovery.inspect(database, root.root.sessionID, liveness, probe, root.root)
  if (
    snapshot.descendants.some(
      (child) => child.proof !== "verified" || child.state !== "terminal" || child.resultState !== "completed",
    )
  )
    return yield* finalize({ state: "held", reason: "unresolved_descendant" })
  const resources = [
    ...snapshot.interruptedResources,
    ...snapshot.descendants.flatMap((child) => child.interruptedResources),
  ]
  if (
    resources.some((resource) =>
      resource.resourceKind === "task"
        ? !snapshot.descendants.some(
            (child) =>
              child.link?.parentAssistantMessageID === resource.assistantMessageID &&
              child.link.parentCallID === resource.callID &&
              child.state === "terminal",
          )
        : resource.liveness !== "dead" && resource.liveness !== "not_applicable",
    )
  )
    return yield* finalize({ state: "held", reason: "unresolved_resource" })
  const members = [...new Set([root.root.sessionID, ...snapshot.descendants.map((child) => child.childSessionID)])]
  for (const id of members) {
    const pending = yield* database.db.get(
      sql`SELECT 1 FROM session_queue WHERE session_id=${id} AND state IN ('pending','claimed','uncertain') LIMIT 1`,
    )
    const queue = yield* database.db.get<{ paused: number; blocked: number; revision: number }>(
      sql`SELECT paused,blocked,revision FROM session_queue_state WHERE session_id=${id}`,
    )
    if (pending || queue?.paused) return yield* finalize({ state: "held", reason: "queue_not_empty_or_paused" })
    const notification = yield* database.db.get(
      sql`SELECT 1 FROM runtime_execution WHERE session_id=${id} AND parent_mode='background' AND COALESCE(parent_notification_state,'pending') <> 'delivered'`,
    )
    if (notification) return yield* finalize({ state: "held", reason: "pending_notification" })
    const frame = frames.find((item) => item.sessionID === id)
    if (!frame && queue?.blocked) return yield* finalize({ state: "held", reason: "unowned_block" })
    if (frame) {
      const owner = yield* stamp(database, frame)
      if (
        !owner ||
        owner.state !== "owned" ||
        owner.internal_user_id !== null ||
        !queue?.blocked ||
        queue.revision !== owner.queue_revision ||
        owner.input_proof !== (yield* inputProof(database, id))
      )
        return yield* finalize({ state: "held", reason: "unowned_block" })
    }
    const result = yield* database.db.get<{ data: string }>(sql`SELECT data FROM message WHERE session_id=${id}
      AND json_extract(data,'$.role')='assistant' AND COALESCE(json_extract(data,'$.summary'),0)=0
      AND json_extract(data,'$.parentID')=(SELECT id FROM message WHERE session_id=${id} AND json_extract(data,'$.role')='user' ORDER BY time_created DESC,id DESC LIMIT 1)
      ORDER BY time_created DESC,id DESC LIMIT 1`)
    const success =
      result &&
      (yield* database.db.get(sql`SELECT 1 WHERE json_extract(${result.data},'$.time.completed') IS NOT NULL
      AND json_extract(${result.data},'$.error') IS NULL AND (json_extract(${result.data},'$.finish')='stop'
        OR (json_extract(${result.data},'$.finish')='tool-calls' AND json_type(${result.data},'$.structured') IS NOT NULL))`))
    if (!success) return yield* finalize({ state: "held", reason: "unsuccessful_result" })
  }
  // Validate every member before clearing any queue flag.
  for (const frame of frames) {
    const owner = yield* stamp(database, frame)
    if (!owner) return yield* Effect.die("Missing recovery queue authority after validation")
    const marked = yield* database.db
      .get(sql`UPDATE session_handoff_recovery_queue_block SET state='restored',reason=NULL
      WHERE session_id=${frame.sessionID} AND recovery_request_id=${frame.recoveryRequestID} AND state='owned' RETURNING session_id`)
    if (!marked) return yield* Effect.die("Recovery queue authority CAS failed")
    const restored = yield* database.db.get(sql`UPDATE session_queue_state SET blocked=0,revision=revision+1
      WHERE session_id=${frame.sessionID} AND blocked=1 AND paused=0 AND revision=${owner.queue_revision} RETURNING session_id`)
    if (!restored) return yield* Effect.die("Recovery queue restoration CAS failed")
  }
  yield* database.db.run(
    sql`DELETE FROM session_handoff_recovery_hold WHERE root_session_id=${root.root.sessionID} AND reservation=${root.reservation}`,
  )
  return yield* finalize({ state: "restored" })
})

function claimed(receipt: unknown, rootSessionID: string) {
  const parsed = Schema.decodeUnknownOption(
    Schema.Struct({
      recoveryFence: Schema.NullOr(Schema.Int),
      children: Schema.Array(
        Schema.Struct({
          priorFence: Schema.Int,
          recoveryFence: Schema.Int,
          link: Schema.Struct({ childSessionID: Schema.String, childUserMessageID: Schema.String }),
        }),
      ),
    }),
  )(receipt)
  if (parsed._tag === "None") return
  return [
    ...(parsed.value.recoveryFence !== null
      ? [{ sessionID: rootSessionID, fence: parsed.value.recoveryFence, userMessageID: undefined }]
      : []),
    ...parsed.value.children
      .filter((child) => child.recoveryFence > child.priorFence)
      .map((child) => ({
        sessionID: child.link.childSessionID,
        fence: child.recoveryFence,
        userMessageID: child.link.childUserMessageID,
      })),
  ]
}

/** Exact root-only automatic-compaction permit, consumed only after durable action membership exists. */
export const preauthorizeCompaction = Effect.fn("SessionHandoffRecoveryQueue.preauthorizeCompaction")(function* (
  database: Connection,
  sessionID: string,
  messageID: string,
) {
  const frame = yield* CurrentFrame
  if (
    !frame ||
    frame.sessionID !== sessionID ||
    frame.root.sessionID !== sessionID ||
    !(yield* authentic(database, frame, true))
  )
    return
  const owner = yield* stamp(database, frame)
  if (
    !owner ||
    owner.state !== "owned" ||
    owner.internal_user_id !== null ||
    owner.input_proof !== (yield* inputProof(database, sessionID))
  )
    return
  yield* database.db.run(sql`UPDATE session_handoff_recovery_queue_block SET internal_user_id=${messageID}
    WHERE session_id=${sessionID} AND recovery_request_id=${frame.recoveryRequestID} AND state='owned'`)
})
export const compacted = Effect.fn("SessionHandoffRecoveryQueue.compacted")(function* (
  database: Connection,
  sessionID: string,
  messageID: string,
) {
  const frame = yield* CurrentFrame
  if (!frame || frame.sessionID !== sessionID || frame.root.sessionID !== sessionID) return
  const owner = yield* stamp(database, frame)
  if (!owner || owner.state !== "owned" || owner.internal_user_id !== messageID) return
  const proof = yield* database.db
    .get(sql`SELECT 1 FROM session_handoff_compaction WHERE message_id=${messageID} AND session_id=${sessionID}
    AND reservation=${frame.reservation} AND queue_id=${frame.root.queueID} AND user_message_id=${frame.root.userMessageID}`)
  if (!proof) return yield* Effect.die("Compaction recovery permit has no action membership")
  yield* database.db
    .run(sql`UPDATE session_handoff_recovery_queue_block SET internal_user_id=NULL,input_proof=${yield* inputProof(database, sessionID)}
    WHERE session_id=${sessionID} AND recovery_request_id=${frame.recoveryRequestID} AND state='owned'`)
})

function stamp(database: Connection, frame: Frame) {
  return database.db.get<Stamp>(sql`SELECT * FROM session_handoff_recovery_queue_block
    WHERE session_id=${frame.sessionID} AND recovery_request_id=${frame.recoveryRequestID}`)
}
const authentic = Effect.fnUntraced(function* (database: Connection, frame: Frame, active: boolean) {
  return !!(yield* database.db.get(sql`SELECT 1 FROM runtime_execution x
    JOIN session_handoff_root r ON r.session_id=${frame.root.sessionID} AND r.reservation=${frame.reservation}
    JOIN session_handoff_control c ON c.session_id=r.session_id AND c.reservation=r.reservation
    JOIN session_handoff_request q ON q.request_id=${frame.recoveryRequestID} AND q.session_id=r.session_id AND q.queue_id=r.queue_id AND q.user_message_id=r.user_message_id
    WHERE x.session_id=${frame.sessionID} AND x.owner_lineage=${frame.ownerLineage} AND x.owner_instance=${frame.ownerInstance}
      AND x.fence=${frame.fence} AND x.desired_active=1 AND x.state IN ('active','waiting_child','completed')
      AND (${active ? 1 : 0}=0 OR x.state IN ('active','waiting_child'))
      AND r.queue_id=${frame.root.queueID} AND r.user_message_id=${frame.root.userMessageID} AND r.state IN ('active','terminal')
      AND r.rowid=(SELECT MAX(rowid) FROM session_handoff_root WHERE session_id=r.session_id AND state <> 'aborted')
      AND json_extract(c.data,'$.recoveryRevision')=${frame.recoveryRevision}`))
})

const inputProof = Effect.fnUntraced(function* (database: Connection, sessionID: string) {
  const session = yield* database.db.get(
    sql`SELECT parent_id,project_id,directory,workspace_id,agent,model,permission,metadata,time_archived FROM session WHERE id=${sessionID}`,
  )
  const runtime = yield* database.db.get(
    sql`SELECT parent_session_id,parent_message_id,parent_call_id,parent_mode FROM runtime_execution WHERE session_id=${sessionID}`,
  )
  const messages = yield* database.db.all(
    sql`SELECT id,json_remove(data,'$.summary') AS data FROM message WHERE session_id=${sessionID} AND json_extract(data,'$.role')='user' ORDER BY time_created,id`,
  )
  const parts = yield* database.db.all(sql`SELECT p.id,p.message_id,
    CASE WHEN json_extract(p.data,'$.type')='compaction' AND json_extract(p.data,'$.auto')=1
      AND EXISTS (SELECT 1 FROM session_handoff_compaction c WHERE c.message_id=p.message_id AND c.session_id=p.session_id AND c.kind='request')
      THEN json_remove(p.data,'$.tail_start_id') ELSE p.data END AS data
    FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=${sessionID} AND json_extract(m.data,'$.role')='user' ORDER BY p.message_id,p.id`)
  return JSON.stringify({ session, runtime, messages, parts })
})
