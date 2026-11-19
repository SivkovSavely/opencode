import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { layer } from "../src/database/sqlite.bun"
import { SessionHandoffRecovery } from "../src/session/handoff-recovery"
import { SessionHandoffStore } from "../src/session/handoff-store"
import { tmpdir } from "./fixture/tmpdir"

function run<A, E>(
  filename: string,
  body: (db: Effect.Success<ReturnType<typeof EffectDrizzleSqlite.makeWithDefaults>>) => Effect.Effect<A, E>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      return yield* body(db)
    }).pipe(Effect.provide(layer({ filename })), Effect.scoped),
  )
}

test("startup holds the enrolled root and ambiguous projected, runtime and metadata descendants without changing owners", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* db.run(
        sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', ${tmp.path}, 1, 1, '[]')`,
      )
      for (const id of ["root", "projected", "runtime", "metadata", "unrelated"]) {
        yield* db.run(
          sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, 'project', ${id === "projected" ? "root" : null}, ${id}, ${tmp.path}, 'test', '1', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, parent_session_id, time_created, time_updated) VALUES (${id}, ${id}, ${tmp.path}, 'lineage', 'prior', 3, 'active', 1, ${id === "runtime" ? "root" : null}, 1, 1)`,
        )
      }
      yield* db.run(
        sql`INSERT INTO session_handoff_root (session_id, reservation, state, queue_id, user_message_id, enrolled_request_id) VALUES ('root', 'reservation', 'active', 'queue', 'user', 'enrollment')`,
      )
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'root', 1, 1, '{"role":"assistant"}')`,
      )
      yield* db.run(
        sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('task', 'assistant', 'root', 1, 1, '{"type":"tool","tool":"task","callID":"call","state":{"status":"running","metadata":{"sessionId":"metadata"}}}')`,
      )
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      yield* SessionHandoffRecovery.installStartupHolds({ db }, "current")
      for (const id of ["root", "projected", "runtime", "metadata"])
        expect(yield* SessionHandoffRecovery.held({ db }, id)).toBe(true)
      expect(yield* SessionHandoffRecovery.held({ db }, "unrelated")).toBe(false)
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
      const view = yield* SessionHandoffRecovery.inspect({ db }, "root", () => Effect.succeed("unknown" as const))
      expect(view.descendants.map((child) => child.childSessionID).sort()).toEqual(["metadata", "projected", "runtime"])
      expect(view.descendants.every((child) => child.proof !== "verified")).toBe(true)
      yield* db.run(
        sql`UPDATE session SET permission = '[{"permission":"bash","pattern":"*","action":"deny"}]' WHERE id = 'projected'`,
      )
      expect(
        (yield* SessionHandoffRecovery.inspect({ db }, "root", () => Effect.succeed("unknown" as const)))
          .descendantDigest,
      ).not.toBe(view.descendantDigest)
    }),
  )
})

const seedLinked = Effect.fnUntraced(function* (db: SessionHandoffRecovery.Connection["db"], directory: string) {
  const model = { providerID: "synthetic", modelID: "reviewer", variant: "max" }
  const task = {
    parentSessionId: "root",
    parentMessageID: "assistant",
    parentCallID: "call",
    messageID: "child-user",
    model,
    variant: "max",
  }
  yield* db.run(
    sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', ${directory}, 1, 1, '[]')`,
  )
  for (const id of ["root", "child"]) {
    yield* db.run(
      sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, agent, metadata, permission, time_created, time_updated) VALUES (${id}, 'project', ${id === "child" ? "root" : null}, ${id}, ${directory}, 'test', '1', 'reviewer', ${JSON.stringify(id === "child" ? { task } : {})}, '[]', 1, 1)`,
    )
    yield* db.run(
      sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, parent_session_id, parent_message_id, parent_call_id, parent_mode, time_created, time_updated) VALUES (${id}, ${id}, ${directory}, 'lineage', ${`${id}-prior`}, 3, 'active', 1, ${id === "child" ? "root" : null}, ${id === "child" ? "assistant" : null}, ${id === "child" ? "call" : null}, ${id === "child" ? "foreground" : null}, 1, 1)`,
    )
  }
  yield* db.run(
    sql`INSERT INTO session_handoff_root (session_id, reservation, state, queue_id, user_message_id, enrolled_request_id) VALUES ('root', 'reservation', 'active', 'queue', 'user', 'enrollment')`,
  )
  yield* db.run(
    sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'root', 1, 1, '{"role":"assistant","parentID":"user"}')`,
  )
  yield* db.run(
    sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('task', 'assistant', 'root', 1, 1, ${JSON.stringify({ type: "tool", tool: "task", callID: "call", state: { status: "running", input: { prompt: "review", subagent_type: "reviewer" }, metadata: { ...task, sessionId: "child" }, time: { start: 1 } } })})`,
  )
  yield* db.run(
    sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('child-user', 'child', 2, 2, ${JSON.stringify({ role: "user", agent: "reviewer", model, variant: "max", time: { created: 2 } })})`,
  )
  yield* db.run(
    sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('child-text', 'child-user', 'child', 2, 2, '{"type":"text","text":"review"}')`,
  )
  yield* SessionHandoffRecovery.installStartupHolds({ db }, "current")
})

