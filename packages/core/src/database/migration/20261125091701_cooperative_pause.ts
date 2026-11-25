import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261125091701_cooperative_pause",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_cooperative_pause\` (
          \`session_id\` text PRIMARY KEY,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`state\` text NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
