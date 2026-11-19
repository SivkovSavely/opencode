import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261119170251_session_orchestration",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_watch_delivery\` (
          \`id\` text PRIMARY KEY,
          \`watch_id\` text NOT NULL,
          \`event_id\` text NOT NULL,
          \`execution_id\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`destination_id\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`state\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_watch_delivery_watch_id_session_watch_id_fk\` FOREIGN KEY (\`watch_id\`) REFERENCES \`session_watch\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_watch_delivery_destination_id_session_id_fk\` FOREIGN KEY (\`destination_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_watch_event\` (
          \`id\` text PRIMARY KEY,
          \`execution_id\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`outcome\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_watch_event_execution_id_session_watch_execution_id_fk\` FOREIGN KEY (\`execution_id\`) REFERENCES \`session_watch_execution\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_watch_execution\` (
          \`sequence\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL UNIQUE,
          \`session_id\` text NOT NULL,
          \`owner_lineage\` text NOT NULL,
          \`owner_instance\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`result\` text,
          \`message_id\` text,
          \`summary\` text DEFAULT '' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_watch_execution_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_watch\` (
          \`id\` text PRIMARY KEY,
          \`owner_id\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`destination_id\` text NOT NULL,
          \`scopes\` text NOT NULL,
          \`submission\` text NOT NULL,
          \`events\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`status\` text NOT NULL,
          \`execution_id\` text,
          \`after_sequence\` integer NOT NULL,
          \`accepted\` integer DEFAULT 0 NOT NULL,
          \`maximum\` integer NOT NULL,
          \`agent\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_watch_owner_id_session_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_watch_source_id_session_id_fk\` FOREIGN KEY (\`source_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_watch_destination_id_session_id_fk\` FOREIGN KEY (\`destination_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_watch_delivery_event_idx\` ON \`session_watch_delivery\` (\`watch_id\`,\`event_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_watch_delivery_pending_idx\` ON \`session_watch_delivery\` (\`state\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_watch_execution_session_idx\` ON \`session_watch_execution\` (\`session_id\`,\`sequence\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_watch_source_status_idx\` ON \`session_watch\` (\`source_id\`,\`status\`);`)
      yield* tx.run(`
        CREATE TABLE \`session_control_request\` (
          \`id\` text PRIMARY KEY,
          \`owner_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`submission\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`scopes\` text NOT NULL,
          \`agent\` text,
          \`auto\` integer NOT NULL,
          \`cancellation\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_control_request_owner_id_session_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_control_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_control_request_owner_idx\` ON \`session_control_request\` (\`owner_id\`);`)
      yield* journal(tx)
    })
  },
} satisfies DatabaseMigration.Migration

