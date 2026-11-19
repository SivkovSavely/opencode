import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionWatchStore } from "@opencode-ai/core/session/watch-store"
import { SessionWatchV1 } from "@opencode-ai/schema/v1/session-watch"
import { Session } from "@/session/session"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { Tool } from "./tool"
import { SessionAccess } from "./session-access"

const WatchParameters = Schema.Struct({
  sessionID: Schema.String,
  destinationID: Schema.optional(Schema.String),
  events: Schema.optional(Schema.Array(SessionWatchV1.Event).check(Schema.isMinLength(1), Schema.isMaxLength(4))),
  mode: Schema.optional(SessionWatchV1.Mode),
  delivery: Schema.optional(SessionWatchV1.Delivery),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 128 }))),
  requestID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
})
const ManageParameters = Schema.Struct({
  action: Schema.Literals(["list", "inspect", "cancel"]),
  watchID: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
})

export const SessionWatchTool = Tool.define(
  "session_watch",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const runtime = Option.getOrElse(
      yield* Effect.serviceOption(RuntimeLifecycle.Service),
      () => RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable(),
    )
    return {
      description:
        "Watch an independent session without waiting. Auto delivery (default) durably queues a bounded notification and resumes an idle runnable destination. Busy, paused, cancelled and recovery-held destinations retain it. A one-shot tracks the active execution, or the next matching future execution if idle; no historical completion is replayed. Persistent watches stop at their delivery limit. Self watches and automatic cycles are forbidden.",
      parameters: WatchParameters,
      execute: (params: typeof WatchParameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (runtime.identity.instance === "unavailable") throw new Error("Session watches require a tracked runtime")
          const caller = yield* sessions.get(ctx.sessionID)
          const source = yield* SessionAccess.authorize(sessions, database, ctx, "session_watch", "observe", [
            params.sessionID,
          ])
          const destination = yield* SessionAccess.authorize(sessions, database, ctx, "session_watch", "deliver", [
            params.destinationID ?? ctx.sessionID,
          ])
          const id = `watch_${createHash("sha256")
            .update(JSON.stringify([ctx.sessionID, params.requestID ?? [ctx.messageID, ctx.callID ?? "watch"]]))
            .digest("hex")}`
          const watch = yield* runtime.withDurableAdmission(
            SessionWatchStore.create(
              database,
              {
                id,
                owner: ctx.sessionID,
                source: params.sessionID,
                destination: params.destinationID ?? ctx.sessionID,
                events: params.events ?? ["completed", "failed", "cancelled"],
                mode: params.mode ?? "once",
                delivery: params.delivery ?? "auto",
                limit: params.limit ?? 32,
                agent: ctx.agent,
              },
              [caller, ...source, ...destination].map((session) => ({
                sessionID: session.id,
                projectID: session.projectID,
                directory: session.directory,
                workspaceID: session.workspaceID,
              })),
            ),
          )
          return { title: "Session watch registered", metadata: { watchID: watch.id }, output: JSON.stringify(watch) }
        }).pipe(Effect.orDie),
    }
  }),
)

export const SessionWatchManageTool = Tool.define(
  "session_watch_manage",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const runtime = Option.getOrElse(
      yield* Effect.serviceOption(RuntimeLifecycle.Service),
      () => RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable(),
    )
    return {
      description:
        "List your watches (maximum 64), inspect a watch and its bounded delivery history, or cancel future deliveries. Cancellation never removes input already accepted by the destination queue. IDs are owner-scoped, not capabilities. Use after as the last delivery ID for history pagination.",
      parameters: ManageParameters,
      execute: (
        params: typeof ManageParameters.Type,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<{ watchID?: string }>> =>
        Effect.gen(function* () {
          yield* SessionAccess.authorize(sessions, database, ctx, "session_watch_manage", params.action, [
            ctx.sessionID,
          ])
          if (params.action === "list")
            return {
              title: "Session watches",
              metadata: {},
              output: JSON.stringify(yield* SessionWatchStore.list(database, ctx.sessionID)),
            }
          if (!params.watchID) return yield* Effect.die(new Error("watchID is required for inspect/cancel"))
          const watch = yield* SessionWatchStore.get(database, ctx.sessionID, params.watchID)
          yield* SessionAccess.authorize(sessions, database, ctx, "session_watch_manage", params.action, [
            watch.source_id,
            watch.destination_id,
          ])
          if (params.action === "cancel")
            return {
              title: "Session watch cancelled",
              metadata: { watchID: watch.id },
              output: JSON.stringify(
                yield* runtime.withDurableAdmission(
                  runtime.identity.instance === "unavailable"
                    ? Effect.die(new Error("Watch mutation requires a tracked runtime"))
                    : SessionWatchStore.cancel(database, ctx.sessionID, watch.id),
                ),
              ),
            }
          const deliveries = yield* SessionWatchStore.deliveries(database, ctx.sessionID, watch.id, params.after)
          return {
            title: "Session watch",
            metadata: { watchID: watch.id },
            output: JSON.stringify({ watch, deliveries, next: deliveries.at(-1)?.id }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
