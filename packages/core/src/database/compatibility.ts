export * as DatabaseCompatibility from "./compatibility"

import { migrations } from "./migration.gen"

// This probe must run on a read-only connection before opening the writable one:
// even closing a writable connection can checkpoint committed WAL frames.
export function check(filename: string, query: (sql: string) => unknown[]) {
  const all = (sql: string) => {
    try {
      return query(sql)
    } catch (cause) {
      throw new Error(
        `Unable to inspect OpenCode database at ${filename}. Refusing to open for writes or run migrations. SQL: ${sql}`,
        { cause },
      )
    }
  }
  all("BEGIN")
  try {
    inspect(filename, all)
    all("COMMIT")
  } catch (cause) {
    try {
      all("ROLLBACK")
    } catch {
      // Preserve the inspection or commit failure if cleanup also fails.
    }
    throw cause
  }
}

function inspect(filename: string, all: (sql: string) => unknown[]) {
  const tables = new Set(
    (all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") as { name: string }[]).map(
      (row) => row.name,
    ),
  )
  if (tables.size === 0) return
  const problems: string[] = []
  const columns = (table: string) =>
    new Set((all(`PRAGMA table_info('${table.replaceAll("'", "''")}')`) as { name: string }[]).map((row) => row.name))
  const completed = new Set<string>()
  const timestamps = new Set<string>()
  if (tables.has("migration")) {
    for (const row of all("SELECT id FROM migration") as { id: string }[]) completed.add(row.id)
  }
  // Match the migration runner's fallback journal semantics without seeding it.
  if (completed.size === 0 && tables.has("__drizzle_migrations")) {
    const named = columns("__drizzle_migrations").has("name")
    for (const row of all(
      named
        ? "SELECT name AS id FROM __drizzle_migrations WHERE name IS NOT NULL"
        : "SELECT strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS id FROM __drizzle_migrations WHERE created_at IS NOT NULL",
    ) as { id: string | null }[]) {
      if (named) {
        if (row.id !== null) completed.add(row.id)
        continue
      }
      if (row.id === null || !migrations.some((migration) => migration.id.startsWith(`${row.id}_`))) {
        problems.push(`unknown legacy migration timestamp prefix ${row.id}`)
        continue
      }
      timestamps.add(row.id)
    }
  }
  const hasCompleted = (id: string) => completed.has(id) || timestamps.has(id.slice(0, 14))
  // Only durable tables: replacement tables named __new_* exist inside a
  // migration transaction, never at a supported admission boundary.
  const required: [string, string, string?][] = [
    ["project", "20260127222353_familiar_lady_ursula"],
    ["session", "20260127222353_familiar_lady_ursula"],
    ["message", "20260127222353_familiar_lady_ursula"],
    ["part", "20260127222353_familiar_lady_ursula"],
    ["todo", "20260127222353_familiar_lady_ursula"],
    ["session_share", "20260127222353_familiar_lady_ursula"],
    ["permission", "20260127222353_familiar_lady_ursula", "20260601202201_amazing_prowler"],
    ["control_account", "20260213144116_wakeful_the_professor"],
    ["workspace", "20260225215848_workspace"],
    ["account", "20260228203230_blue_harpoon"],
    ["account_state", "20260228203230_blue_harpoon"],
    ["event", "20260323234822_events"],
    ["event_sequence", "20260323234822_events"],
    ["session_entry", "20260413175956_chief_energizer", "20260427172553_slow_nightmare"],
    ["session_message", "20260427172553_slow_nightmare"],
    ["data_migration", "20260511000411_data_migration_state"],
    ["session_input", "20260603141458_session_input_inbox"],
    ["session_context_epoch", "20260605003541_add_session_context_snapshot"],
    ["project_directory", "20260602182828_add_project_directories"],
    ["permission", "20260602002951_lowly_union_jack"],
    ["credential", "20260611035744_credential"],
    ["runtime_execution", "20260916183243_durable_runtime_execution"],
    ["session_queue_state", "20261016124546_session_queue"],
    ["session_queue", "20261016124546_session_queue"],
    ["session_queue_import", "20261016130309_session_queue_import"],
    ["transcript_search_state", "20261027085712_transcript_search"],
    ["transcript_search", "20261027085712_transcript_search"],
    ["runtime_retirement", "20261028141815_runtime_retirement_table"],
    ["runtime_retirement_member", "20261028143259_runtime_retirement_members"],
    ["managed_command_coverage", "20261028171804_managed_command_ownership"],
    ["managed_command", "20261028171804_managed_command_ownership"],
  ]
  for (const [table, migration, removed] of required) {
    if (!tables.has(table) && hasCompleted(migration) && (!removed || !hasCompleted(removed)))
      problems.push(`missing ${table} table although migration ${migration} is completed`)
  }
  if (!tables.has("session")) problems.push("non-empty database has no session table")
  if (tables.has("session_message") && !hasCompleted("20260427172553_slow_nightmare"))
    problems.push("session_message exists before pending migration 20260427172553_slow_nightmare")
  if (
    tables.has("session_message") &&
    hasCompleted("20260603040000_session_message_projection_order") &&
    !columns("session_message").has("seq")
  )
    problems.push(
      "session_message has incompatible columns: missing seq although migration 20260603040000_session_message_projection_order is completed",
    )
  if (tables.has("workspace")) {
    const fields = columns("workspace")
    if (!hasCompleted("20260303231226_add_workspace_fields")) {
      const partial = ["type", "name", "directory", "extra"].filter((field) => fields.has(field))
      if (partial.length)
        problems.push(
          `workspace has incompatible columns: ${partial.join(", ")} already present before pending migration 20260303231226_add_workspace_fields`,
        )
      if (fields.has("config") && all("SELECT 1 FROM workspace LIMIT 1").length)
        problems.push("populated config-era workspace cannot run pending migration 20260303231226_add_workspace_fields")
    }
    const expected =
      fields.has("config") && !hasCompleted("20260303231226_add_workspace_fields")
        ? ["id", "branch", "project_id"]
        : ["id", "type", "branch", "directory", "extra", "project_id"]
    const missing = expected.filter((field) => !fields.has(field))
    if (missing.length) problems.push(`workspace has incompatible columns: missing ${missing.join(", ")}`)
  }
  for (const table of tables) {
    const keys = all(`PRAGMA foreign_key_list('${table.replaceAll("'", "''")}')`) as {
      id: number
      seq: number
      table: string
      from: string
      to: string | null
      on_delete: string
      on_update: string
    }[]
    // Before this table's creation migration, supported legacy installs have no
    // session_message table at all. Every generation of the table requires this FK.
    if (
      table.toLowerCase() === "session_message" &&
      !keys.some(
        (key) =>
          key.table.toLowerCase() === "session" &&
          key.from.toLowerCase() === "session_id" &&
          key.to?.toLowerCase() === "id" &&
          key.seq === 0 &&
          keys.filter((item) => item.id === key.id).length === 1,
      )
    )
      problems.push("session_message is missing its session_id -> session.id foreign key (ON DELETE CASCADE)")
    for (const key of keys) {
      if (
        tables.has("workspace") &&
        !hasCompleted("20260410174513_workspace-name") &&
        key.table.toLowerCase() === "workspace" &&
        key.on_delete === "CASCADE"
      )
        problems.push(`unsupported workspace-child foreign key ${table}.${key.from} -> workspace.${key.to} (CASCADE) before pending workspace rebuild`)
      if (
        table.toLowerCase() === "session_message" &&
        !(
          keys.length === 1 &&
          key.table.toLowerCase() === "session" &&
          key.from.toLowerCase() === "session_id" &&
          key.to?.toLowerCase() === "id" &&
          key.on_delete === "CASCADE" &&
          key.on_update === "NO ACTION"
        )
      )
        problems.push(
          `session_message foreign key ${key.from} -> ${key.table}.${key.to} is incompatible (ON DELETE ${key.on_delete}, ON UPDATE ${key.on_update})`,
        )
      if (key.table.toLowerCase() !== "project") continue
      if (
        ["session", "workspace", "permission", "project_directory"].includes(table.toLowerCase()) &&
        keys.filter((item) => item.id === key.id).length === 1 &&
        key.seq === 0 &&
        key.from.toLowerCase() === "project_id" &&
        key.to?.toLowerCase() === "id" &&
        key.on_delete === "CASCADE" &&
        key.on_update === "NO ACTION"
      )
        continue
      problems.push(
        `unsupported project-child foreign key ${table}.${key.from} -> project.${key.to} (${key.on_delete})`,
      )
    }
  }
  if (problems.length)
    throw new Error(
      `Incompatible OpenCode database at ${filename}:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nRefusing to open for writes or run migrations. Use a compatible OpenCode version or a separate database path.`,
    )
}