function expectation(child: SessionHandoffRecovery.TaskDescendant): SessionHandoffRecovery.ChildExpectation {
  if (
    !child.link ||
    !child.inputDigest ||
    !child.ownerLineage ||
    !child.ownerInstance ||
    child.fence === null ||
    child.recoveryRevision === null
  )
    throw new Error("Missing verified child identity")
  return {
    link: child.link,
    inputDigest: child.inputDigest,
    ownerLineage: child.ownerLineage,
    ownerInstance: child.ownerInstance,
    fence: child.fence,
    recoveryRevision: child.recoveryRevision,
  }
}

for (const blocked of [
  "root-live",
  "root-unknown",
  "child-live",
  "child-unknown",
  "closure",
  "permissions",
  "history",
  "missing-child",
  "extra-child",
  "resource",
  "orphan-task",
  "rollback",
] as const) {
  test(`guarded claim rejects ${blocked} without partial runtime claims or root transition`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/recovery.db`, (db) =>
      Effect.gen(function* () {
        yield* seedLinked(db, tmp.path)
        if (blocked === "orphan-task")
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('orphan', 'assistant', 'root', 3, 3, '{"type":"tool","tool":"task","callID":"orphan","state":{"status":"running"}}')`,
          )
        if (blocked === "resource") {
          yield* db.run(
            sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('child-assistant', 'child', 3, 3, '{"role":"assistant","parentID":"child-user","time":{"created":3}}')`,
          )
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('process', 'child-assistant', 'child', 3, 3, '{"type":"tool","tool":"bash","callID":"process","state":{"status":"running","metadata":{"outputPath":"/tmp/output-is-not-death-proof"}}}')`,
          )
        }
        const liveness = (id: string) =>
          Effect.succeed(
            blocked === `${id}-live`
              ? ("live" as const)
              : blocked === `${id}-unknown`
                ? ("unknown" as const)
                : ("dead" as const),
          )
        const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", liveness)
        expect(snapshot.descendants[0]?.proof).toBe("verified")
        const children = snapshot.descendants.map(expectation)
        if (blocked === "closure")
          yield* db.run(
            sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('racing', 'project', 'root', 'racing', ${tmp.path}, 'test', '1', 3, 3)`,
          )
        if (blocked === "permissions")
          yield* db.run(
            sql`UPDATE session SET permission = '[{"permission":"bash","action":"deny","pattern":"*"}]' WHERE id = 'child'`,
          )
        if (blocked === "history")
          yield* db.run(sql`UPDATE part SET data = '{"type":"text","text":"changed"}' WHERE id = 'child-text'`)
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        const result = yield* Effect.flip(
          SessionHandoffRecovery.claim(
            { db },
            {
              sessionID: "root",
              expectedDescendantDigest: snapshot.descendantDigest,
              children:
                blocked === "missing-child" ? [] : blocked === "extra-child" ? [...children, ...children] : children,
              owner: { lineage: "lineage", instance: "current" },
            },
            liveness,
            (tx) =>
              Effect.gen(function* () {
                yield* tx.db.run(sql`UPDATE session_handoff_root SET source = 'transitioned' WHERE session_id = 'root'`)
                if (blocked === "rollback")
                  return yield* new SessionHandoffRecovery.RecoveryError({ code: "stale_fence" })
              }),
          ),
        )
        expect(result).toMatchObject({
          code: blocked.endsWith("live")
            ? "owner_live"
            : blocked.endsWith("unknown")
              ? "owner_unknown"
              : blocked === "resource"
                ? "unresolved_resource"
                : blocked === "orphan-task"
                  ? "ambiguous_lineage"
                  : blocked === "rollback"
                    ? "stale_fence"
                    : "stale_context",
        })
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
        expect(yield* db.get(sql`SELECT source FROM session_handoff_root WHERE session_id = 'root'`)).toEqual({
          source: null,
        })
        expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_child`)).toEqual([])
      }),
    )
  })
}

