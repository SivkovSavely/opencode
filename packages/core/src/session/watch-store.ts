import { and, desc, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SessionWatchV1 } from "@opencode-ai/schema/v1/session-watch"
import { SessionID } from "@opencode-ai/schema/session-id"
import type { Database } from "../database/database"
import { SessionTable } from "./sql"
import { SessionWatchDeliveryTable, SessionWatchExecutionTable, SessionWatchTable } from "./watch.sql"

export class WatchError extends Schema.TaggedErrorClass<WatchError>()("SessionWatchError", {
  code: Schema.Literals(["invalid", "conflict", "not_found", "limit", "scope"]),
  message: Schema.String,
}) {}

type Connection = Pick<Database.Interface, "db">

export const create = Effect.fn("SessionWatchStore.create")(function* (
  database: Connection,
  input: SessionWatchV1.Create,
  authorized: readonly SessionWatchV1.Scope[] = [],
) {
  const decoded = yield* Schema.decodeUnknownEffect(SessionWatchV1.Create)(input).pipe(
    Effect.mapError((error) => new WatchError({ code: "invalid", message: error.message })),
  )
  const submission = JSON.stringify({ ...decoded, events: [...new Set(decoded.events)].sort() })
  const db = database.db
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const existing = yield* db.select().from(SessionWatchTable).where(eq(SessionWatchTable.id, input.id)).get()
          if (existing) {
            if (existing.owner_id !== input.owner || existing.submission !== submission)
              return yield* new WatchError({ code: "conflict", message: "Watch ID already belongs to different input" })
            return existing
          }
          if (input.source === input.destination)
            return yield* new WatchError({ code: "invalid", message: "A session cannot watch itself" })
          const scopes = yield* Effect.forEach([input.owner, input.source, input.destination], (id) =>
            Effect.gen(function* () {
              const session = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(id)))
                .get()
              if (!session || session.time_archived !== null)
                return yield* new WatchError({
                  code: "not_found",
                  message: "Watch sessions must exist and not be archived",
                })
              if (
                authorized.some(
                  (scope) =>
                    scope.sessionID === id &&
                    (scope.projectID !== session.project_id ||
                      scope.directory !== session.directory ||
                      scope.workspaceID !== (session.workspace_id ?? undefined)),
                )
              )
                return yield* new WatchError({ code: "scope", message: "Watch scope changed after authorization" })
              return {
                sessionID: session.id,
                projectID: session.project_id,
                directory: session.directory,
                ...(session.workspace_id ? { workspaceID: session.workspace_id } : {}),
              }
            }),
          )
          const bounds = yield* db.get<{ total: number; owned: number }>(sql`
      SELECT count(*) AS total, count(*) FILTER (WHERE owner_id = ${input.owner}) AS owned FROM session_watch`)
          if (bounds && (bounds.total >= 4096 || bounds.owned >= 64))
            return yield* new WatchError({
              code: "limit",
              message: "Watch retention limit reached (64 per owner, 4096 total)",
            })
          if (input.delivery === "auto") {
            const cycle = yield* db.get(sql`WITH RECURSIVE reachable(id) AS (
        SELECT ${input.destination}
        UNION SELECT w.destination_id FROM session_watch w JOIN reachable r ON w.source_id = r.id
          WHERE w.delivery = 'auto'
      ) SELECT 1 FROM reachable WHERE id = ${input.source} LIMIT 1`)
            if (cycle)
              return yield* new WatchError({ code: "invalid", message: "Automatic watches must form an acyclic graph" })
          }
          const current = yield* db
            .select()
            .from(SessionWatchExecutionTable)
            .where(eq(SessionWatchExecutionTable.session_id, input.source))
            .orderBy(desc(SessionWatchExecutionTable.sequence))
            .get()
          const row = {
            id: input.id,
            owner_id: input.owner,
            source_id: input.source,
            destination_id: input.destination,
            scopes,
            submission,
            events: decoded.events,
            mode: input.mode,
            delivery: input.delivery,
            status: "active" as const,
            execution_id: input.mode === "once" && current?.state === "running" ? current.id : null,
            after_sequence: current?.state === "running" ? current.sequence - 1 : (current?.sequence ?? 0),
            accepted: 0,
            maximum: input.limit,
            agent: input.agent ?? null,
            error: null,
            time_created: Date.now(),
          }
          yield* db.insert(SessionWatchTable).values(row).run()
          return row
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const get = Effect.fn("SessionWatchStore.get")(function* (database: Connection, owner: string, id: string) {
  const value = yield* database.db
    .select()
    .from(SessionWatchTable)
    .where(and(eq(SessionWatchTable.id, id), eq(SessionWatchTable.owner_id, owner)))
    .get()
    .pipe(Effect.orDie)
  if (!value) return yield* new WatchError({ code: "not_found", message: "Watch not found for this owner" })
  return value
})

