import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028141815_runtime_retirement_table",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`runtime_retirement\` (
          \`session_id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`runtime_retirement_root_idx\` ON \`runtime_retirement\` (\`root_session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