test("same-input provider-inflight child and root are fenced atomically; parent Task stays interrupted after real child result", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('older-assistant', 'child', 2, 2, '{"role":"assistant","parentID":"child-user","finish":"stop","time":{"created":2,"completed":2}}')`,
      )
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('child-assistant', 'child', 3, 3, '{"role":"assistant","parentID":"child-user","time":{"created":3}}')`,
      )
      const beforeInput = yield* db.get(sql`SELECT * FROM message WHERE id = 'child-user'`)
      const beforeParts = yield* db.all(sql`SELECT * FROM part WHERE session_id = 'child'`)
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(snapshot.descendants[0]).toMatchObject({
        proof: "verified",
        selection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
        interruptedResources: [],
        resultAssistantMessageID: null,
        resultState: "none",
      })
      const claimed = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: snapshot.descendants.map(expectation),
          owner: { lineage: "lineage", instance: "current" },
        },
        dead,
        (tx) => tx.db.run(sql`UPDATE session_handoff_root SET source = 'transitioned' WHERE session_id = 'root'`),
      )
      expect(claimed.records.map((record) => [record.sessionID, record.fence, record.ownerInstance])).toEqual([
        ["root", 4, "current"],
        ["child", 4, "current"],
      ])
      expect(claimed.children).toMatchObject([
        { link: { childUserMessageID: "child-user" }, priorFence: 3, recoveryFence: 4, state: "claimed" },
      ])
      const interrupted = yield* db.get<{ data: string }>(sql`SELECT data FROM part WHERE id = 'task'`)
      expect(JSON.parse(interrupted?.data ?? "null")).toMatchObject({
        state: { status: "error", metadata: { interrupted: true, handoffRecovery: true } },
      })
      yield* db.run(
        sql`UPDATE message SET data = '{"role":"assistant","parentID":"child-user","finish":"stop","time":{"created":3,"completed":4}}' WHERE id = 'child-assistant'`,
      )
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'child'`)
      const result = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(result.descendants[0]).toMatchObject({
        proof: "verified",
        state: "terminal",
        resultAssistantMessageID: "child-assistant",
        resultState: "completed",
      })
      expect(yield* db.get(sql`SELECT data FROM part WHERE id = 'task'`)).toEqual(interrupted)
      expect(yield* db.get(sql`SELECT * FROM message WHERE id = 'child-user'`)).toEqual(beforeInput)
      expect(yield* db.all(sql`SELECT * FROM part WHERE session_id = 'child'`)).toEqual(beforeParts)
    }),
  )
})

test("independent SQLite connections racing one observed tree can commit only one whole-tree recovery", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/recovery.db`
  const dead = () => Effect.succeed("dead" as const)
  const snapshot = await run(filename, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      return yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
    }),
  )
  const attempts = await Promise.all(
    ["recovery-A", "recovery-B"].map((instance) =>
      run(filename, (db) =>
        SessionHandoffRecovery.claim(
          { db },
          {
            sessionID: "root",
            expectedDescendantDigest: snapshot.descendantDigest,
            children: snapshot.descendants.map(expectation),
            owner: { lineage: "lineage", instance },
          },
          dead,
          (tx) =>
            tx.db.run(
              sql`UPDATE session_handoff_root SET state = 'active', source = ${instance} WHERE session_id = 'root'`,
            ),
        ).pipe(Effect.result),
      ),
    ),
  )
  expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(1)
  expect(attempts.filter((attempt) => attempt._tag === "Failure")).toMatchObject([
    { failure: { code: "stale_context" } },
  ])
  await run(filename, (db) =>
    Effect.gen(function* () {
      const rows = yield* db.all<{ owner_instance: string; fence: number }>(
        sql`SELECT owner_instance, fence FROM runtime_execution ORDER BY session_id`,
      )
      expect(rows).toHaveLength(2)
      expect(rows[0]?.fence).toBe(4)
      expect(rows[1]).toEqual(rows[0])
      expect(yield* db.get(sql`SELECT source FROM session_handoff_root WHERE session_id = 'root'`)).toEqual({
        source: rows[0]?.owner_instance,
      })
      expect(yield* db.all(sql`SELECT recovery_revision FROM session_handoff_recovery_child`)).toEqual([
        { recovery_revision: 1 },
      ])
    }),
  )
})

