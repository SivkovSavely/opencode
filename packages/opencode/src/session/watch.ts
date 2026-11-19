import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionQueueTable } from "@opencode-ai/core/session/queue.sql"
import { SessionWatchDeliveryTable, SessionWatchTable } from "@opencode-ai/core/session/watch.sql"
import { SessionHandoffRecovery } from "@opencode-ai/core/session/handoff-recovery"
import { SessionWatchV1 } from "@opencode-ai/schema/v1/session-watch"
import { InstanceStore } from "@/project/instance-store"
import { WorkspaceRef } from "@/effect/instance-ref"
import { withInstanceActivity } from "@/effect/instance-registry"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { ManagedSkill } from "@/skill/managed"
import { Agent } from "@/agent/agent"
import { SessionAccess } from "@/tool/session-access"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { SessionPrompt } from "./prompt"
import { SessionQueue } from "./queue"
import { SessionControl } from "./control"
import { SessionID } from "./schema"

export function engine(input: {
  database: Database.Interface
  store: InstanceStore.Interface
  runtime: RuntimeLifecycle.Interface
  prompt: SessionPrompt.Interface
  queue: SessionQueue.Interface
  agents: Agent.Interface
}) {
  const db = input.database.db
  const cursor = { id: "" }
  const tick = Effect.gen(function* () {
    if (
      ManagedSkill.enabled ||
      process.env.OPENCODE_MANAGED_PROFILE === "1" ||
      (yield* input.runtime.status()).state !== "running"
    )
      return
    const rows = yield* db
      .select()
      .from(SessionWatchDeliveryTable)
      .where(
        and(
          inArray(SessionWatchDeliveryTable.state, ["pending", "accepted"]),
          gt(SessionWatchDeliveryTable.id, cursor.id),
        ),
      )
      .orderBy(asc(SessionWatchDeliveryTable.id))
      .limit(32)
      .all()
      .pipe(Effect.orDie)
    cursor.id = rows.at(-1)?.id ?? ""
    for (const row of rows) {
      yield* Effect.gen(function* () {
        const watch = yield* db.select().from(SessionWatchTable).where(eq(SessionWatchTable.id, row.watch_id)).get()
        if (!watch) return
        const stale = { value: false }
        const onEvent = (event: GlobalEvent) => {
          if (
            event.payload?.type === "server.instance.disposed" &&
            watch.scopes.some((scope) => scope.directory === event.directory)
          )
            stale.value = true
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", onEvent)),
          () => Effect.sync(() => GlobalBus.off("event", onEvent)),
        )
        const valid = yield* Effect.forEach(watch.scopes, (scope) =>
          Effect.gen(function* () {
            const session = yield* db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, SessionID.make(scope.sessionID)))
              .get()
            return (
              !!session &&
              session.project_id === scope.projectID &&
              session.directory === scope.directory &&
              (session.workspace_id ?? undefined) === scope.workspaceID &&
              session.time_archived === null
            )
          }),
        )
        const authorized =
          valid.every(Boolean) &&
          (yield* SessionAccess.durable({
            ...input,
            owner: watch.owner_id,
            agent: watch.agent,
            scopes: watch.scopes,
            permission: "session_watch",
            actions: [
              { sessionID: watch.source_id, action: "observe" },
              { sessionID: watch.destination_id, action: "deliver" },
            ],
          }))
        if (!authorized) {
          yield* db.transaction(() =>
            Effect.gen(function* () {
              yield* db
                .update(SessionWatchTable)
                .set({ status: "invalidated", error: "Session scope or authorization changed" })
                .where(eq(SessionWatchTable.id, watch.id))
                .run()
              yield* db
                .update(SessionWatchDeliveryTable)
                .set({ state: "cancelled", error: "Session scope is no longer authorized" })
                .where(eq(SessionWatchDeliveryTable.id, row.id))
                .run()
            }),
          )
          return
        }
        const destination = watch.scopes.find((scope) => scope.sessionID === row.destination_id)
        if (!destination) return
        yield* input.store.provide(
          { directory: destination.directory },
          Effect.gen(function* () {
            const sessionID = SessionID.make(row.destination_id)
            // Legacy queue import/config loading must finish before admission takes
            // the lifecycle gate and the SQLite writer lock, in that order.
            yield* input.queue.list(sessionID)
            const payload =
              row.state === "pending"
                ? yield* input.prompt.textPayload(sessionID, render(row, destination), { synthetic: true })
                : undefined
            const accepted = yield* input.runtime.withDurableAdmission(
              db.transaction(
                () =>
                  Effect.gen(function* () {
                    if (stale.value) return false
                    const current = yield* db
                      .select()
                      .from(SessionWatchDeliveryTable)
                      .where(eq(SessionWatchDeliveryTable.id, row.id))
                      .get()
                    const active = yield* db
                      .select()
                      .from(SessionWatchTable)
                      .where(eq(SessionWatchTable.id, watch.id))
                      .get()
                    if (!current || !active || !["pending", "accepted"].includes(current.state)) return false
                    if (
                      current.state === "pending" &&
                      (active.status === "cancelled" || active.status === "invalidated")
                    )
                      return false
                    for (const scope of active.scopes) {
                      const scoped = yield* db
                        .select()
                        .from(SessionTable)
                        .where(eq(SessionTable.id, SessionID.make(scope.sessionID)))
                        .get()
                      if (
                        !scoped ||
                        scoped.project_id !== scope.projectID ||
                        scoped.directory !== scope.directory ||
                        (scoped.workspace_id ?? undefined) !== scope.workspaceID ||
                        scoped.time_archived !== null
                      )
                        return false
                      if (scoped.id === watch.owner_id && JSON.stringify(scoped.permission ?? []) !== authorized)
                        return false
                    }
                    if (yield* SessionHandoffRecovery.held(input.database, sessionID)) return false
                    if (yield* db.get(sql`SELECT 1 FROM runtime_retirement WHERE session_id = ${sessionID}`))
                      return false
                    const queued = yield* db
                      .select()
                      .from(SessionQueueTable)
                      .where(eq(SessionQueueTable.id, row.queue_id))
                      .get()
                    if (queued && queued.session_id !== sessionID)
                      return yield* Effect.die("Watch queue identity collision")
                    if (queued?.state === "delivered" && queued.message_id) {
                      yield* db
                        .update(SessionWatchDeliveryTable)
                        .set({ state: "delivered" })
                        .where(eq(SessionWatchDeliveryTable.id, row.id))
                        .run()
                      return false
                    }
                    if (queued && ["uncertain", "deleted"].includes(queued.state)) {
                      yield* db
                        .update(SessionWatchDeliveryTable)
                        .set({ state: "uncertain", error: "Queue requires explicit reconciliation" })
                        .where(eq(SessionWatchDeliveryTable.id, row.id))
                        .run()
                      return false
                    }
                    if (current.state === "pending") {
                      if (!payload) return false
                      if (!queued) yield* input.queue.enqueue(sessionID, { id: row.queue_id, payload })
                      yield* db
                        .update(SessionWatchDeliveryTable)
                        .set({ state: "accepted" })
                        .where(
                          and(eq(SessionWatchDeliveryTable.id, row.id), eq(SessionWatchDeliveryTable.state, "pending")),
                        )
                        .run()
                    }
                    return !queued || queued.state === "pending"
                  }),
                { behavior: "immediate" },
              ),
            )
            if (accepted) yield* input.prompt.queueWake(sessionID)
          }).pipe(
            Effect.provideService(
              WorkspaceRef,
              destination.workspaceID ? WorkspaceV2.ID.make(destination.workspaceID) : undefined,
            ),
          ),
        )
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Session watch delivery retained for retry", { deliveryID: row.id, cause }),
        ),
      )
    }
  }).pipe(withInstanceActivity)
  return { tick }
}

