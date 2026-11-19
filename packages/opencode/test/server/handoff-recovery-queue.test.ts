import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionHandoffRecovery } from "@opencode-ai/core/session/handoff-recovery"
import { SessionHandoffRecoveryQueue } from "@opencode-ai/core/session/handoff-recovery-queue"
import { SessionHandoffStore } from "@opencode-ai/core/session/handoff-store"
import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Layer } from "effect"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, CrossSpawnSpawner.node])))

for (const order of [
  "child_first",
  "root_first",
  "revoked_child",
  "revoked_desired",
  "pending_child",
  "paused_child",
  "child_compaction",
  "task_aba",
  "resource",
  "rollback",
  "receipt_rollback",
] as const) {
  it.live(`exact recovery batch finishes at last actual completion: ${order}`, () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const database = Context.get(
        yield* Layer.build(Database.layerFromPath(`${directory}/batch.db`)),
        Database.Service,
      )
      const observer = Context.get(
        yield* Layer.build(Database.layerFromPath(`${directory}/batch.db`)),
        Database.Service,
      )
      const runtime = RuntimeLifecycle.make({ lineage: "lineage" }, yield* Effect.scope, database)
      const model = { providerID: "test", modelID: "test" }
      const key = { sessionID: "root", queueID: "queue", userMessageID: "root-user" }
      const link = {
        parentSessionID: "root",
        parentAssistantMessageID: "task-message",
        parentCallID: "call",
        childSessionID: "child",
        childUserMessageID: "child-user",
        mode: "foreground",
      }
      yield* database.db.run(
        sql`INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project',${directory},1,1,'[]')`,
      )
      for (const id of ["root", "child"]) {
        yield* database.db
          .run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,agent,metadata,time_created,time_updated)
        VALUES (${id},'project',${id === "child" ? "root" : null},${id},${directory},'test','1',${id === "child" ? "general" : "build"},${JSON.stringify(id === "child" ? { task: { parentSessionId: "root", parentMessageID: "task-message", parentCallID: "call", messageID: "child-user", model } } : {})},1,1)`)
        yield* runtime.admit({
          sessionID: id,
          directory,
          ...(id === "child"
            ? {
                parentSessionID: "root",
                parentMessageID: "task-message",
                parentCallID: "call",
                parentMode: "foreground" as const,
              }
            : {}),
        })
        yield* database.db.run(
          sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${`${id}-user`},${id},1,1,${JSON.stringify({ role: "user", agent: id === "child" ? "general" : "build", model, time: { created: 1 } })})`,
        )
        yield* database.db.run(
          sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (${`${id}-text`},${`${id}-user`},${id},1,1,'{"type":"text","text":"review"}')`,
        )
        yield* database.db.run(sql`INSERT INTO session_queue_state (session_id) VALUES (${id})`)
      }
      yield* database.db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('task-message','root',2,2,'{"role":"assistant","parentID":"root-user"}')`,
      )
      yield* database.db.run(
        sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('task','task-message','root',2,2,${JSON.stringify({ type: "tool", tool: "task", callID: "call", state: { status: "error", input: { prompt: "review", subagent_type: "general" }, error: "Interrupted", metadata: { interrupted: true, handoffRecovery: true, sessionId: "child", parentSessionId: "root", parentMessageID: "task-message", parentCallID: "call", messageID: "child-user", model }, time: { start: 1, end: 2 } } })})`,
      )
      yield* database.db.run(
        sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id,enrolled_request_id) VALUES ('root','reservation','active','queue','root-user','enroll')`,
      )
      yield* SessionHandoffStore.persistAction(database, {
        ...key,
        directory,
        createdAt: 1,
        baselineSelection: { ...model, variant: "default" },
      })
      yield* database.db.run(
        sql`INSERT INTO session_handoff_control (session_id,queue_id,user_message_id,reservation,state,data) VALUES ('root','queue','root-user','reservation','active',${JSON.stringify({ recoveryRevision: 1, identity: { revision: 0, contextDigest: "context", ownerLineage: runtime.identity.lineage, ownerInstance: runtime.identity.instance, fence: 0 } })})`,
      )
      yield* database.db.run(
        sql`INSERT INTO session_handoff_request (request_id,session_id,queue_id,user_message_id,identity,data) VALUES ('recovery','root','queue','root-user','{}',${JSON.stringify({ kind: "recovery", state: "applied", recoveryFence: 0, children: [{ link, priorFence: -1, recoveryFence: 0, state: "claimed" }] })})`,
      )
      for (const id of ["root", "child"])
        yield* database.db.run(sql`INSERT INTO session_handoff_recovery_hold VALUES ('root','reservation',${id})`)
      yield* SessionHandoffRecovery.retain(
        database,
        key,
        yield* SessionHandoffRecovery.inspect(database, "root", () => Effect.succeed("live")),
      )
      const coordinator = RuntimeLifecycle.make(
        { lineage: runtime.identity.lineage, instance: runtime.identity.instance },
        yield* Effect.scope,
        database,
      )
      const records = yield* Effect.forEach(["root", "child"], (sessionID) =>
        Effect.gen(function* () {
          return {
            sessionID,
            directory,
            ownerLineage: runtime.identity.lineage,
            ownerInstance: runtime.identity.instance,
            fence: 0,
            state: "active" as const,
            ...(sessionID === "child"
              ? {
                  parentSessionID: "root",
                  parentMessageID: "task-message",
                  parentCallID: "call",
                  parentMode: "foreground" as const,
                }
              : {}),
            recoveryAttempts: 1,
            recoveryPreparationAttempts: 0,
            handoffRootSessionID: "root",
            handoffReservation: "reservation",
            recoveryQueueFrame: yield* SessionHandoffRecoveryQueue.frame(database, key, "recovery", sessionID),
          }
        }),
      )
      const rootStarted = yield* Deferred.make<void>()
      const rootProceed = yield* Deferred.make<void>()
      yield* coordinator.runHandoffRecovery(
        records,
        (record) =>
          Effect.gen(function* () {
            const frame = yield* SessionHandoffRecoveryQueue.CurrentFrame
            expect(frame?.sessionID).toBe(record.sessionID)
            if (!frame) throw new Error("Missing exact recovery frame")
            yield* database.db.transaction((tx) => SessionHandoffRecoveryQueue.block({ db: tx }, frame), {
              behavior: "immediate",
            })
            if (record.sessionID === "child" && order !== "child_first")
              yield* coordinator.admit({
                sessionID: "child",
                directory,
                parentSessionID: "root",
                parentMessageID: "task-message",
                parentCallID: "call",
                parentMode: "foreground",
                recoveryFence: 0,
              })
            yield* database.db.run(
              sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${`${record.sessionID}-result`},${record.sessionID},3,3,${JSON.stringify({ role: "assistant", parentID: `${record.sessionID}-user`, finish: "stop", time: { created: 3, completed: 3 } })})`,
            )
            if (record.sessionID === "root") {
              yield* Deferred.succeed(rootStarted, undefined)
              yield* Deferred.await(rootProceed)
            }
          }),
        undefined,
        (connection) =>
          Effect.gen(function* () {
            yield* SessionHandoffRecovery.captureCurrent(connection, "root", () => Effect.succeed("live"))
            yield* connection.db.run(
              sql`INSERT INTO session_handoff_receipt (request_id,revision,data)
       SELECT 'recovery',COALESCE(MAX(revision),0)+1,'{"final":true}' FROM session_handoff_receipt WHERE request_id='recovery'`,
            )
          }).pipe(Effect.orDie),
      )
      yield* awaitWithTimeout(Deferred.await(rootStarted), "root callback did not start", 5_000)
      if (order === "child_first")
        expect(yield* observer.db.get(sql`SELECT state FROM runtime_execution WHERE session_id='child'`)).toEqual({
          state: "completed",
        })
      if (order !== "child_first")
        expect(yield* observer.db.get(sql`SELECT state FROM runtime_execution WHERE session_id='child'`)).toEqual({
          state: "active",
        })
      expect(yield* observer.db.all(sql`SELECT state FROM session_handoff_recovery_queue_block`)).toEqual([
        { state: "owned" },
        { state: "owned" },
      ])
      if (order === "pending_child")
        yield* database.db.run(
          sql`INSERT INTO session_queue (id,session_id,delivery,state,position,payload,submission,message_id,time_created) VALUES ('steer','child','steer','pending',1,'{}','{}','child-user',4)`,
        )
      if (order === "paused_child")
        yield* database.db.run(sql`UPDATE session_queue_state SET paused=1 WHERE session_id='child'`)
      if (order === "resource")
        yield* database.db.run(
          sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('process','child-result','child',4,4,'{"type":"tool","tool":"bash","callID":"process","state":{"status":"running","metadata":{"outputPath":"/tmp/not-death-proof"}}}')`,
        )
      if (order === "child_compaction") {
        yield* database.db.run(
          sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('child-compaction','child',4,4,'{"role":"user","agent":"general","model":{"providerID":"test","modelID":"test"}}')`,
        )
        yield* database.db.run(
          sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('child-marker','child-compaction','child',4,4,'{"type":"compaction","auto":true}')`,
        )
      }
      if (order === "task_aba") {
        const part = yield* database.db.get<{ data: string }>(sql`SELECT data FROM part WHERE id='task'`)
        if (!part) throw new Error("Missing original Task")
        yield* database.db.run(sql`DELETE FROM part WHERE id='task'`)
        yield* database.db.run(
          sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('task','task-message','root',2,2,${part.data})`,
        )
      }
      if (order === "rollback")
        yield* database.db.run(
          sql`CREATE TRIGGER fail_batch_restore BEFORE UPDATE OF blocked ON session_queue_state WHEN NEW.blocked=0 BEGIN SELECT RAISE(ABORT,'batch rollback'); END`,
        )
      yield* Deferred.succeed(rootProceed, undefined)
      yield* pollWithTimeout(
        observer.db
          .get<{ state: string }>(sql`SELECT state FROM runtime_execution WHERE session_id='root'`)
          .pipe(Effect.map((row) => (row?.state === "completed" ? true : undefined))),
        "root did not durably complete",
      )
      if (order === "receipt_rollback")
        yield* database.db.run(
          sql`CREATE TRIGGER fail_batch_receipt BEFORE INSERT ON session_handoff_receipt BEGIN SELECT RAISE(ABORT,'receipt rollback'); END`,
        )
      if (order !== "child_first") {
        expect(yield* observer.db.all(sql`SELECT * FROM session_handoff_receipt`)).toEqual([])
        expect(yield* observer.db.all(sql`SELECT blocked FROM session_queue_state`)).toEqual([
          { blocked: 1 },
          { blocked: 1 },
        ])
        expect(yield* observer.db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toHaveLength(2)
        if (order === "revoked_child")
          yield* database.db.run(
            sql`UPDATE runtime_execution SET owner_instance='replacement',fence=fence+1 WHERE session_id='child'`,
          )
        if (order === "revoked_desired")
          yield* database.db.run(sql`UPDATE runtime_execution SET desired_active=0 WHERE session_id='child'`)
        const history = yield* observer.db.all(sql`SELECT * FROM session_handoff_recovery_history`)
        const released = yield* coordinator.release("child", 0).pipe(Effect.exit)
        if (order === "rollback" || order === "receipt_rollback") {
          expect(released._tag).toBe("Failure")
          expect(yield* observer.db.get(sql`SELECT state FROM runtime_execution WHERE session_id='child'`)).toEqual({
            state: "active",
          })
          expect(yield* observer.db.all(sql`SELECT * FROM session_handoff_recovery_history`)).toEqual(history)
          expect(yield* observer.db.all(sql`SELECT * FROM session_handoff_receipt`)).toEqual([])
          expect(yield* observer.db.all(sql`SELECT blocked FROM session_queue_state`)).toEqual([
            { blocked: 1 },
            { blocked: 1 },
          ])
          yield* database.db.run(
            order === "rollback" ? sql`DROP TRIGGER fail_batch_restore` : sql`DROP TRIGGER fail_batch_receipt`,
          )
          yield* coordinator.release("child", 0)
        }
        if (order === "revoked_child") {
          expect(
            yield* observer.db.get(
              sql`SELECT state,owner_instance,fence FROM runtime_execution WHERE session_id='child'`,
            ),
          ).toEqual({ state: "active", owner_instance: "replacement", fence: 1 })
          expect(yield* observer.db.all(sql`SELECT blocked FROM session_queue_state`)).toEqual([
            { blocked: 1 },
            { blocked: 1 },
          ])
          expect(yield* observer.db.all(sql`SELECT * FROM session_handoff_receipt`)).toEqual([])
          expect(yield* observer.db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toHaveLength(2)
          return
        }
        if (
          order === "revoked_desired" ||
          order === "pending_child" ||
          order === "paused_child" ||
          order === "child_compaction" ||
          order === "task_aba" ||
          order === "resource"
        ) {
          expect(yield* observer.db.all(sql`SELECT blocked FROM session_queue_state`)).toEqual([
            { blocked: 1 },
            { blocked: 1 },
          ])
          expect(yield* observer.db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toHaveLength(2)
          expect(yield* observer.db.all(sql`SELECT data FROM session_handoff_receipt`)).toEqual(
            order === "revoked_desired" ? [] : [{ data: '{"final":true}' }],
          )
          if (order === "revoked_desired")
            expect(
              yield* observer.db.get(sql`SELECT desired_active,state FROM runtime_execution WHERE session_id='child'`),
            ).toEqual({ desired_active: 0, state: "active" })
          return
        }
      }
      expect(yield* observer.db.all(sql`SELECT blocked,revision FROM session_queue_state`)).toEqual([
        { blocked: 0, revision: 2 },
        { blocked: 0, revision: 2 },
      ])
      expect(yield* observer.db.all(sql`SELECT state FROM session_handoff_recovery_queue_block`)).toEqual([
        { state: "restored" },
        { state: "restored" },
      ])
      expect(yield* observer.db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toEqual([])
      expect(yield* observer.db.all(sql`SELECT data FROM session_handoff_receipt`)).toEqual([
        { data: '{"final":true}' },
      ])
      const retained = yield* SessionHandoffRecovery.retained(observer, key)
      const actual = yield* SessionHandoffRecovery.inspect(
        observer,
        "root",
        () => Effect.succeed("live"),
        undefined,
        key,
      )
      expect(retained?.sealed).toBe(true)
      expect(retained?.descendants).toEqual(actual.descendants)
      expect(retained?.descendantDigest).toBe(actual.descendantDigest)
      expect(
        yield* observer.db.get(sql`SELECT json_extract(data,'$.state.status') AS status FROM part WHERE id='task'`),
      ).toEqual({ status: "error" })
    }),
  )
}
