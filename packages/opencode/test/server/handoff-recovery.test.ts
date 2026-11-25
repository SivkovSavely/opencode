import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionHandoffRecovery } from "@opencode-ai/core/session/handoff-recovery"
import { SessionHandoffStore } from "@opencode-ai/core/session/handoff-store"
import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { ServerRecovery } from "../../src/server/recovery"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { InstanceStore } from "../../src/project/instance-store"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, CrossSpawnSpawner.node])))
const integration = testEffect(Layer.mergeAll(TestLLMServer.layer, LayerNode.compile(CrossSpawnSpawner.node)))

for (const operation of ["release", "complete"] as const) {
  for (const guard of ["rollback", "stale_fence", "foreign_owner"] as const) {
    it.live(
      `${operation} ${guard === "rollback" ? "rolls back durable completion when retained history cannot append" : `does not capture history for ${guard}`}`,
      () =>
        Effect.gen(function* () {
          const directory = yield* tmpdirScoped()
          const filename = `${directory}/atomic.db`
          const database = Context.get(yield* Layer.build(Database.layerFromPath(filename)), Database.Service)
          const observer = Context.get(yield* Layer.build(Database.layerFromPath(filename)), Database.Service)
          const root = randomUUID()
          const child = randomUUID()
          yield* database.db.run(sql`INSERT INTO project (id,worktree,time_created,time_updated,sandboxes)
        VALUES (${root},${directory},1,1,'[]')`)
          for (const id of [root, child])
            yield* database.db.run(sql`INSERT INTO session
          (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated,permission,agent)
          VALUES (${id},${root},${id === child ? root : null},${id},${directory},'test','1',1,1,'[]',${id === child ? "general" : "build"})`)
          const first = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
          yield* first.admit({ sessionID: root, directory })
          const admission = yield* first.admit({
            sessionID: child,
            directory,
            parentSessionID: root,
            parentMessageID: "assistant",
            parentCallID: "call",
            parentMode: "foreground",
          })
          yield* database.db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data)
        VALUES ('root-user',${root},1,1,${JSON.stringify({ role: "user", agent: "build", model: { providerID: "test", modelID: "test" }, time: { created: 1 } })}),
        ('assistant',${root},2,2,${JSON.stringify({ role: "assistant", parentID: "root-user", agent: "build", providerID: "test", modelID: "test", time: { created: 2 } })}),
        ('child-user',${child},3,3,${JSON.stringify({ role: "user", agent: "general", model: { providerID: "test", modelID: "test" }, time: { created: 3 } })})`)
          yield* database.db.run(
            sql`UPDATE session SET metadata = ${JSON.stringify({ task: { parentSessionId: root, parentMessageID: "assistant", parentCallID: "call", messageID: "child-user", model: { providerID: "test", modelID: "test" } } })} WHERE id = ${child}`,
          )
          yield* database.db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('task','assistant',${root},2,2,${JSON.stringify({ type: "tool", tool: "task", callID: "call", state: { status: "error", input: { prompt: "review", subagent_type: "general" }, error: "Interrupted", time: { start: 2, end: 3 }, metadata: { interrupted: true, handoffRecovery: true, parentSessionId: root, parentMessageID: "assistant", parentCallID: "call", messageID: "child-user", sessionId: child, model: { providerID: "test", modelID: "test" } } } })}),
        ('child-text','child-user',${child},3,3,${JSON.stringify({ type: "text", text: "review" })})`)
          yield* database.db.run(sql`INSERT INTO session_handoff_root
        (session_id,reservation,queue_id,user_message_id,state,enrolled_request_id)
        VALUES (${root},'reservation','queue','root-user','active','enrollment')`)
          yield* SessionHandoffStore.persistAction(database, {
            sessionID: root,
            queueID: "queue",
            userMessageID: "root-user",
            directory,
            createdAt: 1,
            baselineSelection: { providerID: "test", modelID: "test", variant: "default" },
          })
          const key = { sessionID: root, queueID: "queue", userMessageID: "root-user" }
          yield* SessionHandoffStore.appendAssistant(database, key, {
            kind: "ordinary",
            messageID: "assistant",
            parentUserMessageID: "root-user",
            authorizationUserMessageID: "root-user",
            epochSequence: 0,
            controlRequestID: null,
            selection: { providerID: "test", modelID: "test", variant: "default" },
            selectionEvidence: "persisted_message",
            dispatch: "unknown",
          })
          yield* SessionHandoffRecovery.retain(
            database,
            key,
            yield* SessionHandoffRecovery.inspect(database, root, () => Effect.succeed("live")),
          )
          yield* database.db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data)
        VALUES ('child-result',${child},4,4,${JSON.stringify({ role: "assistant", parentID: "child-user", agent: "general", providerID: "test", modelID: "test", finish: "stop", time: { created: 4, completed: 4 } })})`)
          const runtime =
            operation === "release"
              ? first
              : RuntimeLifecycle.make(
                  { lineage: first.identity.lineage, instance: first.identity.instance },
                  yield* Effect.scope,
                  database,
                )
          const started = yield* Deferred.make<void>()
          const proceed = yield* Deferred.make<void>()
          const finished = yield* Deferred.make<void>()
          if (operation === "complete") {
            // Install a zero-lease continuation slot under the same durable owner, without admitting an input.
            yield* runtime.runHandoffRecovery(
              [
                {
                  sessionID: child,
                  directory,
                  ownerLineage: runtime.identity.lineage,
                  ownerInstance: runtime.identity.instance,
                  fence: admission.fence,
                  state: "active",
                  parentSessionID: root,
                  parentMessageID: "assistant",
                  parentCallID: "call",
                  parentMode: "foreground",
                  recoveryAttempts: 0,
                  recoveryPreparationAttempts: 0,
                  handoffRootSessionID: root,
                },
              ],
              () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.ensuring(Deferred.succeed(finished, undefined)),
                ),
            )
            yield* awaitWithTimeout(Deferred.await(started), "recovery slot never started", 5_000)
          }
          yield* database.db.run(sql`CREATE TRIGGER reject_atomic_history
        BEFORE INSERT ON session_handoff_recovery_history
        BEGIN SELECT RAISE(ABORT, 'synthetic history append failure'); END`)
          if (guard === "stale_fence")
            yield* database.db.run(sql`UPDATE runtime_execution SET fence = fence + 1 WHERE session_id = ${child}`)
          if (guard === "foreign_owner")
            yield* database.db.run(
              sql`UPDATE runtime_execution SET owner_instance = 'another-owner' WHERE session_id = ${child}`,
            )
          const transition = operation === "release" ? runtime.release(child, admission.fence) : runtime.complete(child)
          const failed = yield* transition.pipe(Effect.exit)
          if (guard !== "rollback") {
            expect(failed._tag).toBe("Success")
            expect(
              yield* observer.db.get(
                sql`SELECT state, fence, owner_instance FROM runtime_execution WHERE session_id = ${child}`,
              ),
            ).toEqual({
              state: "active",
              fence: admission.fence + (guard === "stale_fence" ? 1 : 0),
              owner_instance: guard === "foreign_owner" ? "another-owner" : runtime.identity.instance,
            })
            expect((yield* SessionHandoffRecovery.retained(observer, key))?.descendants[0]?.resultState).toBe("none")
            if (operation === "complete") {
              yield* Deferred.succeed(proceed, undefined)
              yield* awaitWithTimeout(Deferred.await(finished), "revoked recovery slot never finished", 5_000)
            }
            return
          }
          expect(failed._tag).toBe("Failure")
          expect(
            yield* observer.db.get(sql`SELECT state, fence FROM runtime_execution WHERE session_id = ${child}`),
          ).toEqual({ state: "active", fence: admission.fence })
          expect((yield* SessionHandoffRecovery.retained(observer, key))?.descendants[0]?.resultState).toBe("none")
          yield* database.db.run(sql`DROP TRIGGER reject_atomic_history`)
          yield* transition
          expect(
            yield* observer.db.get(sql`SELECT state, fence FROM runtime_execution WHERE session_id = ${child}`),
          ).toEqual({ state: "completed", fence: admission.fence })
          expect((yield* SessionHandoffRecovery.retained(observer, key))?.descendants[0]).toMatchObject({
            childSessionID: child,
            resultAssistantMessageID: "child-result",
            resultState: "completed",
            state: "terminal",
          })
          if (operation === "complete") {
            yield* Deferred.succeed(proceed, undefined)
            yield* awaitWithTimeout(Deferred.await(finished), "recovery slot never finished", 5_000)
          }
          yield* database.db.run(sql`UPDATE message SET data = json_set(data, '$.finish', 'stop', '$.time.completed', 5)
          WHERE id = 'assistant'`)
          yield* database.db.run(sql`CREATE TRIGGER reject_atomic_history
          BEFORE INSERT ON session_handoff_recovery_history
          BEGIN SELECT RAISE(ABORT, 'synthetic root history append failure'); END`)
          expect((yield* first.release(root).pipe(Effect.exit))._tag).toBe("Failure")
          expect(yield* observer.db.get(sql`SELECT state FROM runtime_execution WHERE session_id = ${root}`)).toEqual({
            state: "active",
          })
          expect((yield* SessionHandoffRecovery.retained(observer, key))?.sealed).toBe(false)
          yield* database.db.run(sql`DROP TRIGGER reject_atomic_history`)
          yield* first.release(root)
          expect(yield* observer.db.get(sql`SELECT state FROM runtime_execution WHERE session_id = ${root}`)).toEqual({
            state: "completed",
          })
          expect((yield* SessionHandoffRecovery.retained(observer, key))?.sealed).toBe(true)
        }),
    )
  }
}

for (const state of ["competing", "invalidated", "terminal"] as const) {
  it.live(`startup neither resumes nor notifies a closed enrolled ${state} Task tree`, () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const directory = yield* tmpdirScoped()
      const root = randomUUID()
      const child = randomUUID()
      const lineage = randomUUID()
      yield* database.db.run(
        sql`INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES (${root},${directory},1,1,'[]')`,
      )
      for (const id of [root, child])
        yield* database.db.run(
          sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (${id},${root},${id === child ? root : null},${id},${directory},'test','1',1,1)`,
        )
      const first = RuntimeLifecycle.make({ lineage }, yield* Effect.scope, database)
      yield* first.admit({ sessionID: root, directory })
      yield* first.admit({
        sessionID: child,
        directory,
        parentSessionID: root,
        parentMessageID: "assistant",
        parentCallID: "call",
        parentMode: "background",
      })
      yield* first.release(child)
      yield* first.release(root)
      yield* database.db.run(
        sql`UPDATE runtime_execution SET owner_instance='prior',owner_start_time='0',state='completed',desired_active=1 WHERE session_id IN (${root},${child})`,
      )
      if (state !== "terminal")
        yield* database.db.run(sql`UPDATE runtime_execution SET state='active' WHERE session_id=${child}`)
      yield* database.db.run(
        sql`UPDATE runtime_execution SET parent_notification_state='pending' WHERE session_id=${child}`,
      )
      yield* database.db.run(
        sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id,enrolled_request_id) VALUES (${root},'closed',${state},'queue','user','enrolled')`,
      )
      const before = yield* database.db.all(
        sql`SELECT * FROM runtime_execution WHERE session_id IN (${root},${child}) ORDER BY session_id`,
      )
      const resumed = yield* Deferred.make<void>()
      const second = RuntimeLifecycle.make({ lineage }, yield* Effect.scope, database)
      expect(yield* second.verifyOwner(child)).toBe("dead")
      yield* second.recover(() => Deferred.succeed(resumed, undefined))
      expect(yield* SessionHandoffRecovery.held(database, child)).toBe(true)
      expect(yield* second.claimParentNotification(child, "call")).toBe(false)
      yield* second.scheduleNotification(root, Deferred.succeed(resumed, undefined).pipe(Effect.asVoid))
      expect(yield* Deferred.isDone(resumed)).toBe(false)
      expect(
        yield* database.db.all(
          sql`SELECT * FROM runtime_execution WHERE session_id IN (${root},${child}) ORDER BY session_id`,
        ),
      ).toEqual(before)
    }),
  )
}

it.live("a second live runtime neither holds nor claims an enrolled owner's root and children", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const directory = yield* tmpdirScoped()
    const root = randomUUID()
    const child = randomUUID()
    const late = randomUUID()
    const lineage = randomUUID()
    yield* database.db.run(
      sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (${root}, ${directory}, 1, 1, '[]')`,
    )
    for (const id of [root, child, late])
      yield* database.db.run(
        sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, ${root}, ${id === root ? null : root}, ${id}, ${directory}, 'test', '1', 1, 1)`,
      )
    const first = RuntimeLifecycle.make({ lineage }, yield* Effect.scope, database)
    yield* first.admit({ sessionID: root, directory })
    yield* first.admit({
      sessionID: child,
      directory,
      parentSessionID: root,
      parentMessageID: "assistant",
      parentCallID: "call",
      parentMode: "background",
    })
    yield* database.db.run(
      sql`INSERT INTO session_handoff_root (session_id, reservation, state, queue_id, user_message_id, enrolled_request_id) VALUES (${root}, 'r', 'active', 'q', 'u', 'e')`,
    )
    const before = yield* database.db.all(
      sql`SELECT * FROM runtime_execution WHERE session_id IN (${root}, ${child}) ORDER BY session_id`,
    )
    const second = RuntimeLifecycle.make({ lineage }, yield* Effect.scope, database)
    expect(yield* second.verifyOwner(root)).toBe("live")
    expect(yield* second.verifyOwner(child)).toBe("live")
    yield* second.recover(() => Effect.die("second runtime must not continue live work"))
    expect(yield* SessionHandoffRecovery.held(database, root)).toBe(false)
    expect(yield* SessionHandoffRecovery.held(database, child)).toBe(false)
    expect(
      yield* database.db.all(
        sql`SELECT * FROM runtime_execution WHERE session_id IN (${root}, ${child}) ORDER BY session_id`,
      ),
    ).toEqual(before)
    yield* database.db.run(sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id = ${root}`)
    yield* second.recover(() => Effect.die("live child must prevent ordinary root takeover"))
    expect(yield* Effect.flip(second.admit({ sessionID: root, directory, manualRecovery: true }))).toMatchObject({
      _tag: "RuntimeDrainingError",
    })
    expect(yield* SessionHandoffRecovery.held(database, child)).toBe(false)
    const admitted = yield* first.admit({
      sessionID: late,
      directory,
      parentSessionID: root,
      parentMessageID: "assistant",
      parentCallID: "later",
      parentMode: "background",
    })
    expect(admitted.fence).toBe(0)
    for (const id of [late, child, root]) yield* first.release(id)
    expect(
      yield* database.db.all(sql`SELECT * FROM session_handoff_recovery_hold WHERE root_session_id = ${root}`),
    ).toEqual([])
  }),
)

