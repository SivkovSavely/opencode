import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { layer } from "../src/database/sqlite.bun"
import { SessionHandoffRecoveryQueue } from "../src/session/handoff-recovery-queue"
import { tmpdir } from "./fixture/tmpdir"

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

const key = { sessionID: "root", queueID: "queue", userMessageID: "user" }
const seed = Effect.fnUntraced(function* (db: SessionHandoffRecoveryQueue.Connection["db"], directory: string) {
  yield* db.run(
    sql`INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project',${directory},1,1,'[]')`,
  )
  yield* db.run(sql`INSERT INTO session (id,project_id,slug,directory,title,version,agent,time_created,time_updated)
    VALUES ('root','project','root',${directory},'test','1','build',1,1)`)
  yield* db.run(sql`INSERT INTO runtime_execution (id,session_id,directory,owner_lineage,owner_instance,fence,state,desired_active,time_created,time_updated)
    VALUES ('execution','root',${directory},'lineage','current',4,'active',1,1,1)`)
  yield* db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES
    ('user','root',1,1,'{"role":"user","agent":"build","model":{"providerID":"synthetic","modelID":"test"}}')`)
  yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES
    ('text','user','root',1,1,'{"type":"text","text":"original"}')`)
  yield* db.run(sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id,enrolled_request_id)
    VALUES ('root','reservation','active','queue','user','enroll')`)
  yield* db.run(
    sql`INSERT INTO session_handoff_action (session_id,queue_id,user_message_id,data) VALUES ('root','queue','user','{}')`,
  )
  yield* db.run(sql`INSERT INTO session_handoff_control (session_id,queue_id,user_message_id,reservation,state,data)
    VALUES ('root','queue','user','reservation','active','{"recoveryRevision":1,"identity":{"revision":0,"contextDigest":"context","ownerLineage":"lineage","ownerInstance":"current","fence":4}}')`)
  yield* db.run(sql`INSERT INTO session_handoff_request (request_id,session_id,queue_id,user_message_id,identity,data)
    VALUES ('recover','root','queue','user','{}','{"kind":"recovery","state":"applied","recoveryFence":4,"children":[]}')`)
  yield* db.run(sql`INSERT INTO session_handoff_recovery_hold VALUES ('root','reservation','root')`)
  yield* db.run(sql`INSERT INTO session_queue_state (session_id) VALUES ('root')`)
  return yield* SessionHandoffRecoveryQueue.frame({ db }, key, "recover", "root")
})

const successful = Effect.fnUntraced(function* (db: SessionHandoffRecoveryQueue.Connection["db"]) {
  yield* db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES
    ('result','root',2,2,'{"role":"assistant","parentID":"user","finish":"stop","time":{"completed":2}}')`)
  yield* db.run(sql`UPDATE runtime_execution SET state='completed' WHERE session_id='root'`)
})

