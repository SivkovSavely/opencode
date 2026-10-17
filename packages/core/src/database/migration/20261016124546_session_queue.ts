import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261016124546_session_queue",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_queue_state\` (
          \`session_id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`paused\` integer DEFAULT false NOT NULL,
          \`blocked\` integer DEFAULT false NOT NULL,
          CONSTRAINT \`fk_session_queue_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_queue\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`state\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`payload\` text NOT NULL,
          \`submission\` text NOT NULL,
          \`message_id\` text,
          \`owner\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_queue_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_queue_session_state_delivery_position_idx\` ON \`session_queue\` (\`session_id\`,\`state\`,\`delivery\`,\`position\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
