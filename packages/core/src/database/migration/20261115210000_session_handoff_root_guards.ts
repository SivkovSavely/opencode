import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115210000_session_handoff_root_guards",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TRIGGER session_handoff_root_session_guard
        BEFORE UPDATE OF permission, directory, workspace_id, parent_id, revert, time_archived ON session
        WHEN OLD.permission IS NOT NEW.permission OR OLD.directory IS NOT NEW.directory
          OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.parent_id IS NOT NEW.parent_id
          OR OLD.revert IS NOT NEW.revert OR OLD.time_archived IS NOT NEW.time_archived
        BEGIN
          UPDATE session_handoff_root SET state = 'invalidated'
            WHERE session_id = OLD.id AND state = 'active';
        END`)
      yield* tx.run(`CREATE TRIGGER session_handoff_root_owner_guard
        BEFORE UPDATE OF owner_lineage, owner_instance, fence, state ON runtime_execution
        WHEN OLD.owner_lineage IS NOT NEW.owner_lineage OR OLD.owner_instance IS NOT NEW.owner_instance
          OR OLD.fence IS NOT NEW.fence OR NEW.state IN ('completed', 'cancelled')
        BEGIN
          UPDATE session_handoff_root SET state = CASE
            WHEN NEW.state IN ('completed', 'cancelled') THEN 'terminal' ELSE 'invalidated' END
            WHERE session_id = OLD.session_id AND state = 'active';
        END`)
    })
  },
} satisfies DatabaseMigration.Migration
