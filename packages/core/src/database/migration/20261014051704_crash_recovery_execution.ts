import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261014051704_crash_recovery_execution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`runtime_execution\` ADD \`owner_host\` text;`)
      yield* tx.run(`ALTER TABLE \`runtime_execution\` ADD \`owner_machine_id\` text;`)
      yield* tx.run(`ALTER TABLE \`runtime_execution\` ADD \`owner_boot_id\` text;`)
      yield* tx.run(`ALTER TABLE \`runtime_execution\` ADD \`owner_pid_namespace\` text;`)
      yield* tx.run(`ALTER TABLE \`runtime_execution\` ADD \`owner_pid\` integer;`)
      yield* tx.run(`ALTER TABLE \`runtime_execution\` ADD \`owner_start_time\` text;`)
      yield* tx.run(`ALTER TABLE \`runtime_execution\` ADD \`parent_mode\` text;`)
      yield* tx.run(`ALTER TABLE \`runtime_execution\` ADD \`recovery_attempts\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
