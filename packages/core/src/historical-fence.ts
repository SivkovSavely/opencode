export * as HistoricalFence from "./historical-fence"

import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import type { Database } from "./database/database"

export const Attestation = Schema.Struct({
  version: Schema.Literal(1),
  databaseID: Schema.String,
  projectID: Schema.String,
  directory: Schema.String,
  workspaceID: Schema.NullOr(Schema.String),
  rootSessionID: Schema.String,
  members: Schema.Array(
    Schema.Struct({
      sessionID: Schema.String,
      parentSessionID: Schema.NullOr(Schema.String),
      role: Schema.Literals(["root", "descendant"]),
    }),
  ),
  membershipCoverage: Schema.Literal("attested-partial"),
  artifact: Schema.Struct({ reference: Schema.String, sha256: Schema.String }),
  issuer: Schema.String,
  issuedAt: Schema.Number,
  nonce: Schema.String,
}).annotate({ identifier: "HistoricalFenceAttestation" })
export type Attestation = typeof Attestation.Type

export class Rejected extends Schema.TaggedErrorClass<Rejected>()("HistoricalFenceRejected", {
  reason: Schema.String,
}) {}

/** Fixed field order; member order is significant and must be ascending by sessionID. */
export function canonical(input: Attestation) {
  return JSON.stringify({
    version: input.version,
    databaseID: input.databaseID,
    projectID: input.projectID,
    directory: input.directory,
    workspaceID: input.workspaceID,
    rootSessionID: input.rootSessionID,
    members: input.members.map((member) => ({
      sessionID: member.sessionID,
      parentSessionID: member.parentSessionID,
      role: member.role,
    })),
    membershipCoverage: input.membershipCoverage,
    artifact: { reference: input.artifact.reference, sha256: input.artifact.sha256 },
    issuer: input.issuer,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
  })
}

export const identity = Effect.fn("HistoricalFence.identity")(function* (database: Database.Interface) {
  const row = yield* database.db.get<{ database_id: string }>(
    sql`SELECT database_id FROM historical_fence_identity WHERE singleton = 1`,
  )
  if (!row) return yield* Effect.die("Historical fence database identity is missing")
  return row.database_id
})

export const evidence = (database: Database.Interface, rootSessionID: string) =>
  database.db.get<{ evidence_hash: string; payload: string; signer: string; time_created: number }>(sql`
    SELECT evidence_hash, payload, signer, time_created FROM historical_fence_evidence WHERE root_session_id = ${rootSessionID}
  `)

export const partialEvidence = Effect.fn("HistoricalFence.partialEvidence")(function* (
  database: Database.Interface,
  rootSessionID: string,
) {
  const signed = yield* evidence(database, rootSessionID)
  if (signed) return { membershipCoverage: "attested-partial" as const, evidenceHash: signed.evidence_hash }
  const pruned = yield* database.db.get<{ payload: string }>(sql`
    SELECT payload FROM historical_fence_prune WHERE root_session_id = ${rootSessionID}
  `)
  if (pruned)
    return {
      membershipCoverage: "observed-partial" as const,
      evidenceHash: createHash("sha256").update(pruned.payload).digest("hex"),
    }
})

