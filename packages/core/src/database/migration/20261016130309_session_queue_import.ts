import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261016130309_session_queue_import",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_queue_import\` (
          \`session_id\` text PRIMARY KEY,
          \`hidden\` text NOT NULL,
          CONSTRAINT \`fk_session_queue_import_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
