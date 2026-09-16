import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916183243_durable_runtime_execution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`runtime_execution\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`owner_lineage\` text NOT NULL,
          \`owner_instance\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`desired_active\` integer NOT NULL,
          \`retry_at\` integer,
          \`parent_session_id\` text,
          \`parent_message_id\` text,
          \`parent_call_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_runtime_execution_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`runtime_execution_session_idx\` ON \`runtime_execution\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`runtime_execution_owner_state_idx\` ON \`runtime_execution\` (\`owner_lineage\`,\`state\`);`,
      )
      yield* tx.run(`CREATE INDEX \`runtime_execution_parent_idx\` ON \`runtime_execution\` (\`parent_session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
