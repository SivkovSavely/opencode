import { randomUUID } from "node:crypto"
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionQueueStateTable, SessionQueueTable } from "@opencode-ai/core/session/queue.sql"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { SessionV1 } from "@opencode-ai/schema/v1/session"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import type { MessageID, SessionID } from "./schema"
import { SessionQueueMigration } from "./queue-migration"

export const Event = SessionQueueV1.Event

export class QueueError extends Schema.TaggedErrorClass<QueueError>()("SessionQueueError", {
  reason: Schema.Literals(["not_found", "scope", "archived", "conflict", "invalid"]),
  message: Schema.String,
}) {}

type Result<A> = Effect.Effect<A, QueueError>

export interface Interface {
  readonly list: (sessionID: SessionID) => Result<SessionQueueV1.Snapshot>
  readonly enqueue: (sessionID: SessionID, input: SessionQueueV1.Submit) => Result<SessionQueueV1.Snapshot>
  readonly update: (sessionID: SessionID, input: SessionQueueV1.Update) => Result<SessionQueueV1.Snapshot>
  readonly registerSteer: (
    sessionID: SessionID,
    id: string,
    payload: SessionQueueV1.Payload,
    messageID: MessageID,
  ) => Result<SessionQueueV1.Entry>
  readonly attachSteer: (sessionID: SessionID, id: string, messageID: MessageID) => Result<SessionQueueV1.Entry>
  readonly claimSteers: (sessionID: SessionID, messageIDs: readonly MessageID[]) => Result<SessionQueueV1.Entry[]>
  readonly claimNext: (
    sessionID: SessionID,
    explicit?: boolean,
    ids?: ReadonlySet<string>,
  ) => Result<SessionQueueV1.Entry | undefined>
  readonly delivered: (sessionID: SessionID, id: string, messageID?: MessageID) => Result<SessionQueueV1.Entry>
  readonly block: (sessionID: SessionID) => Result<SessionQueueV1.Snapshot>
  readonly abandon: (sessionID: SessionID) => Result<SessionQueueV1.Snapshot>
  readonly unblock: (sessionID: SessionID) => Result<SessionQueueV1.Snapshot>
  readonly get: (sessionID: SessionID, id: string) => Result<SessionQueueV1.Entry>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionQueue") {}

// A service/layer rebuild is not a process restart. Never automatically retry an
// entry reserved by another process, even when explicitly bypassing pause/block.
const ClaimOwner = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, process: Schema.optional(RuntimeLifecycle.ProcessIdentity) }),
)
const owner = JSON.stringify({ id: randomUUID(), process: RuntimeLifecycle.processIdentity() })
type Row = typeof SessionQueueTable.$inferSelect
type State = typeof SessionQueueStateTable.$inferSelect

const entry = (row: Row): SessionQueueV1.Entry => ({
  id: row.id,
  sessionID: row.session_id,
  delivery: row.delivery,
  state: row.state,
  position: row.position,
  payload: Schema.decodeUnknownSync(SessionQueueV1.Payload)(row.payload),
  ...(row.message_id ? { messageID: row.message_id } : {}),
  created: row.time_created,
})

