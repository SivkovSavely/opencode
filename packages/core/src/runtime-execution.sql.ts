import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./session/sql"
import type { SessionSchema } from "./session/schema"

export const RuntimeExecutionTable = sqliteTable(
  "runtime_execution",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    directory: text().notNull(),
    owner_lineage: text().notNull(),
    owner_instance: text().notNull(),
    fence: integer().notNull(),
    state: text().notNull(),
    desired_active: integer().notNull(),
    retry_at: integer(),
    parent_session_id: text().$type<SessionSchema.ID>(),
    parent_message_id: text(),
    parent_call_id: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("runtime_execution_session_idx").on(table.session_id),
    index("runtime_execution_owner_state_idx").on(table.owner_lineage, table.state),
    index("runtime_execution_parent_idx").on(table.parent_session_id),
  ],
)
