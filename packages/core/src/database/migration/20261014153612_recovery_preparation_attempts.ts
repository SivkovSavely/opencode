import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261014153612_recovery_preparation_attempts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `ALTER TABLE \`runtime_execution\` ADD \`recovery_preparation_attempts\` integer DEFAULT 0 NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