// Fresh databases create these tables from schema.gen instead of replaying DDL.
// Both paths install the same atomic runtime journal and outbox acceptance rules.
export function journal(tx: Parameters<DatabaseMigration.Migration["up"]>[0]) {
  return Effect.gen(function* () {
    yield* tx.run(`CREATE TRIGGER session_watch_execution_insert AFTER INSERT ON runtime_execution
      WHEN NEW.state = 'active'
      BEGIN
        INSERT INTO session_watch_execution
          (id, session_id, owner_lineage, owner_instance, fence, state, time_created)
        VALUES ('run_' || lower(hex(randomblob(16))), NEW.session_id, NEW.owner_lineage,
          NEW.owner_instance, NEW.fence, 'running', NEW.time_updated);
      END`)
    yield* tx.run(`CREATE TRIGGER session_watch_execution_start AFTER UPDATE ON runtime_execution
      WHEN NEW.state = 'active' AND OLD.state IN ('completed', 'cancelled')
      BEGIN
        INSERT INTO session_watch_execution
          (id, session_id, owner_lineage, owner_instance, fence, state, time_created)
        VALUES ('run_' || lower(hex(randomblob(16))), NEW.session_id, NEW.owner_lineage,
          NEW.owner_instance, NEW.fence, 'running', NEW.time_updated);
        DELETE FROM session_watch_execution WHERE session_id = NEW.session_id AND state = 'terminal'
          AND sequence NOT IN (SELECT sequence FROM session_watch_execution
            WHERE session_id = NEW.session_id ORDER BY sequence DESC LIMIT 128);
      END`)
    yield* tx.run(`CREATE TRIGGER session_watch_execution_recover AFTER UPDATE ON runtime_execution
      WHEN NEW.state = 'active' AND OLD.state NOT IN ('completed', 'cancelled')
      BEGIN
        UPDATE session_watch_execution SET owner_lineage = NEW.owner_lineage,
          owner_instance = NEW.owner_instance, fence = NEW.fence
          WHERE session_id = NEW.session_id AND state = 'running';
      END`)
    yield* tx.run(`CREATE TRIGGER session_watch_execution_terminal AFTER UPDATE ON runtime_execution
      WHEN NEW.state IN ('completed', 'cancelled') AND OLD.state <> NEW.state
      BEGIN
        UPDATE session_watch_execution SET state = 'terminal', time_completed = NEW.time_updated
          WHERE session_id = NEW.session_id AND state = 'running';
        INSERT OR IGNORE INTO session_watch_event
          (id, execution_id, source_id, sequence, outcome, summary, time_created)
        SELECT id || '/terminal', id, session_id, sequence,
          CASE WHEN NEW.state = 'cancelled' THEN 'cancelled' ELSE result END,
          substr(summary, 1, 2000), NEW.time_updated FROM session_watch_execution
        WHERE sequence = (SELECT max(sequence) FROM session_watch_execution WHERE session_id = NEW.session_id)
          AND (NEW.state = 'cancelled' OR result IS NOT NULL);
        INSERT OR IGNORE INTO session_watch_event
          (id, execution_id, source_id, sequence, outcome, summary, time_created)
        SELECT id || '/idle', id, session_id, sequence, 'idle', substr(summary, 1, 2000), NEW.time_updated
          FROM session_watch_execution WHERE sequence = (SELECT max(sequence) FROM session_watch_execution WHERE session_id = NEW.session_id)
            AND NEW.state = 'completed';
        UPDATE session_watch SET status = 'invalidated', error = 'Tracked execution ended without a matching event'
          WHERE status = 'active' AND mode = 'once' AND source_id = NEW.session_id
            AND execution_id IN (SELECT id FROM session_watch_execution
              WHERE session_id = NEW.session_id AND state = 'terminal')
            AND NEW.state = 'completed';
      END`)
    yield* tx.run(`CREATE TRIGGER session_watch_accept AFTER INSERT ON session_watch_event
      BEGIN
        UPDATE session_watch SET status = 'exhausted', error = 'Destination pending-delivery limit reached'
          WHERE status = 'active' AND delivery = 'auto' AND source_id = NEW.source_id
            AND EXISTS (SELECT 1 FROM json_each(events) WHERE value = NEW.outcome)
            AND (SELECT count(*) FROM session_watch_delivery d WHERE d.destination_id = session_watch.destination_id
              AND d.state IN ('pending', 'accepted', 'uncertain')) >= 64;
        INSERT OR IGNORE INTO session_watch_delivery
          (id, watch_id, event_id, execution_id, source_id, destination_id,
            outcome, summary, state, queue_id, time_created)
        SELECT id || '/' || NEW.id, id, NEW.id, NEW.execution_id, NEW.source_id, destination_id,
          NEW.outcome, NEW.summary, CASE delivery WHEN 'record' THEN 'recorded' ELSE 'pending' END,
          'watch_' || id || '_' || NEW.id, NEW.time_created
        FROM session_watch WHERE source_id = NEW.source_id AND status = 'active'
          AND accepted < maximum AND NEW.sequence > after_sequence
          AND (execution_id IS NULL OR execution_id = NEW.execution_id)
          AND EXISTS (SELECT 1 FROM json_each(events) WHERE value = NEW.outcome);
        UPDATE session_watch SET accepted = accepted + 1,
          status = CASE WHEN mode = 'once' THEN 'resolved'
            WHEN accepted + 1 >= maximum THEN 'exhausted' ELSE 'active' END
        WHERE id IN (SELECT watch_id FROM session_watch_delivery WHERE event_id = NEW.id);
      END`)
    yield* tx.run(`CREATE TRIGGER session_watch_delivery_bound BEFORE INSERT ON session_watch_delivery
      WHEN NEW.state = 'pending' AND (SELECT count(*) FROM session_watch_delivery
        WHERE destination_id = NEW.destination_id AND state IN ('pending', 'accepted', 'uncertain')) >= 64
      BEGIN
        UPDATE session_watch SET status = 'exhausted', error = 'Destination pending-delivery limit reached'
          WHERE id = NEW.watch_id;
        SELECT RAISE(IGNORE);
      END`)
    yield* tx.run(`INSERT INTO session_watch_execution
      (id, session_id, owner_lineage, owner_instance, fence, state, time_created)
      SELECT 'run_' || lower(hex(randomblob(16))), session_id, owner_lineage, owner_instance, fence,
        'running', time_updated FROM runtime_execution WHERE state NOT IN ('completed', 'cancelled')`)
  })
}
