import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261116001000_session_handoff_control",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE IF NOT EXISTS session_handoff_control (
        session_id TEXT NOT NULL, queue_id TEXT NOT NULL, user_message_id TEXT NOT NULL,
        reservation TEXT NOT NULL, state TEXT NOT NULL, pending_request_id TEXT, data TEXT NOT NULL,
        PRIMARY KEY (session_id, queue_id, user_message_id))`)
      yield* tx.run(`CREATE TABLE IF NOT EXISTS session_handoff_context (
        identity TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, queue_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL, retired_reason TEXT)`)
      yield* tx.run(`CREATE TABLE IF NOT EXISTS session_handoff_compaction (
        message_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, reservation TEXT NOT NULL,
        queue_id TEXT NOT NULL, user_message_id TEXT NOT NULL, parent_user_message_id TEXT NOT NULL,
        kind TEXT NOT NULL, epoch_sequence INTEGER NOT NULL, data TEXT NOT NULL)`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_compaction_immutable
        BEFORE UPDATE ON session_handoff_compaction BEGIN SELECT RAISE(ABORT, 'immutable handoff compaction'); END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_compaction_retention
        BEFORE DELETE ON session_handoff_compaction BEGIN SELECT RAISE(ABORT, 'retained handoff compaction'); END`)
      yield* tx.run(`CREATE TABLE IF NOT EXISTS session_handoff_attempt (
        position INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        queue_id TEXT NOT NULL, user_message_id TEXT NOT NULL, data TEXT NOT NULL)`)
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS session_handoff_attempt_message_idx ON session_handoff_attempt (message_id)`,
      )
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_attempt_immutable
        BEFORE UPDATE ON session_handoff_attempt BEGIN SELECT RAISE(ABORT, 'immutable handoff attempt'); END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_attempt_retention
        BEFORE DELETE ON session_handoff_attempt BEGIN SELECT RAISE(ABORT, 'retained handoff attempt'); END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_control_retire
        AFTER UPDATE OF state ON session_handoff_root
        WHEN OLD.state = 'active' AND NEW.state != 'active'
        BEGIN
          INSERT INTO session_handoff_receipt (request_id, revision, data)
            SELECT c.pending_request_id,
              COALESCE((SELECT MAX(revision) FROM session_handoff_receipt WHERE request_id = c.pending_request_id), 0) + 1,
              json_set(COALESCE((SELECT data FROM session_handoff_receipt WHERE request_id = c.pending_request_id ORDER BY revision DESC LIMIT 1), r.data),
                '$.state', 'expired', '$.reason', CASE NEW.state WHEN 'terminal' THEN 'terminal_action' ELSE 'invalidated' END,
                '$.updatedAt', CAST(unixepoch('subsec') * 1000 AS INTEGER))
            FROM session_handoff_control c JOIN session_handoff_request r ON r.request_id = c.pending_request_id
            WHERE c.session_id = OLD.session_id AND c.reservation = OLD.reservation;
          UPDATE session_handoff_context SET retired_reason = CASE NEW.state WHEN 'terminal' THEN 'terminal_action' ELSE 'invalidated' END
            WHERE session_id = OLD.session_id AND queue_id = OLD.queue_id AND user_message_id = OLD.user_message_id;
          UPDATE session_handoff_control SET state = NEW.state, pending_request_id = NULL,
            data = json_set(data, '$.retiredFrom', json_extract(data, '$.identity'),
              '$.identity.revision', json_extract(data, '$.identity.revision') + 1,
              '$.identity.contextDigest', 'retired:v1:' || NEW.state || ':' || json_extract(data, '$.identity.contextDigest'))
            WHERE session_id = OLD.session_id AND reservation = OLD.reservation;
          INSERT OR IGNORE INTO session_handoff_context (identity,session_id,queue_id,user_message_id,retired_reason)
            SELECT json_object('directory', json_extract(data, '$.directory'), 'identity', json(json_extract(data, '$.identity')), 'sessionID', session_id),
              session_id,queue_id,user_message_id,CASE NEW.state WHEN 'terminal' THEN 'terminal_action' ELSE 'invalidated' END
            FROM session_handoff_control WHERE session_id = OLD.session_id AND reservation = OLD.reservation;
        END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_control_delete
        BEFORE DELETE ON session_handoff_root WHEN OLD.enrolled_request_id IS NOT NULL
        BEGIN UPDATE session_handoff_root SET state = 'terminal'
          WHERE session_id = OLD.session_id AND reservation = OLD.reservation AND state = 'active'; END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_context_immutable
        BEFORE UPDATE OF identity, session_id, queue_id, user_message_id ON session_handoff_context
        BEGIN SELECT RAISE(ABORT, 'immutable handoff context'); END`)
      yield* tx.run(`CREATE TRIGGER IF NOT EXISTS session_handoff_context_retention
        BEFORE DELETE ON session_handoff_context BEGIN SELECT RAISE(ABORT, 'retained handoff context'); END`)
    })
  },
} satisfies DatabaseMigration.Migration
