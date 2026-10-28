import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// Tombstones outlive the Session projection and runtime execution rows.
export const RuntimeRetirementTable = sqliteTable(
  "runtime_retirement",
  {
    session_id: text().primaryKey().notNull(),
    root_session_id: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("runtime_retirement_root_idx").on(table.root_session_id)],
)

// A Session may belong to different roots through projected and execution ancestry.
export const RuntimeRetirementMemberTable = sqliteTable(
  "runtime_retirement_member",
  {
    root_session_id: text().notNull(),
    session_id: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.root_session_id, table.session_id] })],
)