it.live("enrolled unknown owner is held before automatic recovery and cannot use manual takeover", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const id = randomUUID()
    const lineage = randomUUID()
    yield* database.db.run(
      sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (${id}, '/tmp', 1, 1, '[]')`,
    )
    yield* database.db.run(
      sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, ${id}, ${id}, '/tmp', 'test', '1', 1, 1)`,
    )
    yield* database.db.run(
      sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated) VALUES (${id}, ${id}, '/tmp', ${lineage}, 'prior', 4, 'parked', 1, 1, 1)`,
    )
    yield* database.db.run(
      sql`INSERT INTO session_handoff_root (session_id, reservation, state, queue_id, user_message_id, enrolled_request_id) VALUES (${id}, 'r', 'active', 'q', 'u', 'e')`,
    )
    const runtime = RuntimeLifecycle.make({ lineage }, yield* Effect.scope, database)
    yield* runtime.recover(() => Effect.die("enrolled automatic continuation must not run"))
    expect(yield* SessionHandoffRecovery.held(database, id)).toBe(true)
    expect(yield* Effect.flip(runtime.admit({ sessionID: id, directory: "/tmp", manualRecovery: true }))).toMatchObject(
      { _tag: "RuntimeDrainingError" },
    )
    expect(
      yield* database.db.get(sql`SELECT fence, owner_instance, state FROM runtime_execution WHERE session_id = ${id}`),
    ).toEqual({ fence: 4, owner_instance: "prior", state: "parked" })
  }),
)

it.live("runtime admission racing startup protection rejects a new Task-only descendant", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const directory = yield* tmpdirScoped()
    const root = randomUUID()
    const child = randomUUID()
    yield* database.db.run(sql`INSERT INTO project (id,worktree,time_created,time_updated,sandboxes)
      VALUES (${root},${directory},1,1,'[]')`)
    for (const id of [root, child])
      yield* database.db
        .run(sql`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated)
        VALUES (${id},${root},${id},${directory},'test','1',1,1)`)
    yield* database.db.run(sql`INSERT INTO session_handoff_root
      (session_id,reservation,state,queue_id,user_message_id,enrolled_request_id)
      VALUES (${root},'r','active','queue','user','enrolled')`)
    const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
    const message = randomUUID()
    const written = yield* Deferred.make<void>()
    const committing = yield* Deferred.make<void>()
    const recovery = yield* database.db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* SessionHandoffRecovery.installStartupHolds({ db: tx }, "restarted")
            yield* tx.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data)
          VALUES (${message},${root},1,1,'{"role":"assistant","parentID":"user"}')`)
            yield* tx.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
          VALUES (${message},${message},${root},1,1,${JSON.stringify({ type: "tool", tool: "task", state: { metadata: { sessionId: child } } })})`)
            yield* Deferred.succeed(written, undefined)
            yield* Deferred.await(committing)
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(written), "startup holds were not installed")
    const admission = yield* runtime
      .admit({ sessionID: child, directory, manualRecovery: true })
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))
    yield* Deferred.succeed(committing, undefined)
    yield* Fiber.join(recovery)
    expect(yield* Fiber.join(admission)).toMatchObject({
      _tag: "RuntimeDrainingError",
      message: "Enrolled execution is held for guarded same-input recovery",
    })
    expect(
      yield* database.db.get(sql`SELECT 1 FROM session_handoff_recovery_hold WHERE session_id = ${child}`),
    ).toBeUndefined()
    expect(yield* database.db.get(sql`SELECT 1 FROM runtime_execution WHERE session_id = ${child}`)).toBeUndefined()
    yield* database.db.run(sql`DELETE FROM part WHERE id = ${message}`)
    expect((yield* runtime.admit({ sessionID: child, directory })).fence).toBe(0)
    yield* runtime.release(child)
  }),
)

integration.live(
  "guarded recovery resumes the exact persisted child input against a synthetic provider before root continuation",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({
        git: true,
        config: { ...testProviderConfig(llm.url), model: "test/test-model" },
      })
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope)
      const context = yield* Layer.build(
        AppNodeBuilderV1.build(
          LayerNode.group([Session.node, SessionPrompt.node, InstanceStore.node, Database.node, SessionProjector.node]),
        ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime))),
      )
      const database = Context.get(context, Database.Service)
      const sessions = Context.get(context, Session.Service)
      const prompt = Context.get(context, SessionPrompt.Service)
      const store = Context.get(context, InstanceStore.Service)
      runtime.bindDatabase(database)
      yield* store.provide(
        { directory },
        Effect.gen(function* () {
          const root = yield* sessions.create({ title: "held root", agent: "build" })
          const parentMessageID = MessageID.ascending()
          const childUserID = MessageID.ascending()
          const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
          const task = {
            parentSessionId: root.id,
            parentMessageID,
            parentCallID: "call",
            messageID: childUserID,
            model,
          }
          const child = yield* sessions.create({
            title: "reviewer child",
            parentID: root.id,
            agent: "general",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
            metadata: { task },
          })
          const rootUserID = MessageID.ascending()
          yield* sessions.updateMessage({
            id: rootUserID,
            sessionID: root.id,
            role: "user",
            agent: "build",
            model,
            time: { created: 1 },
          })
          yield* sessions.updateMessage({
            id: parentMessageID,
            sessionID: root.id,
            role: "assistant",
            parentID: rootUserID,
            agent: "build",
            mode: "build",
            modelID: model.modelID,
            providerID: model.providerID,
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 2 },
          })
          const taskPartID = PartID.ascending()
          yield* sessions.updatePart({
            id: taskPartID,
            messageID: parentMessageID,
            sessionID: root.id,
            type: "tool",
            tool: "task",
            callID: "call",
            state: {
              status: "running",
              input: { prompt: "Review the persisted change", subagent_type: "general", command: "review" },
              metadata: { ...task, sessionId: child.id },
              time: { start: 2 },
            },
          })
          yield* sessions.updateMessage({
            id: childUserID,
            sessionID: child.id,
            role: "user",
            agent: "general",
            model,
            time: { created: 3 },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: childUserID,
            sessionID: child.id,
            type: "text",
            text: "Review the persisted change",
          })
          // Session summary bookkeeping may append diffs, but every authorization/input field must remain unchanged.
          const original = yield* database.db.get(
            sql`SELECT id, session_id, time_created, json_remove(data, '$.summary') AS data FROM message WHERE id = ${childUserID}`,
          )
          const abandoned = RuntimeLifecycle.make({ lineage: runtime.identity.lineage }, yield* Effect.scope, database)
          yield* abandoned.admit({ sessionID: root.id, directory })
          yield* abandoned.admit({
            sessionID: child.id,
            directory,
            parentSessionID: root.id,
            parentMessageID,
            parentCallID: "call",
            parentMode: "foreground",
          })
          yield* database.db.run(
            sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id IN (${root.id}, ${child.id})`,
          )
          yield* database.db.run(
            sql`INSERT INTO session_handoff_root (session_id, reservation, state, queue_id, user_message_id, enrolled_request_id) VALUES (${root.id}, 'r', 'active', 'q', ${rootUserID}, 'e')`,
          )
          yield* SessionHandoffStore.persistAction(database, {
            sessionID: root.id,
            queueID: "q",
            userMessageID: rootUserID,
            directory,
            createdAt: 1,
            baselineSelection: { ...model, variant: "default" },
          })
          yield* SessionHandoffStore.appendAssistant(
            database,
            { sessionID: root.id, queueID: "q", userMessageID: rootUserID },
            {
              kind: "ordinary",
              messageID: parentMessageID,
              parentUserMessageID: rootUserID,
              authorizationUserMessageID: rootUserID,
              epochSequence: 0,
              controlRequestID: null,
              selection: { ...model, variant: "default" },
              selectionEvidence: "persisted_message",
              dispatch: "unknown",
            },
          )
          yield* ServerRecovery.Service.use((recovery) => recovery.initialize).pipe(
            Effect.provide(ServerRecovery.layer),
            Effect.provide(context),
            Effect.provideService(RuntimeLifecycle.Service, runtime),
          )
          expect(yield* llm.calls).toBe(0)
          const snapshot = yield* SessionHandoffRecovery.inspect(database, root.id, runtime.verifyOwner)
          const observed = snapshot.descendants[0]
          if (
            !observed?.link ||
            !observed.inputDigest ||
            !observed.ownerLineage ||
            !observed.ownerInstance ||
            observed.fence === null ||
            observed.recoveryRevision === null
          )
            throw new Error("Missing child identity")
          expect(observed.proof).toBe("verified")
          expect(
            JSON.parse(
              (yield* database.db.get<{ data: string }>(sql`SELECT data FROM part WHERE id=${taskPartID}`))?.data ??
                "null",
            ),
          ).toMatchObject({ state: { status: "running" } })
          const claimed = yield* SessionHandoffRecovery.claim(
            database,
            {
              sessionID: root.id,
              expectedDescendantDigest: snapshot.descendantDigest,
              children: [
                {
                  link: observed.link,
                  inputDigest: observed.inputDigest,
                  ownerLineage: observed.ownerLineage,
                  ownerInstance: observed.ownerInstance,
                  fence: observed.fence,
                  recoveryRevision: observed.recoveryRevision,
                },
              ],
              owner: { ...runtime.identity, process: RuntimeLifecycle.processIdentity() },
            },
            runtime.verifyOwner,
            (db) =>
              db.db
                .run(
                  sql`UPDATE session_handoff_root SET state='active' WHERE session_id=${root.id} AND reservation='r'`,
                )
                .pipe(Effect.asVoid),
          )
          const order: string[] = []
          expect(
            JSON.parse(
              (yield* database.db.get<{ data: string }>(sql`SELECT data FROM part WHERE id=${taskPartID}`))?.data ??
                "null",
            ),
          ).toMatchObject({ state: { status: "error", metadata: { interrupted: true, handoffRecovery: true } } })
          const rootStarted = yield* Deferred.make<void, unknown>()
          yield* llm.push(reply().text("Actual persisted child result").stop())
          yield* runtime.runHandoffRecovery(
            claimed.records,
            (record) =>
              store.provide(
                { directory: record.directory },
                Effect.gen(function* () {
                  order.push(record.sessionID)
                  if (record.sessionID === child.id) {
                    const result = yield* prompt.recover(SessionID.make(record.sessionID), record.fence)
                    expect(result?.info.role).toBe("assistant")
                    return
                  }
                  expect(order).toEqual([child.id, root.id])
                  const actual = yield* SessionHandoffRecovery.inspect(database, root.id, runtime.verifyOwner)
                  expect(actual.descendants[0]).toMatchObject({ state: "terminal", resultState: "completed" })
                  expect(
                    yield* database.db.get(
                      sql`SELECT id, session_id, time_created, json_remove(data, '$.summary') AS data FROM message WHERE id = ${childUserID}`,
                    ),
                  ).toEqual(original)
                  expect(
                    yield* database.db.all(
                      sql`SELECT id FROM message WHERE session_id = ${child.id} AND json_extract(data, '$.role') = 'user'`,
                    ),
                  ).toEqual([{ id: childUserID }])
                  expect(
                    JSON.parse(
                      (yield* database.db.get<{ data: string }>(sql`SELECT data FROM part WHERE id = ${taskPartID}`))
                        ?.data ?? "null",
                    ),
                  ).toMatchObject({ state: { status: "error", metadata: { interrupted: true } } })
                  yield* Deferred.succeed(rootStarted, undefined)
                }),
              ),
            (cause) => Deferred.failCause(rootStarted, cause).pipe(Effect.asVoid),
          )
          yield* awaitWithTimeout(
            Deferred.await(rootStarted),
            "root continuation did not follow child result",
            "20 seconds",
          )
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const row = yield* database.db.get<{ state: string }>(
                sql`SELECT state FROM runtime_execution WHERE session_id=${root.id}`,
              )
              return row?.state === "completed" ? true : undefined
            }),
            "same-input recovery did not finish",
          )
          // This low-level fixture has no retained recovery request or queue ownership frames.
          expect(yield* SessionHandoffRecovery.held(database, root.id)).toBe(true)
          expect(yield* llm.calls).toBe(1)
          const parentBeforeSettlement = yield* sessions.messages({ sessionID: root.id })
          const result = (yield* sessions.messages({ sessionID: child.id })).findLast(
            (message) => message.info.role === "assistant",
          )
          const retained = yield* SessionHandoffRecovery.retained(database, {
            sessionID: root.id,
            queueID: "q",
            userMessageID: rootUserID,
          })
          expect(retained?.descendants[0]).toMatchObject({
            link: observed.link,
            state: "terminal",
            resultState: "completed",
            resultAssistantMessageID: result?.info.id,
          })
          expect(retained?.interruptedResources).toMatchObject([{ tool: "task", effect: "uncertain" }])
          yield* ServerRecovery.settleForeground({
            database,
            sessions,
            record: { sessionID: child.id, parentSessionID: root.id, parentMessageID, parentCallID: "call" },
            result,
          })
          expect(yield* sessions.messages({ sessionID: root.id })).toEqual(parentBeforeSettlement)
        }),
      )
    }),
  30_000,
)

