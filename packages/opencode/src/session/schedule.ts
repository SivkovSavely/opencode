export * as SessionSchedule from "./schedule"

import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { and, asc, desc, eq, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionScheduleTable, SessionScheduleOccurrenceTable } from "@opencode-ai/core/session/schedule.sql"
import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { Session } from "./session"
import { ScheduleTime } from "./schedule-time"
import type { SessionID } from "./schema"

export class ScheduleError extends Schema.TaggedErrorClass<ScheduleError>()("SessionScheduleError", {
  reason: Schema.Literals(["not_found", "scope", "archived", "conflict", "invalid"]),
  message: Schema.String,
}) {}

type Result<A> = Effect.Effect<A, ScheduleError>
export interface Interface {
  readonly list: (sessionID: SessionID) => Result<SessionScheduleV1.Info[]>
  readonly get: (sessionID: SessionID, id: string) => Result<SessionScheduleV1.Info>
  readonly create: (sessionID: SessionID, input: SessionScheduleV1.Input) => Result<SessionScheduleV1.Info>
  readonly update: (sessionID: SessionID, id: string, input: SessionScheduleV1.Input) => Result<SessionScheduleV1.Info>
  readonly pause: (sessionID: SessionID, id: string, paused: boolean) => Result<SessionScheduleV1.Info>
  readonly remove: (sessionID: SessionID, id: string) => Result<void>
  readonly history: (sessionID: SessionID, id: string, cursor?: number) => Result<SessionScheduleV1.History>
  readonly preview: (
    sessionID: SessionID,
    input: { spec: SessionScheduleV1.Spec; scheduleID?: string },
  ) => Result<SessionScheduleV1.Preview>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSchedule") {}

function sameGrid(a: SessionScheduleV1.Spec, b: SessionScheduleV1.Spec) {
  if (a.mode === "interval" && b.mode === "interval") return a.amount === b.amount && a.unit === b.unit
  return isDeepStrictEqual(a, b)
}

export const info = (row: typeof SessionScheduleTable.$inferSelect): SessionScheduleV1.Info => ({
  ...row.input,
  id: row.id,
  sessionID: row.session_id,
  anchor: row.anchor,
  created: row.time_created,
  status: row.status,
  completed: row.completed,
  ...(row.next === null ? {} : { next: row.next }),
  summary: ScheduleTime.summary(row.input.spec),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const lifecycle = Option.getOrElse(
      yield* Effect.serviceOption(RuntimeLifecycle.Service),
      () => RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable(),
    )
    const authorize = Effect.fnUntraced(function* (sessionID: SessionID) {
      const ctx = yield* InstanceRef
      const workspaceID = yield* WorkspaceRef
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!row) return yield* new ScheduleError({ reason: "not_found", message: "Session not found" })
      if (
        !ctx ||
        row.project_id !== ctx.project.id ||
        row.directory !== ctx.directory ||
        (row.workspace_id ?? undefined) !== workspaceID
      )
        return yield* new ScheduleError({
          reason: "scope",
          message: "Session is outside the active project/directory/workspace",
        })
      if (row.time_archived !== null)
        return yield* new ScheduleError({ reason: "archived", message: "Session is archived" })
      const retired = yield* db
        .get(sql`SELECT 1 FROM runtime_retirement WHERE session_id = ${sessionID}`)
        .pipe(Effect.orDie)
      if (retired) return yield* new ScheduleError({ reason: "conflict", message: "Session root is retired" })
    })
    const requireRow = Effect.fnUntraced(function* (sessionID: SessionID, id: string) {
      yield* authorize(sessionID)
      const row = yield* db
        .select()
        .from(SessionScheduleTable)
        .where(and(eq(SessionScheduleTable.id, id), eq(SessionScheduleTable.session_id, sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new ScheduleError({ reason: "not_found", message: "Schedule not found" })
      return row
    })
    const validate = (input: SessionScheduleV1.Input) =>
      Effect.try({
        try: () => {
          Schema.decodeUnknownSync(SessionScheduleV1.Input)(input)
          const now = Date.now()
          ScheduleTime.next(input.spec, now, now)
          if (
            !input.message.trim() ||
            input.message.length > 100_000 ||
            (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))
          )
            throw new Error("Invalid message or delivery limit")
          return { ...input, deferUntilIdle: input.sessionState === "idle" && input.deferUntilIdle }
        },
        catch: (error) =>
          new ScheduleError({
            reason: "invalid",
            message: error instanceof Error ? error.message : "Invalid schedule",
          }),
      })
    const transaction = <A>(sessionID: SessionID, action: Result<A>) =>
      db
        .transaction(
          () =>
            Effect.gen(function* () {
              const session = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, sessionID))
                .get()
                .pipe(Effect.orDie)
              if (process.env.OPENCODE_MANAGED_PROFILE === "1" && session?.parent_id)
                return yield* new ScheduleError({
                  reason: "conflict",
                  message: "Managed foreground children accept only their joined Task prompt",
                })
              return yield* action
            }),
          { behavior: "immediate" },
        )
        .pipe(
          Effect.catchTag("SqlError", Effect.die),
          lifecycle.withDurableAdmission,
          Effect.catchTag("RuntimeDrainingError", (error) =>
            Effect.fail(new ScheduleError({ reason: "conflict", message: error.message })),
          ),
          Effect.tap(() => changed(sessionID)),
        )
    const changed = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        if (row) yield* events.publish(Session.Event.Updated, { sessionID, info: Session.fromRow(row) })
      })
    const get = (sessionID: SessionID, id: string) => requireRow(sessionID, id).pipe(Effect.map(info))
    return Service.of({
      get,
      list: (sessionID) =>
        Effect.gen(function* () {
          yield* authorize(sessionID)
          return (yield* db
            .select()
            .from(SessionScheduleTable)
            .where(eq(SessionScheduleTable.session_id, sessionID))
            .orderBy(asc(SessionScheduleTable.time_created), asc(SessionScheduleTable.id))
            .all()
            .pipe(Effect.orDie)).map(info)
        }),
      create: (sessionID, submitted) =>
        transaction(
          sessionID,
          Effect.gen(function* () {
            yield* authorize(sessionID)
            const input = yield* validate(submitted)
            const now = Date.now()
            const row = {
              id: `sch_${randomUUID()}`,
              session_id: sessionID,
              input,
              anchor: now,
              time_created: now,
              status: "active" as const,
              completed: 0,
              next:
                input.spec.mode === "interval" && input.spec.immediate ? now : ScheduleTime.next(input.spec, now, now),
            }
            yield* db.insert(SessionScheduleTable).values(row).run().pipe(Effect.orDie)
            return info(row)
          }),
        ),
      update: (sessionID, id, submitted) =>
        transaction(
          sessionID,
          Effect.gen(function* () {
            const row = yield* requireRow(sessionID, id)
            const input = yield* validate(submitted)
            const reserved = yield* db
              .get<{
                count: number
              }>(
                sql`SELECT count(*) AS count FROM session_schedule_occurrence WHERE schedule_id = ${id} AND state IN ('accepted', 'uncertain')`,
              )
              .pipe(Effect.orDie)
            if (input.limit !== undefined && input.limit < row.completed + (reserved?.count ?? 0))
              return yield* new ScheduleError({
                reason: "conflict",
                message: "Delivery limit is below already delivered or reserved occurrences",
              })
            const edited = !sameGrid(row.input.spec, input.spec)
            const completed = row.status === "completed" || (input.limit !== undefined && input.limit <= row.completed)
            const anchor = edited ? Date.now() : row.anchor
            const next = edited
              ? ScheduleTime.next(
                  input.spec,
                  anchor,
                  anchor - (input.spec.mode === "interval" && input.spec.immediate ? 1 : 0),
                )
              : row.next
            if (edited || completed)
              yield* db
                .update(SessionScheduleOccurrenceTable)
                .set({ state: "discarded", processed: Date.now() })
                .where(
                  and(
                    eq(SessionScheduleOccurrenceTable.schedule_id, id),
                    eq(SessionScheduleOccurrenceTable.state, "deferred"),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
            yield* db
              .update(SessionScheduleTable)
              .set({
                input,
                anchor,
                next: completed || row.status === "paused" ? null : next,
                status: completed ? "completed" : row.status,
              })
              .where(eq(SessionScheduleTable.id, id))
              .run()
              .pipe(Effect.orDie)
            return yield* get(sessionID, id)
          }),
        ),
      pause: (sessionID, id, paused) =>
        transaction(
          sessionID,
          Effect.gen(function* () {
            const row = yield* requireRow(sessionID, id)
            if (row.status === "completed") return info(row)
            if ((row.status === "paused") === paused) return info(row)
            yield* db
              .update(SessionScheduleOccurrenceTable)
              .set({ state: "discarded", processed: Date.now() })
              .where(
                and(
                  eq(SessionScheduleOccurrenceTable.schedule_id, id),
                  eq(SessionScheduleOccurrenceTable.state, "deferred"),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            yield* db
              .update(SessionScheduleTable)
              .set({
                status: paused ? "paused" : "active",
                next: paused ? null : ScheduleTime.next(row.input.spec, row.anchor, Date.now()),
              })
              .where(eq(SessionScheduleTable.id, id))
              .run()
              .pipe(Effect.orDie)
            return yield* get(sessionID, id)
          }),
        ),
      remove: (sessionID, id) =>
        transaction(
          sessionID,
          Effect.gen(function* () {
            yield* requireRow(sessionID, id)
            yield* db.delete(SessionScheduleTable).where(eq(SessionScheduleTable.id, id)).run().pipe(Effect.orDie)
          }),
        ),
      history: (sessionID, id, cursor) =>
        Effect.gen(function* () {
          yield* requireRow(sessionID, id)
          const rows = yield* db
            .select()
            .from(SessionScheduleOccurrenceTable)
            .where(
              and(
                eq(SessionScheduleOccurrenceTable.schedule_id, id),
                cursor === undefined ? undefined : lt(SessionScheduleOccurrenceTable.scheduled, cursor),
              ),
            )
            .orderBy(desc(SessionScheduleOccurrenceTable.scheduled))
            .limit(51)
            .all()
            .pipe(Effect.orDie)
          return {
            items: rows.slice(0, 50).map((row) => ({
              id: row.id,
              scheduleID: row.schedule_id,
              scheduled: row.scheduled,
              state: row.state,
              ...(row.processed === null ? {} : { processed: row.processed }),
              ...(row.message_id ? { messageID: row.message_id } : {}),
              ...(row.error ? { error: row.error } : {}),
            })),
            ...(rows.length > 50 ? { cursor: rows.slice(0, 50).at(-1)?.scheduled } : {}),
          }
        }),
      preview: (sessionID, input) =>
        Effect.gen(function* () {
          yield* authorize(sessionID)
          yield* Effect.try({
            try: () => ScheduleTime.validate(input.spec),
            catch: (error) => new ScheduleError({ reason: "invalid", message: String(error) }),
          })
          const row = input.scheduleID ? yield* requireRow(sessionID, input.scheduleID) : undefined
          const now = Date.now()
          const edited = !row || !sameGrid(row.input.spec, input.spec)
          return yield* Effect.try({
            try: () => ({
              times: ScheduleTime.preview(
                input.spec,
                edited ? now : row.anchor,
                edited && input.spec.mode === "interval" && input.spec.immediate ? now - 1 : now,
              ),
              summary: ScheduleTime.summary(input.spec),
            }),
            catch: (error) =>
              new ScheduleError({
                reason: "invalid",
                message: error instanceof Error ? error.message : "Invalid schedule",
              }),
          })
        }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, EventV2Bridge.node] })
