import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { layer } from "../src/database/sqlite.bun"
import { SessionHandoffEnrollment } from "../src/session/handoff-enrollment"
import { SessionHandoffStore } from "../src/session/handoff-store"
import { SessionHandoffRecovery } from "../src/session/handoff-recovery"
import { tmpdir } from "./fixture/tmpdir"

const selection = { providerID: "synthetic", modelID: "sol", variant: "max" }
const user = { role: "user", agent: "build", model: selection, time: { created: 1 } }
const payload = { kind: "prompt", agent: "build", model: selection, variant: "max", parts: [] }
const owner = { ownerLineage: "lineage", ownerInstance: "instance", fence: 1 }

function run<A, E>(
  filename: string,
  body: (db: Effect.Success<ReturnType<typeof EffectDrizzleSqlite.makeWithDefaults>>) => Effect.Effect<A, E>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      return yield* body(db)
    }).pipe(Effect.provide(layer({ filename })), Effect.scoped),
  )
}

const seed = Effect.fnUntraced(function* (db: SessionHandoffStore.Connection["db"], directory: string) {
  yield* db.run(
    sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', ${directory}, 1, 1, '[]')`,
  )
  yield* db.run(
    sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'project', 'session', ${directory}, 'test', '1', 1, 1)`,
  )
  yield* db.run(
    sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated) VALUES ('session', 'session', ${directory}, 'lineage', 'instance', 1, 'active', 1, 1, 1)`,
  )
  yield* SessionHandoffEnrollment.reserve({ db }, "session", "reservation")
  yield* db.run(
    sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('user', 'session', 1, 1, ${JSON.stringify(user)})`,
  )
  yield* db.run(
    sql`INSERT INTO session_queue (id, session_id, delivery, state, position, payload, submission, message_id, time_created) VALUES ('queue', 'session', 'queue', 'delivered', 1, ${JSON.stringify(payload)}, ${JSON.stringify({ delivery: "queue", front: false, payload })}, 'user', 1)`,
  )
  yield* SessionHandoffEnrollment.delivered({ db }, "session", "reservation", "queue", "user")
})

test("an unclaimed startup hold denies a new empty Task descendant even with fabricated local bindings", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/startup.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated)
      VALUES ('empty-child','project','session','child',${tmp.path},'new task','1',2,2)`)
      yield* db.run(sql`INSERT INTO session_handoff_recovery_hold (root_session_id,reservation,session_id)
      VALUES ('session','reservation','session')`)
      expect(yield* SessionHandoffRecovery.held({ db }, "empty-child")).toBe(true)
      expect(yield* Effect.flip(SessionHandoffEnrollment.reserve({ db }, "empty-child", "new"))).toMatchObject({
        code: "invalidated",
      })
      expect(
        yield* SessionHandoffEnrollment.newTaskAllowed({ db }, "empty-child").pipe(
          Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, {
            sessionID: "session",
            reservation: "reservation",
            ...owner,
            controlData: "{}",
          }),
          Effect.provideService(SessionHandoffRecovery.CurrentNewTask, {
            sessionID: "empty-child",
            parentMessageID: "assistant",
            parentCallID: "call",
            parentFence: owner.fence,
          }),
        ),
      ).toBe(false)
      expect(yield* db.get(sql`SELECT count(*) AS count FROM message WHERE session_id='empty-child'`)).toEqual({
        count: 0,
      })
      expect(
        yield* db.get(sql`SELECT count(*) AS count FROM runtime_execution WHERE session_id='empty-child'`),
      ).toEqual({ count: 0 })
      expect(yield* db.get(sql`SELECT count(*) AS count FROM session_handoff_recovery_hold`)).toEqual({ count: 1 })
    }),
  )
})

test("an older in-flight preparation blocks enrollment of a later delivered queue root", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/enroll.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "preparing-A")
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "queue-B")
      yield* SessionHandoffEnrollment.delivered({ db }, "session", "queue-B", "queue", "user")
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
    }),
  )
})

