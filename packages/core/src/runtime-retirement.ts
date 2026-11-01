export * as RuntimeRetirement from "./runtime-retirement"

import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "./database/database"

export class RootRetirementError extends Schema.TaggedErrorClass<RootRetirementError>()("RootRetirementError", {
  sessionID: Schema.String,
  reason: Schema.Literals(["not_found", "not_root", "unavailable"]),
}) {}

export type Result = { rootSessionID: string; sessionIDs: string[] }

export const lookup = (database: Database.Interface, sessionID: string, parentSessionID?: string) =>
  database.db.get<{ root_session_id: string }>(sql`
    SELECT root_session_id FROM runtime_retirement
    WHERE session_id IN (${sessionID}, ${parentSessionID ?? null}) LIMIT 1
  `)

/** Call under the removal transaction's write lock, before deleting any projected child. */
export const validateChildPrune = Effect.fn("RuntimeRetirement.validateChildPrune")(function* (
  database: Database.Interface,
  sessionID: string,
) {
  const conflict = yield* database.db.get(sql`
    WITH RECURSIVE ancestors(id) AS (
      SELECT ${sessionID}
      UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
      UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
        WHERE e.parent_session_id IS NOT NULL
    ), roots(id) AS (
      SELECT a.id FROM ancestors a JOIN session s ON s.id = a.id WHERE s.parent_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM runtime_execution e WHERE e.session_id = a.id AND e.parent_session_id IS NOT NULL)
    ), descendants(id) AS (
      SELECT ${sessionID}
      UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id = d.id
      UNION SELECT e.session_id FROM runtime_execution e JOIN descendants d ON e.parent_session_id = d.id
    ) SELECT 1 WHERE (SELECT count(*) FROM roots) <> 1
      OR EXISTS (SELECT 1 FROM (SELECT id FROM ancestors UNION SELECT id FROM descendants) t
        JOIN session s ON s.id = t.id JOIN runtime_execution e ON e.session_id = t.id
        WHERE s.parent_id IS NOT NULL AND e.parent_session_id IS NOT NULL AND s.parent_id <> e.parent_session_id)
      OR EXISTS (SELECT 1 FROM managed_command c
        WHERE c.session_id IN (SELECT id FROM ancestors UNION SELECT id FROM descendants)
          AND c.root_session_id NOT IN (SELECT id FROM roots))
      OR EXISTS (SELECT 1 FROM descendants d LEFT JOIN session s ON s.id = d.id
        LEFT JOIN runtime_execution e ON e.session_id = d.id
        WHERE d.id <> ${sessionID} AND (
          (s.parent_id IS NOT NULL AND s.parent_id NOT IN (SELECT id FROM descendants))
          OR (e.parent_session_id IS NOT NULL AND e.parent_session_id NOT IN (SELECT id FROM descendants))))
      OR EXISTS (SELECT 1 FROM runtime_retirement_member m WHERE m.session_id IN (SELECT id FROM descendants)
        AND m.root_session_id NOT IN (SELECT id FROM roots))
      OR EXISTS (SELECT 1 FROM runtime_retirement r WHERE r.session_id IN (SELECT id FROM descendants)
        AND r.root_session_id NOT IN (SELECT id FROM roots))
  `)
  if (conflict) return yield* new RootRetirementError({ sessionID, reason: "unavailable" })
})

