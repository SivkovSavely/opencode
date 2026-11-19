import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115205619_session_handoff_root",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_handoff_root\` (
          \`session_id\` text NOT NULL,
          \`reservation\` text NOT NULL,
          \`state\` text NOT NULL,
          \`queue_id\` text,
          \`user_message_id\` text,
          \`source\` text,
          \`enrolled_request_id\` text,
          CONSTRAINT \`session_handoff_root_pk\` PRIMARY KEY(\`session_id\`, \`reservation\`),
          CONSTRAINT \`fk_session_handoff_root_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_handoff_root_session_idx\` ON \`session_handoff_root\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
