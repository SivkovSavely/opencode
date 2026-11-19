import { foreignKey, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"
import { SessionHandoffActionTable } from "./handoff.sql"

export const SessionHandoffRecoveryHoldTable = sqliteTable(
  "session_handoff_recovery_hold",
  {
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    reservation: text().notNull(),
    session_id: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.root_session_id, table.reservation, table.session_id] }),
    index("session_handoff_recovery_hold_session_idx").on(table.session_id),
  ],
)

export const SessionHandoffRecoveryChildTable = sqliteTable("session_handoff_recovery_child", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  recovery_revision: integer().notNull().default(0),
  link: text().notNull(),
  input_digest: text().notNull(),
  prior_fence: integer().notNull(),
  recovery_fence: integer().notNull(),
})

export const SessionHandoffRecoveryHistoryTable = sqliteTable(
  "session_handoff_recovery_history",
  {
    session_id: text().notNull(),
    queue_id: text().notNull(),
    user_message_id: text().notNull(),
    revision: integer().notNull(),
    data: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.queue_id, table.user_message_id, table.revision] }),
    foreignKey({
      columns: [table.session_id, table.queue_id, table.user_message_id],
      foreignColumns: [
        SessionHandoffActionTable.session_id,
        SessionHandoffActionTable.queue_id,
        SessionHandoffActionTable.user_message_id,
      ],
    }),
  ],
)