test("terminal reconciliation records evidence but cannot release unowned startup protection", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'root'`)
      const dead = () => Effect.succeed("dead" as const)
      const active = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(
        yield* Effect.flip(
          SessionHandoffRecovery.reconcileTerminal(
            { db },
            {
              sessionID: "root",
              queueID: "queue",
              userMessageID: "user",
              expectedDescendantDigest: active.descendantDigest,
            },
            dead,
            () => Effect.void,
          ),
        ),
      ).toMatchObject({ code: "unresolved_resource" })
      expect(yield* SessionHandoffRecovery.held({ db }, "root")).toBe(true)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'child'`)
      const terminal = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      yield* SessionHandoffRecovery.reconcileTerminal(
        { db },
        {
          sessionID: "root",
          queueID: "queue",
          userMessageID: "user",
          expectedDescendantDigest: terminal.descendantDigest,
        },
        dead,
        () => Effect.succeed("expired-receipt"),
      )
      expect(yield* SessionHandoffRecovery.held({ db }, "root")).toBe(true)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
    }),
  )
})

test("startup protects terminal enrolled background descendants without reconstructing their input", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      yield* db.run(sql`UPDATE runtime_execution SET parent_mode = 'background' WHERE session_id = 'child'`)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'root'`)
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      yield* SessionHandoffRecovery.installStartupHolds({ db }, "restarted")
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
    }),
  )
})

test("startup does not install admission holds on a proven-live enrolled owner or child", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      const protectedIDs = yield* SessionHandoffRecovery.installStartupHolds({ db }, "second", () =>
        Effect.succeed("live" as const),
      )
      expect(protectedIDs).toEqual(["child", "root"])
      expect(yield* SessionHandoffRecovery.held({ db }, "root")).toBe(false)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(false)
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
    }),
  )
})

test("terminal-root guarded recovery claims only existing children and preserves the terminal root forever", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'root'`)
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      const root = yield* db.get(sql`SELECT * FROM runtime_execution WHERE session_id = 'root'`)
      const result = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: snapshot.descendants.map(expectation),
          owner: { lineage: "lineage", instance: "restarted" },
        },
        dead,
        () => Effect.succeed("expired-root-receipt"),
      )
      expect(result.root).toBe("expired-root-receipt")
      expect(result.records.map((record) => record.sessionID)).toEqual(["child"])
      expect(result.children).toMatchObject([{ state: "claimed", priorFence: 3, recoveryFence: 4 }])
      expect(yield* db.get(sql`SELECT * FROM runtime_execution WHERE session_id = 'root'`)).toEqual(root)
      expect(
        yield* db.get(sql`SELECT json_extract(data,'$.state.status') AS status FROM part WHERE id = 'task'`),
      ).toEqual({ status: "error" })
    }),
  )
})

