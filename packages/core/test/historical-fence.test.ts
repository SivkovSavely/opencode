import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { HistoricalFence } from "../src/historical-fence"
import { RuntimeRetirement } from "../src/runtime-retirement"
import { tmpdir } from "./fixture/tmpdir"

describe("historical admission fence", () => {
  for (const membership of [false, true]) {
    for (const fenced of [false, true]) {
      test(`raw pruning only exempts immutable shared membership with a permanent fence: membership=${membership}, fenced=${fenced}`, async () => {
        await Effect.runPromise(
          Effect.gen(function* () {
            const database = yield* Database.Service
            yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
            VALUES ('project', '/tmp', 0, 0, '[]')`)
            yield* database.db
              .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
            VALUES ('root', 'project', 'test', '/tmp', 'test', '1', 0, 0), ('other', 'project', 'test', '/tmp', 'test', '1', 0, 0)`)
            yield* database.db.run(sql`INSERT INTO managed_command (id, session_id, root_session_id,
            owner_instance, execution_generation, state, time_created, time_updated)
            VALUES ('first', 'shared', 'root', 'owner', 'generation', 'unknown', 0, 0),
              ('second', 'shared', 'other', 'owner', 'generation', 'unknown', 0, 0)`)
            if (membership)
              yield* database.db.run(sql`INSERT INTO runtime_retirement_member (root_session_id, session_id)
              VALUES ('root', 'shared'), ('other', 'shared')`)
            if (fenced)
              yield* database.db.run(sql`INSERT INTO runtime_retirement (session_id, root_session_id, time_created)
              VALUES ('shared', 'other', 0)`)
            const members = yield* database.db.all(sql`SELECT * FROM runtime_retirement_member`)
            const retired = yield* database.db.all(sql`SELECT * FROM runtime_retirement`)
            const deleted = yield* database.db.run(sql`DELETE FROM session WHERE id = 'root'`).pipe(Effect.exit)
            expect(Exit.isSuccess(deleted)).toBe(membership && fenced)
            if (!membership || !fenced) {
              expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = 'root'`)).toEqual({ id: "root" })
              expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement_member`)).toEqual(members)
              expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement`)).toEqual(retired)
              expect(yield* HistoricalFence.partialEvidence(database, "root")).toBeUndefined()
              return
            }
            expect(yield* RuntimeRetirement.lookup(database, "shared")).toEqual({ root_session_id: "other" })
            expect(
              yield* database.db.all(sql`SELECT * FROM runtime_retirement_member WHERE session_id = 'shared'`),
            ).toEqual(members)
            expect(yield* RuntimeRetirement.lookup(database, "other")).toBeUndefined()
            expect(yield* HistoricalFence.partialEvidence(database, "root")).toMatchObject({
              membershipCoverage: "observed-partial",
            })
          }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
        )
      })
    }
  }

  test("upgrades a database without historical evidence or identity tables", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(sql`DROP TRIGGER historical_fence_before_root_prune`)
        yield* database.db.run(sql`DROP TRIGGER historical_fence_before_child_prune`)
        for (const table of ["historical_fence_identity", "historical_fence_evidence", "historical_fence_prune"])
          yield* database.db.run(sql`DROP TABLE ${sql.identifier(table)}`)
        yield* database.db.run(sql`DELETE FROM migration WHERE id = '20261101090000_historical_admission_fence'`)
        yield* DatabaseMigration.apply(database.db)
        expect(yield* HistoricalFence.identity(database)).toMatch(/^[a-f0-9]{64}$/)
        expect(yield* database.db.all(sql`SELECT * FROM historical_fence_evidence`)).toEqual([])
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  })

  test("root pruning fences observed identities before execution cascades and retains partial provenance", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/tmp', 0, 0, '[]')`,
        )
        yield* database.db
          .run(sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('root', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0), ('child', 'project', 'root', 'test', '/tmp', 'test', '1', 0, 0)`)
        yield* database.db.run(sql`DELETE FROM session WHERE id = 'root'`)
        expect(yield* RuntimeRetirement.retireRoot(database, "root")).toEqual({
          rootSessionID: "root",
          sessionIDs: ["child", "root"],
        })
        const evidence = yield* database.db.get<{ payload: string }>(
          sql`SELECT payload FROM historical_fence_prune WHERE root_session_id = 'root'`,
        )
        expect(evidence?.payload).toContain('"membershipCoverage":"observed-partial"')
        expect(evidence?.payload).toContain('"sessionIDs":["child","root"]')
        expect(yield* database.db.all(sql`SELECT * FROM historical_fence_evidence`)).toEqual([])
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  })

  test("independent child deletion retains ancestry without retiring the live root or siblings", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "pruned.sqlite")
    const proof = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/tmp', 0, 0, '[]')`,
        )
        yield* database.db
          .run(sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('root', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0),
          ('child', 'project', 'root', 'test', '/tmp', 'test', '1', 0, 0),
           ('grandchild', 'project', 'child', 'test', '/tmp', 'test', '1', 0, 0),
           ('sibling', 'project', 'root', 'test', '/tmp', 'test', '1', 0, 0)`)
        yield* database.db.run(sql`INSERT INTO managed_command (id, session_id, root_session_id,
          owner_instance, execution_generation, state, time_created, time_updated)
          VALUES ('command', 'grandchild', 'root', 'owner', 'generation', 'unknown', 0, 0)`)
        yield* database.db.run(sql`DELETE FROM session WHERE id = 'grandchild'`)
        yield* database.db.run(sql`DELETE FROM session WHERE id = 'child'`)
        expect(yield* RuntimeRetirement.lookup(database, "root")).toBeUndefined()
        expect(yield* RuntimeRetirement.lookup(database, "sibling")).toBeUndefined()
        expect(yield* RuntimeRetirement.lookup(database, "grandchild")).toEqual({ root_session_id: "root" })
        expect(yield* HistoricalFence.partialEvidence(database, "root")).toBeUndefined()
        yield* database.db.run(sql`DELETE FROM session WHERE id = 'root'`)
        expect((yield* RuntimeRetirement.retireRoot(database, "root")).sessionIDs).toEqual([
          "child",
          "grandchild",
          "root",
          "sibling",
        ])
        return yield* HistoricalFence.partialEvidence(database, "root")
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        expect(yield* HistoricalFence.partialEvidence(database, "root")).toEqual(proof)
        expect((yield* RuntimeRetirement.retireRoot(database, "root")).sessionIDs).toEqual([
          "child",
          "grandchild",
          "root",
          "sibling",
        ])
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("raw execution-only child pruning preserves ancestry, subtree fences, and proof across reopen", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "execution-child.sqlite")
    const proof = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
          VALUES ('project', '/tmp', 0, 0, '[]')`)
        yield* database.db
          .run(sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('root', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0),
            ('child', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0),
            ('leaf', 'project', 'child', 'test', '/tmp', 'test', '1', 0, 0),
            ('unrelated', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0)`)
        yield* database.db.run(sql`INSERT INTO runtime_execution (id, session_id, parent_session_id, directory,
          owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
          VALUES ('execution', 'child', 'root', '/tmp', 'owner', 'owner', 0, 'active', 1, 0, 0)`)
        yield* database.db.run(sql`DELETE FROM session WHERE id = 'child'`)
        expect(yield* database.db.get(sql`SELECT 1 FROM runtime_execution WHERE session_id = 'child'`)).toBeUndefined()
        expect(yield* RuntimeRetirement.lookup(database, "root")).toBeUndefined()
        expect(yield* RuntimeRetirement.lookup(database, "unrelated")).toBeUndefined()
        expect(yield* HistoricalFence.partialEvidence(database, "child")).toBeUndefined()
        expect(yield* HistoricalFence.partialEvidence(database, "root")).toBeUndefined()
        for (const sessionID of ["child", "leaf"]) {
          expect(yield* RuntimeRetirement.lookup(database, sessionID)).toEqual({ root_session_id: "root" })
        }
        expect(
          Exit.isFailure(
            yield* database.db
              .run(
                sql`INSERT INTO session
          (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('child', 'project', 'test', '/tmp', 'test', '1', 0, 0)`,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* RuntimeRetirement.retireRoot(database, "root")).sessionIDs).toEqual(["child", "leaf", "root"])
        yield* database.db.run(sql`DELETE FROM session WHERE id IN ('root', 'leaf')`)
        return yield* HistoricalFence.partialEvidence(database, "root")
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        expect(yield* HistoricalFence.partialEvidence(database, "root")).toEqual(proof)
        expect(proof).toMatchObject({ membershipCoverage: "observed-partial" })
        expect((yield* RuntimeRetirement.retireRoot(database, "root")).sessionIDs).toEqual(["child", "leaf", "root"])
        expect(yield* RuntimeRetirement.retireRoot(database, "child").pipe(Effect.flip)).toMatchObject({
          reason: "not_root",
        })
        expect(
          Exit.isFailure(
            yield* database.db
              .run(
                sql`INSERT INTO session
        (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('child', 'project', 'test', '/tmp', 'test', '1', 0, 0)`,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  for (const mode of ["valid", "conflicting-command", "reparented-projection", "reparented-execution"] as const) {
    test(`raw root pruning validates and fences command-only identities across reopen: ${mode}`, async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "raw-command-root.sqlite")
      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
            VALUES ('project', '/tmp', 0, 0, '[]')`)
          yield* database.db.run(sql`INSERT INTO session
            (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
            VALUES ('root', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0),
              ('other', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0)`)
          // No projection or execution survives for this command's original session.
          yield* database.db.run(sql`INSERT INTO managed_command (id, session_id, root_session_id,
            owner_instance, execution_generation, state, time_created, time_updated)
            VALUES ('command', 'command-only', 'root', 'owner', 'generation', 'unknown', 0, 0)`)
          if (mode === "conflicting-command")
            yield* database.db.run(sql`INSERT INTO managed_command (id, session_id, root_session_id,
              owner_instance, execution_generation, state, time_created, time_updated)
              VALUES ('conflict', 'command-only', 'other', 'owner', 'generation', 'unknown', 0, 0)`)
          if (mode === "reparented-projection" || mode === "reparented-execution")
            yield* database.db.run(sql`INSERT INTO session
              (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
              VALUES ('command-only', 'project', ${mode === "reparented-projection" ? "other" : null}, 'test', '/tmp', 'test', '1', 0, 0)`)
          if (mode === "reparented-execution")
            yield* database.db.run(sql`INSERT INTO runtime_execution (id, session_id, parent_session_id, directory,
              owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
              VALUES ('execution', 'command-only', 'other', '/tmp', 'owner', 'owner', 0, 'active', 1, 0, 0)`)
          const deleted = yield* database.db.run(sql`DELETE FROM session WHERE id = 'root'`).pipe(Effect.exit)
          expect(Exit.isSuccess(deleted)).toBe(mode === "valid")
          if (mode !== "valid") {
            expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = 'root'`)).toEqual({ id: "root" })
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement_member`)).toEqual([])
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement`)).toEqual([])
            expect(yield* database.db.all(sql`SELECT * FROM historical_fence_prune`)).toEqual([])
            return
          }
          // No explicit retireRoot is allowed to repair a missing raw-delete fence.
          expect(yield* RuntimeRetirement.lookup(database, "command-only")).toEqual({ root_session_id: "root" })
          const proof = yield* HistoricalFence.partialEvidence(database, "root")
          expect(proof).toMatchObject({ membershipCoverage: "observed-partial" })
          expect(
            yield* database.db.get<{ payload: string }>(sql`SELECT payload FROM historical_fence_prune
            WHERE root_session_id = 'root'`),
          ).toMatchObject({ payload: expect.stringContaining('"sessionIDs":["command-only","root"]') })
          expect(yield* database.db.all(sql`SELECT * FROM historical_fence_evidence`)).toEqual([])
          return proof
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          if (mode !== "valid") {
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement_member`)).toEqual([])
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement`)).toEqual([])
            expect(yield* HistoricalFence.partialEvidence(database, "root")).toBeUndefined()
            return
          }
          expect(yield* HistoricalFence.partialEvidence(database, "root")).toEqual(first)
          expect(yield* RuntimeRetirement.lookup(database, "command-only")).toEqual({ root_session_id: "root" })
          expect(yield* RuntimeRetirement.lookup(database, "other")).toBeUndefined()
          expect(
            Exit.isFailure(
              yield* database.db
                .run(
                  sql`INSERT INTO session
            (id, project_id, slug, directory, title, version, time_created, time_updated)
            VALUES ('command-only', 'project', 'test', '/tmp', 'test', '1', 0, 0)`,
                )
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(
            yield* database.db.get(sql`INSERT INTO runtime_execution
            (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
            VALUES ('late', 'command-only', '/tmp', 'new', 'new', 0, 'active', 1, 0, 0) RETURNING session_id`),
          ).toBeUndefined()
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )
    })
  }

  for (const owner of ["child", "ancestor", "descendant"] as const) {
    for (const target of ["child", "other"] as const) {
      test(`raw ${target} pruning rejects reparented ${owner} command ownership across reopen`, async () => {
        await using tmp = await tmpdir()
        const filename = path.join(tmp.path, "raw-command-conflict.sqlite")
        await Effect.runPromise(
          Effect.gen(function* () {
            const database = yield* Database.Service
            yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
              VALUES ('project', '/tmp', 0, 0, '[]')`)
            yield* database.db.run(sql`INSERT INTO session
              (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
              VALUES ('root', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0),
                ('other', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0),
                ('ancestor', 'project', 'root', 'test', '/tmp', 'test', '1', 0, 0),
                ('child', 'project', 'ancestor', 'test', '/tmp', 'test', '1', 0, 0),
                ('descendant', 'project', 'child', 'test', '/tmp', 'test', '1', 0, 0)`)
            yield* database.db.run(sql`INSERT INTO managed_command (id, session_id, root_session_id,
              owner_instance, execution_generation, state, time_created, time_updated)
              VALUES ('command', ${owner}, 'root', 'owner', 'generation', 'unknown', 0, 0)`)
            yield* database.db.run(sql`UPDATE session SET parent_id = 'other' WHERE id = 'ancestor'`)
            expect(
              Exit.isFailure(yield* database.db.run(sql`DELETE FROM session WHERE id = ${target}`).pipe(Effect.exit)),
            ).toBe(true)
            expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = ${target}`)).toEqual({ id: target })
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement_member`)).toEqual([])
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement`)).toEqual([])
            expect(yield* database.db.all(sql`SELECT * FROM historical_fence_prune`)).toEqual([])
          }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
        )
        await Effect.runPromise(
          Effect.gen(function* () {
            const database = yield* Database.Service
            expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = ${target}`)).toEqual({ id: target })
            expect(yield* RuntimeRetirement.lookup(database, owner)).toBeUndefined()
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement_member`)).toEqual([])
            expect(yield* HistoricalFence.partialEvidence(database, "other")).toBeUndefined()
            expect(
              Exit.isFailure(yield* database.db.run(sql`DELETE FROM session WHERE id = ${target}`).pipe(Effect.exit)),
            ).toBe(true)
          }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
        )
      })
    }
  }

  for (const conflict of ["direct", "ancestor", "descendant-child", "descendant-root"] as const) {
    test(`raw child deletion fails closed for conflicting ${conflict} projected/runtime parents`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
          VALUES ('project', '/tmp', 0, 0, '[]')`)
          yield* database.db
            .run(sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('root', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0),
            ('other', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0),
            ('middle', 'project', 'other', 'test', '/tmp', 'test', '1', 0, 0),
            ('child', 'project', ${conflict === "direct" ? "other" : "middle"}, 'test', '/tmp', 'test', '1', 0, 0),
            ('leaf', 'project', 'child', 'test', '/tmp', 'test', '1', 0, 0)`)
          const executionID = conflict === "direct" ? "child" : conflict === "ancestor" ? "middle" : "leaf"
          yield* database.db.run(sql`INSERT INTO runtime_execution (id, session_id, parent_session_id, directory,
          owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
          VALUES ('execution', ${executionID}, 'root', '/tmp', 'owner', 'owner', 0, 'active', 1, 0, 0)`)
          expect(
            Exit.isFailure(
              yield* database.db
                .run(sql`DELETE FROM session WHERE id = ${conflict === "descendant-root" ? "other" : "child"}`)
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(yield* database.db.get(sql`SELECT id FROM session WHERE id = 'child'`)).toEqual({ id: "child" })
          expect(
            yield* database.db.get(sql`SELECT session_id FROM runtime_execution WHERE session_id = ${executionID}`),
          ).toEqual({ session_id: executionID })
          expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement`)).toEqual([])
          expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement_member`)).toEqual([])
          expect(yield* database.db.all(sql`SELECT * FROM historical_fence_prune`)).toEqual([])
        }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
      )
    })
  }

  for (const mode of [
    "valid",
    "foreign-project",
    "foreign-directory",
    "foreign-execution-directory",
    "conflicting-parent",
  ] as const) {
    test(`root-only enrollment atomically handles observed descendants: ${mode}`, async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "observed-enrollment.sqlite")
      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
          VALUES ('project', '/tmp', 0, 0, '[]'), ('foreign', '/tmp', 0, 0, '[]')`)
          yield* database.db
            .run(sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('root', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0),
            ('child', ${mode === "foreign-project" ? "foreign" : "project"}, 'root', 'test', ${mode === "foreign-directory" ? "/foreign" : "/tmp"}, 'test', '1', 0, 0),
            ('grandchild', 'project', 'child', 'test', '/tmp', 'test', '1', 0, 0),
            ('other', 'project', NULL, 'test', '/tmp', 'test', '1', 0, 0)`)
          yield* database.db.run(sql`INSERT INTO runtime_execution (id, session_id, parent_session_id, directory,
          owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
          VALUES ('execution', 'grandchild', ${mode === "conflicting-parent" ? "other" : "child"}, ${mode === "foreign-execution-directory" ? "/foreign" : "/tmp"}, 'owner', 'owner', 7, 'parked', 1, 0, 0)`)
          const input: HistoricalFence.Attestation = {
            version: 1,
            databaseID: yield* HistoricalFence.identity(database),
            projectID: "project",
            directory: "/tmp",
            workspaceID: null,
            rootSessionID: "root",
            members: [{ sessionID: "root", parentSessionID: null, role: "root" }],
            membershipCoverage: "attested-partial",
            artifact: { reference: "archive:root", sha256: "a".repeat(64) },
            issuer: "operator",
            issuedAt: 1,
            nonce: "nonce",
          }
          if (mode !== "valid") {
            expect(
              yield* HistoricalFence.enroll(database, input, "signer", "signature").pipe(Effect.flip),
            ).toMatchObject({ reason: "conflicting_membership" })
            expect(yield* database.db.all(sql`SELECT * FROM historical_fence_evidence`)).toEqual([])
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement`)).toEqual([])
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement_member`)).toEqual([])
            expect(
              yield* database.db.get(
                sql`SELECT desired_active, fence FROM runtime_execution WHERE session_id = 'grandchild'`,
              ),
            ).toEqual({ desired_active: 1, fence: 7 })
            return
          }
          const proof = yield* HistoricalFence.enroll(database, input, "signer", "signature")
          // Deliberately do not call retireRoot: this is the handler interruption boundary.
          for (const sessionID of ["root", "child", "grandchild"])
            expect(yield* RuntimeRetirement.lookup(database, sessionID)).toEqual({ root_session_id: "root" })
          expect(yield* RuntimeRetirement.lookup(database, "other")).toBeUndefined()
          expect(
            yield* database.db.get(
              sql`SELECT state, desired_active, fence FROM runtime_execution WHERE session_id = 'grandchild'`,
            ),
          ).toEqual({ state: "cancelled", desired_active: 0, fence: 8 })
          const evidence = yield* database.db.get<{ payload: string; observed_payload: string }>(
            sql`SELECT payload, observed_payload FROM historical_fence_evidence WHERE root_session_id = 'root'`,
          )
          expect(evidence?.payload).toBe(HistoricalFence.canonical(input))
          expect(evidence?.observed_payload).toContain('"session_id":"grandchild"')
          expect(evidence?.observed_payload).toContain('"membershipCoverage":"observed-partial"')
          expect(
            Exit.isFailure(
              yield* database.db
                .run(sql`UPDATE historical_fence_evidence SET observed_payload = '{}' WHERE root_session_id = 'root'`)
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(yield* HistoricalFence.enroll(database, input, "signer", "signature")).toEqual(proof)
          return { input, proof, evidence }
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )
      if (!first) return
      await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          expect(yield* HistoricalFence.enroll(database, first.input, "signer", "signature")).toEqual(first.proof)
          expect(
            yield* database.db.get(
              sql`SELECT payload, observed_payload FROM historical_fence_evidence WHERE root_session_id = 'root'`,
            ),
          ).toEqual(first.evidence)
          expect((yield* RuntimeRetirement.retireRoot(database, "root")).sessionIDs).toEqual([
            "child",
            "grandchild",
            "root",
          ])
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )
    })
  }

  for (const conflict of [false, true]) {
    test(`enrollment atomically handles command-only durable descendants, conflicting root: ${conflict}`, async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "command-only.sqlite")
      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          // Command ownership deliberately outlives old projection/execution rows.
          yield* database.db.run(sql`INSERT INTO managed_command (id, session_id, root_session_id,
            owner_instance, execution_generation, state, time_created, time_updated)
            VALUES ('command', 'command-only', 'root', 'owner', 'generation', 'unknown', 0, 0)`)
          if (conflict)
            yield* database.db.run(sql`INSERT INTO managed_command (id, session_id, root_session_id,
              owner_instance, execution_generation, state, time_created, time_updated)
              VALUES ('foreign-command', 'command-only', 'other', 'owner', 'generation', 'unknown', 0, 0)`)
          const input: HistoricalFence.Attestation = {
            version: 1,
            databaseID: yield* HistoricalFence.identity(database),
            projectID: "project",
            directory: "/tmp",
            workspaceID: null,
            rootSessionID: "root",
            members: [{ sessionID: "root", parentSessionID: null, role: "root" }],
            membershipCoverage: "attested-partial",
            artifact: { reference: "archive:root", sha256: "a".repeat(64) },
            issuer: "operator",
            issuedAt: 1,
            nonce: "nonce",
          }
          if (conflict) {
            expect(
              yield* HistoricalFence.enroll(database, input, "signer", "signature").pipe(Effect.flip),
            ).toMatchObject({ reason: "conflicting_membership" })
            expect(yield* database.db.all(sql`SELECT * FROM historical_fence_evidence`)).toEqual([])
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement`)).toEqual([])
            expect(yield* database.db.all(sql`SELECT * FROM runtime_retirement_member`)).toEqual([])
            return
          }
          const proof = yield* HistoricalFence.enroll(database, input, "signer", "signature")
          // No subsequent retireRoot call may be required to install this fence.
          expect(yield* RuntimeRetirement.lookup(database, "command-only")).toEqual({ root_session_id: "root" })
          const evidence = yield* database.db.get<{ payload: string; observed_payload: string }>(
            sql`SELECT payload, observed_payload FROM historical_fence_evidence WHERE root_session_id = 'root'`,
          )
          expect(evidence?.payload).toBe(HistoricalFence.canonical(input))
          expect(evidence?.observed_payload).toContain('"session_id":"command-only"')
          expect(evidence?.observed_payload).toContain('"command_roots":"[\\"root\\"]"')
          return { input, proof, evidence }
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )
      if (!first) return
      await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          expect(yield* HistoricalFence.enroll(database, first.input, "signer", "signature")).toEqual(first.proof)
          expect(
            yield* database.db.get(
              sql`SELECT payload, observed_payload FROM historical_fence_evidence WHERE root_session_id = 'root'`,
            ),
          ).toEqual(first.evidence)
          expect(yield* RuntimeRetirement.lookup(database, "command-only")).toEqual({ root_session_id: "root" })
          yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
            VALUES ('project', '/tmp', 0, 0, '[]')`)
          expect(
            Exit.isFailure(
              yield* database.db
                .run(
                  sql`INSERT INTO session (id, project_id, slug, directory,
            title, version, time_created, time_updated) VALUES ('command-only', 'project', 'test', '/tmp', 'test', '1', 0, 0)`,
                )
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(
            yield* database.db.get(sql`INSERT INTO runtime_execution (id, session_id, directory,
            owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
            VALUES ('late-command', 'command-only', '/tmp', 'new', 'new', 0, 'active', 1, 0, 0) RETURNING session_id`),
          ).toBeUndefined()
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )
    })
  }

  test("persists exact evidence across pruning and reopen, rejects conflicting replay, never recreates projections", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "fence.sqlite")
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        expect(yield* RuntimeRetirement.retireRoot(database, "root").pipe(Effect.flip)).toMatchObject({
          reason: "not_found",
        })
        const input: HistoricalFence.Attestation = {
          version: 1,
          databaseID: yield* HistoricalFence.identity(database),
          projectID: "project",
          directory: "/tmp",
          workspaceID: null,
          rootSessionID: "root",
          members: [
            { sessionID: "child", parentSessionID: "root", role: "descendant" },
            { sessionID: "root", parentSessionID: null, role: "root" },
          ],
          membershipCoverage: "attested-partial",
          artifact: { reference: "archive:receipt", sha256: "a".repeat(64) },
          issuer: "operator",
          issuedAt: 1,
          nonce: "nonce",
        }
        const proof = yield* HistoricalFence.enroll(database, input, "trusted-fingerprint", "verified-signature")
        expect(yield* HistoricalFence.enroll(database, input, "trusted-fingerprint", "verified-signature")).toEqual(
          proof,
        )
        expect(yield* database.db.all(sql`SELECT id FROM session`)).toEqual([])
        yield* database.db.run(sql`DELETE FROM session`)
        return { input, proof }
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        expect(yield* HistoricalFence.identity(database)).toBe(first.input.databaseID)
        expect(
          yield* HistoricalFence.enroll(database, first.input, "trusted-fingerprint", "verified-signature"),
        ).toEqual(first.proof)
        expect(yield* RuntimeRetirement.retireRoot(database, "root")).toEqual({
          rootSessionID: "root",
          sessionIDs: ["child", "root"],
        })
        expect(
          yield* HistoricalFence.enroll(
            database,
            { ...first.input, nonce: "changed" },
            "trusted-fingerprint",
            "signature",
          ).pipe(Effect.flip),
        ).toMatchObject({ reason: "conflicting_replay" })
        expect(
          yield* HistoricalFence.enroll(
            database,
            { ...first.input, rootSessionID: "other", databaseID: "other" },
            "trusted-fingerprint",
            "signature",
          ).pipe(Effect.flip),
        ).toMatchObject({ reason: "wrong_database" })
        yield* database.db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/tmp', 0, 0, '[]')`,
        )
        for (const id of ["root", "child"]) {
          expect(
            Exit.isFailure(
              yield* database.db
                .run(
                  sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES (${id}, 'project', 'test', '/tmp', 'test', '1', 0, 0)`,
                )
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(
            yield* database.db
              .get(sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance,
          fence, state, desired_active, time_created, time_updated) VALUES (${id}, ${id}, '/tmp', 'new', 'new', 0, 'active', 1, 0, 0) RETURNING session_id`),
          ).toBeUndefined()
        }
        for (const table of ["historical_fence_evidence", "historical_fence_identity"]) {
          expect(
            Exit.isFailure(yield* database.db.run(sql`DELETE FROM ${sql.identifier(table)}`).pipe(Effect.exit)),
          ).toBe(true)
        }
        expect(yield* RuntimeRetirement.retireRoot(database, "unproven").pipe(Effect.flip)).toMatchObject({
          reason: "not_found",
        })
        expect(yield* RuntimeRetirement.lookup(database, "unproven")).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  })

  test("conflicting projected ownership rolls back all evidence and tombstones", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('foreign', '/tmp', 0, 0, '[]')`,
        )
        yield* database.db
          .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('root', 'foreign', 'test', '/tmp', 'test', '1', 0, 0)`)
        const input: HistoricalFence.Attestation = {
          version: 1,
          databaseID: yield* HistoricalFence.identity(database),
          projectID: "project",
          directory: "/tmp",
          workspaceID: null,
          rootSessionID: "root",
          members: [{ sessionID: "root", parentSessionID: null, role: "root" }],
          membershipCoverage: "attested-partial",
          artifact: { reference: "archive", sha256: "a".repeat(64) },
          issuer: "operator",
          issuedAt: 1,
          nonce: "nonce",
        }
        expect(yield* HistoricalFence.enroll(database, input, "signer", "signature").pipe(Effect.flip)).toMatchObject({
          reason: "conflicting_membership",
        })
        expect(yield* database.db.all(sql`SELECT * FROM historical_fence_evidence`)).toEqual([])
        expect(yield* RuntimeRetirement.lookup(database, "root")).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  })
})