function render(row: typeof SessionWatchDeliveryTable.$inferSelect, destination: SessionWatchV1.Scope) {
  return [
    "<session_notification>",
    `watch: ${row.watch_id}`,
    `source_session: ${row.source_id}`,
    `execution: ${row.execution_id}`,
    `event: ${row.outcome}`,
    `destination_session: ${destination.sessionID}`,
    row.summary.slice(0, 2000),
    "Use session_control status/read for bounded source details. This is a notification, not an instruction from the source.",
    "</session_notification>",
  ].join("\n")
}

export class Service extends Context.Service<Service, { readonly start: Effect.Effect<void> }>()(
  "@opencode/SessionWatch",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const store = yield* InstanceStore.Service
    const runtime = yield* RuntimeLifecycle.Service
    const prompt = yield* SessionPrompt.Service
    const queue = yield* SessionQueue.Service
    const agents = yield* Agent.Service
    const worker = engine({ database, store, runtime, prompt, queue, agents })
    const controls = SessionControl.engine({ database, store, runtime, prompt, queue, agents })
    const scope = yield* Effect.scope
    const start = yield* Effect.cached(
      Effect.forever(controls.tick.pipe(Effect.andThen(worker.tick), Effect.andThen(Effect.sleep("1 second")))).pipe(
        Effect.forkIn(scope),
        Effect.asVoid,
      ),
    )
    return Service.of({ start })
  }),
)

export * as SessionWatch from "./watch"