for (const state of ["competing", "invalidated"]) {
  test(`startup holds an enrolled ${state} generation with an active Task child`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/recovery.db`, (db) =>
      Effect.gen(function* () {
        yield* seedLinked(db, tmp.path)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
        yield* db.run(sql`UPDATE session_handoff_root SET state = ${state}`)
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        expect(
          yield* SessionHandoffRecovery.installStartupHolds({ db }, "restarted", () => Effect.succeed("dead" as const)),
        ).toEqual(["child", "root"])
        expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
        expect(
          yield* SessionHandoffRecovery.installStartupHolds({ db }, "second", () => Effect.succeed("live" as const)),
        ).toEqual(["child", "root"])
        expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toEqual([])
      }),
    )
  })
}

for (const notification of [null, "pending", "delivering", "delivered"]) {
  test(`startup distinguishes terminal completed background children with ${notification} delivery state`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/recovery.db`, (db) =>
      Effect.gen(function* () {
        yield* seedLinked(db, tmp.path)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
        yield* db.run(sql`UPDATE runtime_execution SET state = 'completed'`)
        yield* db.run(
          sql`UPDATE runtime_execution SET parent_mode = 'background', parent_notification_state = ${notification} WHERE session_id = 'child'`,
        )
        yield* db.run(sql`UPDATE part SET data = json_set(data,'$.state.status','completed') WHERE id = 'task'`)
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        expect(
          yield* SessionHandoffRecovery.installStartupHolds({ db }, "restarted", () => Effect.succeed("dead" as const)),
        ).toEqual(notification === "delivered" ? [] : ["child", "root"])
        expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(notification !== "delivered")
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
        expect(
          yield* SessionHandoffRecovery.installStartupHolds({ db }, "second", () => Effect.succeed("live" as const)),
        ).toEqual(notification === "delivered" ? [] : ["child", "root"])
        expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toEqual([])
      }),
    )
  })
}

test("startup scopes closed generation holds to its Task links and terminal reconciliation preserves all generation protection", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'root'`)
      yield* db.run(sql`UPDATE session_handoff_root SET state = 'competing'`)
      yield* db.run(
        sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id,enrolled_request_id) VALUES ('root','later','terminal','later-queue','later-user','later-enrollment')`,
      )
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('later-user','root',4,4,'{"role":"user"}')`,
      )
      const dead = () => Effect.succeed("dead" as const)
      yield* SessionHandoffRecovery.installStartupHolds({ db }, "restarted", dead)
      expect(
        yield* db.all(sql`SELECT DISTINCT reservation FROM session_handoff_recovery_hold ORDER BY reservation`),
      ).toEqual([{ reservation: "reservation" }])
      const unresolved = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(
        yield* Effect.flip(
          SessionHandoffRecovery.claim(
            { db },
            {
              sessionID: "root",
              expectedDescendantDigest: unresolved.descendantDigest,
              children: unresolved.descendants.map(expectation),
              owner: { lineage: "lineage", instance: "restarted" },
            },
            dead,
            () => Effect.void,
          ),
        ),
      ).toMatchObject({ code: "stale_context" })
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'child'`)
      yield* db.run(sql`UPDATE session_handoff_root SET state = 'terminal' WHERE reservation = 'reservation'`)
      yield* db.run(
        sql`INSERT INTO session_handoff_recovery_hold (root_session_id,reservation,session_id) VALUES ('root','later','root')`,
      )
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      yield* SessionHandoffRecovery.reconcileTerminal(
        { db },
        {
          sessionID: "root",
          queueID: "queue",
          userMessageID: "user",
          expectedDescendantDigest: snapshot.descendantDigest,
        },
        dead,
        () => Effect.void,
      )
      expect(yield* db.all(sql`SELECT reservation,session_id FROM session_handoff_recovery_hold`)).toEqual([
        { reservation: "reservation", session_id: "child" },
        { reservation: "reservation", session_id: "root" },
        { reservation: "later", session_id: "root" },
      ])
    }),
  )
})

