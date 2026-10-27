import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { PartTable } from "./sql"

// Disposable projection. Historical rows are populated incrementally, not in a migration.
export const TranscriptSearchTable = sqliteTable("transcript_search", {
  part_id: text()
    .primaryKey()
    .references(() => PartTable.id, { onDelete: "cascade" }),
  body: text().notNull(),
  truncated: integer().notNull(),
})

export const TranscriptSearchStateTable = sqliteTable("transcript_search_state", {
  id: integer().primaryKey(),
  cursor: text().notNull(),
  ready: integer().notNull(),
})
