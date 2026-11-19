import { foreignKey, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Deliberately independent of queue/message/session cascades: retained proof is not live execution state.
export const SessionHandoffActionTable = sqliteTable(
  "session_handoff_action",
  {
    session_id: text().notNull(),
    queue_id: text().notNull(),
    user_message_id: text().notNull(),
    data: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.session_id, t.queue_id, t.user_message_id] })],
)

export const SessionHandoffRequestTable = sqliteTable(
  "session_handoff_request",
  {
    request_id: text().primaryKey(),
    session_id: text().notNull(),
    queue_id: text().notNull(),
    user_message_id: text().notNull(),
    identity: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.session_id, t.queue_id, t.user_message_id],
      foreignColumns: [
        SessionHandoffActionTable.session_id,
        SessionHandoffActionTable.queue_id,
        SessionHandoffActionTable.user_message_id,
      ],
    }),
  ],
)

export const SessionHandoffBoundaryTable = sqliteTable(
  "session_handoff_boundary",
  {
    session_id: text().notNull(),
    queue_id: text().notNull(),
    user_message_id: text().notNull(),
    sequence: integer().notNull(),
    request_id: text()
      .notNull()
      .references(() => SessionHandoffRequestTable.request_id),
    data: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.session_id, t.queue_id, t.user_message_id, t.sequence] }),
    uniqueIndex("session_handoff_boundary_request_idx").on(t.request_id),
    foreignKey({
      columns: [t.session_id, t.queue_id, t.user_message_id],
      foreignColumns: [
        SessionHandoffActionTable.session_id,
        SessionHandoffActionTable.queue_id,
        SessionHandoffActionTable.user_message_id,
      ],
    }),
  ],
)

// Revision zero remains in the immutable request row; only later receipt snapshots live here.
export const SessionHandoffReceiptTable = sqliteTable(
  "session_handoff_receipt",
  {
    request_id: text()
      .notNull()
      .references(() => SessionHandoffRequestTable.request_id),
    revision: integer().notNull(),
    data: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.request_id, t.revision] })],
)

export const SessionHandoffAssistantTable = sqliteTable(
  "session_handoff_assistant",
  {
    position: integer().primaryKey({ autoIncrement: true }),
    message_id: text().notNull(),
    session_id: text().notNull(),
    queue_id: text().notNull(),
    user_message_id: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    uniqueIndex("session_handoff_assistant_message_idx").on(t.message_id),
    foreignKey({
      columns: [t.session_id, t.queue_id, t.user_message_id],
      foreignColumns: [
        SessionHandoffActionTable.session_id,
        SessionHandoffActionTable.queue_id,
        SessionHandoffActionTable.user_message_id,
      ],
    }),
  ],
)
