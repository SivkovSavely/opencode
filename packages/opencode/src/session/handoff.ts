import { Database } from "@opencode-ai/core/database/database"
import { SessionHandoffEnrollment } from "@opencode-ai/core/session/handoff-enrollment"
import { SessionHandoffControl } from "@opencode-ai/core/session/handoff-control"
import { SessionHandoffRecovery } from "@opencode-ai/core/session/handoff-recovery"
import { SessionHandoffRecoveryQueue } from "@opencode-ai/core/session/handoff-recovery-queue"
import { SessionHandoffStore } from "@opencode-ai/core/session/handoff-store"
import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { SessionID } from "./schema"
import { Session } from "./session"
import { SessionPrompt } from "./prompt"
import { InstanceStore } from "@/project/instance-store"
import { Agent } from "@/agent/agent"

export class HandoffError extends Schema.TaggedErrorClass<HandoffError>()("SessionHandoffError", {
  code: SessionHandoffV1.ErrorCode,
  message: Schema.String,
}) {}

// Local only. Caller identities are never accepted as evidence of live ownership.
export const candidate = Effect.fn("SessionHandoff.candidate")(function* (sessionID: SessionID) {
  const database = yield* Database.Service
  const runtime = yield* RuntimeLifecycle.Service
  const context = yield* InstanceState.context
  const fence = yield* runtime.ownershipFence(sessionID)
  if (fence === undefined || runtime.identity.instance === "unavailable") return null
  return yield* SessionHandoffEnrollment.candidate(database, sessionID, context.directory, {
    ownerLineage: runtime.identity.lineage,
    ownerInstance: runtime.identity.instance,
    fence,
  })
})

export const enroll = Effect.fn("SessionHandoff.enroll")(function* (sessionID: SessionID, input: unknown) {
  const request = yield* decode(SessionHandoffV1.EnrollRequest, input)
  yield* scope(sessionID)
  const database = yield* Database.Service
  const runtime = yield* RuntimeLifecycle.Service
  const context = yield* InstanceState.context
  // Exact persisted retry identity is compared by the transaction even if the local lease ended.
  const fence = yield* runtime.ownershipFence(sessionID)
  const result = yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const connection = { db: tx }
        const retry = yield* SessionHandoffStore.receipt(connection, sessionID, request.requestID)
        const result = yield* SessionHandoffEnrollment.enroll(
          connection,
          sessionID,
          context.directory,
          {
            ownerLineage: runtime.identity.lineage,
            ownerInstance: runtime.identity.instance,
            fence: fence ?? -1,
          },
          request,
        )
        // A retry never recaptures a different generation's mutable closure.
        if (
          !retry &&
          result.state === "enrolled" &&
          !(yield* SessionHandoffRecovery.retained(connection, {
            sessionID,
            queueID: request.queueID,
            userMessageID: request.userMessageID,
          }))
        ) {
          yield* SessionHandoffRecovery.retain(
            connection,
            { sessionID, queueID: request.queueID, userMessageID: request.userMessageID },
            yield* SessionHandoffRecovery.inspect(
              connection,
              sessionID,
              runtime.verifyOwner,
              RuntimeLifecycle.processLiveness,
              request,
            ),
          )
        }
        return result
      }),
    { behavior: "immediate" },
  )
  return yield* Schema.decodeUnknownEffect(SessionHandoffV1.EnrollmentReceipt)(result)
}, Effect.mapError(domainError))

export const receipt = Effect.fn("SessionHandoff.receipt")(function* (sessionID: SessionID, requestID: string) {
  yield* scope(sessionID)
  const database = yield* Database.Service
  const value = yield* SessionHandoffStore.receipt(database, sessionID, requestID)
  if (!value) return yield* new HandoffError({ code: "not_found", message: "No admitted request has this identity" })
  return yield* Schema.decodeUnknownEffect(SessionHandoffV1.Receipt)(value)
}, Effect.mapError(domainError))

