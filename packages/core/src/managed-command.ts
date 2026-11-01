export * as ManagedCommand from "./managed-command"

import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import type { Database } from "./database/database"
import { PermissionV1 } from "./v1/permission"

export type Status = "draining" | "drained" | "unknown"
export type Permit = { id: string; sessionID: string; rootSessionID: string; ownerInstance: string; generation: string }

export class AdmissionError extends Schema.TaggedErrorClass<AdmissionError>()("ManagedCommandAdmissionError", {
  sessionID: Schema.String,
}) {}

/** Only opt in before any execution/history exists, never upgrade a historical root. */
export const coverRoot = (database: Database.Interface, sessionID: string) =>
  database.db.get(sql`
    UPDATE managed_command_coverage SET state = 'managed'
    WHERE root_session_id = ${sessionID} AND state = 'eligible'
      AND EXISTS (SELECT 1 FROM session s WHERE s.id = ${sessionID} AND s.parent_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM session WHERE parent_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM runtime_execution WHERE session_id = s.id OR parent_session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM message WHERE session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM session_message WHERE session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM session_input WHERE session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM event_sequence WHERE aggregate_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM runtime_retirement WHERE session_id = s.id))
    RETURNING root_session_id
  `)

/** Called in the creation event's transaction, before subscribers can start work. */
export const enrollCreatedRoot = (database: Database.Interface, sessionID: string) =>
  process.env.OPENCODE_MANAGED_PROFILE === "1" &&
  (!process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST || process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST.trim() === "[]")
    ? coverRoot(database, sessionID).pipe(Effect.asVoid, Effect.orDie)
    : invalidateCoverage(database, sessionID).pipe(Effect.asVoid, Effect.orDie)

/** Reserve before publishing creation; existing sessions must already belong to this exact lineage. */
export const reserveChild = Effect.fn("ManagedCommand.reserveChild")(function* (
  database: Database.Interface,
  sessionID: string,
  parentSessionID: string,
  parentFence: number,
  policy?: PermissionV1.Ruleset,
) {
  const row = yield* database.db.get(sql`
    INSERT INTO managed_session_member
      (session_id, parent_session_id, root_session_id, owner_instance, parent_fence, directory, workspace_id, permission_policy, time_created)
    SELECT ${sessionID}, p.id, COALESCE(m.root_session_id, p.id), e.owner_instance, e.fence,
      p.directory, p.workspace_id,
      CASE WHEN ${policy !== undefined ? 1 : 0} = 1
        THEN json_insert(COALESCE(m.permission_policy, '[]'), '$[#]', json(${JSON.stringify(policy ?? [])}))
        ELSE '[]' END, ${Date.now()}
    FROM session p JOIN runtime_execution e ON e.session_id = p.id
    LEFT JOIN managed_session_member m ON m.session_id = p.id
    JOIN managed_command_coverage c ON c.root_session_id = COALESCE(m.root_session_id, p.id) AND c.state = 'managed'
    WHERE p.id = ${parentSessionID} AND (p.parent_id IS NULL OR m.session_id IS NOT NULL)
      AND (WITH RECURSIVE lineage(id) AS (
        SELECT p.id UNION SELECT ancestor.parent_session_id FROM managed_session_member ancestor
        JOIN lineage ON ancestor.session_id = lineage.id
      ) SELECT count(*) FROM lineage) <= 8
      AND e.fence = ${parentFence} AND e.state = 'active' AND e.desired_active = 1
      AND EXISTS (SELECT 1 FROM managed_command x WHERE x.session_id = p.id
        AND x.owner_instance = e.owner_instance AND x.execution_generation = 'managed-execution' AND x.state = 'running')
      AND NOT EXISTS (SELECT 1 FROM runtime_retirement WHERE session_id IN (p.id, c.root_session_id, ${sessionID}))
      AND (NOT EXISTS (SELECT 1 FROM session WHERE id = ${sessionID}) OR EXISTS (
        SELECT 1 FROM managed_session_member old JOIN session s ON s.id = old.session_id
        WHERE old.session_id = ${sessionID} AND old.parent_session_id = p.id
          AND old.root_session_id = c.root_session_id AND s.parent_id = p.id
          AND s.directory = p.directory AND s.workspace_id IS p.workspace_id))
    ON CONFLICT(session_id) DO UPDATE SET owner_instance = excluded.owner_instance, parent_fence = excluded.parent_fence,
      permission_policy = CASE WHEN ${policy !== undefined ? 1 : 0} = 1 THEN excluded.permission_policy ELSE managed_session_member.permission_policy END
      WHERE managed_session_member.parent_session_id = excluded.parent_session_id
        AND managed_session_member.root_session_id = excluded.root_session_id
    RETURNING session_id
  `)
  if (!row) return yield* new AdmissionError({ sessionID })
})

