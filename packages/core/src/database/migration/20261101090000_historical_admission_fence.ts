import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261101090000_historical_admission_fence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE TABLE IF NOT EXISTS historical_fence_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), database_id TEXT NOT NULL UNIQUE)`,
      )
      yield* tx.run(`INSERT OR IGNORE INTO historical_fence_identity VALUES (1, lower(hex(randomblob(32))))`)
      yield* tx.run(`CREATE TABLE IF NOT EXISTS historical_fence_evidence (
        root_session_id TEXT PRIMARY KEY, evidence_hash TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, observed_payload TEXT NOT NULL, signer TEXT NOT NULL, signature TEXT NOT NULL,
        issuer TEXT NOT NULL, nonce TEXT NOT NULL, time_created INTEGER NOT NULL)`)
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS historical_fence_nonce_idx ON historical_fence_evidence(signer, nonce)`,
      )
      yield* tx.run(`CREATE TABLE IF NOT EXISTS historical_fence_prune (
        root_session_id TEXT PRIMARY KEY, payload TEXT NOT NULL, time_created INTEGER NOT NULL)`)
      for (const table of ["historical_fence_identity", "historical_fence_evidence", "historical_fence_prune"]) {
        for (const operation of ["UPDATE", "DELETE"]) {
          yield* tx.run(`CREATE TRIGGER ${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
            BEGIN SELECT RAISE(ABORT, 'Historical fence evidence is immutable'); END`)
        }
      }
      // A child may be independently deleted long before its root. Remember observed
      // ownership without retiring the still-live root or its other children.
      yield* tx.run(`CREATE TRIGGER historical_fence_before_child_prune BEFORE DELETE ON session
        WHEN (OLD.parent_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM runtime_execution WHERE session_id = OLD.id AND parent_session_id IS NOT NULL
        )) AND NOT EXISTS (SELECT 1 FROM runtime_retirement WHERE session_id = OLD.id) BEGIN
          SELECT RAISE(ABORT, 'Ambiguous historical child ancestry') WHERE (
            WITH RECURSIVE ancestors(id) AS (
              SELECT OLD.id
              UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
              UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
                WHERE e.parent_session_id IS NOT NULL
            ) SELECT
              EXISTS (SELECT 1 FROM ancestors a JOIN session s ON s.id = a.id
                JOIN runtime_execution e ON e.session_id = a.id
                WHERE s.parent_id IS NOT NULL AND e.parent_session_id IS NOT NULL AND s.parent_id <> e.parent_session_id)
              OR (SELECT count(*) FROM ancestors a JOIN session s ON s.id = a.id
                WHERE s.parent_id IS NULL AND NOT EXISTS (
                  SELECT 1 FROM runtime_execution e WHERE e.session_id = a.id AND e.parent_session_id IS NOT NULL
                )) <> 1
          );
          SELECT RAISE(ABORT, 'Ambiguous historical descendant ancestry') WHERE EXISTS (
            WITH RECURSIVE descendants(id) AS (
              SELECT OLD.id
              UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
              UNION SELECT e.session_id FROM runtime_execution e JOIN descendants d ON e.parent_session_id = d.id
            ) SELECT 1 FROM descendants d JOIN session s ON s.id = d.id
              JOIN runtime_execution e ON e.session_id = d.id
              WHERE s.parent_id IS NOT NULL AND e.parent_session_id IS NOT NULL AND s.parent_id <> e.parent_session_id
          );
          SELECT RAISE(ABORT, 'Conflicting historical command ownership') WHERE EXISTS (
            WITH RECURSIVE ancestors(id) AS (
              SELECT OLD.id
              UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
              UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
                WHERE e.parent_session_id IS NOT NULL
            ), descendants(id) AS (
              SELECT OLD.id
              UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
              UNION SELECT e.session_id FROM runtime_execution e JOIN descendants d ON e.parent_session_id = d.id
            ) SELECT 1 FROM managed_command c
              WHERE c.session_id IN (SELECT id FROM ancestors UNION SELECT id FROM descendants)
                AND c.root_session_id <> (
                  SELECT a.id FROM ancestors a JOIN session s ON s.id = a.id
                  WHERE s.parent_id IS NULL AND NOT EXISTS (
                    SELECT 1 FROM runtime_execution e WHERE e.session_id = a.id AND e.parent_session_id IS NOT NULL
                  )
                )
          );
          INSERT OR IGNORE INTO runtime_retirement_member (root_session_id, session_id)
          WITH RECURSIVE ancestors(id) AS (
            SELECT OLD.id
            UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
            UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
              WHERE e.parent_session_id IS NOT NULL
          ), descendants(id) AS (
            SELECT OLD.id
            UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
            UNION SELECT e.session_id FROM runtime_execution e JOIN descendants d ON e.parent_session_id = d.id
          ) SELECT a.id, d.id FROM ancestors a JOIN session s ON s.id = a.id CROSS JOIN descendants d
            WHERE s.parent_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM runtime_execution e WHERE e.session_id = a.id AND e.parent_session_id IS NOT NULL
            );
          INSERT OR IGNORE INTO runtime_retirement (session_id, root_session_id, time_created)
          SELECT m.session_id, m.root_session_id, CAST(unixepoch('subsec') * 1000 AS INTEGER)
          FROM runtime_retirement_member m WHERE m.session_id IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT OLD.id
              UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
              UNION SELECT e.session_id FROM runtime_execution e JOIN descendants d ON e.parent_session_id = d.id
            ) SELECT id FROM descendants
          );
          UPDATE runtime_execution SET state = 'cancelled', desired_active = 0, fence = fence + 1,
            retry_at = NULL, time_updated = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE session_id IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT OLD.id
              UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
              UNION SELECT e.session_id FROM runtime_execution e JOIN descendants d ON e.parent_session_id = d.id
            ) SELECT id FROM descendants
          ) AND (state <> 'cancelled' OR desired_active <> 0 OR retry_at IS NOT NULL);
        END`)
      // Capture only identities the database actually knows before cascades remove execution ancestry.
      yield* tx.run(`CREATE TRIGGER historical_fence_before_root_prune BEFORE DELETE ON session
        WHEN OLD.parent_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM runtime_execution WHERE session_id = OLD.id AND parent_session_id IS NOT NULL
        ) BEGIN
          SELECT RAISE(ABORT, 'Ambiguous historical descendant ancestry') WHERE EXISTS (
            WITH RECURSIVE descendants(id) AS (
              SELECT OLD.id
              UNION SELECT session_id FROM runtime_retirement_member WHERE root_session_id = OLD.id
              UNION SELECT session_id FROM managed_command WHERE root_session_id = OLD.id
              UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
              UNION SELECT e.session_id FROM runtime_execution e JOIN descendants d ON e.parent_session_id = d.id
            ) SELECT 1 FROM descendants d JOIN session s ON s.id = d.id
              JOIN runtime_execution e ON e.session_id = d.id
              WHERE s.parent_id IS NOT NULL AND e.parent_session_id IS NOT NULL AND s.parent_id <> e.parent_session_id
                AND NOT EXISTS (SELECT 1 FROM runtime_retirement_member m JOIN runtime_retirement r ON r.session_id = m.session_id
                  WHERE m.root_session_id = OLD.id AND m.session_id = d.id)
          );
          SELECT RAISE(ABORT, 'Conflicting historical command ownership') WHERE EXISTS (
            WITH RECURSIVE descendants(id) AS (
              SELECT OLD.id
              UNION SELECT session_id FROM runtime_retirement_member WHERE root_session_id = OLD.id
              UNION SELECT session_id FROM managed_command WHERE root_session_id = OLD.id
              UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
              UNION SELECT e.session_id FROM runtime_execution e JOIN descendants d ON e.parent_session_id = d.id
            ) SELECT 1 FROM descendants d
              LEFT JOIN session s ON s.id = d.id
              LEFT JOIN runtime_execution e ON e.session_id = d.id
              -- Immutable membership plus a permanent fence needs no new ownership inference.
              WHERE NOT EXISTS (SELECT 1 FROM runtime_retirement_member m
                JOIN runtime_retirement r ON r.session_id = m.session_id
                WHERE m.root_session_id = OLD.id AND m.session_id = d.id)
                AND ((s.parent_id IS NOT NULL AND s.parent_id NOT IN (SELECT id FROM descendants))
                OR (e.parent_session_id IS NOT NULL AND e.parent_session_id NOT IN (SELECT id FROM descendants))
                OR EXISTS (SELECT 1 FROM managed_command c WHERE c.session_id = d.id AND c.root_session_id <> OLD.id)
                OR EXISTS (SELECT 1 FROM runtime_retirement r WHERE r.session_id = d.id AND r.root_session_id <> OLD.id)
                OR EXISTS (SELECT 1 FROM runtime_retirement_member m WHERE m.session_id = d.id AND m.root_session_id <> OLD.id))
          );
          INSERT OR IGNORE INTO runtime_retirement_member (root_session_id, session_id)
          SELECT OLD.id, id FROM (
            WITH RECURSIVE descendants(id) AS (
              SELECT OLD.id
              UNION SELECT session_id FROM runtime_retirement_member WHERE root_session_id = OLD.id
              UNION SELECT session_id FROM managed_command WHERE root_session_id = OLD.id
              UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
              UNION SELECT e.session_id FROM runtime_execution e JOIN descendants d ON e.parent_session_id = d.id
            ) SELECT id FROM descendants
          );
          INSERT OR IGNORE INTO historical_fence_prune (root_session_id, payload, time_created)
          SELECT OLD.id, json_object('version', 1, 'source', 'database-before-root-prune',
            'databaseID', (SELECT database_id FROM historical_fence_identity WHERE singleton = 1),
            'projectID', OLD.project_id, 'directory', OLD.directory, 'workspaceID', OLD.workspace_id,
            'rootSessionID', OLD.id, 'membershipCoverage', 'observed-partial',
            'sessionIDs', json((SELECT json_group_array(session_id) FROM (
              SELECT session_id FROM runtime_retirement_member WHERE root_session_id = OLD.id ORDER BY session_id
            )))), CAST(unixepoch('subsec') * 1000 AS INTEGER);
          INSERT OR IGNORE INTO runtime_retirement (session_id, root_session_id, time_created)
          SELECT session_id, OLD.id, CAST(unixepoch('subsec') * 1000 AS INTEGER)
          FROM runtime_retirement_member WHERE root_session_id = OLD.id;
          UPDATE runtime_execution SET state = 'cancelled', desired_active = 0, fence = fence + 1,
            retry_at = NULL, time_updated = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE session_id IN (SELECT session_id FROM runtime_retirement_member WHERE root_session_id = OLD.id)
            AND (state <> 'cancelled' OR desired_active <> 0 OR retry_at IS NOT NULL);
        END`)
    })
  },
} satisfies DatabaseMigration.Migration
