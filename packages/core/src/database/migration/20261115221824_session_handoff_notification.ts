import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115221824_session_handoff_notification",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_handoff_notification\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`reservation\` text,
          \`classification\` text NOT NULL,
          \`user_message_id\` text,
          \`after_message_id\` text,
          \`data\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_handoff_notification_action_idx\` ON \`session_handoff_notification\` (\`session_id\`,\`reservation\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