export const policies = Effect.fn("ManagedCommand.policies")(function* (
  database: Database.Interface,
  sessionID: string,
) {
  const row = yield* database.db.get<{ permission_policy: string }>(sql`
    SELECT permission_policy FROM managed_session_member WHERE session_id = ${sessionID}`)
  if (!row) return []
  return Schema.decodeUnknownSync(Schema.Array(PermissionV1.Ruleset))(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(row.permission_policy),
  )
})

/** A durable lease for local model execution, settled only after all admitted owners join. */
export const beginExecution = Effect.fn("ManagedCommand.beginExecution")(function* (
  database: Database.Interface,
  sessionID: string,
  ownerInstance: string,
  parentSessionID?: string,
) {
  const member = yield* database.db.get<{ root_session_id: string }>(sql`
    SELECT m.root_session_id FROM managed_session_member m
    JOIN session s ON s.id = m.session_id AND s.parent_id = m.parent_session_id
      AND s.directory = m.directory AND s.workspace_id IS m.workspace_id
    JOIN runtime_execution p ON p.session_id = m.parent_session_id
      AND p.fence = m.parent_fence AND p.owner_instance = m.owner_instance
      AND p.state = 'active' AND p.desired_active = 1
    WHERE m.session_id = ${sessionID} AND m.parent_session_id = ${parentSessionID ?? null}
      AND m.owner_instance = ${ownerInstance}
  `)
  if (parentSessionID && !member) return yield* new AdmissionError({ sessionID })
  const permit = {
    id: randomUUID(),
    sessionID,
    rootSessionID: member?.root_session_id ?? sessionID,
    ownerInstance,
    generation: "managed-execution",
  }
  const row = yield* database.db.get(sql`
    INSERT INTO managed_command (id, session_id, root_session_id, owner_instance, execution_generation, state, time_created, time_updated)
    SELECT ${permit.id}, ${sessionID}, ${permit.rootSessionID}, ${ownerInstance}, ${permit.generation}, 'running', ${Date.now()}, ${Date.now()}
    WHERE EXISTS (SELECT 1 FROM session WHERE id = ${sessionID} AND parent_id IS ${parentSessionID ?? null})
      AND (${parentSessionID ?? null} IS NULL OR EXISTS (
        SELECT 1 FROM managed_session_member m JOIN runtime_execution p ON p.session_id = m.parent_session_id
        JOIN managed_command_coverage c ON c.root_session_id = m.root_session_id AND c.state = 'managed'
        WHERE m.session_id = ${sessionID} AND m.parent_session_id = ${parentSessionID ?? null}
          AND m.root_session_id = ${permit.rootSessionID} AND m.owner_instance = ${ownerInstance}
          AND p.fence = m.parent_fence AND p.owner_instance = m.owner_instance
          AND p.state = 'active' AND p.desired_active = 1))
      AND NOT EXISTS (SELECT 1 FROM runtime_retirement WHERE session_id IN (${sessionID}, ${permit.rootSessionID}, ${parentSessionID ?? sessionID}))
    RETURNING id
  `)
  if (!row) return yield* new AdmissionError({ sessionID })
  return permit
})

// Snapshot both ancestry graphs, including missing projections and ancestor execution generations.
const boundary = (db: Pick<Database.Interface["db"], "all">, sessionID: string) =>
  db.all<{
    id: string
    parent_id: string | null
    projected: string | null
    execution_parent: string | null
    fence: number | null
    owner_instance: string | null
    state: string | null
    desired_active: number | null
    retired: string | null
  }>(sql`
    WITH RECURSIVE ancestors(id) AS (
      SELECT ${sessionID}
      UNION SELECT s.parent_id FROM session s JOIN ancestors a ON s.id = a.id WHERE s.parent_id IS NOT NULL
      UNION SELECT e.parent_session_id FROM runtime_execution e JOIN ancestors a ON e.session_id = a.id
        WHERE e.parent_session_id IS NOT NULL
    ) SELECT a.id, s.id AS projected, s.parent_id, e.parent_session_id AS execution_parent,
      e.fence, e.owner_instance, e.state, e.desired_active, r.session_id AS retired
      FROM ancestors a LEFT JOIN session s ON s.id = a.id
      LEFT JOIN runtime_execution e ON e.session_id = a.id
      LEFT JOIN runtime_retirement r ON r.session_id = a.id ORDER BY a.id
  `)