test("pristine failure restores eligibility but dirty failure never reopens a root or overwrites a newer reservation", async () => {
  for (const dirty of [false, true]) {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/enroll.db`, (db) =>
      Effect.gen(function* () {
        yield* seed(db, tmp.path)
        yield* SessionHandoffEnrollment.reserve({ db }, "session", "A")
        if (dirty) yield* SessionHandoffEnrollment.preparing({ db }, "session", "A")
        yield* SessionHandoffEnrollment.reserve({ db }, "session", "B")
        yield* SessionHandoffEnrollment.delivered({ db }, "session", "B", "queue", "user")
        yield* SessionHandoffEnrollment.abort({ db }, "session", "A")
        const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)
        if (dirty) expect(candidate).toBeNull()
        if (!dirty) expect(candidate).toMatchObject({ queueID: "queue" })
        yield* SessionHandoffEnrollment.reserve({ db }, "session", "C")
        yield* SessionHandoffEnrollment.abort({ db }, "session", "A")
        expect(yield* db.get(sql`SELECT state FROM session_handoff_root WHERE reservation = 'C'`)).toEqual({
          state: "reserved",
        })
      }),
    )
  }
})

test("provider-owned, orphaned, and rejected tools are not evidence of executable local continuation", async () => {
  for (const evidence of [
    { metadata: { providerExecuted: true }, state: { status: "completed" } },
    { state: { status: "error", metadata: { interrupted: true } } },
    { state: { status: "error", error: "permission rejected" } },
  ]) {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/enroll.db`, (db) =>
      Effect.gen(function* () {
        yield* seed(db, tmp.path)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'session', 2, 2, ${JSON.stringify({ role: "assistant", parentID: "user", providerID: "synthetic", modelID: "sol", variant: "max", time: { created: 2, completed: 3 }, finish: "stop" })})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('tool', 'assistant', 'session', 2, 2, ${JSON.stringify({ type: "tool", tool: "read", ...evidence })})`,
        )
        expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
      }),
    )
  }
})

test("discovery is read-only; enrollment persists exact baseline and retries before lifecycle guards", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/enroll.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      const before = yield* db.all(sql`SELECT * FROM session_handoff_action`)
      const roots = yield* db.all(sql`SELECT * FROM session_handoff_root`)
      const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)
      expect(candidate).toMatchObject({ queueID: "queue", userMessageID: "user", ...owner })
      expect(yield* db.all(sql`SELECT * FROM session_handoff_action`)).toEqual(before)
      expect(yield* db.all(sql`SELECT * FROM session_handoff_root`)).toEqual(roots)
      expect(yield* db.all(sql`SELECT * FROM session_handoff_action`)).toEqual([])
      if (!candidate) throw new Error("Missing candidate")
      const request = { requestID: "request", ...candidate }
      const receipt = yield* SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, request)
      expect(receipt).toMatchObject({ kind: "enrollment", state: "enrolled", identity: { revision: 0, ...owner } })
      yield* SessionHandoffEnrollment.close({ db }, "session", "terminal")
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
      expect(yield* SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, request)).toEqual(receipt)
      expect(
        yield* Effect.flip(
          SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, { ...request, fence: 2 }),
        ),
      ).toMatchObject({ code: "request_id_conflict" })
      expect(
        (yield* SessionHandoffStore.lookup({ db }, { sessionID: "session", queueID: "queue", userMessageID: "user" }))
          ?.action.baselineSelection,
      ).toEqual(selection)
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "later-input")
      expect(
        yield* db.all(
          sql`SELECT reservation, state, enrolled_request_id FROM session_handoff_root ORDER BY reservation`,
        ),
      ).toEqual([
        { reservation: "later-input", state: "reserved", enrolled_request_id: null },
        { reservation: "reservation", state: "terminal", enrolled_request_id: "request" },
      ])
    }),
  )
})

test("a queue payload changed from its immutable submission is not enrollable", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/enroll.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "changed-queue")
      yield* db.run(
        sql`UPDATE session_queue SET payload = ${JSON.stringify({ ...payload, agent: "changed" })} WHERE id = 'queue'`,
      )
      yield* SessionHandoffEnrollment.delivered({ db }, "session", "changed-queue", "queue", "user")
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
    }),
  )
})

test("unprovable source user history fails closed as a candidate rather than leaking a decoder failure", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/enroll.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "invalid-user")
      yield* db.run(sql`UPDATE message SET data = '{"role":"user"}' WHERE id = 'user'`)
      yield* SessionHandoffEnrollment.delivered({ db }, "session", "invalid-user", "queue", "user")
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
    }),
  )
})

test("stale history and competing reservations cannot enroll or resurrect the old delivery", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/enroll.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)
      if (!candidate) throw new Error("Missing candidate")
      yield* db.run(
        sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part', 'user', 'session', 1, 1, '{"type":"text","text":"changed"}')`,
      )
      expect(
        yield* Effect.flip(
          SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, { requestID: "stale", ...candidate }),
        ),
      ).toMatchObject({ code: "stale_context" })
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "competing")
      yield* SessionHandoffEnrollment.delivered({ db }, "session", "reservation", "queue", "user")
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
      expect(yield* db.all(sql`SELECT * FROM session_handoff_action`)).toEqual([])
    }),
  )
})

