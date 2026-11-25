import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const SessionCooperativePauseTable = sqliteTable("session_cooperative_pause", {
  session_id: text().primaryKey(),
  queue_id: text().notNull(),
  user_message_id: text().notNull(),
  request_id: text().notNull(),
  revision: integer().notNull(),
  state: text().notNull(),
})