test("only an authenticated false-to-true recovery block is restored, without dispatch", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/queue.db`, (db) =>
    Effect.gen(function* () {
      const frame = yield* seed(db, tmp.path)
      expect(yield* SessionHandoffRecoveryQueue.block({ db }, frame)).toBe("owned")
      const owned = yield* db.get(sql`SELECT * FROM session_handoff_recovery_queue_block`)
      for (let i = 0; i < 2; i++) expect(yield* SessionHandoffRecoveryQueue.block({ db }, frame)).toBe("owned")
      expect(yield* db.get(sql`SELECT * FROM session_handoff_recovery_queue_block`)).toEqual(owned)
      const early = yield* SessionHandoffRecoveryQueue.finish(
        { db },
        [frame],
        () => Effect.die("too early"),
        () => Effect.succeed("live" as const),
      )
      expect(early).toEqual({ state: "held", reason: "not_ready" })
      expect(yield* db.get(sql`SELECT state FROM session_handoff_recovery_queue_block`)).toEqual({ state: "owned" })
      yield* successful(db)
      const result = yield* db.transaction(
        (tx) =>
          SessionHandoffRecoveryQueue.finish(
            { db: tx },
            [frame],
            () => Effect.void,
            () => Effect.succeed("live" as const),
          ),
        { behavior: "immediate" },
      )
      expect(result).toEqual({ state: "restored" })
      expect(yield* db.get(sql`SELECT revision,blocked,paused FROM session_queue_state`)).toEqual({
        revision: 2,
        blocked: 0,
        paused: 0,
      })
      expect(yield* db.get(sql`SELECT state FROM session_handoff_recovery_queue_block`)).toEqual({ state: "restored" })
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM session_queue`)).toEqual([])
      expect(yield* db.all(sql`SELECT id FROM message ORDER BY id`)).toEqual([{ id: "result" }, { id: "user" }])
      yield* db.run(sql`DELETE FROM session WHERE id='root'`)
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_queue_block`)).toEqual([])
    }),
  )
})

for (const mutation of [
  "noop_block",
  "noop_pause",
  "input_aba",
  "permission_aba",
  "owner_aba",
  "control_aba",
  "runtime_delete",
  "queue_delete",
  "direct_user",
  "pending_steer",
  "paused",
  "managed",
] as const) {
  test(`recovery queue ownership refuses ${mutation} without clearing holds`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/queue.db`, (db) =>
      Effect.gen(function* () {
        const frame = yield* seed(db, tmp.path)
        yield* SessionHandoffRecoveryQueue.block({ db }, frame)
        if (mutation === "noop_block")
          yield* db.run(sql`UPDATE session_queue_state SET blocked=1 WHERE session_id='root'`)
        if (mutation === "noop_pause")
          yield* db.run(sql`UPDATE session_queue_state SET paused=0 WHERE session_id='root'`)
        if (mutation === "input_aba") {
          yield* db.run(sql`UPDATE part SET data='{"type":"text","text":"changed"}' WHERE id='text'`)
          yield* db.run(sql`UPDATE part SET data='{"type":"text","text":"original"}' WHERE id='text'`)
        }
        if (mutation === "permission_aba") {
          yield* db.run(sql`UPDATE session SET permission='[]' WHERE id='root'`)
          yield* db.run(sql`UPDATE session SET permission=NULL WHERE id='root'`)
        }
        if (mutation === "owner_aba") {
          yield* db.run(sql`UPDATE runtime_execution SET fence=5 WHERE session_id='root'`)
          yield* db.run(sql`UPDATE runtime_execution SET fence=4 WHERE session_id='root'`)
        }
        if (mutation === "control_aba") {
          const prior = yield* db.get<{ data: string }>(
            sql`SELECT data FROM session_handoff_control WHERE session_id='root'`,
          )
          if (!prior) throw new Error("Missing control")
          yield* db.run(sql`UPDATE session_handoff_control SET data='{"recoveryRevision":2}' WHERE session_id='root'`)
          yield* db.run(sql`UPDATE session_handoff_control SET data=${prior.data} WHERE session_id='root'`)
        }
        if (mutation === "runtime_delete") {
          yield* db.run(sql`DELETE FROM runtime_execution WHERE session_id='root'`)
          yield* db.run(sql`INSERT INTO runtime_execution (id,session_id,directory,owner_lineage,owner_instance,fence,state,desired_active,time_created,time_updated)
          VALUES ('execution','root',${tmp.path},'lineage','current',4,'active',1,1,1)`)
        }
        if (mutation === "queue_delete") {
          yield* db.run(sql`DELETE FROM session_queue_state WHERE session_id='root'`)
          yield* db.run(sql`INSERT INTO session_queue_state (session_id,revision,blocked) VALUES ('root',1,1)`)
        }
        if (mutation === "direct_user")
          yield* db.run(
            sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('direct','root',3,3,'{"role":"user"}')`,
          )
        if (mutation === "pending_steer")
          yield* db.run(
            sql`INSERT INTO session_queue (id,session_id,delivery,state,position,payload,submission,message_id,time_created) VALUES ('steer','root','steer','pending',1,'{}','{}','user',3)`,
          )
        if (mutation === "paused") yield* db.run(sql`UPDATE session_queue_state SET paused=1 WHERE session_id='root'`)
        if (mutation === "managed")
          yield* db.run(sql`UPDATE managed_command_coverage SET state='managed' WHERE root_session_id='root'`)
        yield* successful(db)
        const result = yield* SessionHandoffRecoveryQueue.finish(
          { db },
          [frame],
          () => Effect.void,
          () => Effect.succeed("live" as const),
        )
        expect(result.state).toBe("held")
        if (mutation === "managed") expect(result).toEqual({ state: "held", reason: "unsupported_managed" })
        expect(yield* db.get(sql`SELECT blocked FROM session_queue_state`)).toEqual({ blocked: 1 })
        expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toHaveLength(1)
        if (mutation.endsWith("aba") || mutation.endsWith("delete"))
          expect(yield* db.get(sql`SELECT state FROM session_handoff_recovery_queue_block`)).toEqual({
            state: "invalidated",
          })
      }),
    )
  })
}

test("a distinct authorized recovery retains old invalidated authority but cannot rearm its request", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/queue.db`, (db) =>
    Effect.gen(function* () {
      const first = yield* seed(db, tmp.path)
      yield* SessionHandoffRecoveryQueue.block({ db }, first)
      yield* db.run(sql`UPDATE session_queue_state SET blocked=0,revision=revision+1 WHERE session_id='root'`)
      expect(yield* SessionHandoffRecoveryQueue.block({ db }, first)).toBe("unowned")
      expect(yield* db.get(sql`SELECT blocked FROM session_queue_state`)).toEqual({ blocked: 0 })
      yield* db.run(sql`UPDATE runtime_execution SET fence=5 WHERE session_id='root'`)
      yield* db.run(sql`UPDATE session_handoff_control SET data='{"recoveryRevision":2}' WHERE session_id='root'`)
      yield* db.run(sql`UPDATE session_handoff_root SET state='active' WHERE session_id='root'`)
      yield* db.run(sql`INSERT INTO session_handoff_request (request_id,session_id,queue_id,user_message_id,identity,data)
      VALUES ('recover2','root','queue','user','{}','{"kind":"recovery","state":"applied","recoveryFence":5,"children":[]}')`)
      const second = yield* SessionHandoffRecoveryQueue.frame({ db }, key, "recover2", "root")
      expect(yield* SessionHandoffRecoveryQueue.block({ db }, second)).toBe("owned")
      expect(
        yield* db.all(
          sql`SELECT recovery_request_id,state FROM session_handoff_recovery_queue_block ORDER BY recovery_request_id`,
        ),
      ).toEqual([
        { recovery_request_id: "recover", state: "invalidated" },
        { recovery_request_id: "recover2", state: "owned" },
      ])
    }),
  )
})

