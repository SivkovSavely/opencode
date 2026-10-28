import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028174200_managed_command_ancestry",
  up(tx) {
    return Effect.gen(function* () {
      // An existing subtree can carry unknown tools even after its history was deleted.
      yield* tx.run(`CREATE TRIGGER managed_command_session_ancestry AFTER UPDATE OF parent_id ON session
        BEGIN
          UPDATE managed_command_coverage SET state = 'unknown' WHERE root_session_id IN (
            WITH RECURSIVE ancestors(id) AS (
              SELECT NEW.id UNION SELECT OLD.parent_id WHERE OLD.parent_id IS NOT NULL
              UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
              UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
                WHERE e.parent_session_id IS NOT NULL
            ) SELECT id FROM ancestors
          );
        END`)
      yield* tx.run(`CREATE TRIGGER managed_command_session_child AFTER INSERT ON session
        WHEN NEW.parent_id IS NOT NULL
        BEGIN
          UPDATE managed_command_coverage SET state = 'unknown' WHERE root_session_id IN (
            WITH RECURSIVE ancestors(id) AS (
              SELECT NEW.parent_id
              UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
              UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
                WHERE e.parent_session_id IS NOT NULL
            ) SELECT id FROM ancestors
          );
        END`)
      yield* tx.run(`CREATE TRIGGER managed_command_execution_ancestry AFTER UPDATE ON runtime_execution
        BEGIN
          UPDATE managed_command_coverage SET state = 'unknown' WHERE root_session_id IN (
            WITH RECURSIVE ancestors(id) AS (
              SELECT NEW.session_id UNION SELECT OLD.parent_session_id WHERE OLD.parent_session_id IS NOT NULL
              UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
              UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
                WHERE e.parent_session_id IS NOT NULL
            ) SELECT id FROM ancestors
          );
        END`)
    })
  },
} satisfies DatabaseMigration.Migration