it.live("interrupted process liveness uses its own complete identity rather than root death or output files", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const id = randomUUID()
    const lineage = randomUUID()
    yield* database.db.run(
      sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (${id}, '/tmp', 1, 1, '[]')`,
    )
    yield* database.db.run(
      sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, ${id}, ${id}, '/tmp', 'test', '1', 1, 1)`,
    )
    const abandoned = RuntimeLifecycle.make({ lineage }, yield* Effect.scope, database)
    yield* abandoned.admit({ sessionID: id, directory: "/tmp" })
    yield* database.db.run(sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id = ${id}`)
    yield* database.db.run(
      sql`INSERT INTO session_handoff_root (session_id, reservation, state, queue_id, user_message_id, enrolled_request_id) VALUES (${id}, 'r', 'active', 'q', 'u', 'e')`,
    )
    const runtime = RuntimeLifecycle.make({ lineage }, yield* Effect.scope, database)
    yield* SessionHandoffRecovery.installStartupHolds(database, runtime.identity.instance)
    const assistantID = randomUUID()
    const partID = randomUUID()
    yield* database.db.run(
      sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${assistantID}, ${id}, 1, 1, '{"role":"assistant"}')`,
    )
    const processIdentity = RuntimeLifecycle.processIdentity()
    if (!processIdentity) throw new Error("This Linux liveness qualification requires /proc process identity")
    for (const state of ["live", "unknown", "dead"] as const) {
      const identity =
        state === "live" ? processIdentity : state === "dead" ? { ...processIdentity, startTime: "0" } : undefined
      yield* database.db.run(
        sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${partID}, ${assistantID}, ${id}, 1, 1, ${JSON.stringify({ type: "tool", tool: "bash", callID: "process", state: { status: "running", input: { command: "synthetic fixture" }, metadata: { outputPath: "/tmp/not-death-evidence", processIdentity: identity }, time: { start: 1 } } })}) ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
      )
      const snapshot = yield* SessionHandoffRecovery.inspect(
        database,
        id,
        runtime.verifyOwner,
        RuntimeLifecycle.processLiveness,
      )
      expect(yield* runtime.verifyOwner(id)).toBe("dead")
      expect(snapshot.interruptedResources[0]?.liveness).toBe(state)
      const attempt = SessionHandoffRecovery.claim(
        database,
        {
          sessionID: id,
          expectedDescendantDigest: snapshot.descendantDigest,
          children: [],
          owner: { ...runtime.identity, process: processIdentity },
        },
        runtime.verifyOwner,
        () => Effect.void,
        RuntimeLifecycle.processLiveness,
      )
      if (state !== "dead") {
        expect(yield* Effect.flip(attempt)).toMatchObject({ code: "unresolved_resource" })
        continue
      }
      expect((yield* attempt).records).toMatchObject([
        { sessionID: id, ownerInstance: runtime.identity.instance, fence: 1 },
      ])
    }
  }),
)
