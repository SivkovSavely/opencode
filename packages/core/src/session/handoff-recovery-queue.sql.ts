import { sql } from "drizzle-orm"
import { foreignKey, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"
import { SessionHandoffActionTable, SessionHandoffRequestTable } from "./handoff.sql"

export const SessionHandoffRecoveryQueueBlockTable = sqliteTable(
  "session_handoff_recovery_queue_block",
  {
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    recovery_request_id: text()
      .notNull()
      .references(() => SessionHandoffRequestTable.request_id),
    root_session_id: text().notNull(),
    queue_id: text().notNull(),
    user_message_id: text().notNull(),
    reservation: text().notNull(),
    recovery_revision: integer().notNull(),
    owner_lineage: text().notNull(),
    owner_instance: text().notNull(),
    recovery_fence: integer().notNull(),
    queue_revision: integer().notNull(),
    input_proof: text().notNull(),
    state: text().notNull(),
    reason: text(),
    internal_user_id: text(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.recovery_request_id] }),
    uniqueIndex("session_handoff_recovery_queue_owned_idx")
      .on(table.session_id)
      .where(sql`${table.state}='owned'`),
    foreignKey({
      columns: [table.root_session_id, table.queue_id, table.user_message_id],
      foreignColumns: [
        SessionHandoffActionTable.session_id,
        SessionHandoffActionTable.queue_id,
        SessionHandoffActionTable.user_message_id,
      ],
    }),
  ],
)
