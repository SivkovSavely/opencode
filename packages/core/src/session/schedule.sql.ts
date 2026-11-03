import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { SessionTable } from "./sql"

export const SessionScheduleTable = sqliteTable(
  "session_schedule",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<typeof SessionTable.$inferSelect.id>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    input: text({ mode: "json" }).$type<SessionScheduleV1.Input>().notNull(),
    anchor: integer().notNull(),
    time_created: integer().notNull(),
    status: text().$type<SessionScheduleV1.Info["status"]>().notNull(),
    completed: integer().notNull().default(0),
    next: integer(),
  },
  (table) => [
    index("session_schedule_due_idx").on(table.status, table.next),
    index("session_schedule_session_idx").on(table.session_id),
  ],
)

export const SessionScheduleOccurrenceTable = sqliteTable(
  "session_schedule_occurrence",
  {
    id: text().primaryKey(),
    schedule_id: text()
      .notNull()
      .references(() => SessionScheduleTable.id, { onDelete: "cascade" }),
    scheduled: integer().notNull(),
    processed: integer(),
    state: text().$type<SessionScheduleV1.Occurrence["state"]>().notNull(),
    message_id: text(),
    error: text(),
  },
  (table) => [
    uniqueIndex("session_schedule_occurrence_time_idx").on(table.schedule_id, table.scheduled),
    index("session_schedule_occurrence_state_idx").on(table.state),
  ],
)
