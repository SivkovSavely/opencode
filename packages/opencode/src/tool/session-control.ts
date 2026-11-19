import { createHash } from "node:crypto"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionControlRequestTable } from "@opencode-ai/core/session/control.sql"
import { SessionQueueTable } from "@opencode-ai/core/session/queue.sql"
import { SessionControlV1 } from "@opencode-ai/schema/v1/session-control"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { Flag } from "@opencode-ai/core/flag/flag"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { Session } from "@/session/session"
import { SessionQueue } from "@/session/queue"
import type { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"
import { Tool } from "./tool"
import { SessionAccess } from "./session-access"

export type SessionControlOps = Pick<
  SessionPrompt.Interface,
  "textPayload" | "queueWake" | "controlSteer" | "controlCancel"
>

export const SessionControlTool = Tool.define(
  "session_control",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const queue = yield* SessionQueue.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const fs = yield* FSUtil.Service
    const runtime = Option.getOrElse(
      yield* Effect.serviceOption(RuntimeLifecycle.Service),
      () => RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable(),
    )
    const db = database.db
    return {
      description:
        "Control independent root sessions without waiting for execution. Actions: create (directory, title, agent, model provider/model, variant, optional prompt; start defaults to whether prompt exists), prompt (durable ordered queue), steer (existing safe-boundary steering), status, read (bounded previews, limit <=20, before message ID), cancel (active execution only). Existing sessions always retain their original directory/project/workspace. Every operation is permission checked; IDs and creator metadata are not grants. Use a stable requestID for retry-safe mutations; reusing it with different arguments fails. Paused, cancelled and recovery-held work is never implicitly resumed. Self-cancellation is forbidden. No transcript or tool output is returned unbounded.",
      parameters: SessionControlV1.Parameters,
      execute: (
        params: typeof SessionControlV1.Parameters.Type,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<{ sessionID: string; requestID?: string }>> =>
        Effect.gen(function* () {
          if (params.action !== "create" && !params.sessionID) throw new Error("sessionID is required")
          if (
            params.action !== "create" &&
            (params.directory !== undefined || params.title !== undefined || params.start !== undefined)
          )
            throw new Error("directory, title and start are creation options only")
          if (params.action === "create" && params.sessionID) throw new Error("create does not accept sessionID")
          if ((params.action === "prompt" || params.action === "steer") && !params.prompt)
            throw new Error("prompt is required")
          if (params.action === "cancel" && params.sessionID === ctx.sessionID)
            throw new Error("A controller cannot cancel itself")
          const targets = yield* SessionAccess.authorize(sessions, database, ctx, "session_control", params.action, [
            params.action === "create" ? ctx.sessionID : (params.sessionID ?? ctx.sessionID),
          ])
          const caller = yield* sessions.get(ctx.sessionID)
          const selected = targets[0]
          if (!selected) throw new Error("Session target is unavailable")
          const stores = yield* Effect.serviceOption(InstanceStore.Service)
          if (Option.isNone(stores)) throw new Error("Session routing service is unavailable")
          const directory =
            params.action === "create"
              ? yield* fs.realPath(path.resolve(caller.directory, params.directory ?? caller.directory))
              : selected.directory
          if (!(yield* fs.isDir(directory))) throw new Error("Target directory is unavailable")
          if (params.action === "create" && Flag.OPENCODE_WORKSPACE_ID && directory !== caller.directory)
            throw new Error("A workspace-hosted runtime cannot create independent sessions outside its placement")
          if (params.action === "create" && directory !== caller.directory) {
            const glob = `${directory.replaceAll("\\", "/").replace(/\/$/, "")}/*`
            yield* ctx.ask({
              permission: "external_directory",
              patterns: [glob],
              always: [glob],
              metadata: { directory, action: "create" },
            })
            yield* ctx.ask({
              permission: "session_control",
              patterns: [`create:${directory}`],
              always: [`create:${directory}`],
              metadata: { directory, action: "create" },
            })
          }
          const instance = yield* stores.value.load({ directory })
          if (
            params.action !== "create" &&
            (instance.directory !== selected.directory || instance.project.id !== selected.projectID)
          )
            throw new Error("Target project or directory changed; automatic migration is forbidden")
          const workspaceID =
            params.action === "create" && directory === caller.directory
              ? caller.workspaceID
              : params.action === "create"
                ? undefined
                : selected.workspaceID
          if (params.action === "create") {
            const pattern = `create:${instance.project.id}:${instance.directory}:${workspaceID ?? "local"}`
            yield* ctx.ask({
              permission: "session_control",
              patterns: [pattern],
              always: [pattern],
              metadata: {
                action: "create",
                directory: instance.directory,
                projectID: instance.project.id,
                workspaceID,
              },
            })
          }
          return yield* stores.value.provide(
            { directory },
            Effect.gen(function* () {
              const current = yield* InstanceState.context
              if (current.project.id !== instance.project.id || current.directory !== instance.directory)
                throw new Error("Target project or directory changed after approval")
              if (params.action !== "create") {
                const target = yield* sessions.get(selected.id)
                if (
                  target.directory !== directory ||
                  target.projectID !== current.project.id ||
                  target.workspaceID !== workspaceID ||
                  target.time.archived
                )
                  throw new Error("Target session scope changed")
              }
              if (params.action === "read")
                return {
                  title: "Session output",
                  metadata: { sessionID: selected.id },
                  output: JSON.stringify(yield* read(database, selected.id, params.limit ?? 10, params.before)),
                }
              if (params.action === "status")
                return {
                  title: "Session status",
                  metadata: { sessionID: selected.id },
                  output: JSON.stringify({
                    sessionID: selected.id,
                    title: selected.title.slice(0, 256),
                    parentID: selected.parentID,
                    directory,
                    projectID: selected.projectID,
                    workspaceID,
                    agent: selected.agent,
                    model: selected.model,
                    execution:
                      yield* db.get(sql`SELECT id, state, result, message_id AS messageID, summary, time_created AS created,
              time_completed AS completed FROM session_watch_execution WHERE session_id = ${selected.id} ORDER BY sequence DESC LIMIT 1`),
                    runtime: yield* db.get(
                      sql`SELECT state, desired_active AS desiredActive, fence FROM runtime_execution WHERE session_id = ${selected.id}`,
                    ),
                    queue:
                      yield* db.get(sql`SELECT coalesce((SELECT paused FROM session_queue_state WHERE session_id = ${selected.id}), 0) AS paused,
              coalesce((SELECT blocked FROM session_queue_state WHERE session_id = ${selected.id}), 0) AS blocked,
              count(*) AS pending FROM session_queue WHERE session_id = ${selected.id} AND state IN ('pending', 'claimed', 'uncertain')`),
                  }),
                }
              if (runtime.identity.instance === "unavailable")
                throw new Error("Independent session mutation requires a tracked runtime")
              const ops = ctx.extra?.sessionControlOps
              if (!isControlOps(ops)) throw new Error("Session admission service is unavailable")
              const id = createHash("sha256")
                .update(JSON.stringify([ctx.sessionID, params.requestID ?? [ctx.messageID, ctx.callID ?? "control"]]))
                .digest("hex")
              const submission = JSON.stringify([
                params.action,
                params.sessionID,
                params.action === "create" ? directory : undefined,
                params.title,
                params.agent,
                params.model,
                params.variant,
                params.prompt,
                params.start,
                params.before,
                params.limit,
              ])
              const prior = yield* db
                .select()
                .from(SessionControlRequestTable)
                .where(eq(SessionControlRequestTable.id, id))
                .get()
              const agent = params.agent && !prior ? yield* agents.get(params.agent) : undefined
              if (params.agent && !prior && !agent) throw new Error("Agent is unavailable in the target directory")
              const model = params.model
                ? Provider.parseModel(params.model)
                : params.action === "create" && params.variant
                  ? ((agent ?? (yield* agents.defaultInfo())).model ?? (yield* provider.defaultModel()))
                  : undefined
              if (model && !prior) {
                const full = yield* provider.getModel(model.providerID, model.modelID)
                if (
                  params.variant &&
                  params.variant !== "default" &&
                  !Object.hasOwn(full.variants ?? {}, params.variant)
                )
                  throw new Error("Model variant is unavailable")
              }
              if (params.action === "create" && (params.start ?? Boolean(params.prompt)) && !params.prompt)
                throw new Error("An initial prompt is required to start a new session")
              const request = yield* runtime.withDurableAdmission(
                db.transaction(
                  () =>
                    Effect.gen(function* () {
                      const existing = yield* db
                        .select()
                        .from(SessionControlRequestTable)
                        .where(eq(SessionControlRequestTable.id, id))
                        .get()
                      if (existing) {
                        if (existing.owner_id !== ctx.sessionID || existing.submission !== submission)
                          throw new Error("Conflicting session control request identity")
                        return existing
                      }
                      const bound = yield* db.get<{ total: number; owned: number }>(sql`SELECT count(*) AS total,
            coalesce(sum(owner_id = ${ctx.sessionID}), 0) AS owned FROM session_control_request`)
                      if ((bound?.total ?? 0) >= 4096 || (bound?.owned ?? 0) >= 64)
                        throw new Error("Session control request retention limit reached")
                      const session =
                        params.action === "create"
                          ? yield* sessions.create({
                              title: params.title,
                              agent: params.agent,
                              model: model
                                ? {
                                    id: model.modelID,
                                    providerID: model.providerID,
                                    variant: params.variant ?? "default",
                                  }
                                : undefined,
                              metadata: { orchestration: { creatorSessionID: ctx.sessionID, requestID: id } },
                            })
                          : selected
                      const active =
                        params.action === "cancel"
                          ? yield* db.get<{
                              owner_lineage: string
                              owner_instance: string
                              fence: number
                            }>(
                              sql`SELECT owner_lineage, owner_instance, fence FROM runtime_execution WHERE session_id = ${session.id} AND desired_active = 1`,
                            )
                          : undefined
                      if (
                        active &&
                        (active.owner_lineage !== runtime.identity.lineage ||
                          active.owner_instance !== runtime.identity.instance)
                      )
                        throw new Error("Target execution belongs to another runtime; cancellation was not admitted")
                      return yield* db
                        .insert(SessionControlRequestTable)
                        .values({
                          id,
                          owner_id: ctx.sessionID,
                          action: params.action,
                          submission,
                          session_id: session.id,
                          scopes: [caller, session]
                            .filter(
                              (item, index, values) => values.findIndex((value) => value.id === item.id) === index,
                            )
                            .map((item) => ({
                              sessionID: item.id,
                              projectID: item.projectID,
                              directory: item.directory,
                              workspaceID: item.workspaceID,
                            })),
                          agent: ctx.agent,
                          auto: params.action !== "create" || params.start !== false,
                          state: params.action === "create" && !params.prompt ? "done" : "created",
                          queue_id: `msg_control_${id}`,
                          cancellation: active
                            ? {
                                ownerLineage: active.owner_lineage,
                                ownerInstance: active.owner_instance,
                                fence: active.fence,
                              }
                            : null,
                          time_created: Date.now(),
                        })
                        .returning()
                        .get()
                    }),
                  { behavior: "immediate" },
                ),
              )
              const session = yield* sessions.get(request.session_id)
              if (
                session.directory !== directory ||
                session.projectID !== current.project.id ||
                session.workspaceID !== workspaceID ||
                session.time.archived
              )
                throw new Error("Target session scope changed")
              if (request.state !== "done" && params.action === "cancel") {
                if (request.cancellation) yield* ops.controlCancel(session.id, request.cancellation)
                yield* runtime.withDurableAdmission(
                  db
                    .update(SessionControlRequestTable)
                    .set({ state: "done" })
                    .where(eq(SessionControlRequestTable.id, id)),
                )
              }
              if (request.state !== "done" && params.action !== "cancel") {
                // Prepare outside the writer and lifecycle gate: config/provider initialization may acquire their own locks.
                yield* queue.list(session.id)
                const queued = yield* db
                  .select({ id: SessionQueueTable.id })
                  .from(SessionQueueTable)
                  .where(eq(SessionQueueTable.id, request.queue_id))
                  .get()
                const payload =
                  !queued && request.state === "created"
                    ? yield* ops.textPayload(session.id, params.prompt ?? "", {
                        agent: params.agent,
                        model: params.model ? Provider.parseModel(params.model) : undefined,
                        variant: params.variant,
                      })
                    : undefined
                if (params.action === "steer" && payload) yield* ops.controlSteer(session.id, payload, request.queue_id)
                yield* runtime.withDurableAdmission(
                  db.transaction(
                    () =>
                      Effect.gen(function* () {
                        const target = yield* sessions.get(session.id)
                        if (
                          target.directory !== directory ||
                          target.projectID !== current.project.id ||
                          target.workspaceID !== workspaceID ||
                          target.time.archived
                        )
                          throw new Error("Target session scope changed")
                        const saved = yield* db
                          .select({ id: SessionQueueTable.id })
                          .from(SessionQueueTable)
                          .where(eq(SessionQueueTable.id, request.queue_id))
                          .get()
                        if (!saved && payload && params.action !== "steer") {
                          const pending = yield* db.get<{
                            count: number
                          }>(sql`SELECT count(*) AS count FROM session_queue
                WHERE session_id = ${session.id} AND state IN ('pending', 'claimed', 'uncertain')`)
                          if ((pending?.count ?? 0) >= 64) throw new Error("Target input queue limit reached")
                          yield* queue.enqueue(session.id, { id: request.queue_id, payload })
                        }
                        yield* db
                          .update(SessionControlRequestTable)
                          .set({ state: "admitted" })
                          .where(eq(SessionControlRequestTable.id, id))
                      }),
                    { behavior: "immediate" },
                  ),
                )
                if (params.action !== "create" || params.start !== false) yield* ops.queueWake(session.id)
              }
              return {
                title: "Session control accepted",
                metadata: { sessionID: session.id, requestID: id },
                output: JSON.stringify({
                  sessionID: session.id,
                  requestID: id,
                  directory,
                  projectID: session.projectID,
                  workspaceID,
                  state: params.action === "cancel" || request.state === "done" ? "done" : "admitted",
                  queueID: request.state === "done" || params.action === "cancel" ? undefined : request.queue_id,
                }),
              }
            }).pipe(Effect.provideService(WorkspaceRef, workspaceID)),
          )
        }).pipe(Effect.orDie),
    }
  }),
)