// Called only after server-side signature verification, with the configured signer's fingerprint.
export const enroll = Effect.fn("HistoricalFence.enroll")(function* (
  database: Database.Interface,
  input: Attestation,
  signer: string,
  signature: string,
) {
  const payload = canonical(input)
  const hash = createHash("sha256").update(payload).digest("hex")
  return yield* database.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const stored = yield* tx.get<{
          evidence_hash: string
          payload: string
          signer: string
          signature: string
          time_created: number
        }>(sql`
      SELECT evidence_hash, payload, signer, signature, time_created FROM historical_fence_evidence WHERE root_session_id = ${input.rootSessionID}
    `)
        if (stored) {
          if (
            stored.evidence_hash !== hash ||
            stored.payload !== payload ||
            stored.signer !== signer ||
            stored.signature !== signature
          )
            return yield* new Rejected({ reason: "conflicting_replay" })
          return { evidenceHash: hash, recordedAt: stored.time_created }
        }
        const id = yield* tx.get<{ database_id: string }>(
          sql`SELECT database_id FROM historical_fence_identity WHERE singleton = 1`,
        )
        if (id?.database_id !== input.databaseID) return yield* new Rejected({ reason: "wrong_database" })
        const replay = yield* tx.get(
          sql`SELECT 1 FROM historical_fence_evidence WHERE signer = ${signer} AND nonce = ${input.nonce}`,
        )
        if (replay) return yield* new Rejected({ reason: "conflicting_replay" })
        for (const member of input.members) {
          const retired = yield* tx.get(sql`SELECT 1 FROM runtime_retirement WHERE session_id = ${member.sessionID}`)
          const existing = yield* tx.get<{
            project_id: string
            directory: string
            workspace_id: string | null
            parent_id: string | null
          }>(sql`
        SELECT project_id, directory, workspace_id, parent_id FROM session WHERE id = ${member.sessionID}
      `)
          const execution = yield* tx.get<{ parent_session_id: string | null }>(
            sql`SELECT parent_session_id FROM runtime_execution WHERE session_id = ${member.sessionID}`,
          )
          if (
            retired ||
            (existing &&
              (existing.project_id !== input.projectID ||
                existing.directory !== input.directory ||
                existing.workspace_id !== input.workspaceID ||
                existing.parent_id !== member.parentSessionID)) ||
            (execution && execution.parent_session_id !== member.parentSessionID)
          )
            return yield* new Rejected({ reason: "conflicting_membership" })
        }
        // Snapshot and fence observed descendants in this transaction, not in the
        // handler's subsequent best-effort local cancellation request.
        const observed = yield* tx.all<{
          session_id: string
          project_id: string | null
          directory: string | null
          workspace_id: string | null
          parent_id: string | null
          execution_directory: string | null
          parent_session_id: string | null
          retired_root: string | null
          command_roots: string
          membership_roots: string
        }>(sql`
          WITH RECURSIVE tree(session_id) AS (
            SELECT value FROM json_each(${JSON.stringify(input.members.map((member) => member.sessionID))})
            UNION SELECT session_id FROM runtime_retirement_member WHERE root_session_id = ${input.rootSessionID}
            UNION SELECT session_id FROM managed_command WHERE root_session_id = ${input.rootSessionID}
            UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.session_id
            UNION SELECT e.session_id FROM runtime_execution e JOIN tree t ON e.parent_session_id = t.session_id
          ) SELECT t.session_id, s.project_id, s.directory, s.workspace_id, s.parent_id,
            e.directory AS execution_directory, e.parent_session_id, r.root_session_id AS retired_root,
            (SELECT json_group_array(DISTINCT c.root_session_id) FROM managed_command c
              WHERE c.session_id = t.session_id) AS command_roots,
            (SELECT json_group_array(m.root_session_id) FROM runtime_retirement_member m
              WHERE m.session_id = t.session_id) AS membership_roots
          FROM tree t LEFT JOIN session s ON s.id = t.session_id
          LEFT JOIN runtime_execution e ON e.session_id = t.session_id
          LEFT JOIN runtime_retirement r ON r.session_id = t.session_id ORDER BY t.session_id
        `)
        const members = new Set(observed.map((row) => row.session_id))
        if (
          observed.some(
            (row) =>
              (row.project_id !== null &&
                (row.project_id !== input.projectID ||
                  row.directory !== input.directory ||
                  row.workspace_id !== input.workspaceID)) ||
              (row.execution_directory !== null && row.execution_directory !== input.directory) ||
              (row.retired_root !== null && row.retired_root !== input.rootSessionID) ||
              (row.command_roots !== "[]" && row.command_roots !== JSON.stringify([input.rootSessionID])) ||
              (row.membership_roots !== "[]" && row.membership_roots !== JSON.stringify([input.rootSessionID])) ||
              (row.parent_id !== null && !members.has(row.parent_id)) ||
              (row.parent_session_id !== null && !members.has(row.parent_session_id)) ||
              (row.parent_id !== null && row.parent_session_id !== null && row.parent_id !== row.parent_session_id),
          )
        )
          return yield* new Rejected({ reason: "conflicting_membership" })
        const now = Date.now()
        const observedPayload = JSON.stringify({
          version: 1,
          source: "database-during-enrollment",
          databaseID: input.databaseID,
          rootSessionID: input.rootSessionID,
          membershipCoverage: "observed-partial",
          members: observed.filter(
            (row) =>
              row.project_id !== null ||
              row.execution_directory !== null ||
              row.retired_root !== null ||
              row.command_roots !== "[]" ||
              row.membership_roots !== "[]",
          ),
        })
        yield* tx.run(sql`INSERT INTO historical_fence_evidence (root_session_id, evidence_hash, payload, observed_payload, signer, signature, issuer, nonce, time_created)
      VALUES (${input.rootSessionID}, ${hash}, ${payload}, ${observedPayload}, ${signer}, ${signature}, ${input.issuer}, ${input.nonce}, ${now})`)
        for (const sessionID of members) {
          yield* tx.run(
            sql`INSERT OR IGNORE INTO runtime_retirement_member (root_session_id, session_id) VALUES (${input.rootSessionID}, ${sessionID})`,
          )
          yield* tx.run(
            sql`INSERT OR IGNORE INTO runtime_retirement (session_id, root_session_id, time_created) VALUES (${sessionID}, ${input.rootSessionID}, ${now})`,
          )
          yield* tx.run(sql`UPDATE runtime_execution SET state = 'cancelled', desired_active = 0, fence = fence + 1, retry_at = NULL, time_updated = ${now}
        WHERE session_id = ${sessionID} AND (state <> 'cancelled' OR desired_active <> 0)`)
        }
        return { evidenceHash: hash, recordedAt: now }
      }),
    { behavior: "immediate" },
  )
})