test("a live child from an older generation prevents disruptive holds on their shared root", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      yield* db.run(sql`UPDATE session_handoff_root SET state = 'competing'`)
      yield* db.run(
        sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id,enrolled_request_id) VALUES ('root','later','active','later-queue','later-user','later-enrollment')`,
      )
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      expect(
        yield* SessionHandoffRecovery.installStartupHolds({ db }, "second", (id) =>
          Effect.succeed(id === "child" ? ("live" as const) : ("dead" as const)),
        ),
      ).toEqual(["child", "root"])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
    }),
  )
})

test("retained action closure survives reopened SQLite and later reused child metadata without live inference", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/history.db`
  const key = { sessionID: "root", queueID: "queue", userMessageID: "user" }
  const saved = await run(filename, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* SessionHandoffStore.persistAction(
        { db },
        {
          ...key,
          directory: tmp.path,
          baselineSelection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
          createdAt: 1,
        },
      )
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", () => Effect.succeed("dead" as const))
      yield* SessionHandoffRecovery.captureCurrent({ db }, "child", () => Effect.succeed("dead" as const))
      expect(yield* SessionHandoffRecovery.retained({ db }, key)).toEqual(snapshot)
      yield* SessionHandoffRecovery.retain({ db }, key, snapshot)
      expect(yield* db.all(sql`SELECT revision FROM session_handoff_recovery_history`)).toEqual([{ revision: 0 }])
      return snapshot
    }),
  )
  await run(filename, (db) =>
    Effect.gen(function* () {
      yield* db.run(sql`UPDATE session SET metadata='{}',agent='different',permission='[]' WHERE id='child'`)
      yield* db.run(
        sql`UPDATE runtime_execution SET fence=fence+10,parent_call_id='later-call' WHERE session_id='child'`,
      )
      yield* db.run(sql`UPDATE part SET data='{"type":"text","text":"later content"}' WHERE id='child-text'`)
      expect(yield* SessionHandoffRecovery.retained({ db }, key)).toEqual(saved)
      expect(yield* SessionHandoffRecovery.retained({ db }, { ...key, userMessageID: "other" })).toBeUndefined()
      expect(yield* SessionHandoffRecovery.retained({ db }, { ...key, queueID: "other" })).toBeUndefined()
      yield* db.run(
        sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id) VALUES ('root','next','active','future-queue','future-user')`,
      )
      yield* SessionHandoffRecovery.captureCurrent({ db }, "child", () => Effect.succeed("dead" as const))
      expect(yield* SessionHandoffRecovery.retained({ db }, key)).toEqual(saved)
      expect(yield* SessionHandoffRecovery.retain({ db }, key, saved).pipe(Effect.flip)).toMatchObject({
        code: "stale_context",
      })
      for (const query of [
        sql`DELETE FROM session_handoff_recovery_history`,
        sql`UPDATE session_handoff_recovery_history SET data='{}'`,
        sql`INSERT OR REPLACE INTO session_handoff_recovery_history SELECT * FROM session_handoff_recovery_history`,
      ])
        expect(yield* db.run(query).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
    }),
  )
})
