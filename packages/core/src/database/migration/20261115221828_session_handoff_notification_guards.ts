import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115221828_session_handoff_notification_guards",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TRIGGER session_handoff_notification_immutable_update
        BEFORE UPDATE ON session_handoff_notification BEGIN SELECT RAISE(ABORT, 'immutable Task notification evidence'); END`)
      yield* tx.run(`CREATE TRIGGER session_handoff_notification_immutable_delete
        BEFORE DELETE ON session_handoff_notification BEGIN SELECT RAISE(ABORT, 'retained Task notification evidence'); END`)
    })
  },
} satisfies DatabaseMigration.Migration
