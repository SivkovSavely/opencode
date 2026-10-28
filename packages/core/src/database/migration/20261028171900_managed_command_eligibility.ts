import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028171900_managed_command_eligibility",
  up(tx) {
    return Effect.gen(function* () {
      // Only future roots can opt in; empty historical roots are still historical.
      yield* tx.run(`CREATE TRIGGER managed_command_new_root AFTER INSERT ON session
        WHEN NEW.parent_id IS NULL
        BEGIN
          INSERT OR IGNORE INTO managed_command_coverage (root_session_id, state, time_created)
          VALUES (NEW.id, 'eligible', NEW.time_created);
        END`)
      // Neither legacy nor V2 execution proves cleanup of arbitrary tools/plugins.
      for (const table of ["runtime_execution", "message", "session_message", "session_input"]) {
        yield* tx.run(`CREATE TRIGGER managed_command_${table}_activity AFTER INSERT ON ${table}
          BEGIN
            UPDATE managed_command_coverage SET state = 'unknown'
            WHERE root_session_id IN (
              WITH RECURSIVE ancestors(id) AS (
                SELECT NEW.session_id
                UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
                UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
                  WHERE e.parent_session_id IS NOT NULL
              ) SELECT id FROM ancestors
            );
          END`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
