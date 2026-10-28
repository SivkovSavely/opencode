import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// No foreign keys: deletion of projections must not erase uncertain process ownership.
export const ManagedCommandCoverageTable = sqliteTable("managed_command_coverage", {
  root_session_id: text().primaryKey().notNull(),
  state: text({ enum: ["eligible", "managed", "unknown"] }).notNull(),
  time_created: integer().notNull(),
})

export const ManagedCommandTable = sqliteTable(
  "managed_command",
  {
    id: text().primaryKey().notNull(),
    session_id: text().notNull(),
    root_session_id: text().notNull(),
    owner_instance: text().notNull(),
    execution_generation: text().notNull(),
    state: text({ enum: ["pending", "running", "confirmed", "unknown"] }).notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("managed_command_root_idx").on(table.root_session_id)],
)
