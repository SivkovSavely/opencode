import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115203647_session_handoff_receipt_retention",
  up(tx) {
    return Effect.gen(function* () {
      for (const operation of ["UPDATE", "DELETE"]) {
        yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_receipt_retain_${operation.toLowerCase()}
          BEFORE ${operation} ON session_handoff_receipt BEGIN
            SELECT RAISE(ABORT, 'immutable handoff receipt');
          END`)
      }
      // Also rejects REPLACE, which otherwise bypasses delete guards with recursive_triggers off.
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_receipt_append
        BEFORE INSERT ON session_handoff_receipt
        WHEN NEW.revision <> COALESCE((SELECT MAX(revision) FROM session_handoff_receipt
          WHERE request_id = NEW.request_id), 0) + 1
        BEGIN SELECT RAISE(ABORT, 'nonconsecutive handoff receipt'); END`)
    })
  },
} satisfies DatabaseMigration.Migration
