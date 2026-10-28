import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028143259_runtime_retirement_members",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`runtime_retirement_member\` (
          \`root_session_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          CONSTRAINT \`runtime_retirement_member_pk\` PRIMARY KEY(\`root_session_id\`, \`session_id\`)
        );
      `)
      yield* tx.run(`
        INSERT INTO runtime_retirement_member (root_session_id, session_id)
        SELECT root_session_id, session_id FROM runtime_retirement
      `)
    })
  },
} satisfies DatabaseMigration.Migration