export const modelControl = Effect.fn("SessionHandoff.modelControl")(function* (sessionID: SessionID, input: unknown) {
  const request = yield* decode(SessionHandoffV1.ControlRequest, input)
  const context = yield* scope(sessionID)
  const database = yield* Database.Service
  const reconciled = yield* SessionHandoffControl.reconcileObsolete(database, sessionID, context.directory, request)
  if (reconciled) return yield* Schema.decodeUnknownEffect(SessionHandoffV1.ControlReceipt)(reconciled)
  yield* validateSelection(request.target)
  return yield* SessionHandoffControl.admit(database, sessionID, context.directory, request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SessionHandoffV1.ControlReceipt)),
  )
}, Effect.mapError(domainError))

export const recover = Effect.fn("SessionHandoff.recover")(function* (sessionID: SessionID, input: unknown) {
  const request = yield* decode(SessionHandoffV1.RecoveryRequest, input)
  const context = yield* scope(sessionID)
  const database = yield* Database.Service
  const runtime = yield* RuntimeLifecycle.Service
  const identity = {
    sessionID,
    directory: context.directory,
    queueID: request.expected.queueID,
    userMessageID: request.expected.userMessageID,
    requestID: request.requestID,
    kind: "recovery" as const,
    payload: request,
  }
  const retry = yield* SessionHandoffStore.retryRequest(database, identity)
  if (retry) return yield* Schema.decodeUnknownEffect(SessionHandoffV1.ControlReceipt)(retry)
  yield* validateSelection(request.target)
  const prompt = yield* SessionPrompt.Service
  const instances = yield* InstanceStore.Service
  const agents = yield* Agent.Service
  const outcome = yield* runtime.withDurableAdmission(
    database.db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const connection = { db: tx }
          const retry = yield* SessionHandoffStore.retryRequest(connection, identity)
          if (retry)
            return { receipt: yield* Schema.decodeUnknownEffect(SessionHandoffV1.ControlReceipt)(retry), records: [] }
          const current = yield* SessionHandoffControl.execution(connection, sessionID, context.directory, {
            queueID: request.expected.queueID,
            userMessageID: request.expected.userMessageID,
          })
          if (!current?.isCurrent)
            return yield* new HandoffError({
              code: "stale_context",
              message: "Recovery action is not the current root generation",
            })
          if (
            canonical(current.identity) !== canonical(request.expected) ||
            current.recoveryRevision !== request.expectedRecoveryRevision
          )
            return yield* new HandoffError({ code: "stale_context", message: "Recovery identity or revision changed" })
          const snapshot = yield* SessionHandoffRecovery.inspect(
            connection,
            sessionID,
            runtime.verifyOwner,
            RuntimeLifecycle.processLiveness,
            identity,
          )
          yield* SessionHandoffRecovery.retain(connection, identity, snapshot)
          // Resolve the retained child configuration without changing any child's selection or authorization.
          for (const child of snapshot.descendants) {
            if (child.proof !== "verified" || child.state === "terminal") continue
            if (!child.selection || !child.agent)
              return yield* new HandoffError({ code: "unsupported_child", message: "Child configuration is missing" })
            yield* validateSelection(child.selection).pipe(
              Effect.mapError(
                () =>
                  new HandoffError({
                    code: "unsupported_child",
                    message: "Original child model or variant is unavailable",
                  }),
              ),
            )
            const agent = yield* agents.get(child.agent)
            if (!agent)
              return yield* new HandoffError({
                code: "unsupported_child",
                message: "Original child agent is unavailable",
              })
          }
          const now = Date.now()
          const initial: SessionHandoffV1.ControlReceipt = {
            kind: "recovery",
            requestID: request.requestID,
            sessionID,
            directory: context.directory,
            expected: request.expected,
            target: request.target,
            state: "pending",
            reason: null,
            boundary: null,
            dispatch: "none",
            recoveryFence: null,
            interruptedResources: snapshot.interruptedResources,
            children: snapshot.descendants.flatMap((child) =>
              child.link && child.fence !== null
                ? [
                    {
                      link: child.link,
                      priorFence: child.fence,
                      recoveryFence: child.fence,
                      state: child.state === "terminal" ? ("terminal" as const) : ("held" as const),
                      resultAssistantMessageID: child.resultAssistantMessageID,
                      resultState: child.resultState,
                      interruptedResources: child.interruptedResources,
                    },
                  ]
                : [],
            ),
            createdAt: now,
            updatedAt: now,
          }
          if (current.state === "terminal" && snapshot.descendants.every((child) => child.state === "terminal")) {
            if (request.children.length !== 0)
              return yield* new HandoffError({
                code: "stale_context",
                message: "Terminal reconciliation cannot claim children",
              })
            const value = yield* SessionHandoffRecovery.reconcileTerminal(
              connection,
              { ...identity, expectedDescendantDigest: request.expectedDescendantDigest },
              runtime.verifyOwner,
              (db) =>
                SessionHandoffStore.recordRequest(db, identity, {
                  ...initial,
                  state: "expired",
                  reason: "terminal_action",
                }),
              RuntimeLifecycle.processLiveness,
            )
            yield* SessionHandoffRecovery.retain(
              connection,
              identity,
              yield* SessionHandoffRecovery.inspect(
                connection,
                sessionID,
                runtime.verifyOwner,
                RuntimeLifecycle.processLiveness,
                identity,
              ),
            )
            return { receipt: yield* Schema.decodeUnknownEffect(SessionHandoffV1.ControlReceipt)(value), records: [] }
          }
          const claimed = yield* SessionHandoffRecovery.claim(
            connection,
            {
              sessionID,
              expectedDescendantDigest: request.expectedDescendantDigest,
              children: request.children,
              owner: { ...runtime.identity, process: RuntimeLifecycle.processIdentity() },
            },
            runtime.verifyOwner,
            (db) =>
              Effect.gen(function* () {
                // The runtime CAS may retire the old identity via trigger; claimRecovery validates that exact retirement.
                const rechecked = yield* SessionHandoffControl.execution(db, sessionID, context.directory, {
                  queueID: identity.queueID,
                  userMessageID: identity.userMessageID,
                })
                if (!rechecked || rechecked.recoveryRevision !== request.expectedRecoveryRevision)
                  return yield* new HandoffError({
                    code: "stale_context",
                    message: "Recovery revision changed during claim",
                  })
                if (current.state === "terminal") {
                  if (canonical(rechecked.identity) !== canonical(request.expected) || rechecked.state !== "terminal")
                    return yield* new HandoffError({ code: "stale_context", message: "Terminal root identity changed" })
                  yield* SessionHandoffStore.recordRequest(db, identity, initial)
                  return null
                }
                const owner = yield* db.db.get<{ owner_lineage: string; owner_instance: string; fence: number }>(
                  sql`SELECT owner_lineage,owner_instance,fence FROM runtime_execution WHERE session_id = ${sessionID}`,
                )
                if (!owner) return yield* new HandoffError({ code: "stale_fence", message: "Missing root runtime" })
                yield* SessionHandoffStore.recordRequest(db, identity, initial)
                return yield* SessionHandoffControl.claimRecovery(
                  db,
                  identity,
                  request.expected,
                  { ownerLineage: owner.owner_lineage, ownerInstance: owner.owner_instance, fence: owner.fence },
                  request.target,
                  request.requestID,
                )
              }),
            RuntimeLifecycle.processLiveness,
          )
          const boundary =
            claimed.root === null ? null : yield* Schema.decodeUnknownEffect(SessionHandoffV1.Boundary)(claimed.root)
          const applied = {
            ...initial,
            state: current.state === "terminal" ? ("expired" as const) : ("applied" as const),
            reason: current.state === "terminal" ? "terminal_action" : null,
            boundary,
            recoveryFence: claimed.records.find((record) => record.sessionID === sessionID)?.fence ?? null,
            children: [...initial.children.filter((child) => child.state === "terminal"), ...claimed.children],
            updatedAt: Date.now(),
          }
          yield* SessionHandoffStore.appendReceipt(connection, identity, initial, applied)
          yield* SessionHandoffRecovery.retain(
            connection,
            identity,
            yield* SessionHandoffRecovery.inspect(
              connection,
              sessionID,
              runtime.verifyOwner,
              RuntimeLifecycle.processLiveness,
              identity,
            ),
          )
          const records = yield* Effect.forEach(claimed.records, (record) =>
            Effect.gen(function* () {
              return {
                ...record,
                recoveryQueueFrame: yield* SessionHandoffRecoveryQueue.frame(
                  connection,
                  identity,
                  request.requestID,
                  record.sessionID,
                ),
              }
            }),
          )
          return { receipt: applied, records }
        }),
      { behavior: "immediate" },
    ),
  )
  if (outcome.records.length === 0) return outcome.receipt
  const capture = (failed: boolean, db: SessionHandoffRecovery.Connection, final = false) =>
    Effect.gen(function* () {
      const latest = yield* SessionHandoffStore.receipt(db, sessionID, request.requestID)
      if (!latest) return
      const stored = yield* Schema.decodeUnknownEffect(SessionHandoffV1.ControlReceipt)(latest)
      const action = yield* SessionHandoffControl.execution(db, sessionID, context.directory, {
        queueID: identity.queueID,
        userMessageID: identity.userMessageID,
      })
      if (!action?.isCurrent) return
      const actual = yield* SessionHandoffRecovery.inspect(
        db,
        sessionID,
        (id) => runtime.verifyOwner(id, db),
        RuntimeLifecycle.processLiveness,
        identity,
      )
      const prior = yield* SessionHandoffRecovery.retained(db, identity)
      if (
        prior &&
        prior.descendants.some(
          (child) =>
            child.link &&
            !actual.descendants.some(
              (item) =>
                canonical(item.link) === canonical(child.link) &&
                item.agent === child.agent &&
                canonical(item.selection) === canonical(child.selection),
            ),
        )
      )
        return yield* new HandoffError({
          code: "history_unavailable",
          message: "Original descendant evidence changed before capture",
        })
      yield* SessionHandoffRecovery.retain(db, identity, actual)
      const value = {
        ...stored,
        reason: failed ? "continuation_failed" : stored.reason,
        updatedAt: Date.now(),
        children: stored.children.map((child) => {
          const observed = actual.descendants.find((item) => item.childSessionID === child.link.childSessionID)
          return {
            ...child,
            state:
              observed?.state === "terminal" && (final || failed)
                ? ("terminal" as const)
                : failed
                  ? ("failed" as const)
                  : ("continuing" as const),
            resultAssistantMessageID: observed?.resultAssistantMessageID ?? child.resultAssistantMessageID,
            resultState: observed?.resultState ?? child.resultState,
            interruptedResources: observed?.interruptedResources ?? child.interruptedResources,
          }
        }),
      }
      yield* SessionHandoffStore.appendReceipt(db, identity, latest, value)
    }).pipe(Effect.orDie)
  const update = (failed: boolean) =>
    database.db.transaction((tx) => capture(failed, { db: tx }), { behavior: "immediate" }).pipe(Effect.orDie)
  // Only existing persisted inputs are resumed. No prompt, queue entry, or Task call is admitted here.
  yield* runtime
    .runHandoffRecovery(
      outcome.records,
      (record) =>
        instances.provide(
          { directory: record.directory },
          prompt
            .recover(SessionID.make(record.sessionID), record.fence)
            .pipe(
              Effect.flatMap((result) =>
                record.sessionID === sessionID && (!result || result.info.role !== "assistant" || result.info.error)
                  ? Effect.die(new Error("Guarded root continuation did not persist a successful assistant result"))
                  : update(false),
              ),
            ),
        ),
      () => update(true),
      (connection) => capture(false, connection, true),
    )
    .pipe(Effect.catchCause(() => update(true)))
  return outcome.receipt
}, Effect.mapError(domainError))

