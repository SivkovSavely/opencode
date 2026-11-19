import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Context, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionWatchStore } from "@opencode-ai/core/session/watch-store"
import { Agent } from "@/agent/agent"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { initProjectors } from "@/server/projectors"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { Session } from "@/session/session"
import { SessionControl } from "@/session/control"
import { SessionPrompt } from "@/session/prompt"
import { SessionQueue } from "@/session/queue"
import { SessionWatch } from "@/session/watch"
import { MessageID, SessionID } from "@/session/schema"
import { SessionControlTool } from "@/tool/session-control"
import { SessionWatchTool, SessionWatchManageTool } from "@/tool/session-watch"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

initProjectors()

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const directory = process.env.TEST_DIRECTORY
      if (!directory) throw new Error("Missing fixture directory")
      const runtime = RuntimeLifecycle.make({ lineage: "orchestration-restart-test" }, yield* Effect.scope)
      const context = yield* Layer.build(
        AppNodeBuilderV1.build(
          LayerNode.group([
            Session.node,
            SessionPrompt.node,
            SessionQueue.node,
            ToolRegistry.node,
            InstanceStore.node,
            Database.node,
            SessionProjector.node,
            Agent.node,
            Provider.node,
            FSUtil.node,
            Truncate.node,
          ]),
        ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime))),
      )
      const database = Context.get(context, Database.Service)
      const store = Context.get(context, InstanceStore.Service)
      runtime.bindDatabase(database)
      yield* store.provide(
        { directory },
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const queue = yield* SessionQueue.Service
          const agents = yield* Agent.Service
          const registry = yield* ToolRegistry.Service
          const ctx: Tool.Context = {
            sessionID: SessionID.make("ses_managed"),
            messageID: MessageID.ascending(),
            agent: "build",
            callID: randomUUID(),
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
            extra: { sessionControlOps: prompt },
          }
          if (process.env.TEST_PHASE === "managed") {
            assert.ok(
              !(yield* registry.ids()).some((id) =>
                ["session_watch", "session_watch_manage", "session_control"].includes(id),
              ),
            )
            const control = yield* Tool.init(yield* SessionControlTool)
            const watch = yield* Tool.init(yield* SessionWatchTool)
            const manage = yield* Tool.init(yield* SessionWatchManageTool)
            assert.ok(
              Exit.isFailure(yield* Effect.exit(control.execute({ action: "create", title: "forbidden" }, ctx))),
            )
            assert.ok(Exit.isFailure(yield* Effect.exit(watch.execute({ sessionID: "ses_other" }, ctx))))
            assert.ok(Exit.isFailure(yield* Effect.exit(manage.execute({ action: "list" }, ctx))))
            assert.equal((yield* database.db.all(sql`SELECT id FROM session`)).length, 0)
            return
          }
          if (process.env.TEST_PHASE === "seed") {
            const source = yield* sessions.create({ title: "restart-source" })
            const destination = yield* sessions.create({ title: "restart-watch" })
            yield* SessionWatchStore.create(database, {
              id: "restart-watch",
              owner: destination.id,
              source: source.id,
              destination: destination.id,
              events: ["completed"],
              mode: "once",
              delivery: "auto",
              limit: 8,
              agent: "build",
            })
            const active = yield* runtime.admit({ sessionID: source.id, directory })
            yield* SessionWatchStore.result(database, source.id, {
              outcome: "completed",
              summary: "durable source result",
              ownerLineage: runtime.identity.lineage,
              ownerInstance: runtime.identity.instance,
              fence: active.fence,
            })
            yield* runtime.release(source.id, active.fence)
            const controller = yield* sessions.create({ title: "restart-controller" })
            const target = yield* sessions.create({ title: "restart-control" })
            yield* queue.update(target.id, {
              revision: (yield* queue.list(target.id)).revision,
              mutation: { action: "pause", paused: true },
            })
            const tool = (yield* registry.all()).find((item) => item.id === "session_control")
            assert.ok(tool)
            yield* tool.execute(
              { action: "prompt", sessionID: target.id, prompt: "durable control input", requestID: "restart-control" },
              { ...ctx, sessionID: controller.id },
            )
            yield* queue.update(target.id, {
              revision: (yield* queue.list(target.id)).revision,
              mutation: { action: "pause", paused: false },
            })
            assert.equal(
              (yield* database.db.all(sql`SELECT id FROM session_watch_delivery WHERE state = 'pending'`)).length,
              1,
            )
            return
          }
          const watches = SessionWatch.engine({ database, store, runtime, prompt, queue, agents })
          const controls = SessionControl.engine({ database, store, runtime, prompt, queue, agents })
          for (const tick of [controls.tick, watches.tick]) yield* tick
          const targets = yield* database.db.all<{ id: string }>(
            sql`SELECT id FROM session WHERE title IN ('restart-watch', 'restart-control')`,
          )
          assert.equal(targets.length, 2)
          for (const target of targets) yield* runtime.waitForIdle(target.id)
          for (const tick of [controls.tick, watches.tick, controls.tick, watches.tick]) yield* tick
          for (const target of targets) {
            const messages = yield* sessions.messages({ sessionID: SessionID.make(target.id) })
            assert.equal(messages.filter((message) => message.info.role === "user").length, 1)
            assert.equal(
              messages.filter((message) => message.info.role === "assistant" && message.info.time.completed).length,
              1,
            )
          }
          assert.equal(
            (yield* database.db.all(sql`SELECT id FROM session_watch_delivery WHERE state = 'delivered'`)).length,
            1,
          )
          assert.equal(
            (yield* database.db.all(sql`SELECT id FROM session_control_request WHERE state = 'done'`)).length,
            1,
          )
        }).pipe(Effect.provide(context), Effect.provideService(RuntimeLifecycle.Service, runtime)),
      )
      const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
      yield* Effect.promise(() => AppRuntime.dispose())
    }),
  ),
)
