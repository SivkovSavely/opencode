import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const SessionHandoffNotificationTable = sqliteTable(
  "session_handoff_notification",
  {
    message_id: text().primaryKey(),
    session_id: text().notNull(),
    reservation: text(),
    classification: text().notNull(),
    user_message_id: text(),
    after_message_id: text(),
    data: text().notNull(),
  },
  (table) => [index("session_handoff_notification_action_idx").on(table.session_id, table.reservation)],
)
