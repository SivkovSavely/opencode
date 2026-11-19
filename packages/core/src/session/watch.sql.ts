import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { SessionWatchV1 } from "@opencode-ai/schema/v1/session-watch"
import { SessionTable } from "./sql"

export const SessionWatchExecutionTable = sqliteTable(
  "session_watch_execution",
  {
    sequence: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull().unique(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    owner_lineage: text().notNull(),
    owner_instance: text().notNull(),
    fence: integer().notNull(),
    state: text().notNull(),
    result: text().$type<"completed" | "failed">(),
    message_id: text(),
    summary: text().notNull().default(""),
    time_created: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [index("session_watch_execution_session_idx").on(table.session_id, table.sequence)],
)

export const SessionWatchTable = sqliteTable(
  "session_watch",
  {
    id: text().primaryKey(),
    owner_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    source_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    destination_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    scopes: text({ mode: "json" }).$type<readonly SessionWatchV1.Scope[]>().notNull(),
    submission: text().notNull(),
    events: text({ mode: "json" }).$type<readonly SessionWatchV1.Event[]>().notNull(),
    mode: text().$type<typeof SessionWatchV1.Mode.Type>().notNull(),
    delivery: text().$type<typeof SessionWatchV1.Delivery.Type>().notNull(),
    status: text().$type<typeof SessionWatchV1.Status.Type>().notNull(),
    execution_id: text(),
    after_sequence: integer().notNull(),
    accepted: integer().notNull().default(0),
    maximum: integer().notNull(),
    agent: text(),
    error: text(),
    time_created: integer().notNull(),
  },
  (table) => [index("session_watch_source_status_idx").on(table.source_id, table.status)],
)

export const SessionWatchEventTable = sqliteTable("session_watch_event", {
  id: text().primaryKey(),
  execution_id: text()
    .notNull()
    .references(() => SessionWatchExecutionTable.id, { onDelete: "cascade" }),
  source_id: text().notNull(),
  sequence: integer().notNull(),
  outcome: text().$type<SessionWatchV1.Event>().notNull(),
  summary: text().notNull(),
  time_created: integer().notNull(),
})

export const SessionWatchDeliveryTable = sqliteTable(
  "session_watch_delivery",
  {
    id: text().primaryKey(),
    watch_id: text()
      .notNull()
      .references(() => SessionWatchTable.id, { onDelete: "cascade" }),
    event_id: text().notNull(),
    execution_id: text().notNull(),
    source_id: text().notNull(),
    destination_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    outcome: text().$type<SessionWatchV1.Event>().notNull(),
    summary: text().notNull(),
    state: text().$type<"pending" | "accepted" | "delivered" | "recorded" | "cancelled" | "uncertain">().notNull(),
    queue_id: text().notNull(),
    error: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_watch_delivery_event_idx").on(table.watch_id, table.event_id),
    index("session_watch_delivery_pending_idx").on(table.state, table.id),
  ],
)
