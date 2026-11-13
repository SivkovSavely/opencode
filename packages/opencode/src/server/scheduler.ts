export * as ServerScheduler from "./scheduler"

import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { Cause, Context, Effect, Latch, Layer, Option, Result, Schema, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionScheduleTable, SessionScheduleOccurrenceTable } from "@opencode-ai/core/session/schedule.sql"
import { SessionQueueTable } from "@opencode-ai/core/session/queue.sql"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { SessionV1 } from "@opencode-ai/schema/v1/session"
import { InstanceStore } from "@/project/instance-store"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { SessionPrompt } from "@/session/prompt"
import { SessionQueue } from "@/session/queue"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionID } from "@/session/schema"
import { ScheduleTime } from "@/session/schedule-time"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeLifecycle } from "./runtime-lifecycle"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { isDeepStrictEqual } from "node:util"

type Schedule = typeof SessionScheduleTable.$inferSelect
type Occurrence = typeof SessionScheduleOccurrenceTable.$inferSelect
type StepResult = { id: string; blocked: boolean; occurrenceID?: string; accepted?: string }
const ClaimOwner = Schema.fromJsonString(Schema.Struct({ process: Schema.optional(RuntimeLifecycle.ProcessIdentity) }))

function executionBlocked(
  execution: { state: string; desired_active: number; owner_lineage: string; owner_instance: string } | undefined,
  runtime?: RuntimeLifecycle.Interface,
) {
  if (!execution) return false
  if (["recovery_needed", "parked", "cancelled"].includes(execution.state)) return true
  // An untracked runtime owns no durable execution, including records whose owner
  // cannot be identified. Missing/finished execution records still permit delivery.
  return (
    ["active", "waiting_child", "retry_wait"].includes(execution.state) &&
    execution.desired_active === 1 &&
    (!runtime ||
      runtime.identity.instance === "unavailable" ||
      execution.owner_lineage !== runtime.identity.lineage ||
      execution.owner_instance !== runtime.identity.instance)
  )
}

