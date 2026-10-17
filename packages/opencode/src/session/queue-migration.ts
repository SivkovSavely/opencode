import { createHash } from "node:crypto"
import path from "node:path"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { SessionQueueImportTable } from "@opencode-ai/core/session/queue-import.sql"
import { SessionQueueStateTable, SessionQueueTable } from "@opencode-ai/core/session/queue.sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { MessageID, SessionID } from "./schema"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function canonical(value: unknown) {
  return JSON.stringify(value, (_, item: unknown) =>
    record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  )
}

export const storagePath = (projectID: string) =>
  path.join(Global.Path.data, "opencode-queue", `${createHash("sha256").update(projectID).digest("hex")}.json`)

function payload(item: unknown) {
  if (!record(item) || !record(item.info)) return
  const common = { agent: item.info.agent, model: item.info.model, variant: item.info.variant }
  const value = (() => {
    switch (item.kind) {
      case "prompt":
        if (typeof item.body !== "string" || !Array.isArray(item.parts) || !item.parts.length) return
        // Plugin parts include persisted message/session/part IDs. Replay always
        // allocated fresh IDs, so none of those identities belong to native input.
        return {
          ...common,
          kind: item.kind,
          parts: item.parts.map((part: unknown) => {
            if (!record(part)) return part
            const { id, sessionID, messageID, ...input } = part
            return input
          }),
        }
      case "command":
        if (
          typeof item.source !== "string" ||
          typeof item.cmd !== "string" ||
          typeof item.args !== "string" ||
          !Array.isArray(item.files)
        )
          return
        return {
          ...common,
          kind: item.kind,
          command: item.cmd,
          arguments: item.args,
          parts: item.files.map((part: unknown) => {
            if (!record(part)) return part
            const { id, sessionID, messageID, ...input } = part
            return input
          }),
        }
      case "shell":
        if (typeof item.source !== "string" || typeof item.shell !== "string") return
        return { ...common, kind: item.kind, command: item.shell }
      case "compact":
        if (typeof item.source !== "string") return
        return { ...common, kind: item.kind }
    }
  })()
  const decoded = Schema.decodeUnknownOption(SessionQueueV1.Payload)(value)
  return Option.isSome(decoded) ? Schema.encodeSync(SessionQueueV1.Payload)(decoded.value) : undefined
}

