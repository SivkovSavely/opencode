import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261112165157_session_schedule_definition_order",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_schedule\` ADD \`definition_order\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`UPDATE session_schedule SET definition_order = rowid`)
    })
  },
} satisfies DatabaseMigration.Migration
