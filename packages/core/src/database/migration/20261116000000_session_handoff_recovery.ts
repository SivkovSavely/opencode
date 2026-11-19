import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261116000000_session_handoff_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE session_handoff_recovery_hold (
        root_session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE, reservation text NOT NULL, session_id text NOT NULL,
        PRIMARY KEY (root_session_id, reservation, session_id))`)
      yield* tx.run(
        `CREATE INDEX session_handoff_recovery_hold_session_idx ON session_handoff_recovery_hold (session_id)`,
      )
      yield* tx.run(`CREATE TABLE session_handoff_recovery_child (
        session_id text PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE, recovery_revision integer NOT NULL DEFAULT 0,
        link text NOT NULL, input_digest text NOT NULL, prior_fence integer NOT NULL,
        recovery_fence integer NOT NULL)`)
    })
  },
} satisfies DatabaseMigration.Migration
