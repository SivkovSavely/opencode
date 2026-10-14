import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261014053100_durable_task_notification",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`runtime_execution\` ADD \`parent_notification_state\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