export const list = (database: Connection, owner: string) =>
  database.db
    .select()
    .from(SessionWatchTable)
    .where(eq(SessionWatchTable.owner_id, owner))
    .orderBy(desc(SessionWatchTable.time_created))
    .limit(64)
    .all()
    .pipe(Effect.orDie)

export const deliveries = (database: Connection, owner: string, id: string, after = "") =>
  Effect.gen(function* () {
    yield* get(database, owner, id)
    const cursor = after
      ? yield* database.db
          .get<{ sequence: number }>(
            sql`
    SELECT rowid AS sequence FROM session_watch_delivery WHERE id = ${after} AND watch_id = ${id}`,
          )
          .pipe(Effect.orDie)
      : undefined
    if (after && !cursor) return yield* new WatchError({ code: "invalid", message: "Unknown delivery cursor" })
    return (yield* database.db
      .select()
      .from(SessionWatchDeliveryTable)
      .where(
        and(
          eq(SessionWatchDeliveryTable.watch_id, id),
          sql`${SessionWatchDeliveryTable}.rowid > ${cursor?.sequence ?? 0}`,
        ),
      )
      .orderBy(sql`${SessionWatchDeliveryTable}.rowid`)
      .limit(128)
      .all()
      .pipe(Effect.orDie)).map((row) => ({ ...row, executionID: row.execution_id }))
  })

export const cancel = (database: Connection, owner: string, id: string) =>
  database.db
    .transaction(
      () =>
        Effect.gen(function* () {
          yield* get(database, owner, id)
          yield* database.db
            .update(SessionWatchTable)
            .set({ status: "cancelled" })
            .where(eq(SessionWatchTable.id, id))
            .run()
          // Accepted queue entries already belong to the destination. Cancelling a watch
          // never silently removes its previously admitted input.
          yield* database.db
            .update(SessionWatchDeliveryTable)
            .set({ state: "cancelled" })
            .where(and(eq(SessionWatchDeliveryTable.watch_id, id), eq(SessionWatchDeliveryTable.state, "pending")))
            .run()
          return yield* get(database, owner, id)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))

export const result = Effect.fn("SessionWatchStore.result")(function* (
  database: Connection,
  sessionID: string,
  input: {
    outcome: "completed" | "failed"
    summary: string
    messageID?: string
    ownerLineage: string
    ownerInstance: string
    fence: number
  },
) {
  yield* database.db
    .update(SessionWatchExecutionTable)
    .set({
      result: input.outcome,
      summary: input.summary.slice(0, 2000),
      message_id: input.messageID ?? null,
    })
    .where(
      and(
        eq(SessionWatchExecutionTable.session_id, sessionID),
        eq(SessionWatchExecutionTable.state, "running"),
        eq(SessionWatchExecutionTable.owner_lineage, input.ownerLineage),
        eq(SessionWatchExecutionTable.owner_instance, input.ownerInstance),
        eq(SessionWatchExecutionTable.fence, input.fence),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export const idle = (database: Connection, sessionID: string) =>
  database.db
    .transaction(
      () =>
        Effect.gen(function* () {
          yield* database.db.run(sql`INSERT OR IGNORE INTO session_watch_event
    (id, execution_id, source_id, sequence, outcome, summary, time_created)
    SELECT id || '/idle', id, session_id, sequence, 'idle', substr(summary, 1, 2000), ${Date.now()}
      FROM session_watch_execution WHERE session_id = ${sessionID} ORDER BY sequence DESC LIMIT 1`)
          yield* database.db.run(sql`UPDATE session_watch SET status = 'invalidated',
    error = 'Tracked execution ended without a matching event'
    WHERE status = 'active' AND mode = 'once' AND execution_id IN
      (SELECT id FROM session_watch_execution WHERE session_id = ${sessionID} AND state = 'terminal')`)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)

export * as SessionWatchStore from "./watch-store"
