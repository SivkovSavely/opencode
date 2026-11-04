export * as DatabaseCompatibility from "./compatibility.js"

import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { migrations } from "./migration.gen.js"

const previousV2 = "20260730195856_optional_session_title"
const splitV2 = "20260804233008_loose_psylocke"
// 0fbe489e35 removed these migrations, but supported native V2 journals retain their IDs.
const retiredV2 = new Set([
  "20260702134641_add_session_context_entry",
  "20260703090000_reset_v2_event_rename_sweep",
  "20260703181610_event_created_column",
  "20260703190000_reset_v2_shell_event_payloads",
  "20260703200000_reset_v2_session_events",
  "20260705180000_rename_instructions",
  "20260706223930_add-session-fork",
  "20260707010146_durable_session_inbox",
  "20260707120000_migrate_prelaunch_v2_state",
  "20260709013000_generic_session_input",
  "20260709025533_drop-todo",
  "20260709163752_time_suspended",
  "20260709190621_session_pending_table",
  "20260710025429_instruction_sync",
  "20260716020354_kv",
  "20260722011141_delete_tool_progress_events",
  "20260722170000_canonical_tool_results",
  "20260729022634_session_fork_boundary",
  previousV2,
])

// The caller owns a read-only connection, before writable open or pragma tuning.
export const check = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.acquireUseRelease(
    sql`BEGIN`,
    () => inspect(sql),
    (_, exit) => (Exit.isFailure(exit) ? sql`ROLLBACK`.pipe(Effect.ignoreCause) : sql`COMMIT`.pipe(Effect.orDie)),
  )
})

function inspect(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const tables = new Set(
      (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => row.name),
    )
    if (![...tables].some((name) => !name.startsWith("sqlite_") && !name.startsWith("_"))) return
    if (!tables.has("session") && !tables.has("session_v2"))
      return yield* Effect.die(new Error("Database is not empty and has no session table"))
    if (tables.has("event")) {
      const encoded = yield* sql`SELECT 1 FROM event WHERE typeof(data) <> 'text' LIMIT 1`
      if (encoded.length > 0)
        return yield* Effect.die(
          new Error(
            "Database contains non-TEXT durable event payloads; a separately validated event-history migration is required",
          ),
        )
    }

    const completed = yield* journal(sql, tables)
    const unknown = [...completed].find(
      (id) => !retiredV2.has(id) && !migrations.some((migration) => migration.id === id),
    )
    if (unknown !== undefined) return yield* Effect.die(new Error(`Unknown database migration ${unknown}`))

    if (completed.has(splitV2)) {
      if (!tables.has("session_v2"))
        return yield* Effect.die(new Error(`Missing session_v2 table after completed migration ${splitV2}`))
      return
    }
    if (!completed.has(previousV2)) return

    // Match the pre-split V2 migration's refusal, without first changing the file.
    const history = yield* sql`
      SELECT 1 FROM message
      WHERE NOT EXISTS (
        SELECT 1 FROM session_message WHERE session_message.session_id = message.session_id
      ) LIMIT 1
    `
    if (history.length > 0) return yield* Effect.die(new Error("Previous V2 database contains V1-only session history"))
  })
}

function journal(sql: SqlClient.SqlClient, tables: Set<string>) {
  return Effect.gen(function* () {
    const current = tables.has("migration") ? yield* sql<{ id: string }>`SELECT id FROM migration` : []
    if (current.length > 0) return new Set(current.map((row) => row.id))
    if (!tables.has("__drizzle_migrations")) return new Set<string>()
    const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('__drizzle_migrations')`
    if (columns.some((column) => column.name === "name"))
      return new Set(
        (yield* sql<{ name: string }>`SELECT name FROM __drizzle_migrations WHERE name IS NOT NULL`).map(
          (row) => row.name,
        ),
      )

    const entries = yield* sql<{ created_at: number; prefix: string | null }>`
      SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
      FROM __drizzle_migrations WHERE created_at IS NOT NULL
    `
    return new Set(
      yield* Effect.forEach(entries, (entry) => {
        const migration = migrations.find((item) => item.id.startsWith(`${entry.prefix}_`))
        return migration
          ? Effect.succeed(migration.id)
          : Effect.die(new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`))
      }),
    )
  })
}
