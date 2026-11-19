import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Retained independently of live sessions and runtime leases.
export const SessionHandoffControlTable = sqliteTable(
  "session_handoff_control",
  {
    session_id: text().notNull(),
    queue_id: text().notNull(),
    user_message_id: text().notNull(),
    reservation: text().notNull(),
    state: text().notNull(),
    pending_request_id: text(),
    data: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.session_id, t.queue_id, t.user_message_id] })],
)

export const SessionHandoffContextTable = sqliteTable("session_handoff_context", {
  identity: text().primaryKey(),
  session_id: text().notNull(),
  queue_id: text().notNull(),
  user_message_id: text().notNull(),
  retired_reason: text(),
})

export const SessionHandoffCompactionTable = sqliteTable("session_handoff_compaction", {
  message_id: text().primaryKey(),
  session_id: text().notNull(),
  reservation: text().notNull(),
  queue_id: text().notNull(),
  user_message_id: text().notNull(),
  parent_user_message_id: text().notNull(),
  kind: text().notNull(),
  epoch_sequence: integer().notNull(),
  data: text().notNull(),
})

export const SessionHandoffAttemptTable = sqliteTable(
  "session_handoff_attempt",
  {
    position: integer().primaryKey({ autoIncrement: true }),
    message_id: text().notNull(),
    session_id: text().notNull(),
    queue_id: text().notNull(),
    user_message_id: text().notNull(),
    data: text().notNull(),
  },
  (t) => [uniqueIndex("session_handoff_attempt_message_idx").on(t.message_id)],
)
