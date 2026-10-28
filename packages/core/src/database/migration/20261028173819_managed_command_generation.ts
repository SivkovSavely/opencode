import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028173819_managed_command_generation",
  up(tx) {
    return Effect.gen(function* () {
      // Existing permits have no trustworthy generation and cannot authorize a new gate.
      yield* tx.run(`ALTER TABLE \`managed_command\` ADD \`execution_generation\` text NOT NULL DEFAULT '';`)
    })
  },
} satisfies DatabaseMigration.Migration