export const execution = Effect.fn("SessionHandoff.execution")(function* (
  sessionID: SessionID,
  selector?: { queueID?: string; userMessageID?: string },
) {
  if (selector && (!selector.queueID || !selector.userMessageID))
    return yield* new HandoffError({
      code: "incomplete_action_selector",
      message: "Both action selectors are required",
    })
  const context = yield* scope(sessionID)
  const database = yield* Database.Service
  const runtime = yield* RuntimeLifecycle.Service
  const key =
    selector?.queueID && selector.userMessageID
      ? { queueID: selector.queueID, userMessageID: selector.userMessageID }
      : undefined
  const control = yield* SessionHandoffControl.execution(database, sessionID, context.directory, key)
  const ownerLiveness = yield* runtime.verifyOwner(sessionID)
  const owner = yield* database.db.get<{ owner_lineage: string; owner_instance: string; fence: number }>(
    sql`SELECT owner_lineage,owner_instance,fence FROM runtime_execution WHERE session_id = ${sessionID}`,
  )
  const current =
    control?.isCurrent === true &&
    owner?.owner_lineage === control.identity.ownerLineage &&
    owner.owner_instance === control.identity.ownerInstance &&
    owner.fence === control.identity.fence
  const evidence = control
    ? yield* SessionHandoffRecovery.retained(database, {
        sessionID,
        queueID: control.identity.queueID,
        userMessageID: control.identity.userMessageID,
      })
    : undefined
  const closure =
    current && (!selector || !evidence?.sealed)
      ? yield* SessionHandoffRecovery.inspect(
          database,
          sessionID,
          runtime.verifyOwner,
          RuntimeLifecycle.processLiveness,
          { queueID: control.identity.queueID, userMessageID: control.identity.userMessageID },
        )
      : evidence
  if (control && !current && !closure)
    return yield* new HandoffError({
      code: "history_unavailable",
      message: "Retained descendant evidence is unavailable",
    })
  const descendants = closure?.descendants ?? []
  const resources = closure?.interruptedResources ?? []
  const proof = descendants.find((child) => child.proof !== "verified")?.proof
  const unresolved = [...resources, ...descendants.flatMap((child) => child.interruptedResources)].some(
    (item) => item.liveness !== "dead" && item.liveness !== "not_applicable",
  )
  const eligibility = !control
    ? "not_enrolled"
    : !current || selector
      ? "stale"
      : control.state === "terminal"
        ? "terminal"
        : control.state === "invalidated"
          ? "stale"
          : proof && proof !== "verified"
            ? proof
            : unresolved
              ? "unresolved_resource"
              : ownerLiveness !== "dead"
                ? ownerLiveness === "live"
                  ? "owner_live"
                  : "owner_unknown"
                : descendants.some((child) => child.state !== "terminal" && child.ownerLiveness !== "dead")
                  ? descendants.some((child) => child.state !== "terminal" && child.ownerLiveness === "live")
                    ? "owner_live"
                    : "owner_unknown"
                  : "eligible"
  const notifications = control
    ? yield* database.db.all<{
        message_id: string
        classification: string
        data: string
        user_message_id: string | null
      }>(
        sql`SELECT n.message_id,n.classification,n.data,n.user_message_id FROM session_handoff_notification n JOIN session_handoff_control c ON c.session_id = n.session_id AND c.reservation = n.reservation WHERE c.session_id = ${sessionID} AND c.queue_id = ${control.identity.queueID} AND c.user_message_id = ${control.identity.userMessageID} ORDER BY n.rowid`,
      )
    : []
  const taskNotifications = yield* Effect.forEach(notifications, (row) =>
    Effect.gen(function* () {
      const evidence = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            link: Schema.Struct({
              parentSessionID: Schema.String,
              parentMessageID: Schema.String,
              parentCallID: Schema.String,
              childSessionID: Schema.String,
              childUserMessageID: Schema.String,
            }),
          }),
        ),
      )(row.data)
      const message = yield* database.db.get(
        sql`SELECT 1 FROM message WHERE id = ${row.message_id} AND session_id = ${sessionID}`,
      )
      const member = control?.assistants.find((item) => item.parentUserMessageID === row.message_id)
      return {
        messageID: row.message_id,
        link: {
          parentSessionID: evidence.link.parentSessionID,
          parentAssistantMessageID: evidence.link.parentMessageID,
          parentCallID: evidence.link.parentCallID,
          childSessionID: evidence.link.childSessionID,
          childUserMessageID: evidence.link.childUserMessageID,
          mode: "background" as const,
        },
        queueID: control?.identity.queueID,
        authorizationUserMessageID: row.user_message_id,
        classification: row.classification === "in_action" ? "in_action" : "later_input",
        epochSequence: member?.epochSequence ?? null,
        state: message ? "delivered" : current && control?.state === "held" ? "held" : "pending",
      }
    }),
  )
  return yield* Schema.decodeUnknownEffect(SessionHandoffV1.ExecutionView)({
    sessionID,
    directory: context.directory,
    enrolled: !!control,
    identity: control?.identity ?? null,
    state: control?.state ?? "not_enrolled",
    ownerLiveness: current || !control ? ownerLiveness : "unknown",
    recoveryRevision: control?.recoveryRevision ?? null,
    effectiveSelection: control?.effectiveSelection ?? null,
    baselineSelection: control?.baselineSelection ?? null,
    pendingRequestID: control?.pendingRequestID ?? null,
    boundaries: control?.boundaries ?? [],
    assistants: control?.assistants.map((item) => ({ ...item, queueID: control.identity.queueID })) ?? [],
    summaries: control?.summaries.map((item) => ({ ...item, queueID: control.identity.queueID })) ?? [],
    interruptedResources: resources,
    eligibility,
    descendants,
    descendantDigest: closure?.descendantDigest ?? null,
    candidate: !control && !selector ? yield* candidate(sessionID) : null,
    taskNotifications,
    viewKind: selector ? "historical" : "current",
    isCurrent: current,
  })
}, Effect.mapError(domainError))