/** Atomically and permanently fence a root and both projected and execution-only descendants. */
export const retireRoot = Effect.fn("RuntimeRetirement.retireRoot")(function* (
  database: Database.Interface,
  sessionID: string,
  options?: { validateAncestry: true },
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const retired = yield* tx.get<{ root_session_id: string }>(sql`
        SELECT root_session_id FROM runtime_retirement WHERE session_id = ${sessionID}
      `)
        if (retired && retired.root_session_id !== sessionID)
          return yield* new RootRetirementError({ sessionID, reason: "not_root" })
        if (!retired) {
          const session = yield* tx.get<{ parent_id: string | null }>(sql`
          SELECT parent_id FROM session WHERE id = ${sessionID}
        `)
          if (!session) return yield* new RootRetirementError({ sessionID, reason: "not_found" })
          const execution = yield* tx.get<{ parent_session_id: string | null }>(sql`
          SELECT parent_session_id FROM runtime_execution WHERE session_id = ${sessionID}
        `)
          if (session.parent_id || execution?.parent_session_id)
            return yield* new RootRetirementError({ sessionID, reason: "not_root" })
        }
        // Recursive pruning must validate before retirement makes delete-trigger
        // exemptions applicable. Keep validation and fencing under the same lock.
        if (options?.validateAncestry) {
          const conflict = yield* tx.get(sql`
            WITH RECURSIVE tree(session_id) AS (
              SELECT ${sessionID}
              UNION SELECT session_id FROM runtime_retirement_member WHERE root_session_id = ${sessionID}
              UNION SELECT session_id FROM managed_command WHERE root_session_id = ${sessionID}
              UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.session_id
              UNION SELECT e.session_id FROM runtime_execution e JOIN tree t ON e.parent_session_id = t.session_id
            ) SELECT 1 FROM tree t
            LEFT JOIN session s ON s.id = t.session_id
            LEFT JOIN runtime_execution e ON e.session_id = t.session_id
            LEFT JOIN runtime_retirement r ON r.session_id = t.session_id
            WHERE NOT EXISTS (SELECT 1 FROM runtime_retirement_member m
              JOIN runtime_retirement fenced ON fenced.session_id = m.session_id
              WHERE m.root_session_id = ${sessionID} AND m.session_id = t.session_id)
              AND ((s.parent_id IS NOT NULL AND e.parent_session_id IS NOT NULL AND s.parent_id <> e.parent_session_id)
              OR (s.parent_id IS NOT NULL AND s.parent_id NOT IN (SELECT session_id FROM tree))
              OR (e.parent_session_id IS NOT NULL AND e.parent_session_id NOT IN (SELECT session_id FROM tree))
              OR (r.root_session_id IS NOT NULL AND r.root_session_id <> ${sessionID})
              OR EXISTS (SELECT 1 FROM runtime_retirement_member m
                WHERE m.session_id = t.session_id AND m.root_session_id <> ${sessionID})
              OR EXISTS (SELECT 1 FROM managed_command c
                WHERE c.session_id = t.session_id AND c.root_session_id <> ${sessionID}))
            LIMIT 1
          `)
          if (conflict) return yield* new RootRetirementError({ sessionID, reason: "unavailable" })
        }
        yield* tx.run(sql`
        WITH RECURSIVE descendants(session_id) AS (
          SELECT ${sessionID}
          UNION
          SELECT session_id FROM runtime_retirement_member WHERE root_session_id = ${sessionID}
          UNION
          SELECT session_id FROM managed_command WHERE root_session_id = ${sessionID}
          UNION
          SELECT child.id FROM session child JOIN descendants parent ON child.parent_id = parent.session_id
          UNION
          SELECT child.session_id FROM runtime_execution child
            JOIN descendants parent ON child.parent_session_id = parent.session_id
        )
        INSERT OR IGNORE INTO runtime_retirement_member (root_session_id, session_id)
        SELECT ${sessionID}, session_id FROM descendants
      `)
        yield* tx.run(sql`
        INSERT OR IGNORE INTO runtime_retirement (session_id, root_session_id, time_created)
        SELECT session_id, ${sessionID}, ${Date.now()} FROM runtime_retirement_member
        WHERE root_session_id = ${sessionID}
      `)
        yield* tx.run(sql`
        UPDATE runtime_execution SET state = 'cancelled', desired_active = 0, fence = fence + 1,
          retry_at = NULL, time_updated = ${Date.now()}
        WHERE session_id IN (SELECT session_id FROM runtime_retirement_member WHERE root_session_id = ${sessionID})
          AND (state <> 'cancelled' OR desired_active <> 0)
      `)
        const rows = yield* tx.all<{ session_id: string }>(sql`
        SELECT session_id FROM runtime_retirement_member WHERE root_session_id = ${sessionID} ORDER BY session_id
      `)
        return { rootSessionID: sessionID, sessionIDs: rows.map((row) => row.session_id) }
      }),
    { behavior: "immediate" },
  )
})