// Database-only dependencies let both the store and transcript reads migrate
// lazily, without a Session -> Queue -> Plugin/Question dependency cycle.
export const ensure = Effect.fn("SessionQueueMigration.ensure")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const ctx = yield* InstanceRef
  const workspaceID = yield* WorkspaceRef
  if (!ctx) return
  const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  if (
    !session ||
    session.project_id !== ctx.project.id ||
    session.directory !== ctx.directory ||
    (session.workspace_id ?? undefined) !== workspaceID
  )
    return
  if (
    yield* db
      .select()
      .from(SessionQueueImportTable)
      .where(eq(SessionQueueImportTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
  )
    return

  const file = storagePath(ctx.project.id)
  const contents = yield* Effect.tryPromise(() => Bun.file(file).text()).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const cause = error.cause
        if (!record(cause) || cause.code !== "ENOENT")
          yield* Effect.logWarning("Native queue could not read legacy queue storage; source retained", { file, error })
        return undefined
      }),
    ),
  )
  if (contents === undefined) return
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(contents)
  if (
    Option.isNone(parsed) ||
    !record(parsed.value) ||
    parsed.value.version !== 1 ||
    parsed.value.projectID !== ctx.project.id ||
    !record(parsed.value.sessions)
  ) {
    yield* Effect.logWarning("Native queue ignored invalid legacy queue storage; source retained", { file })
    return
  }
  const stored = parsed.value.sessions[sessionID]
  if (stored === undefined) return
  if (!record(stored) || typeof stored.stopped !== "boolean" || !Array.isArray(stored.items)) {
    yield* Effect.logWarning("Native queue skipped invalid legacy session", { file, sessionID })
    return
  }
  const items = stored.items.flatMap((item, index) => {
    const converted = payload(item)
    return converted
      ? [
          {
            id: `queue-import-${createHash("sha256")
              .update(canonical([ctx.project.id, sessionID, index, converted]))
              .digest("hex")}`,
            payload: converted,
          },
        ]
      : []
  })
  if (items.length !== stored.items.length)
    yield* Effect.logWarning("Native queue skipped invalid legacy items", {
      file,
      sessionID,
      skipped: stored.items.length - items.length,
    })
  const hidden = Array.isArray(stored.hidden)
    ? stored.hidden.flatMap((id: unknown) => {
        const decoded = Schema.decodeUnknownOption(MessageID)(id)
        return Option.isSome(decoded) ? [decoded.value] : []
      })
    : []
  if (!Array.isArray(stored.hidden) || hidden.length !== stored.hidden.length)
    yield* Effect.logWarning("Native queue skipped invalid legacy hidden IDs", { file, sessionID })

  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          // Recheck the durable marker and placement under the writer lock. Reading
          // the legacy file does not hold a database transaction open across file I/O.
          if (
            yield* db
              .select()
              .from(SessionQueueImportTable)
              .where(eq(SessionQueueImportTable.session_id, sessionID))
              .get()
              .pipe(Effect.orDie)
          )
            return
          const current = yield* db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (
            !current ||
            current.project_id !== ctx.project.id ||
            current.directory !== ctx.directory ||
            (current.workspace_id ?? undefined) !== workspaceID
          )
            return
          const verified = yield* Effect.forEach([...new Set(hidden)], (id) =>
            Effect.gen(function* () {
              const message = yield* db
                .select()
                .from(MessageTable)
                .where(and(eq(MessageTable.id, id), eq(MessageTable.session_id, sessionID)))
                .get()
                .pipe(Effect.orDie)
              if (!message || message.data.role !== "user") return []
              const parts = yield* db
                .select()
                .from(PartTable)
                .where(and(eq(PartTable.message_id, id), eq(PartTable.session_id, sessionID)))
                .all()
                .pipe(Effect.orDie)
              if (
                parts.length &&
                !parts.some((part) => {
                  const data: unknown = part.data
                  return (
                    record(data) &&
                    data.type === "text" &&
                    data.text === "" &&
                    data.synthetic === true &&
                    data.ignored === true
                  )
                })
              )
                return []
              return [id]
            }),
          )
          if (verified.flat().length !== hidden.length)
            yield* Effect.logWarning("Native queue skipped missing, foreign or non-placeholder hidden messages", {
              file,
              sessionID,
            })
          yield* db
            .insert(SessionQueueImportTable)
            .values({ session_id: sessionID, hidden: verified.flat() })
            .run()
            .pipe(Effect.orDie)
          // Archived history can retain filtering, but must never gain executable work.
          if (current.time_archived !== null) {
            yield* Effect.logWarning("Native queue skipped archived legacy backlog", { file, sessionID })
            return
          }
          yield* db
            .insert(SessionQueueStateTable)
            .values({ session_id: sessionID })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const existing = yield* db
            .select()
            .from(SessionQueueTable)
            .where(eq(SessionQueueTable.session_id, sessionID))
            .all()
            .pipe(Effect.orDie)
          const position = existing.reduce((max, row) => Math.max(max, row.position + 1), 0)
          yield* Effect.forEach(items, (item, index) =>
            db
              .insert(SessionQueueTable)
              .values({
                ...item,
                session_id: sessionID,
                delivery: "queue",
                state: "pending",
                position: position + index,
                submission: canonical({ payload: item.payload, front: false, delivery: "queue" }),
                time_created: Date.now(),
              })
              .run()
              .pipe(Effect.orDie),
          )
          yield* db
            .update(SessionQueueStateTable)
            .set({
              paused: sql`${SessionQueueStateTable.paused} OR ${stored.stopped}`,
              blocked: true,
              revision: sql`${SessionQueueStateTable.revision} + 1`,
            })
            .where(eq(SessionQueueStateTable.session_id, sessionID))
            .run()
            .pipe(Effect.orDie)
          yield* Effect.logInfo("Imported legacy queue; explicit start/flush required; source retained", {
            file,
            sessionID,
            items: items.length,
          })
          return true as const
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

// SQL filtering happens before pagination, so hidden placeholders cannot leave
// empty pages or truncate model history. No historical rows or parts are rewritten.
export const visible = sql`NOT EXISTS (
  SELECT 1 FROM ${SessionQueueImportTable}, json_each(${SessionQueueImportTable.hidden})
  WHERE ${SessionQueueImportTable.session_id} = ${MessageTable.session_id}
    AND json_each.value = ${MessageTable.id}
)`

export * as SessionQueueMigration from "./queue-migration"