for (const permit of ["proven", "proven_tail", "fabricated", "dangling", "different_id"] as const) {
  test(`automatic root compaction authority requires exact consumed action membership: ${permit}`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/queue.db`, (db) =>
      Effect.gen(function* () {
        const frame = yield* seed(db, tmp.path)
        yield* SessionHandoffRecoveryQueue.block({ db }, frame)
        yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              if (permit !== "fabricated")
                yield* SessionHandoffRecoveryQueue.preauthorizeCompaction({ db: tx }, "root", "internal")
              const id = permit === "different_id" ? "unrelated" : "internal"
              yield* tx.run(
                sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${id},'root',2,2,'{"role":"user","agent":"build","model":{"providerID":"synthetic","modelID":"test"}}')`,
              )
              yield* tx.run(
                sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('internal-part',${id},'root',2,2,${permit === "proven_tail" ? '{"type":"compaction","auto":true}' : '{"type":"text","synthetic":true,"metadata":{"compaction_continue":true},"text":"Continue"}'})`,
              )
              if (permit === "proven" || permit === "proven_tail") {
                yield* tx.run(
                  sql`INSERT INTO session_handoff_compaction (message_id,session_id,reservation,queue_id,user_message_id,parent_user_message_id,kind,epoch_sequence,data) VALUES ('internal','root','reservation','queue','user','user',${permit === "proven_tail" ? "request" : "continuation"},1,'{}')`,
                )
                yield* SessionHandoffRecoveryQueue.compacted({ db: tx }, "root", "internal")
              }
            }).pipe(Effect.provideService(SessionHandoffRecoveryQueue.CurrentFrame, frame)),
          { behavior: "immediate" },
        )
        if (permit === "proven_tail")
          yield* db.run(sql`UPDATE part SET data=json_set(data,'$.tail_start_id','user') WHERE id='internal-part'`)
        yield* successful(db)
        yield* db.run(
          sql`UPDATE message SET data=json_set(data,'$.parentID',${permit === "different_id" ? "unrelated" : "internal"}) WHERE id='result'`,
        )
        const decision = yield* SessionHandoffRecoveryQueue.finish(
          { db },
          [frame],
          () => Effect.void,
          () => Effect.succeed("live" as const),
        )
        expect(decision.state).toBe(permit === "proven" || permit === "proven_tail" ? "restored" : "held")
        expect(yield* db.get(sql`SELECT blocked FROM session_queue_state`)).toEqual({
          blocked: permit === "proven" || permit === "proven_tail" ? 0 : 1,
        })
        expect(yield* db.get(sql`SELECT state,internal_user_id FROM session_handoff_recovery_queue_block`)).toEqual({
          state:
            permit === "proven" || permit === "proven_tail"
              ? "restored"
              : permit === "dangling"
                ? "owned"
                : "invalidated",
          internal_user_id:
            permit === "fabricated" || permit === "proven" || permit === "proven_tail" ? null : "internal",
        })
      }),
    )
  })
}

test("an already blocked unowned queue is never backfilled or adopted", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/queue.db`, (db) =>
    Effect.gen(function* () {
      const frame = yield* seed(db, tmp.path)
      yield* db.run(sql`UPDATE session_queue_state SET blocked=1 WHERE session_id='root'`)
      expect(yield* SessionHandoffRecoveryQueue.block({ db }, frame)).toBe("unowned")
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_queue_block`)).toEqual([])
      yield* successful(db)
      expect(
        (yield* SessionHandoffRecoveryQueue.finish(
          { db },
          [frame],
          () => Effect.void,
          () => Effect.succeed("live" as const),
        )).state,
      ).toBe("held")
    }),
  )
})

test("live-session authority cannot be deleted, replaced or rearmed to erase invalidation", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/queue.db`, (db) =>
    Effect.gen(function* () {
      const frame = yield* seed(db, tmp.path)
      yield* SessionHandoffRecoveryQueue.block({ db }, frame)
      yield* db.run(sql`UPDATE session_queue_state SET blocked=1 WHERE session_id='root'`)
      expect((yield* Effect.exit(db.run(sql`DELETE FROM session_handoff_recovery_queue_block`)))._tag).toBe("Failure")
      expect(
        (yield* Effect.exit(
          db.run(
            sql`INSERT OR REPLACE INTO session_handoff_recovery_queue_block SELECT * FROM session_handoff_recovery_queue_block`,
          ),
        ))._tag,
      ).toBe("Failure")
      expect(
        (yield* Effect.exit(db.run(sql`UPDATE session_handoff_recovery_queue_block SET state='owned'`)))._tag,
      ).toBe("Failure")
      expect(
        (yield* Effect.exit(
          db.run(sql`UPDATE session_handoff_recovery_queue_block SET recovery_request_id='different'`),
        ))._tag,
      ).toBe("Failure")
      expect(yield* db.get(sql`SELECT recovery_request_id,state FROM session_handoff_recovery_queue_block`)).toEqual({
        recovery_request_id: "recover",
        state: "invalidated",
      })
    }),
  )
})

test("ownership insert failure rolls back its false-to-true block and revision", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/queue.db`, (db) =>
    Effect.gen(function* () {
      const frame = yield* seed(db, tmp.path)
      yield* db.run(
        sql`CREATE TRIGGER fail_authority BEFORE INSERT ON session_handoff_recovery_queue_block BEGIN SELECT RAISE(ABORT,'ownership insert fault'); END`,
      )
      expect(
        (yield* Effect.exit(
          db.transaction((tx) => SessionHandoffRecoveryQueue.block({ db: tx }, frame), { behavior: "immediate" }),
        ))._tag,
      ).toBe("Failure")
      expect(yield* db.get(sql`SELECT revision,blocked FROM session_queue_state`)).toEqual({ revision: 0, blocked: 0 })
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_queue_block`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toHaveLength(1)
    }),
  )
})

