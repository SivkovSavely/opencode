import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261101091000_managed_capabilities",
  up(tx) {
    return Effect.gen(function* () {
      // No backfill: an old child can never establish managed membership.
      yield* tx.run(`CREATE TABLE IF NOT EXISTS managed_session_member (
        session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        root_session_id TEXT NOT NULL,
        owner_instance TEXT NOT NULL,
        parent_fence INTEGER NOT NULL,
        directory TEXT NOT NULL,
        workspace_id TEXT,
        permission_policy TEXT NOT NULL DEFAULT '[]',
        time_created INTEGER NOT NULL
      )`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS managed_session_member_root_idx ON managed_session_member(root_session_id)`,
      )
      yield* tx.run(`DROP TRIGGER managed_command_session_ancestry`)
      // Projectors write the unchanged parent_id during ordinary child updates.
      yield* tx.run(`CREATE TRIGGER managed_command_session_ancestry AFTER UPDATE OF parent_id ON session
        WHEN NEW.parent_id IS NOT OLD.parent_id
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
      yield* tx.run(`DROP TRIGGER managed_command_session_child`)
      yield* tx.run(`CREATE TRIGGER managed_command_session_child AFTER INSERT ON session
        WHEN NEW.parent_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'Invalid managed child reservation')
          WHERE EXISTS (SELECT 1 FROM managed_session_member WHERE session_id = NEW.id)
            AND NOT EXISTS (
              SELECT 1 FROM managed_session_member m
              JOIN runtime_execution e ON e.session_id = m.parent_session_id
              JOIN managed_command_coverage c ON c.root_session_id = m.root_session_id AND c.state = 'managed'
              WHERE m.session_id = NEW.id AND m.parent_session_id = NEW.parent_id
                AND m.directory = NEW.directory AND m.workspace_id IS NEW.workspace_id
                AND e.owner_instance = m.owner_instance AND e.fence = m.parent_fence
                AND e.state = 'active' AND e.desired_active = 1
                AND NOT EXISTS (SELECT 1 FROM runtime_retirement WHERE session_id IN (m.root_session_id, m.parent_session_id, NEW.id))
            );
          UPDATE managed_command_coverage SET state = 'unknown' WHERE root_session_id IN (
            WITH RECURSIVE ancestors(id) AS (
              SELECT NEW.parent_id
              UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
              UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
                WHERE e.parent_session_id IS NOT NULL
            ) SELECT id FROM ancestors
          ) AND NOT EXISTS (SELECT 1 FROM managed_session_member WHERE session_id = NEW.id);
        END`)
      yield* tx.run(`DROP TRIGGER managed_command_execution_ancestry`)
      yield* tx.run(`CREATE TRIGGER managed_command_execution_ancestry AFTER UPDATE ON runtime_execution
        WHEN (NEW.parent_session_id IS NOT OLD.parent_session_id AND NOT (
          OLD.parent_session_id IS NULL AND EXISTS (
            SELECT 1 FROM managed_session_member m WHERE m.session_id = NEW.session_id
              AND m.parent_session_id = NEW.parent_session_id AND m.owner_instance = NEW.owner_instance
          ))) OR (NEW.state = 'active' AND NOT EXISTS (SELECT 1 FROM managed_command c
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
