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

/** Atomically and permanently fence a root and both projected and execution-only descendants. */
export const retireRoot = Effect.fn("RuntimeRetirement.retireRoot")(function* (
  database: Database.Interface,
  sessionID: string,
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