export const admit = Effect.fn("ManagedCommand.admit")(function* (
  database: Database.Interface,
  sessionID: string,
  ownerInstance: string,
  executionFence?: number,
) {
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const ancestors = yield* boundary(tx, sessionID)
        const roots = ancestors.filter((row) => row.projected !== null && row.parent_id === null)
        const execution = ancestors.find((row) => row.id === sessionID)
        if (roots.length !== 1 || !execution?.projected || ancestors.some((row) => row.retired !== null))
          return yield* new AdmissionError({ sessionID })
        if (
          execution.fence !== null &&
          (execution.fence !== executionFence ||
            execution.owner_instance !== ownerInstance ||
            execution.state !== "active" ||
            execution.desired_active !== 1)
        )
          return yield* new AdmissionError({ sessionID })
        if (execution.fence === null && executionFence !== undefined) return yield* new AdmissionError({ sessionID })
        const root = roots[0]
        if (!root) return yield* new AdmissionError({ sessionID })
        const permit = {
          id: randomUUID(),
          sessionID,
          rootSessionID: root.id,
          ownerInstance,
          generation: JSON.stringify(ancestors),
        }
        yield* tx.run(sql`
      INSERT INTO managed_command (id, session_id, root_session_id, owner_instance, execution_generation, state, time_created, time_updated)
      VALUES (${permit.id}, ${sessionID}, ${permit.rootSessionID}, ${ownerInstance}, ${permit.generation}, 'pending', ${Date.now()}, ${Date.now()})
    `)
        return permit
      }),
    { behavior: "immediate" },
  )
})

/** open must synchronously release only the paused launcher's gate, never await the command. */
export const authorize = (database: Database.Interface, permit: Permit, open: () => void) =>
  database.db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          if (JSON.stringify(yield* boundary(tx, permit.sessionID)) !== permit.generation) return false
          const row = yield* tx.get(sql`
      UPDATE managed_command SET state = 'running', time_updated = ${Date.now()}
      WHERE id = ${permit.id} AND owner_instance = ${permit.ownerInstance} AND state = 'pending'
        AND execution_generation = ${permit.generation}
        AND NOT EXISTS (SELECT 1 FROM runtime_retirement WHERE session_id IN (${permit.sessionID}, ${permit.rootSessionID}))
      RETURNING id
    `)
          if (!row) return false
          yield* Effect.sync(open)
          return true
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.uninterruptible)

export const settle = (database: Database.Interface, permit: Permit, confirmed: boolean) =>
  database.db.run(sql`
    UPDATE managed_command SET state = ${confirmed ? "confirmed" : "unknown"}, time_updated = ${Date.now()}
    WHERE id = ${permit.id} AND owner_instance = ${permit.ownerInstance} AND state IN ('pending', 'running')
  `)

/** Owner death is not proof of namespace teardown; unresolved durable rows stay unknown. */
export const status = Effect.fn("ManagedCommand.status")(function* (
  database: Database.Interface,
  rootSessionID: string,
  localPermits: ReadonlySet<string> = new Set(),
) {
  const rows = yield* database.db.all<{ id: string; state: string }>(sql`
    SELECT id, state FROM managed_command WHERE root_session_id = ${rootSessionID}
      OR session_id IN (SELECT session_id FROM runtime_retirement_member WHERE root_session_id = ${rootSessionID})
  `)
  if (rows.some((row) => localPermits.has(row.id) && row.state !== "confirmed")) return "draining" as const
  if (rows.some((row) => row.state !== "confirmed")) return "unknown" as const
  const covered = yield* database.db.get(sql`
    SELECT 1 FROM managed_command_coverage WHERE root_session_id = ${rootSessionID} AND state = 'managed'
  `)
  return covered ? ("drained" as const) : ("unknown" as const)
})

/** Call before any nonmanaged command/tool can execute in an otherwise enrolled tree. */
export const invalidateCoverage = (database: Database.Interface, rootSessionID: string) =>
  database.db.run(sql`
    UPDATE managed_command_coverage SET state = 'unknown' WHERE root_session_id = ${rootSessionID}
  `)
