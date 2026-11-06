import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core"
import { SessionMessageTable } from "./sql.js"

export const TranscriptDocumentTable = sqliteTable(
  "transcript_document",
  {
    id: text().primaryKey(),
    message_id: text()
      .notNull()
      .references(() => SessionMessageTable.id, { onDelete: "cascade" }),
    source: text().notNull(),
    part_id: text(),
    category: text().notNull(),
    time_created: integer().notNull(),
    body: text().notNull(),
    truncated: integer().notNull(),
    tool_name: text(),
    tool_status: text(),
  },
  (table) => [
    index("transcript_document_message_idx").on(table.message_id),
    index("transcript_document_time_idx").on(table.time_created, table.message_id, table.id),
  ],
)

export const TranscriptStateTable = sqliteTable("transcript_state", {
  id: integer().primaryKey(),
  cursor: text().notNull(),
  phase: text().notNull(),
  ready: integer().notNull(),
  generation: text().notNull(),
})