// Compare persisted JSON identities independently of object key order and omitted
// optional fields, including legacy part inputs that encode undefined properties.
function identity(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service

    const rows = (sessionID: SessionID) =>
      db
        .select()
        .from(SessionQueueTable)
        .where(
          and(
            eq(SessionQueueTable.session_id, sessionID),
            inArray(SessionQueueTable.state, ["pending", "claimed", "uncertain"]),
          ),
        )
        .orderBy(asc(SessionQueueTable.position), asc(SessionQueueTable.id))
        .all()
        .pipe(Effect.orDie)

    const requireRow = Effect.fnUntraced(function* (sessionID: SessionID, id: string) {
      const row = yield* db
        .select()
        .from(SessionQueueTable)
        .where(and(eq(SessionQueueTable.id, id), eq(SessionQueueTable.session_id, sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new QueueError({ reason: "not_found", message: `Queue entry not found: ${id}` })
      return row
    })

    const requireMessage = Effect.fnUntraced(function* (sessionID: SessionID, messageID: MessageID, id: string) {
      const message = yield* db
        .select()
        .from(MessageTable)
        .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!message || message.data.role !== "user")
        return yield* new QueueError({
          reason: "invalid",
          message: "Steer requires a persisted user message in this session",
        })
      const existing = yield* db
        .select()
        .from(SessionQueueTable)
        .where(and(eq(SessionQueueTable.message_id, messageID), ne(SessionQueueTable.id, id)))
        .get()
        .pipe(Effect.orDie)
      if (existing)
        return yield* new QueueError({ reason: "conflict", message: "Message already belongs to another queue entry" })
    })

    const transaction = <A>(sessionID: SessionID, action: (state: State) => Result<{ value: A; changed: boolean }>) =>
      Effect.gen(function* () {
        const imported = yield* SessionQueueMigration.ensure(sessionID).pipe(
          Effect.provideService(Database.Service, { db }),
        )
        const result = yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                const ctx = yield* InstanceRef
                const workspaceID = yield* WorkspaceRef
                const session = yield* db
                  .select()
                  .from(SessionTable)
                  .where(eq(SessionTable.id, sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (!session)
                  return yield* new QueueError({ reason: "not_found", message: `Session not found: ${sessionID}` })
                if (
                  !ctx ||
                  session.project_id !== ctx.project.id ||
                  session.directory !== ctx.directory ||
                  (session.workspace_id ?? undefined) !== workspaceID
                )
                  return yield* new QueueError({
                    reason: "scope",
                    message: "Session is outside the active project/directory/workspace",
                  })
                if (session.time_archived !== null)
                  return yield* new QueueError({ reason: "archived", message: "Session is archived" })

                yield* db
                  .insert(SessionQueueStateTable)
                  .values({ session_id: sessionID })
                  .onConflictDoNothing()
                  .run()
                  .pipe(Effect.orDie)
                const foreign = yield* db
                  .select()
                  .from(SessionQueueTable)
                  .where(
                    and(
                      eq(SessionQueueTable.session_id, sessionID),
                      eq(SessionQueueTable.state, "claimed"),
                      or(ne(SessionQueueTable.owner, owner), isNull(SessionQueueTable.owner)),
                    ),
                  )
                  .all()
                  .pipe(Effect.orDie)
                const recovered = foreign.filter((row) => {
                  const identity = Schema.decodeUnknownOption(ClaimOwner)(row.owner)
                  return (
                    Option.isSome(identity) &&
                    identity.value.process &&
                    RuntimeLifecycle.processLiveness(identity.value.process) === "dead"
                  )
                })
                if (recovered.length) {
                  yield* db
                    .update(SessionQueueTable)
                    .set({ state: "uncertain" })
                    .where(
                      inArray(
                        SessionQueueTable.id,
                        recovered.map((row) => row.id),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie)
                  yield* db
                    .update(SessionQueueStateTable)
                    .set({ blocked: true, revision: sql`${SessionQueueStateTable.revision} + 1` })
                    .where(eq(SessionQueueStateTable.session_id, sessionID))
                    .run()
                    .pipe(Effect.orDie)
                }
                const state = yield* db
                  .select()
                  .from(SessionQueueStateTable)
                  .where(eq(SessionQueueStateTable.session_id, sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (!state) return yield* Effect.die("Missing queue state")
                const output = yield* action(state)
                const changed = imported === true || recovered.length > 0 || output.changed
                if (output.changed)
                  yield* db
                    .update(SessionQueueStateTable)
                    .set({ revision: sql`${SessionQueueStateTable.revision} + 1` })
                    .where(
                      and(
                        eq(SessionQueueStateTable.session_id, sessionID),
                        eq(SessionQueueStateTable.revision, state.revision),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie)
                const current = yield* db
                  .select()
                  .from(SessionQueueStateTable)
                  .where(eq(SessionQueueStateTable.session_id, sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (!current) return yield* Effect.die("Missing queue state")
                const snapshot: SessionQueueV1.Snapshot = {
                  sessionID,
                  revision: current.revision,
                  paused: current.paused,
                  blocked: current.blocked,
                  items: (yield* rows(sessionID)).map(entry),
                }
                return { value: output.value, snapshot, changed }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.catchTag("SqlError", Effect.die))
        // With an ambient transaction this is after savepoint release, NOT outer
        // commit. Runtime callers must treat the event as an invalidation hint.
        if (result.changed) yield* events.publish(Event.Changed, { sessionID, revision: result.snapshot.revision })
        return result
      })

    const list = Effect.fn("SessionQueue.list")(function* (sessionID: SessionID) {
      return (yield* transaction(sessionID, () => Effect.succeed({ value: undefined, changed: false }))).snapshot
    })

    const admit = Effect.fnUntraced(function* (
      sessionID: SessionID,
      input: SessionQueueV1.Submit,
      delivery: SessionQueueV1.Delivery,
      messageID?: MessageID,
    ) {
      const encoded = yield* Schema.encodeEffect(SessionQueueV1.Payload)(input.payload).pipe(
        Effect.mapError((error) => new QueueError({ reason: "invalid", message: error.message })),
      )
      const submission = yield* Effect.try({
        try: () =>
          identity({
            payload: encoded,
            front: input.front ?? false,
            delivery,
            ...(messageID ? { messageID } : {}),
          }),
        catch: () => new QueueError({ reason: "invalid", message: "Queue payload must be JSON serializable" }),
      })
      return yield* transaction(sessionID, () =>
        Effect.gen(function* () {
          const retired = yield* db
            .get<{
              root_session_id: string
            }>(sql`SELECT root_session_id FROM runtime_retirement WHERE session_id = ${sessionID}`)
            .pipe(Effect.orDie)
          if (retired) return yield* new QueueError({ reason: "conflict", message: "Session root is retired" })
          const existing = yield* db
            .select()
            .from(SessionQueueTable)
            .where(eq(SessionQueueTable.id, input.id))
            .get()
            .pipe(Effect.orDie)
          if (existing) {
            if (existing.session_id !== sessionID || existing.submission !== submission)
              return yield* new QueueError({
                reason: "conflict",
                message: "Queue ID was already submitted with different input",
              })
            return { value: entry(existing), changed: false }
          }
          if (messageID) yield* requireMessage(sessionID, messageID, input.id)
          const group = (yield* rows(sessionID)).filter((row) => row.delivery === delivery)
          const position = group.length
            ? input.front
              ? Math.min(...group.map((row) => row.position)) - 1
              : Math.max(...group.map((row) => row.position)) + 1
            : 0
          const row = {
            id: input.id,
            session_id: sessionID,
            payload: encoded,
            submission,
            delivery,
            state: "pending" as const,
            position,
            message_id: messageID ?? null,
            owner: null,
            time_created: Date.now(),
          }
          yield* db.insert(SessionQueueTable).values(row).run().pipe(Effect.orDie)
          return { value: entry(row), changed: true }
        }),
      )
    })

    const enqueue = Effect.fn("SessionQueue.enqueue")(function* (sessionID: SessionID, input: SessionQueueV1.Submit) {
      const payload = input.payload
      if (
        !input.id.trim() ||
        !payload.agent.trim() ||
        !payload.model.providerID.trim() ||
        !payload.model.modelID.trim() ||
        (payload.kind === "prompt" && !payload.parts.some((part) => part.type !== "text" || part.text.trim())) ||
        ((payload.kind === "shell" || payload.kind === "command") && !payload.command.trim())
      )
        return yield* new QueueError({
          reason: "invalid",
          message: "Queue input is empty or missing submission metadata",
        })
      if (
        (payload.kind === "prompt" || payload.kind === "command") &&
        payload.parts?.some((part) => part.type === "file" && part.url.startsWith("blob:"))
      )
        return yield* new QueueError({
          reason: "invalid",
          message: "Queue attachments must use durable URLs, not browser blob URLs",
        })
      return (yield* admit(sessionID, input, "queue")).snapshot
    })
    const registerSteer = Effect.fn("SessionQueue.registerSteer")(function* (
      sessionID: SessionID,
      id: string,
      payload: SessionQueueV1.Payload,
      messageID: MessageID,
    ) {
      return (yield* admit(sessionID, { id, payload }, "steer", messageID)).value
    })

    const update = Effect.fn("SessionQueue.update")(function* (sessionID: SessionID, input: SessionQueueV1.Update) {
      return (yield* transaction(sessionID, (state) =>
        Effect.gen(function* () {
          if (state.revision !== input.revision)
            return yield* new QueueError({
              reason: "conflict",
              message: `Stale queue revision: expected ${state.revision}, received ${input.revision}`,
            })
          const mutation = input.mutation
          if (mutation.action === "pause") {
            yield* db
              .update(SessionQueueStateTable)
              .set({ paused: mutation.paused })
              .where(eq(SessionQueueStateTable.session_id, sessionID))
              .run()
              .pipe(Effect.orDie)
            return { value: undefined, changed: state.paused !== mutation.paused }
          }
          const pending = (yield* rows(sessionID)).filter((row) => row.state === "pending")
          if (mutation.action === "reorder") {
            const group = pending.filter((row) => row.delivery === mutation.delivery)
            if (
              mutation.ids.length !== group.length ||
              new Set(mutation.ids).size !== group.length ||
              group.some((row) => !mutation.ids.includes(row.id))
            )
              return yield* new QueueError({
                reason: "invalid",
                message: "Reorder must contain every pending ID in the delivery group exactly once",
              })
            yield* Effect.forEach(mutation.ids, (id, position) =>
              db
                .update(SessionQueueTable)
                .set({ position })
                .where(eq(SessionQueueTable.id, id))
                .run()
                .pipe(Effect.orDie),
            )
            return {
              value: undefined,
              changed: group.some((row, position) => row.id !== mutation.ids[position] || row.position !== position),
            }
          }
          const targets =
            mutation.action === "clear"
              ? pending.filter((row) => row.delivery === "queue")
              : [yield* requireRow(sessionID, mutation.id)]
          if (targets.some((row) => row.state !== "pending"))
            return yield* new QueueError({ reason: "conflict", message: "Only pending entries can be changed" })
          const changed = targets.filter((row) => mutation.action !== "convert" || row.delivery !== mutation.delivery)
          yield* Effect.forEach(changed, (row) =>
            Effect.gen(function* () {
              if (row.delivery === "steer" && row.message_id) {
                yield* db
                  .delete(MessageTable)
                  .where(and(eq(MessageTable.id, row.message_id), eq(MessageTable.session_id, sessionID)))
                  .run()
                  .pipe(Effect.orDie)
                // Keep the durable legacy journal consistent with its projection.
                yield* events.publish(SessionV1.Event.MessageRemoved, { sessionID, messageID: row.message_id })
              }
              const group =
                mutation.action === "convert" ? pending.filter((item) => item.delivery === mutation.delivery) : []
              yield* db
                .update(SessionQueueTable)
                .set(
                  mutation.action === "convert"
                    ? {
                        delivery: mutation.delivery,
                        message_id: null,
                        position: group.length ? Math.max(...group.map((item) => item.position)) + 1 : 0,
                      }
                    : { state: "deleted", message_id: null },
                )
                .where(and(eq(SessionQueueTable.id, row.id), eq(SessionQueueTable.state, "pending")))
                .run()
                .pipe(Effect.orDie)
            }),
          )
          return { value: undefined, changed: changed.length > 0 }
        }),
      )).snapshot
    })

    const attachSteer = Effect.fn("SessionQueue.attachSteer")(function* (
      sessionID: SessionID,
      id: string,
      messageID: MessageID,
    ) {
      return (yield* transaction(sessionID, () =>
        Effect.gen(function* () {
          const row = yield* requireRow(sessionID, id)
          if (row.delivery !== "steer" || row.state !== "pending" || (row.message_id && row.message_id !== messageID))
            return yield* new QueueError({ reason: "conflict", message: "Entry is not an unattached pending steer" })
          yield* requireMessage(sessionID, messageID, id)
          yield* db
            .update(SessionQueueTable)
            .set({ message_id: messageID })
            .where(eq(SessionQueueTable.id, id))
            .run()
            .pipe(Effect.orDie)
          return { value: entry({ ...row, message_id: messageID }), changed: row.message_id !== messageID }
        }),
      )).value
    })

    const claimSteers = Effect.fn("SessionQueue.claimSteers")(function* (
      sessionID: SessionID,
      messageIDs: readonly MessageID[],
    ) {
      return (yield* transaction(sessionID, () =>
        Effect.gen(function* () {
          const pending = (yield* rows(sessionID)).filter(
            (row) =>
              row.delivery === "steer" &&
              row.state === "pending" &&
              row.message_id &&
              messageIDs.includes(row.message_id),
          )
          const claimed = yield* Effect.forEach(pending, (row) =>
            Effect.gen(function* () {
              if (!row.message_id) return yield* Effect.die("Missing steer message")
              yield* requireMessage(sessionID, row.message_id, row.id)
              const state = row.payload.kind === "command" ? "claimed" : "delivered"
              yield* db
                .update(SessionQueueTable)
                .set({ state, owner: state === "claimed" ? owner : row.owner })
                .where(and(eq(SessionQueueTable.id, row.id), eq(SessionQueueTable.state, "pending")))
                .run()
                .pipe(Effect.orDie)
              return entry({ ...row, state })
            }),
          )
          return { value: claimed, changed: claimed.length > 0 }
        }),
      )).value
    })

    const claimNext = Effect.fn("SessionQueue.claimNext")(function* (
      sessionID: SessionID,
      explicit = false,
      ids?: ReadonlySet<string>,
    ) {
      return (yield* transaction(sessionID, (state) =>
        Effect.gen(function* () {
          const items = yield* rows(sessionID)
          if ((!explicit && (state.paused || state.blocked)) || items.some((row) => row.state === "claimed"))
            return { value: undefined, changed: false }
          const row = items.find(
            (row) => row.state === "pending" && row.delivery === "queue" && (!ids || ids.has(row.id)),
          )
          if (!row) return { value: undefined, changed: false }
          yield* db
            .update(SessionQueueTable)
            .set({ state: "claimed", owner })
            .where(and(eq(SessionQueueTable.id, row.id), eq(SessionQueueTable.state, "pending")))
            .run()
            .pipe(Effect.orDie)
          return { value: entry({ ...row, state: "claimed" }), changed: true }
        }),
      )).value
    })

    const delivered = Effect.fn("SessionQueue.delivered")(function* (
      sessionID: SessionID,
      id: string,
      messageID?: MessageID,
    ) {
      return (yield* transaction(sessionID, () =>
        Effect.gen(function* () {
          const row = yield* requireRow(sessionID, id)
          if (row.state === "delivered" && (!messageID || row.message_id === messageID))
            return { value: entry(row), changed: false }
          if (
            row.state !== "claimed" ||
            row.owner !== owner ||
            (row.message_id && messageID && row.message_id !== messageID)
          )
            return yield* new QueueError({ reason: "conflict", message: "Entry is not claimed by this process" })
          const next = { ...row, state: "delivered" as const, message_id: messageID ?? row.message_id }
          yield* db
            .update(SessionQueueTable)
            .set({ state: next.state, message_id: next.message_id })
            .where(eq(SessionQueueTable.id, id))
            .run()
            .pipe(Effect.orDie)
          return { value: entry(next), changed: true }
        }),
      )).value
    })

    const setBlocked = Effect.fnUntraced(function* (sessionID: SessionID, blocked: boolean, abandon = false) {
      return (yield* transaction(sessionID, (state) =>
        Effect.gen(function* () {
          const abandoned = abandon
            ? yield* db
                .update(SessionQueueTable)
                .set({ state: "uncertain" })
                .where(
                  and(
                    eq(SessionQueueTable.session_id, sessionID),
                    eq(SessionQueueTable.state, "claimed"),
                    eq(SessionQueueTable.owner, owner),
                  ),
                )
                .returning()
                .all()
                .pipe(Effect.orDie)
            : []
          yield* db
            .update(SessionQueueStateTable)
            .set({ blocked })
            .where(eq(SessionQueueStateTable.session_id, sessionID))
            .run()
            .pipe(Effect.orDie)
          return { value: undefined, changed: state.blocked !== blocked || abandoned.length > 0 }
        }),
      )).snapshot
    })

    const get = Effect.fn("SessionQueue.get")(function* (sessionID: SessionID, id: string) {
      return (yield* transaction(sessionID, () =>
        requireRow(sessionID, id).pipe(Effect.map((row) => ({ value: entry(row), changed: false }))),
      )).value
    })

    return Service.of({
      list,
      enqueue,
      update,
      registerSteer,
      attachSteer,
      claimSteers,
      claimNext,
      delivered,
      get,
      block: (sessionID) => setBlocked(sessionID, true),
      abandon: (sessionID) => setBlocked(sessionID, true, true),
      unblock: (sessionID) => setBlocked(sessionID, false),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, EventV2Bridge.node] })

export * as SessionQueue from "./queue"
