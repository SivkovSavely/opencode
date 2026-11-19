import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261116002000_session_handoff_recovery_history",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE IF NOT EXISTS session_handoff_recovery_history (
        session_id text NOT NULL, queue_id text NOT NULL, user_message_id text NOT NULL,
        revision integer NOT NULL, data text NOT NULL,
        PRIMARY KEY (session_id,queue_id,user_message_id,revision),
        FOREIGN KEY (session_id,queue_id,user_message_id) REFERENCES session_handoff_action(session_id,queue_id,user_message_id))`)
      for (const operation of ["UPDATE", "DELETE"])
        yield* tx.run(
          `CREATE TRIGGER IF NOT EXISTS session_handoff_recovery_history_retain_${operation.toLowerCase()} BEFORE ${operation} ON session_handoff_recovery_history BEGIN SELECT RAISE(ABORT,'immutable handoff recovery history'); END`,
        )
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_recovery_history_append BEFORE INSERT ON session_handoff_recovery_history
        WHEN NEW.revision <> COALESCE((SELECT MAX(revision) FROM session_handoff_recovery_history WHERE session_id=NEW.session_id AND queue_id=NEW.queue_id AND user_message_id=NEW.user_message_id),-1)+1
        BEGIN SELECT RAISE(ABORT,'nonconsecutive handoff recovery history'); END`)
    })
  },
} satisfies DatabaseMigration.Migration