test("an ignored restored-marker CAS cannot clear any owned queue or release protection", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/queue.db`, (db) =>
    Effect.gen(function* () {
      const frame = yield* seed(db, tmp.path)
      yield* SessionHandoffRecoveryQueue.block({ db }, frame)
      yield* successful(db)
      yield* db.run(
        sql`CREATE TRIGGER ignore_restored BEFORE UPDATE OF state ON session_handoff_recovery_queue_block WHEN NEW.state='restored' BEGIN SELECT RAISE(IGNORE); END`,
      )
      const result = yield* Effect.exit(
        db.transaction(
          (tx) =>
            SessionHandoffRecoveryQueue.finish(
              { db: tx },
              [frame],
              () => Effect.void,
              () => Effect.succeed("live" as const),
            ),
          { behavior: "immediate" },
        ),
      )
      expect(result._tag).toBe("Failure")
      expect(yield* db.get(sql`SELECT blocked,revision FROM session_queue_state`)).toEqual({ blocked: 1, revision: 1 })
      expect(yield* db.get(sql`SELECT state FROM session_handoff_recovery_queue_block`)).toEqual({ state: "owned" })
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toHaveLength(1)
    }),
  )
})

test("an ignored ownership insert cannot commit a block without durable authority", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/queue.db`, (db) =>
    Effect.gen(function* () {
      const frame = yield* seed(db, tmp.path)
      yield* db.run(
        sql`CREATE TRIGGER ignore_authority BEFORE INSERT ON session_handoff_recovery_queue_block BEGIN SELECT RAISE(IGNORE); END`,
      )
      expect(
        (yield* Effect.exit(
          db.transaction((tx) => SessionHandoffRecoveryQueue.block({ db: tx }, frame), { behavior: "immediate" }),
        ))._tag,
      ).toBe("Failure")
      expect(yield* db.get(sql`SELECT revision,blocked FROM session_queue_state`)).toEqual({ revision: 0, blocked: 0 })
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_queue_block`)).toEqual([])
    }),
  )
})

test("restoration fault rolls back completion, receipt callback, history and holds together", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/queue.db`, (db) =>
    Effect.gen(function* () {
      const frame = yield* seed(db, tmp.path)
      yield* SessionHandoffRecoveryQueue.block({ db }, frame)
      yield* db.run(
        sql`CREATE TRIGGER fail_restore BEFORE UPDATE OF blocked ON session_queue_state WHEN NEW.blocked=0 BEGIN SELECT RAISE(ABORT,'test restoration fault'); END`,
      )
      const before = yield* db.all(sql`SELECT * FROM session_handoff_recovery_queue_block`)
      const result = yield* Effect.exit(
        db.transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* successful(tx)
              yield* tx.run(sql`INSERT INTO session_handoff_recovery_history VALUES ('root','queue','user',0,'{}')`)
              return yield* SessionHandoffRecoveryQueue.finish(
                { db: tx },
                [frame],
                (connection) =>
                  connection.db
                    .run(sql`INSERT INTO session_handoff_receipt VALUES ('recover',1,'{"final":true}')`)
                    .pipe(Effect.asVoid, Effect.orDie),
                () => Effect.succeed("live" as const),
              )
            }),
          { behavior: "immediate" },
        ),
      )
      expect(result._tag).toBe("Failure")
      expect(yield* db.get(sql`SELECT state FROM runtime_execution`)).toEqual({ state: "active" })
      expect(yield* db.all(sql`SELECT * FROM session_handoff_receipt`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_history`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_queue_block`)).toEqual(before)
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toHaveLength(1)
    }),
  )
})