// Each step is one SQLite IMMEDIATE transaction, including durable queue admission.
// A crash rolls both records back or commits both: no expiring lease can fence out a
// still-live dispatcher, and recovery never guesses whether a model request ran.
export function engine(input: {
  database: Database.Interface
  startup: number
  runtime?: RuntimeLifecycle.Interface
  store?: InstanceStore.Interface
  prepare?: (
    schedule: Schedule,
    session: typeof SessionTable.$inferSelect,
  ) => Effect.Effect<SessionQueueV1.Payload, unknown>
  dispatch: (
    schedule: Schedule,
    occurrence: Occurrence,
    session: typeof SessionTable.$inferSelect,
    prepared?: Result.Result<SessionQueueV1.Payload, unknown>,
  ) => Effect.Effect<"busy" | "idle", unknown>
  changed?: (sessionID: SessionID) => Effect.Effect<void>
}) {
  const db = input.database.db
  const staleInstance = new Error("Prepared scheduler instance was disposed")
  const admit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    input.runtime ? input.runtime.withDurableAdmission(effect) : effect
  const notifications = new Set<SessionID>()
  const notify = Effect.gen(function* () {
    const ids = [...notifications]
    notifications.clear()
    if (input.changed) for (const id of ids) yield* input.changed(id)
  })
  const progress = { reconcile: "" }
  const candidate = (now: number, excluded: readonly string[], occurrences: readonly string[]) =>
    db.get<{ id: string; scheduled: number; occurrence: string | null }>(sql`
    SELECT s.id, s.next AS scheduled, NULL AS occurrence, s.definition_order AS definition_order
    FROM session_schedule s WHERE s.status = 'active' AND s.next <= ${now}
      AND s.id NOT IN (SELECT value FROM json_each(${JSON.stringify(excluded)}))
    UNION ALL
    SELECT s.id, o.scheduled, o.id AS occurrence, s.definition_order AS definition_order
    FROM session_schedule_occurrence o JOIN session_schedule s ON s.id = o.schedule_id
    WHERE s.status = 'active' AND o.state = 'deferred'
      AND s.id NOT IN (SELECT value FROM json_each(${JSON.stringify(excluded)}))
      AND o.id NOT IN (SELECT value FROM json_each(${JSON.stringify(occurrences)}))
    ORDER BY scheduled, definition_order LIMIT 1
  `)
  // Configuration and instance bootstrap may perform I/O. Resolve before acquiring
  // either admission or SQLite's writer lock, then revalidate the selected snapshot.
  const prepare = (now: number, excluded: readonly string[], occurrences: readonly string[]) =>
    Effect.gen(function* () {
      const resolve = input.prepare
      if (!resolve) return
      const selected = yield* candidate(now, excluded, occurrences)
      if (!selected) return
      const schedule = yield* db
        .select()
        .from(SessionScheduleTable)
        .where(eq(SessionScheduleTable.id, selected.id))
        .get()
      if (!schedule) return
      const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, schedule.session_id)).get()
      if (!session) return
      // Discarded missed ticks need no instance, model/config or legacy queue I/O.
      if (!selected.occurrence && selected.scheduled < input.startup && schedule.input.missed === "none")
        return { selected, schedule, session, result: undefined, instance: undefined, invalidated: { value: false } }
      const invalidated = { value: false }
      const onEvent = (event: GlobalEvent) => {
        if (event.directory === session.directory && event.payload?.type === "server.instance.disposed")
          invalidated.value = true
      }
      if (input.store) {
        yield* Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", onEvent)),
          () => Effect.sync(() => GlobalBus.off("event", onEvent)),
        )
      }
      const loaded: { instance?: InstanceContext } = {}
      const result = yield* Effect.gen(function* () {
        loaded.instance = input.store ? yield* input.store.load({ directory: session.directory }) : undefined
        const preparation = resolve(schedule, session)
        return yield* input.store ? preparation.pipe(Effect.provideService(InstanceRef, loaded.instance)) : preparation
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(Cause.squash(cause)),
        ),
        Effect.result,
      )
      return {
        selected,
        schedule,
        session,
        result,
        instance: loaded.instance,
        invalidated,
      }
    })
  const reconcile = Effect.gen(function* () {
    const page = () =>
      db
        .select()
        .from(SessionScheduleOccurrenceTable)
        .where(
          and(
            inArray(SessionScheduleOccurrenceTable.state, ["accepted", "uncertain"]),
            gt(SessionScheduleOccurrenceTable.id, progress.reconcile),
          ),
        )
        .orderBy(SessionScheduleOccurrenceTable.id)
        .limit(32)
        .all()
    const first = yield* page()
    if (!first.length) progress.reconcile = ""
    const accepted = first.length ? first : yield* page()
    for (const occurrence of accepted) {
      progress.reconcile = occurrence.id
      const queued = yield* db.select().from(SessionQueueTable).where(eq(SessionQueueTable.id, occurrence.id)).get()
      const schedule = yield* db
        .select()
        .from(SessionScheduleTable)
        .where(eq(SessionScheduleTable.id, occurrence.schedule_id))
        .get()
      if (!schedule) continue
      const matches =
        queued?.session_id === schedule.session_id &&
        queued.payload.kind === "prompt" &&
        queued.origin?.type === "scheduled" &&
        queued.origin.scheduleID === schedule.id &&
        queued.origin.occurrenceID === occurrence.id
      if (matches && queued.state === "delivered" && queued.message_id) {
        yield* db
          .update(SessionScheduleOccurrenceTable)
          .set({ state: "delivered", message_id: queued.message_id, processed: Date.now(), error: null })
          .where(eq(SessionScheduleOccurrenceTable.id, occurrence.id))
          .run()
        yield* db
          .update(SessionScheduleTable)
          .set({ completed: sql`${SessionScheduleTable.completed} + 1` })
          .where(eq(SessionScheduleTable.id, schedule.id))
          .run()
        if (schedule.input.limit !== undefined && schedule.completed + 1 >= schedule.input.limit) {
          yield* db
            .update(SessionScheduleTable)
            .set({ status: "completed", next: null })
            .where(eq(SessionScheduleTable.id, schedule.id))
            .run()
          yield* db
            .update(SessionScheduleOccurrenceTable)
            .set({ state: "discarded", processed: Date.now(), error: "Successful delivery limit reached" })
            .where(
              and(
                eq(SessionScheduleOccurrenceTable.schedule_id, schedule.id),
                eq(SessionScheduleOccurrenceTable.state, "deferred"),
              ),
            )
            .run()
        }
        notifications.add(schedule.session_id)
        continue
      }
      const owner = queued?.state === "claimed" ? Schema.decodeUnknownOption(ClaimOwner)(queued.owner) : Option.none()
      const abandoned =
        Option.isSome(owner) && owner.value.process && RuntimeLifecycle.processLiveness(owner.value.process) === "dead"
      if (
        (!matches ||
          queued.state === "delivered" ||
          queued.state === "uncertain" ||
          queued.state === "deleted" ||
          abandoned) &&
        (occurrence.state !== "uncertain" || (matches && queued.state === "deleted") || !occurrence.error)
      ) {
        yield* db
          .update(SessionScheduleOccurrenceTable)
          .set({
            state: matches && queued.state === "deleted" ? "discarded" : "uncertain",
            processed: Date.now(),
            error:
              matches && queued.state === "deleted" ? null : "Admission has no conclusive materialization evidence",
          })
          .where(eq(SessionScheduleOccurrenceTable.id, occurrence.id))
          .run()
        notifications.add(schedule.session_id)
      }
    }
  })
  const step = (
    now: number,
    excluded: readonly string[] = [],
    excludedOccurrences: readonly string[] = [],
    reconcileFirst = true,
  ) =>
    Effect.gen(function* () {
      const prepared = yield* prepare(now, excluded, excludedOccurrences)
      return yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              if (reconcileFirst) yield* reconcile
              const selected = yield* candidate(now, excluded, excludedOccurrences)
              if (!selected) return undefined
              if (input.prepare && !isDeepStrictEqual(prepared?.selected, selected))
                return { id: selected.id, blocked: false }
              const schedule = yield* db
                .select()
                .from(SessionScheduleTable)
                .where(eq(SessionScheduleTable.id, selected.id))
                .get()
              if (!schedule) return undefined
              if (input.prepare && !isDeepStrictEqual(prepared?.schedule, schedule))
                return { id: schedule.id, blocked: false }
              const reserved = yield* db.get<{ count: number }>(
                sql`SELECT count(*) AS count FROM session_schedule_occurrence WHERE schedule_id = ${schedule.id} AND state IN ('accepted','uncertain')`,
              )
              const session = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, schedule.session_id))
                .get()
              if (input.prepare && !isDeepStrictEqual(prepared?.session, session))
                return { id: schedule.id, blocked: false }
              // Disposal invalidates prepared config/state. Never wait for its replacement
              // while holding SQLite or durable admission, and leave the cursor untouched.
              if (prepared?.invalidated.value) return { id: schedule.id, blocked: true }
              const retired = yield* db.get(
                sql`SELECT 1 FROM runtime_retirement WHERE session_id = ${schedule.session_id}`,
              )
              const execution = yield* db.get<{
                state: string
                desired_active: number
                owner_lineage: string
                owner_instance: string
              }>(
                sql`SELECT state, desired_active, owner_lineage, owner_instance FROM runtime_execution WHERE session_id = ${schedule.session_id}`,
              )
              if (
                !session ||
                session.time_archived !== null ||
                retired ||
                execution?.state === "cancelled" ||
                (process.env.OPENCODE_MANAGED_PROFILE === "1" && session.parent_id)
              ) {
                const error = retired
                  ? "Session root is retired"
                  : session?.time_archived !== null
                    ? "Session is archived or missing"
                    : execution?.state === "cancelled"
                      ? "Session was cancelled; resume the session and its queue before resuming this schedule"
                      : "Managed foreground child cannot accept scheduled inputs"
                yield* db
                  .insert(SessionScheduleOccurrenceTable)
                  .values({
                    id: `occ_${schedule.id}_${selected.scheduled}`,
                    schedule_id: schedule.id,
                    scheduled: selected.scheduled,
                    state: "failed",
                    processed: now,
                    error,
                  })
                  .onConflictDoUpdate({
                    target: SessionScheduleOccurrenceTable.id,
                    set: { state: "failed", processed: now, error },
                  })
                  .run()
                yield* db
                  .update(SessionScheduleOccurrenceTable)
                  .set({ state: "failed", processed: now, error })
                  .where(
                    and(
                      eq(SessionScheduleOccurrenceTable.schedule_id, schedule.id),
                      eq(SessionScheduleOccurrenceTable.state, "deferred"),
                    ),
                  )
                  .run()
                yield* db
                  .update(SessionScheduleTable)
                  .set({ status: "paused", next: null })
                  .where(eq(SessionScheduleTable.id, schedule.id))
                  .run()
                notifications.add(schedule.session_id)
                return { id: schedule.id, blocked: true }
              }
              if (
                schedule.input.limit !== undefined &&
                schedule.completed + (reserved?.count ?? 0) >= schedule.input.limit
              )
                return { id: schedule.id, blocked: true }
              if (executionBlocked(execution, input.runtime)) return { id: schedule.id, blocked: true }
              const occurrence: Occurrence = selected.occurrence
                ? ((yield* db
                    .select()
                    .from(SessionScheduleOccurrenceTable)
                    .where(eq(SessionScheduleOccurrenceTable.id, selected.occurrence))
                    .get()) ?? {
                    id: "",
                    schedule_id: schedule.id,
                    scheduled: selected.scheduled,
                    state: "pending",
                    processed: null,
                    message_id: null,
                    error: null,
                  })
                : {
                    id: `occ_${schedule.id}_${selected.scheduled}`,
                    schedule_id: schedule.id,
                    scheduled: selected.scheduled,
                    state: "pending",
                    processed: null,
                    message_id: null,
                    error: null,
                  }
              if (prepared?.invalidated.value) return { id: schedule.id, blocked: true }
              const calculated = yield* Effect.try({
                try: () => ScheduleTime.next(schedule.input.spec, schedule.anchor, selected.scheduled),
                catch: (error) => error,
              }).pipe(Effect.result)
              if (calculated._tag === "Failure") {
                const error = String(calculated.failure).slice(0, 2000)
                yield* db
                  .insert(SessionScheduleOccurrenceTable)
                  .values({ ...occurrence, state: "failed", processed: now, error })
                  .onConflictDoUpdate({
                    target: SessionScheduleOccurrenceTable.id,
                    set: { state: "failed", processed: now, error },
                  })
                  .run()
                yield* db
                  .update(SessionScheduleOccurrenceTable)
                  .set({ state: "failed", processed: now, error })
                  .where(
                    and(
                      eq(SessionScheduleOccurrenceTable.schedule_id, schedule.id),
                      eq(SessionScheduleOccurrenceTable.state, "deferred"),
                    ),
                  )
                  .run()
                yield* db
                  .update(SessionScheduleTable)
                  .set({ status: "paused" })
                  .where(eq(SessionScheduleTable.id, schedule.id))
                  .run()
                notifications.add(schedule.session_id)
                return { id: schedule.id, blocked: true }
              }
              const next = calculated.success
              if (!selected.occurrence) {
                yield* db.insert(SessionScheduleOccurrenceTable).values(occurrence).run()
                yield* db
                  .update(SessionScheduleTable)
                  .set({ next })
                  .where(eq(SessionScheduleTable.id, schedule.id))
                  .run()
              }
              const missed =
                !selected.occurrence &&
                selected.scheduled < input.startup &&
                (schedule.input.missed === "none" || (schedule.input.missed === "latest" && next < input.startup))
              if (missed) {
                yield* db
                  .update(SessionScheduleOccurrenceTable)
                  .set({ state: "discarded", processed: now })
                  .where(eq(SessionScheduleOccurrenceTable.id, occurrence.id))
                  .run()
                notifications.add(schedule.session_id)
                return { id: schedule.id, blocked: false }
              }
              if (prepared?.invalidated.value) return yield* Effect.fail(staleInstance)
              // Without a loaded instance, dispatch cannot check live session state.
              // Preserve the bootstrap error instead of reloading under the writer lock.
              const result =
                input.store && prepared?.result && !prepared.instance && Result.isFailure(prepared.result)
                  ? prepared.result
                  : yield* Effect.suspend(() => {
                      const dispatch = input.dispatch(schedule, occurrence, session, prepared?.result)
                      return input.store
                        ? dispatch.pipe(Effect.provideService(InstanceRef, prepared?.instance))
                        : dispatch
                    }).pipe(Effect.result)
              if (prepared?.invalidated.value) return yield* Effect.fail(staleInstance)
              if (result._tag === "Failure") {
                if (result.failure instanceof RuntimeLifecycle.RuntimeDrainingError)
                  return yield* Effect.fail(result.failure)
                const admitted = yield* db
                  .select()
                  .from(SessionQueueTable)
                  .where(eq(SessionQueueTable.id, occurrence.id))
                  .get()
                const accepted =
                  admitted?.session_id === schedule.session_id &&
                  admitted.origin?.scheduleID === schedule.id &&
                  admitted.origin.occurrenceID === occurrence.id
                yield* db
                  .update(SessionScheduleOccurrenceTable)
                  .set({
                    state: accepted ? "accepted" : "failed",
                    processed: now,
                    error: accepted ? null : String(result.failure).slice(0, 2000),
                  })
                  .where(eq(SessionScheduleOccurrenceTable.id, occurrence.id))
                  .run()
                notifications.add(schedule.session_id)
                return { id: schedule.id, blocked: false }
              }
              const busy = result.success === "busy"
              const skip =
                schedule.input.sessionState === "busy" && !busy
                  ? "skipped_idle"
                  : schedule.input.sessionState === "idle" && busy
                    ? "skipped_busy"
                    : undefined
              const deferred = busy && schedule.input.deferUntilIdle && schedule.input.sessionState === "idle"
              if (deferred && occurrence.state === "deferred")
                return { id: schedule.id, blocked: true, occurrenceID: occurrence.id }
              yield* db
                .update(SessionScheduleOccurrenceTable)
                .set({ state: deferred ? "deferred" : (skip ?? "accepted"), processed: now })
                .where(eq(SessionScheduleOccurrenceTable.id, occurrence.id))
                .run()
              notifications.add(schedule.session_id)
              return {
                id: schedule.id,
                blocked: deferred,
                occurrenceID: deferred ? occurrence.id : undefined,
                accepted: !deferred && !skip ? occurrence.id : undefined,
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(
          admit,
          Effect.catch((error) =>
            error === staleInstance && prepared
              ? Effect.succeed({ id: prepared.schedule.id, blocked: true })
              : Effect.fail(error),
          ),
          Effect.map((result): StepResult | undefined => result),
        )
    }).pipe(
      Effect.scoped,
      Effect.tap(() => notify),
    )
  const reconcilePage = db
    .transaction(() => reconcile, { behavior: "immediate" })
    .pipe(
      admit,
      Effect.tap(() => notify),
    )
  const drain = (now: () => number = Date.now, onAccepted?: (id: string) => Effect.Effect<void, unknown>) =>
    Effect.gen(function* () {
      yield* reconcilePage
      const excluded: string[] = []
      const occurrences: string[] = []
      for (;;) {
        if (input.runtime && (yield* input.runtime.status()).state !== "running") return
        const result = yield* step(now(), excluded, occurrences, false)
        if (!result) return
        if (result.blocked && result.occurrenceID) occurrences.push(result.occurrenceID)
        if (result.blocked && !result.occurrenceID) excluded.push(result.id)
        if (result.accepted && onAccepted) yield* onAccepted(result.accepted)
        yield* Effect.yieldNow
      }
    })
  return { step, reconcile: reconcilePage, drain }
}

