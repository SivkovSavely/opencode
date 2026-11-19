import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"
import { SessionWatchV1 } from "@opencode-ai/schema/v1/session-watch"

export const SessionControlRequestTable = sqliteTable(
  "session_control_request",
  {
    id: text().primaryKey(),
    owner_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    submission: text().notNull(),
    session_id: text()
      .$type<typeof SessionTable.$inferSelect.id>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    state: text().$type<"created" | "admitted" | "done">().notNull(),
    queue_id: text().notNull(),
    scopes: text({ mode: "json" }).$type<SessionWatchV1.Scope[]>().notNull(),
    agent: text(),
    auto: integer({ mode: "boolean" }).notNull(),
    cancellation: text({ mode: "json" }).$type<{ ownerLineage: string; ownerInstance: string; fence: number }>(),
    time_created: integer().notNull(),
  },
  (table) => [index("session_control_request_owner_idx").on(table.owner_id)],
)
