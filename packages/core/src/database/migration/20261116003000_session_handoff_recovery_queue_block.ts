import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261116003000_session_handoff_recovery_queue_block",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE IF NOT EXISTS session_handoff_recovery_queue_block (
        session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        recovery_request_id text NOT NULL REFERENCES session_handoff_request(request_id),
        root_session_id text NOT NULL, queue_id text NOT NULL, user_message_id text NOT NULL,
        reservation text NOT NULL, recovery_revision integer NOT NULL,
        owner_lineage text NOT NULL, owner_instance text NOT NULL, recovery_fence integer NOT NULL,
        queue_revision integer NOT NULL, input_proof text NOT NULL,
        state text NOT NULL, reason text, internal_user_id text,
        PRIMARY KEY (session_id,recovery_request_id),
        FOREIGN KEY (root_session_id,queue_id,user_message_id) REFERENCES session_handoff_action(session_id,queue_id,user_message_id))`)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS session_handoff_recovery_queue_owned_idx
        ON session_handoff_recovery_queue_block(session_id) WHERE state='owned'`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_no_rearm BEFORE UPDATE ON session_handoff_recovery_queue_block
        WHEN OLD.state <> 'owned' AND NEW.state='owned'
        BEGIN SELECT RAISE(ABORT,'recovery queue authority cannot be rearmed'); END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_retain BEFORE DELETE ON session_handoff_recovery_queue_block
        WHEN EXISTS (SELECT 1 FROM session WHERE id=OLD.session_id)
        BEGIN SELECT RAISE(ABORT,'retained recovery queue authority'); END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_no_replace BEFORE INSERT ON session_handoff_recovery_queue_block
        WHEN EXISTS (SELECT 1 FROM session_handoff_recovery_queue_block WHERE session_id=NEW.session_id AND recovery_request_id=NEW.recovery_request_id)
        BEGIN SELECT RAISE(ABORT,'recovery queue authority already exists'); END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_identity BEFORE UPDATE ON session_handoff_recovery_queue_block
        WHEN OLD.session_id IS NOT NEW.session_id OR OLD.recovery_request_id IS NOT NEW.recovery_request_id
          OR OLD.root_session_id IS NOT NEW.root_session_id OR OLD.queue_id IS NOT NEW.queue_id OR OLD.user_message_id IS NOT NEW.user_message_id
          OR OLD.reservation IS NOT NEW.reservation OR OLD.recovery_revision IS NOT NEW.recovery_revision
          OR OLD.owner_lineage IS NOT NEW.owner_lineage OR OLD.owner_instance IS NOT NEW.owner_instance OR OLD.recovery_fence IS NOT NEW.recovery_fence
          OR OLD.queue_revision IS NOT NEW.queue_revision
        BEGIN SELECT RAISE(ABORT,'immutable recovery queue identity'); END`)
      // Generic flag writes express intent even when the queue revision does not change.
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_flags AFTER UPDATE OF blocked,paused ON session_queue_state
        BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='queue_flags'
          WHERE session_id=NEW.session_id AND state='owned'; END`)
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const row = operation === "DELETE" ? "OLD" : "NEW"
        yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_entry_${operation.toLowerCase()} AFTER ${operation} ON session_queue
          BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='queue_entry'
            WHERE session_id=${row}.session_id AND state='owned'; END`)
        yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_user_${operation.toLowerCase()} AFTER ${operation} ON message
          WHEN ${operation === "UPDATE" ? "(json_extract(OLD.data,'$.role')='user' OR json_extract(NEW.data,'$.role')='user') AND (OLD.session_id IS NOT NEW.session_id OR OLD.time_created IS NOT NEW.time_created OR json(json_remove(OLD.data,'$.summary')) IS NOT json(json_remove(NEW.data,'$.summary')))" : `json_extract(${row}.data,'$.role')='user'`}
          BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='input_message'
            WHERE session_id=${row}.session_id AND state='owned'
              ${operation === "INSERT" ? `AND (internal_user_id IS NULL OR internal_user_id <> ${row}.id)` : ""}; END`)
        yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_part_${operation.toLowerCase()} AFTER ${operation} ON part
          WHEN EXISTS (SELECT 1 FROM message WHERE id=${row}.message_id AND json_extract(data,'$.role')='user')
            ${operation === "UPDATE" ? "AND (OLD.message_id IS NOT NEW.message_id OR OLD.session_id IS NOT NEW.session_id OR json(OLD.data) IS NOT json(NEW.data))" : ""}
            ${
              operation === "UPDATE"
                ? `AND NOT (OLD.message_id=NEW.message_id AND OLD.session_id=NEW.session_id
              AND json_extract(NEW.data,'$.type')='compaction' AND json_extract(NEW.data,'$.auto')=1
              AND json(json_remove(OLD.data,'$.tail_start_id'))=json(json_remove(NEW.data,'$.tail_start_id'))
              AND EXISTS (SELECT 1 FROM session_handoff_compaction c JOIN session_handoff_recovery_queue_block b
                ON b.session_id=c.session_id AND b.root_session_id=c.session_id AND b.reservation=c.reservation
                  AND b.queue_id=c.queue_id AND b.user_message_id=c.user_message_id AND b.state='owned'
                WHERE c.message_id=NEW.message_id AND c.session_id=NEW.session_id AND c.kind='request'))`
                : ""
            }
          BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='input_part'
            WHERE session_id=${row}.session_id AND state='owned'
              ${operation === "INSERT" ? `AND (internal_user_id IS NULL OR internal_user_id <> ${row}.message_id)` : ""}; END`)
      }
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_context AFTER UPDATE ON session
        WHEN OLD.parent_id IS NOT NEW.parent_id OR OLD.project_id IS NOT NEW.project_id OR OLD.directory IS NOT NEW.directory
          OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.agent IS NOT NEW.agent OR OLD.model IS NOT NEW.model
          OR OLD.permission IS NOT NEW.permission OR OLD.metadata IS NOT NEW.metadata OR OLD.time_archived IS NOT NEW.time_archived
        BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='session_context'
          WHERE session_id=NEW.id AND state='owned'; END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_owner AFTER UPDATE ON runtime_execution
        WHEN OLD.owner_lineage IS NOT NEW.owner_lineage OR OLD.owner_instance IS NOT NEW.owner_instance OR OLD.fence IS NOT NEW.fence
          OR NEW.desired_active <> 1 OR OLD.parent_session_id IS NOT NEW.parent_session_id OR OLD.parent_message_id IS NOT NEW.parent_message_id
          OR OLD.parent_call_id IS NOT NEW.parent_call_id OR OLD.parent_mode IS NOT NEW.parent_mode
          OR OLD.owner_host IS NOT NEW.owner_host OR OLD.owner_machine_id IS NOT NEW.owner_machine_id OR OLD.owner_boot_id IS NOT NEW.owner_boot_id
          OR OLD.owner_pid_namespace IS NOT NEW.owner_pid_namespace OR OLD.owner_pid IS NOT NEW.owner_pid OR OLD.owner_start_time IS NOT NEW.owner_start_time
        BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='runtime_owner'
          WHERE session_id=NEW.session_id AND state='owned'; END`)
      for (const table of ["runtime_execution", "session_queue_state"])
        yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_${table}_delete AFTER DELETE ON ${table}
          BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='deleted_execution_or_queue'
            WHERE session_id=OLD.session_id AND state='owned'; END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_control AFTER UPDATE ON session_handoff_control
        WHEN OLD.reservation IS NOT NEW.reservation OR NEW.state IN ('competing','invalidated')
          OR (OLD.data IS NOT NEW.data AND (NEW.state <> 'terminal'
            OR json(json_remove(OLD.data,'$.retiredFrom','$.identity.revision','$.identity.contextDigest'))
              IS NOT json(json_remove(NEW.data,'$.retiredFrom','$.identity.revision','$.identity.contextDigest'))))
        BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='control_context'
          WHERE root_session_id=NEW.session_id AND state='owned'; END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_parent_task AFTER UPDATE ON part
        WHEN json_extract(OLD.data,'$.tool')='task' AND json(OLD.data) IS NOT json(NEW.data)
        BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='parent_task'
          WHERE state='owned' AND session_id IN (SELECT session_id FROM runtime_execution
            WHERE parent_session_id=OLD.session_id AND parent_message_id=OLD.message_id AND parent_call_id=json_extract(OLD.data,'$.callID')); END`)
      for (const operation of ["INSERT", "DELETE"]) {
        const row = operation === "DELETE" ? "OLD" : "NEW"
        yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_parent_task_${operation.toLowerCase()} AFTER ${operation} ON part
          WHEN json_extract(${row}.data,'$.tool')='task'
          BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='parent_task'
            WHERE state='owned' AND session_id IN (SELECT session_id FROM runtime_execution
              WHERE parent_session_id=${row}.session_id AND parent_message_id=${row}.message_id AND parent_call_id=json_extract(${row}.data,'$.callID')); END`)
      }
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS handoff_queue_competing AFTER INSERT ON session_handoff_root
        BEGIN UPDATE session_handoff_recovery_queue_block SET state='invalidated',reason='competing_reservation'
          WHERE (session_id=NEW.session_id OR root_session_id=NEW.session_id) AND state='owned'; END`)
    })
  },
} satisfies DatabaseMigration.Migration
