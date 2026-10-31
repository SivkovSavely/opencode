import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261031090000_managed_execution_accounting",
  up(tx) {
    return Effect.gen(function* () {
      // History is not execution. Eligible roots still lose eligibility on first history.
      yield* tx.run(`DROP TRIGGER IF EXISTS managed_command_message_activity`)
      yield* tx.run(`CREATE TRIGGER managed_command_message_activity AFTER INSERT ON message
        BEGIN
          UPDATE managed_command_coverage SET state = 'unknown'
          WHERE root_session_id = NEW.session_id AND state = 'eligible';
        END`)
      yield* tx.run(`DROP TRIGGER IF EXISTS managed_command_runtime_execution_activity`)
      yield* tx.run(`CREATE TRIGGER managed_command_runtime_execution_activity AFTER INSERT ON runtime_execution
        WHEN NOT EXISTS (SELECT 1 FROM managed_command c WHERE c.session_id = NEW.session_id
          AND c.owner_instance = NEW.owner_instance AND c.execution_generation = 'managed-execution' AND c.state = 'running')
        BEGIN
          UPDATE managed_command_coverage SET state = 'unknown' WHERE root_session_id IN (
            WITH RECURSIVE ancestors(id) AS (
              SELECT NEW.session_id
              UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
              UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
                WHERE e.parent_session_id IS NOT NULL
            ) SELECT id FROM ancestors
          );
        END`)
      yield* tx.run(`DROP TRIGGER IF EXISTS managed_command_execution_ancestry`)
      yield* tx.run(`CREATE TRIGGER managed_command_execution_ancestry AFTER UPDATE ON runtime_execution
        WHEN NEW.parent_session_id IS NOT OLD.parent_session_id
          OR (NEW.state = 'active' AND NOT EXISTS (SELECT 1 FROM managed_command c
            WHERE c.session_id = NEW.session_id AND c.owner_instance = NEW.owner_instance
              AND c.execution_generation = 'managed-execution' AND c.state = 'running'))
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
