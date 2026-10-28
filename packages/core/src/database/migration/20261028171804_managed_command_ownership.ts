import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028171804_managed_command_ownership",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`managed_command_coverage\` (
          \`root_session_id\` text PRIMARY KEY,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`managed_command\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`root_session_id\` text NOT NULL,
          \`owner_instance\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`managed_command_root_idx\` ON \`managed_command\` (\`root_session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
