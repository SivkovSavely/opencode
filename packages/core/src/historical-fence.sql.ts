import { sql } from "drizzle-orm"
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const HistoricalFenceIdentityTable = sqliteTable(
  "historical_fence_identity",
  {
    singleton: integer().primaryKey().notNull(),
    database_id: text().notNull().unique(),
  },
  (table) => [check("historical_fence_identity_singleton", sql`${table.singleton} = 1`)],
)

export const HistoricalFenceEvidenceTable = sqliteTable(
  "historical_fence_evidence",
  {
    root_session_id: text().primaryKey().notNull(),
    evidence_hash: text().notNull().unique(),
    payload: text().notNull(),
    observed_payload: text().notNull(),
    signer: text().notNull(),
    signature: text().notNull(),
    issuer: text().notNull(),
    nonce: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [uniqueIndex("historical_fence_nonce_idx").on(table.signer, table.nonce)],
)

export const HistoricalFencePruneTable = sqliteTable("historical_fence_prune", {
  root_session_id: text().primaryKey().notNull(),
  payload: text().notNull(),
  time_created: integer().notNull(),
})
