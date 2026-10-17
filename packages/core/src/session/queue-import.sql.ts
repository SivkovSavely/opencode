import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"

// The marker and hidden IDs survive queue delivery/deletion and user pause changes.
export const SessionQueueImportTable = sqliteTable("session_queue_import", {
  session_id: text()
    .$type<typeof SessionTable.$inferSelect.id>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  hidden: text({ mode: "json" }).$type<string[]>().notNull(),
})