function isControlOps(value: unknown): value is SessionControlOps {
  return (
    isRecord(value) &&
    typeof value.textPayload === "function" &&
    typeof value.queueWake === "function" &&
    typeof value.controlSteer === "function" &&
    typeof value.controlCancel === "function"
  )
}

const read = Effect.fn("SessionControl.read")(function* (
  database: Database.Interface,
  sessionID: SessionID,
  limit: number,
  before?: string,
) {
  const db = database.db
  const cursor = before
    ? yield* db.get<{ time_created: number }>(sql`SELECT time_created FROM message
    WHERE session_id = ${sessionID} AND id = ${before}`)
    : undefined
  if (before && !cursor) throw new Error("Invalid session history cursor")
  const rows = yield* db.all<{
    id: string
    created: number
    role: string
    agent: string | null
    error: string | null
  }>(sql`
    SELECT id, time_created AS created, json_extract(data, '$.role') AS role, substr(json_extract(data, '$.agent'), 1, 128) AS agent,
      substr(json_extract(data, '$.error.data.message'), 1, 1000) AS error FROM message
    WHERE session_id = ${sessionID} ${cursor ? sql`AND (time_created < ${cursor.time_created} OR (time_created = ${cursor.time_created} AND id < ${before}))` : sql``}
    ORDER BY time_created DESC, id DESC LIMIT ${limit + 1}`)
  let budget = 24000
  const items = yield* Effect.forEach(rows.slice(0, limit), (row) =>
    Effect.gen(function* () {
      const parts = yield* db.all<{
        id: string
        type: string
        text: string | null
        tool: string | null
        status: string | null
        output: string | null
      }>(sql`
      SELECT id, json_extract(data, '$.type') AS type, substr(json_extract(data, '$.text'), 1, 2000) AS text,
        substr(json_extract(data, '$.tool'), 1, 128) AS tool, json_extract(data, '$.state.status') AS status,
        substr(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error')), 1, 2000) AS output
      FROM part WHERE session_id = ${sessionID} AND message_id = ${row.id} ORDER BY id LIMIT 16`)
      return {
        ...row,
        parts: parts.map((part) => {
          const text = part.text?.slice(0, Math.max(0, budget))
          budget -= text?.length ?? 0
          const output = part.output?.slice(0, Math.max(0, budget))
          budget -= output?.length ?? 0
          return { ...part, text, output }
        }),
      }
    }),
  )
  return {
    sessionID,
    items,
    more: rows.length > limit,
    next: rows.length > limit ? items.at(-1)?.id : undefined,
    bounded: true,
    previewCharacters: 2000,
    previewParts: 16,
  }
})