for (const order of ["enqueue_first", "finish_first"] as const) {
  test(`independent SQLite writers serialize queue admission and completion: ${order}`, async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/queue.db`
    await run(filename, (db) =>
      Effect.gen(function* () {
        const frame = yield* seed(db, tmp.path)
        yield* SessionHandoffRecoveryQueue.block({ db }, frame)
        yield* successful(db)
        const enqueue = Effect.promise(() =>
          run(filename, (other) =>
            other.transaction(
              (tx) =>
                Effect.gen(function* () {
                  yield* tx.run(sql`INSERT INTO session_queue (id,session_id,delivery,state,position,payload,submission,time_created)
          VALUES ('next','root','queue','pending',1,'{}','{}',3)`)
                  yield* tx.run(sql`UPDATE session_queue_state SET revision=revision+1 WHERE session_id='root'`)
                }),
              { behavior: "immediate" },
            ),
          ),
        )
        if (order === "enqueue_first") yield* enqueue
        const decision = yield* db.transaction(
          (tx) =>
            SessionHandoffRecoveryQueue.finish(
              { db: tx },
              [frame],
              () => Effect.void,
              () => Effect.succeed("live" as const),
            ),
          { behavior: "immediate" },
        )
        if (order === "finish_first") yield* enqueue
        expect(decision.state).toBe(order === "finish_first" ? "restored" : "held")
        expect(yield* db.get(sql`SELECT blocked FROM session_queue_state`)).toEqual({
          blocked: order === "finish_first" ? 0 : 1,
        })
        expect(yield* db.all(sql`SELECT id,state FROM session_queue`)).toEqual([{ id: "next", state: "pending" }])
        expect(yield* db.all(sql`SELECT id FROM message ORDER BY id`)).toEqual([{ id: "result" }, { id: "user" }])
        expect(yield* db.get(sql`SELECT fence,state FROM runtime_execution`)).toEqual({ fence: 4, state: "completed" })
        expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toHaveLength(
          order === "finish_first" ? 0 : 1,
        )
      }),
    )
  })
}