test("baseline membership includes an in-flight assistant even with tied timestamps and reverse-sorting IDs", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/enroll.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'session', 1, 1, ${JSON.stringify({ role: "assistant", parentID: "user", providerID: "synthetic", modelID: "sol", variant: "max", time: { created: 1 } })})`,
      )
      const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)
      if (!candidate) throw new Error("Missing candidate")
      yield* SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, {
        requestID: "baseline",
        ...candidate,
      })
      const history = yield* SessionHandoffStore.lookup(
        { db },
        { sessionID: "session", queueID: "queue", userMessageID: "user" },
      )
      expect(history?.assistants).toMatchObject([
        { messageID: "assistant", epochSequence: 0, selectionEvidence: "persisted_message", dispatch: "unknown" },
      ])
    }),
  )
})

test("permission mutation and runtime owner replacement permanently close the reservation", async () => {
  for (const change of [
    sql`UPDATE session SET permission = '[]' WHERE id = 'session'`,
    sql`UPDATE runtime_execution SET fence = 2 WHERE session_id = 'session'`,
  ]) {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/enroll.db`, (db) =>
      Effect.gen(function* () {
        yield* seed(db, tmp.path)
        yield* db.run(change)
        expect(yield* db.get(sql`SELECT state FROM session_handoff_root WHERE session_id = 'session'`)).toEqual({
          state: "invalidated",
        })
        expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
      }),
    )
  }
})

test("persisted terminal evidence closes the enrollment gap before the runner terminalizes", async () => {
  for (const final of [{ finish: "tool-calls", structured: { answer: "done" } }, { finish: "stop" }]) {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/enroll.db`, (db) =>
      Effect.gen(function* () {
        yield* seed(db, tmp.path)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'session', 2, 2, ${JSON.stringify({ role: "assistant", parentID: "user", providerID: "synthetic", modelID: "sol", variant: "max", time: { created: 2, completed: 3 }, ...final })})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('tool', 'assistant', 'session', 2, 2, '{"type":"tool","tool":"StructuredOutput","metadata":{"providerExecuted":true}}')`,
        )
        expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
        expect(yield* db.all(sql`SELECT * FROM session_handoff_action`)).toEqual([])
      }),
    )
  }
})

test("exact enrollment receipt survives reopening and deletion of the live session", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/enroll.db`
  const saved = await run(filename, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)
      if (!candidate) throw new Error("Missing candidate")
      const request = { requestID: "reopened", ...candidate }
      const receipt = yield* SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, request)
      yield* db.run(sql`DELETE FROM session WHERE id = 'session'`)
      return { request, receipt }
    }),
  )
  await run(filename, (db) =>
    Effect.gen(function* () {
      expect(
        yield* SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, { ...owner, fence: 99 }, saved.request),
      ).toEqual(saved.receipt)
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
      expect(
        yield* Effect.flip(
          SessionHandoffEnrollment.enroll({ db }, "session", `${tmp.path}/other`, owner, saved.request),
        ),
      ).toMatchObject({ code: "request_id_conflict" })
    }),
  )
})

test("a previously persisted steer cannot be hidden by delivery-time history membership", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/enroll.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('older-steer', 'session', 0, 0, ${JSON.stringify(user)})`,
      )
      yield* db.run(
        sql`INSERT INTO session_queue (id, session_id, delivery, state, position, payload, submission, message_id, time_created) VALUES ('older-steer-queue', 'session', 'steer', 'pending', 0, ${JSON.stringify(payload)}, ${JSON.stringify({ delivery: "steer", front: false, payload })}, 'older-steer', 0)`,
      )
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "new-root")
      yield* SessionHandoffEnrollment.delivered({ db }, "session", "new-root", "queue", "user")
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
      yield* db.run(sql`UPDATE session_queue SET state = 'delivered' WHERE id = 'older-steer-queue'`)
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
    }),
  )
})

test("failed receipt persistence rolls the entire enrollment transaction back", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/enroll.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)
      if (!candidate) throw new Error("Missing candidate")
      yield* db.run(
        "CREATE TRIGGER enrollment_fault BEFORE INSERT ON session_handoff_request BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
      )
      expect(
        (yield* SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, {
          requestID: "rollback",
          ...candidate,
        }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(yield* db.all(sql`SELECT * FROM session_handoff_action`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_request`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_receipt`)).toEqual([])
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toEqual(candidate)
    }),
  )
})

test("request guards reject unknown fields, mismatched owners, and ambiguous assistant history without writes", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/enroll.db`, (db) =>
    Effect.gen(function* () {
      yield* seed(db, tmp.path)
      const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)
      if (!candidate) throw new Error("Missing candidate")
      const request = { requestID: "guard", ...candidate }
      const excess = { ...request, force: true }
      expect(
        (yield* SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, excess).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(
        yield* Effect.flip(
          SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, { ...owner, ownerInstance: "foreign" }, request),
        ),
      ).toMatchObject({ code: "stale_fence" })
      expect(
        yield* Effect.flip(
          SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, { ...request, queueID: "other" }),
        ),
      ).toMatchObject({ code: "wrong_queue" })
      expect(
        yield* Effect.flip(
          SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, { ...request, userMessageID: "other" }),
        ),
      ).toMatchObject({ code: "wrong_user" })
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('foreign-assistant', 'session', 2, 2, ${JSON.stringify({ role: "assistant", parentID: "user", providerID: "synthetic", modelID: "other", time: { created: 2 } })})`,
      )
      expect(yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)).toBeNull()
      expect(yield* db.all(sql`SELECT * FROM session_handoff_action`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_request`)).toEqual([])
    }),
  )
})