export class Service extends Context.Service<Service, { readonly start: Effect.Effect<void> }>()(
  "@opencode/ServerScheduler",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const store = yield* InstanceStore.Service
    const lifecycle = yield* RuntimeLifecycle.Service
    const prompt = yield* SessionPrompt.Service
    const queue = yield* SessionQueue.Service
    const status = yield* SessionStatus.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope
    const signal = yield* Latch.make()
    const startup = { time: 0 }
    const changed = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const session = yield* database.db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (session)
          yield* store.provide(
            { directory: session.directory },
            events
              .publish(Session.Event.Updated, { sessionID, info: Session.fromRow(session) })
              .pipe(Effect.provideService(WorkspaceRef, session.workspace_id ?? undefined)),
          )
      })
    const scheduler = engine({
      database,
      store,
      runtime: lifecycle,
      get startup() {
        return startup.time
      },
      prepare: (schedule, session) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(session.id)
          yield* queue.prepareScheduled(sessionID)
          const latestUser = yield* database.db
            .select()
            .from(MessageTable)
            .where(
              and(eq(MessageTable.session_id, sessionID), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`),
            )
            .orderBy(sql`${MessageTable.time_created} DESC`, sql`${MessageTable.id} DESC`)
            .limit(1)
            .get()
          const decoded = latestUser
            ? Schema.decodeUnknownOption(SessionV1.User)({ ...latestUser.data, id: latestUser.id, sessionID })
            : Option.none()
          const user = Option.getOrUndefined(decoded)
          const agent = session.agent
            ? yield* agents.get(session.agent)
            : user
              ? yield* agents.get(user.agent)
              : yield* agents.defaultInfo()
          if (!agent) return yield* Effect.fail(new Error("Scheduled agent is unavailable"))
          const model = session.model
            ? {
                providerID: ProviderV2.ID.make(session.model.providerID),
                modelID: ModelV2.ID.make(session.model.id),
              }
            : (agent.model ?? user?.model ?? (yield* provider.defaultModel()))
          const full = yield* provider.getModel(model.providerID, model.modelID)
          const same = agent.model?.providerID === model.providerID && agent.model?.modelID === model.modelID
          const variant =
            session.model?.variant ??
            (!session.model && !agent.model ? user?.model.variant : undefined) ??
            (same ? agent.variant : undefined) ??
            "default"
          if (variant !== "default" && !Object.hasOwn(full.variants ?? {}, variant))
            return yield* new SessionQueue.QueueError({
              reason: "invalid",
              message: `Variant not found: "${variant}" for ${model.providerID}/${model.modelID}`,
            })
          return {
            kind: "prompt" as const,
            agent: agent.name,
            model,
            variant,
            selection: { variant },
            parts: [{ type: "text" as const, text: schedule.input.message }],
          }
        }).pipe(Effect.provideService(WorkspaceRef, session.workspace_id ?? undefined)),
      dispatch: (schedule, occurrence, session, prepared) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(session.id)
          const currentExecution = yield* database.db.get(
            sql`SELECT 1 FROM runtime_execution WHERE session_id = ${sessionID} AND desired_active = 1 AND state IN ('active', 'waiting_child', 'retry_wait')`,
          )
          const currentBusy = (yield* status.get(sessionID)).type !== "idle" || !!currentExecution
          if (
            (schedule.input.sessionState === "busy" && !currentBusy) ||
            (schedule.input.sessionState === "idle" && currentBusy)
          )
            return currentBusy ? ("busy" as const) : ("idle" as const)
          if (!prepared) return yield* Effect.fail(new Error("Scheduled payload was not prepared"))
          if (prepared._tag === "Failure") return yield* Effect.fail(prepared.failure)
          yield* queue.enqueueScheduled(
            sessionID,
            { id: occurrence.id, payload: prepared.success },
            { type: "scheduled", scheduleID: schedule.id, occurrenceID: occurrence.id },
            { prepared: true },
          )
          return currentBusy ? ("busy" as const) : ("idle" as const)
        }).pipe(Effect.provideService(WorkspaceRef, session.workspace_id ?? undefined)),
      changed,
    })
    // Re-enqueue the exact durable payload only as an idempotent wake, never resolve
    // current agent/model settings again for an already accepted occurrence.
    const wakeProgress = { id: "" }
    const wake = (id?: string) =>
      Effect.gen(function* () {
        const pending = yield* database.db
          .select({
            occurrence: SessionScheduleOccurrenceTable,
            schedule: SessionScheduleTable,
            queued: SessionQueueTable,
            session: SessionTable,
          })
          .from(SessionScheduleOccurrenceTable)
          .innerJoin(SessionScheduleTable, eq(SessionScheduleTable.id, SessionScheduleOccurrenceTable.schedule_id))
          .innerJoin(SessionQueueTable, eq(SessionQueueTable.id, SessionScheduleOccurrenceTable.id))
          .innerJoin(SessionTable, eq(SessionTable.id, SessionScheduleTable.session_id))
          .where(
            and(
              sql`${SessionScheduleOccurrenceTable.state} = 'accepted' AND ${SessionQueueTable.state} = 'pending' AND ${SessionTable.time_archived} IS NULL AND NOT EXISTS (SELECT 1 FROM runtime_retirement WHERE session_id = ${SessionTable.id})`,
              id ? eq(SessionScheduleOccurrenceTable.id, id) : gt(SessionScheduleOccurrenceTable.id, wakeProgress.id),
            ),
          )
          .orderBy(SessionScheduleOccurrenceTable.id)
          .limit(id ? 1 : 32)
          .all()
        if (!id) wakeProgress.id = pending.at(-1)?.occurrence.id ?? ""
        for (const row of pending) {
          if ((yield* lifecycle.status()).state !== "running") return
          if (process.env.OPENCODE_MANAGED_PROFILE === "1" && row.session.parent_id) continue
          yield* store
            .provide(
              { directory: row.session.directory },
              Effect.gen(function* () {
                // Bootstrap can yield. Check ownership after it, immediately before
                // waking, rather than trusting a snapshot from before instance I/O.
                const execution = yield* database.db.get<{
                  state: string
                  desired_active: number
                  owner_lineage: string
                  owner_instance: string
                }>(
                  sql`SELECT state, desired_active, owner_lineage, owner_instance FROM runtime_execution WHERE session_id = ${row.session.id}`,
                )
                if (executionBlocked(execution, lifecycle)) return
                yield* prompt
                  .queueSubmitScheduled(
                    SessionID.make(row.session.id),
                    {
                      id: row.occurrence.id,
                      payload: Schema.decodeUnknownSync(SessionQueueV1.Payload)(row.queued.payload),
                    },
                    { type: "scheduled", scheduleID: row.schedule.id, occurrenceID: row.occurrence.id },
                  )
                  .pipe(
                    Effect.catchTag("SessionQueueError", (error) =>
                      Effect.gen(function* () {
                        if (error.reason !== "invalid") return yield* error
                        const message = error.message.slice(0, 2000)
                        const updated = yield* database.db
                          .update(SessionScheduleOccurrenceTable)
                          .set({ error: message })
                          .where(
                            and(
                              eq(SessionScheduleOccurrenceTable.id, row.occurrence.id),
                              eq(SessionScheduleOccurrenceTable.schedule_id, row.schedule.id),
                              eq(SessionScheduleOccurrenceTable.state, "accepted"),
                              sql`${SessionScheduleOccurrenceTable.error} IS NOT ${message}`,
                              sql`EXISTS (SELECT 1 FROM session_queue q WHERE q.id = ${row.occurrence.id}
                                AND q.session_id = ${row.session.id} AND q.state = 'pending' AND q.message_id IS NULL
                                AND json_extract(q.origin, '$.type') = 'scheduled'
                                AND json_extract(q.origin, '$.scheduleID') = ${row.schedule.id}
                                AND json_extract(q.origin, '$.occurrenceID') = ${row.occurrence.id})`,
                            ),
                          )
                          .returning({ id: SessionScheduleOccurrenceTable.id })
                          .all()
                        if (!updated.length) return
                        yield* changed(SessionID.make(row.session.id))
                        yield* Effect.logWarning("Scheduled queue wake failed", {
                          occurrenceID: row.occurrence.id,
                          error: message,
                        })
                      }),
                    ),
                  )
              }).pipe(Effect.provideService(WorkspaceRef, row.session.workspace_id ?? undefined)),
            )
            .pipe(Effect.catchCause((cause) => Effect.logWarning("Scheduled queue wake failed", cause)))
        }
      })
    const tick = Effect.gen(function* () {
      if ((yield* lifecycle.status()).state !== "running") return
      yield* wake()
      yield* scheduler.drain(Date.now, (id) => wake(id))
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Scheduler tick failed", cause)))
    const start = yield* Effect.cached(
      Effect.gen(function* () {
        startup.time = Date.now()
        const onEvent = (event: GlobalEvent) => {
          if (
            event.payload?.type === "session.idle" ||
            event.payload?.type === "session.updated" ||
            event.payload?.type === "session.queue.changed"
          )
            signal.openUnsafe()
        }
        GlobalBus.on("event", onEvent)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            GlobalBus.off("event", onEvent)
          }),
        ).pipe(Effect.provideService(Scope.Scope, scope))
        yield* Effect.forever(
          Effect.gen(function* () {
            yield* signal.close
            yield* tick
            yield* signal.await.pipe(Effect.timeoutOption("1 second"))
          }),
        ).pipe(Effect.forkIn(scope))
      }),
    )
    return Service.of({ start })
  }),
)