const scope = Effect.fn("SessionHandoff.scope")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const session = yield* sessions
    .get(sessionID)
    .pipe(Effect.mapError(() => new HandoffError({ code: "not_found", message: "Session not found" })))
  const context = yield* InstanceState.context
  const workspaceID = yield* InstanceState.workspaceID
  if (session.directory !== context.directory)
    return yield* new HandoffError({ code: "wrong_directory", message: "Session is outside the canonical directory" })
  if (session.projectID !== context.project.id || session.workspaceID !== workspaceID)
    return yield* new HandoffError({
      code: "wrong_session",
      message: "Session is outside the current project or workspace",
    })
  return context
})

const validateSelection = Effect.fn("SessionHandoff.validateSelection")(function* (
  selection: SessionHandoffV1.Selection,
) {
  const providers = yield* Provider.Service
  const model = yield* providers
    .getModel(ProviderV2.ID.make(selection.providerID), ModelV2.ID.make(selection.modelID))
    .pipe(
      Effect.mapError(() => new HandoffError({ code: "unsupported_model", message: "Target model is not configured" })),
    )
  if (selection.variant !== "default" && !Object.hasOwn(model.variants ?? {}, selection.variant))
    return yield* new HandoffError({ code: "unsupported_variant", message: "Target variant is not configured" })
})

function decode<S extends Schema.Top>(schema: S, input: unknown) {
  return Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () => new HandoffError({ code: "invalid_request", message: "Request does not match the handoff contract" }),
    ),
  )
}

function domainError(error: unknown): HandoffError {
  if (error instanceof HandoffError) return error
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Schema.decodeUnknownOption(SessionHandoffV1.ErrorCode)(error.code)
      : Option.none()
  const value = Option.getOrElse(code, () => "history_unavailable" as const)
  return new HandoffError({ code: value, message: `Handoff state could not be verified: ${value}` })
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
}

export * as SessionHandoff from "./handoff"
