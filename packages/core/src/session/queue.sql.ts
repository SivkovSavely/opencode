import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import type { SessionV1 } from "@opencode-ai/schema/v1/session"
import { SessionTable } from "./sql"

export const SessionQueueStateTable = sqliteTable("session_queue_state", {
  session_id: text()
    .$type<typeof SessionTable.$inferSelect.id>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  revision: integer().notNull().default(0),
  paused: integer({ mode: "boolean" }).notNull().default(false),
  blocked: integer({ mode: "boolean" }).notNull().default(false),
})

export const SessionQueueTable = sqliteTable(
  "session_queue",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<typeof SessionTable.$inferSelect.id>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    delivery: text().$type<SessionQueueV1.Delivery>().notNull(),
    state: text().$type<SessionQueueV1.State>().notNull(),
    position: integer().notNull(),
    payload: text({ mode: "json" }).$type<(typeof SessionQueueV1.Payload)["Encoded"]>().notNull(),
    // Immutable admission identity survives conversion, deletion, and delivery.
    submission: text().notNull(),
    message_id: text().$type<SessionV1.MessageID>(),
    owner: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("session_queue_session_state_delivery_position_idx").on(
      table.session_id,
      table.state,
      table.delivery,
      table.position,
    ),
  ],
)
