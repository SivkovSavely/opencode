import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Cause, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionControlRequestTable } from "@opencode-ai/core/session/control.sql"
import { SessionQueueTable } from "@opencode-ai/core/session/queue.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Agent } from "@/agent/agent"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { WorkspaceRef } from "@/effect/instance-ref"
import { withInstanceActivity } from "@/effect/instance-registry"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { ManagedSkill } from "@/skill/managed"
import { SessionAccess } from "@/tool/session-access"
import { SessionPrompt } from "./prompt"
import { SessionQueue } from "./queue"
import { SessionID } from "./schema"

// Queue acceptance is authoritative. This worker only replays advisory wakes,
// never creates input or retries provider work from an ambiguous prior claim.
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
      .from(SessionControlRequestTable)
      .where(and(eq(SessionControlRequestTable.state, "admitted"), gt(SessionControlRequestTable.id, cursor.id)))
      .orderBy(asc(SessionControlRequestTable.id))
      .limit(32)
      .all()
      .pipe(Effect.orDie)
    cursor.id = rows.at(-1)?.id ?? ""
    for (const row of rows) {
      yield* Effect.gen(function* () {
        if (!row.auto) return
        const stale = { value: false }
        const onEvent = (event: GlobalEvent) => {
          if (
            event.payload?.type === "server.instance.disposed" &&
            row.scopes.some((scope) => scope.directory === event.directory)
          )
            stale.value = true
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", onEvent)),
          () => Effect.sync(() => GlobalBus.off("event", onEvent)),
        )
        const authorization = yield* SessionAccess.durable({
          ...input,
          owner: row.owner_id,
          agent: row.agent,
          scopes: row.scopes,
          permission: "session_control",
          actions: [{ sessionID: row.session_id, action: row.action }],
        })
        if (!authorization) {
          yield* input.runtime.withDurableAdmission(
            db
              .update(SessionControlRequestTable)
              .set({ state: "done" })
              .where(eq(SessionControlRequestTable.id, row.id)),
          )
          return
        }
        const target = row.scopes.find((scope) => scope.sessionID === row.session_id)
        if (!target) return
        yield* input.store.provide(
          { directory: target.directory },
          Effect.gen(function* () {
            yield* input.queue.list(row.session_id)
            const pending = yield* input.runtime.withDurableAdmission(
              db.transaction(
                () =>
                  Effect.gen(function* () {
                    if (stale.value) return false
                    for (const scope of row.scopes) {
                      const current = yield* db
                        .select()
                        .from(SessionTable)
                        .where(eq(SessionTable.id, SessionID.make(scope.sessionID)))
                        .get()
                      if (
                        !current ||
                        current.time_archived !== null ||
                        current.project_id !== scope.projectID ||
                        current.directory !== scope.directory ||
                        (current.workspace_id ?? undefined) !== scope.workspaceID
                      )
                        return false
                      if (current.id === row.owner_id && JSON.stringify(current.permission ?? []) !== authorization)
                        return false
                    }
                    const request = yield* db
                      .select()
                      .from(SessionControlRequestTable)
                      .where(eq(SessionControlRequestTable.id, row.id))
                      .get()
                    if (request?.state !== "admitted") return false
                    const queued = yield* db
                      .select()
                      .from(SessionQueueTable)
                      .where(eq(SessionQueueTable.id, row.queue_id))
                      .get()
                    if (!queued || ["delivered", "deleted", "uncertain"].includes(queued.state)) {
                      yield* db
                        .update(SessionControlRequestTable)
                        .set({ state: "done" })
                        .where(eq(SessionControlRequestTable.id, row.id))
                      return false
                    }
                    if (queued.session_id !== row.session_id)
                      return yield* Effect.die(new Error("Session control queue identity collision"))
                    if (yield* db.get(sql`SELECT 1 FROM runtime_retirement WHERE session_id = ${row.session_id}`))
                      return false
                    return queued.state === "pending"
                  }),
                { behavior: "immediate" },
              ),
            )
            if (pending) yield* input.prompt.queueWake(row.session_id)
          }).pipe(
            Effect.provideService(
              WorkspaceRef,
              target.workspaceID ? WorkspaceV2.ID.make(target.workspaceID) : undefined,
            ),
          ),
        )
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Session control wake retained for retry", { requestID: row.id, cause }),
        ),
      )
    }
  }).pipe(withInstanceActivity)
  return { tick }
}

export * as SessionControl from "./control"
