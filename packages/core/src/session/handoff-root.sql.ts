import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"

export const SessionHandoffRootTable = sqliteTable(
  "session_handoff_root",
  {
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    reservation: text().notNull(),
    state: text().notNull(),
    queue_id: text(),
    user_message_id: text(),
    source: text(),
    enrolled_request_id: text(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.reservation] }),
    index("session_handoff_root_session_idx").on(table.session_id),
  ],
)
