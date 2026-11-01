import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerRecovery } from "../../src/server/recovery"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { MessageID, PartID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, LayerNode.compile(CrossSpawnSpawner.node)))
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

describe("HTTP startup recovery", () => {
  for (const scenario of ["recovered", "foreground", "cancel", "task", "task-cancel", "task-reuse-cancel"] as const) {
    const cancelledTask = scenario === "task-cancel" || scenario === "task-reuse-cancel"
    it.live(
      scenario === "task-cancel"
        ? "settles a reconstructed foreground Task when its empty child is stopped during prompt preparation"
        : scenario === "task-reuse-cancel"
          ? "does not deliver a reused child's previous answer when reconstructed prompt preparation is stopped"
          : `${scenario} nested no-reply notification`,
      () =>
        Effect.gen(function* () {
          const previous = RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable()
          yield* Effect.addFinalizer(() => Effect.sync(() => RuntimeLifecycle.setCurrent(previous)))
          RuntimeLifecycle.setCurrent(RuntimeLifecycle.unavailable())
          // Reproduce CLI prewarming, but never use this unrelated graph for the test server.
          yield* Effect.promise(() => AppRuntime.runPromise(SessionPrompt.Service.use(() => Effect.void)))
          const llm = yield* TestLLMServer
          const directory = yield* tmpdirScoped({
            git: true,
            config: { ...testProviderConfig(llm.url), model: "test/test-model" },
          })
          const entered = yield* Deferred.make<void>()
          const nestedFinished = yield* Deferred.make<void>()
          const releaseGate = yield* Deferred.make<void>()
          const releaseTurn = Promise.withResolvers<void>()
          const releaseChild = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(releaseGate, undefined).pipe(Effect.asVoid))
          yield* Effect.addFinalizer(() => Effect.sync(() => releaseTurn.resolve()))
          yield* Effect.addFinalizer(() => Effect.sync(() => releaseChild.resolve()))
          const gateContext = yield* Layer.build(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
          const gate = Context.get(gateContext, HttpServer.HttpServer)
          yield* gate.serve(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest
              if (request.url === "/finished") {
                yield* Deferred.succeed(nestedFinished, undefined)
                return HttpServerResponse.empty()
              }
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(releaseGate)
              return HttpServerResponse.empty()
            }),
          )
          const lineage = randomUUID()
          const runtime = RuntimeLifecycle.make({ lineage, startupRecovery: true }, yield* Effect.scope)
          const app = AppNodeBuilderV1.build(
            LayerNode.group([
              Session.node,
              Database.node,
              InstanceStore.node,
              SessionRunState.node,
              SessionPrompt.node,
            ]),
          ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime)))
          const routes = HttpApiApp.createRoutes(undefined, runtime)
          // All listener services, including recovery and HTTP handlers, share one fresh memo map.
          const serverContext = yield* Layer.build(
            HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
              Layer.provideMerge(app),
              Layer.provide(layerWebSocketConstructorGlobal),
              Layer.provideMerge(NodeHttpServer.layerTest),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Effect.provide(HttpApiApp.context))
          yield* Effect.addFinalizer(() => Deferred.succeed(releaseGate, undefined).pipe(Effect.asVoid))
          yield* Effect.addFinalizer(() => Effect.sync(() => releaseTurn.resolve()))
          yield* Effect.addFinalizer(() => Effect.sync(() => releaseChild.resolve()))
          const database = Context.get(serverContext, Database.Service)
          const sessions = Context.get(serverContext, Session.Service)
          const store = Context.get(serverContext, InstanceStore.Service)
          const recovery = Context.get(serverContext, ServerRecovery.Service)
          const server = Context.get(serverContext, HttpServer.HttpServer)
          const baseUrl = HttpServer.formatAddress(server.address)
          const sdk = createOpencodeClient({ baseUrl, directory })
          yield* Effect.promise(async () => {
            const plugins = path.join(directory, ".opencode", "plugin")
            await mkdir(plugins, { recursive: true })
            await Bun.write(
              path.join(plugins, "nested.js"),
              `
import { createOpencodeClient } from ${JSON.stringify(import.meta.resolve("@opencode-ai/sdk"))}
export default async ({ directory }) => {
  const client = createOpencodeClient({ baseUrl: ${JSON.stringify(baseUrl)}, directory })
  return {
    "chat.message": async (_input, output) => {
      if (output.parts.some(part => part.type === "text" && ((${scenario === "cancel"} && part.text === "nested notification") || (${cancelledTask} && part.text === "perform child task"))))
        await fetch(${JSON.stringify(HttpServer.formatAddress(gate.address))})
    },
    tool: { nested: {
      description: "Send a notification to the current session",
      args: {},
      async execute(_args, context) {
        try {
          const result = await client.session.prompt({
            path: { id: context.sessionID },
            body: { noReply: true, agent: "build", parts: [{ type: "text", text: "nested notification" }] },
            throwOnError: true,
          })
          if (result.error) throw new Error(JSON.stringify(result.error))
          return "notification delivered"
        } finally {
          await fetch(${JSON.stringify(HttpServer.formatAddress(gate.address) + "/finished")})
        }
      },
    } },
  }
}
`,
            )
          })
          const session = yield* store.provide(
            { directory },
            sessions.create({
              title: "Recovery fixture",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            }),
          )
          const child =
            scenario === "task" || cancelledTask
              ? yield* store.provide(
                  { directory },
                  sessions.create({ title: "Task child", parentID: session.id, agent: "general" }),
                )
              : undefined
          if (child && scenario === "task-reuse-cancel")
            yield* store.provide(
              { directory },
              Effect.gen(function* () {
                const user = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  sessionID: child.id,
                  role: "user",
                  agent: "general",
                  model,
                  time: { created: Date.now() },
                })
                const assistant = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  sessionID: child.id,
                  role: "assistant",
                  parentID: user.id,
                  mode: "general",
                  agent: "general",
                  path: { cwd: directory, root: directory },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: model.modelID,
                  providerID: model.providerID,
                  time: { created: Date.now(), completed: Date.now() },
                  finish: "stop",
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: assistant.id,
                  sessionID: child.id,
                  type: "text",
                  text: "previous task answer",
                })
              }),
            )
          const childMessageID = MessageID.ascending()
          const parentMessageID = MessageID.ascending()
          const taskPartID = PartID.ascending()
          const callID = "call_reconstructed_task"
          if (scenario !== "foreground") {
            yield* store.provide(
              { directory },
              Effect.gen(function* () {
                const message = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  sessionID: session.id,
                  role: "user",
                  agent: "build",
                  model,
                  time: { created: Date.now() },
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: message.id,
                  sessionID: session.id,
                  type: "text",
                  text: "initial request",
                })
                if (child) {
                  yield* sessions.updateMessage({
                    id: parentMessageID,
                    sessionID: session.id,
                    role: "assistant",
                    parentID: message.id,
                    mode: "build",
                    agent: "build",
                    path: { cwd: directory, root: directory },
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    modelID: model.modelID,
                    providerID: model.providerID,
                    time: { created: Date.now() },
                  })
                  yield* sessions.updatePart({
                    id: taskPartID,
                    messageID: parentMessageID,
                    sessionID: session.id,
                    type: "tool",
                    tool: "task",
                    callID,
                    state: {
                      status: "running",
                      input: {
                        prompt: "perform child task",
                        description: "review",
                        subagent_type: "general",
                        command: "review",
                      },
                      metadata: {
                        sessionId: child.id,
                        parentSessionId: session.id,
                        parentMessageID,
                        parentCallID: callID,
                        messageID: childMessageID,
                        model,
                        inheritVariant: true,
                      },
                      time: { start: Date.now() },
                    },
                  })
                }
              }),
            )
            const abandoned = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, yield* Effect.scope, database)
            yield* abandoned.admit({ sessionID: session.id, directory })
            yield* database.db.run(
              sql`UPDATE runtime_execution SET owner_start_time = ${"0"} WHERE session_id = ${session.id}`,
            )
          }
          if (child) {
            expect(
              yield* database.db.get(sql`SELECT session_id FROM runtime_execution WHERE session_id = ${child.id}`),
            ).toBeUndefined()
            if (cancelledTask) yield* llm.push(reply().text("parent continued").wait(releaseTurn.promise).stop())
            else
              yield* llm.push(
                reply().text("child completed").wait(releaseChild.promise).stop(),
                reply().text("parent continued").wait(releaseTurn.promise).stop(),
              )
          } else {
            yield* llm.push(reply().tool("nested", {}), reply().text("continued").wait(releaseTurn.promise).stop())
          }
          yield* recovery.initialize
          yield* runtime.finishStartupRecovery()
          const visible = yield* Effect.promise(() => sdk.session.get({ sessionID: session.id }))
          expect(visible.response.status).toBe(200)
          if (child && cancelledTask) {
            yield* awaitWithTimeout(
              Deferred.await(entered),
              "child prompt preparation did not reach the plugin gate",
              "10 seconds",
            )
            const history = yield* Effect.promise(() => sdk.session.messages({ sessionID: child.id }))
            expect(history.response.status).toBe(200)
            expect(history.data).toHaveLength(scenario === "task-reuse-cancel" ? 2 : 0)
            expect(history.data?.some((message) => message.info.id === childMessageID)).toBe(false)
            expect(yield* llm.calls).toBe(0)
            const beforeStop = yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))
            const running = beforeStop.data?.flatMap((message) => message.parts).find((part) => part.id === taskPartID)
            expect(running?.type === "tool" && running.state.status).toBe("running")
            const stopped = yield* awaitWithTimeout(
              Effect.promise(() => sdk.session.abort({ sessionID: child.id })),
              "child abort blocked on prompt preparation",
              "10 seconds",
            )
            expect(stopped.response.status).toBe(200)
            expect(
              yield* database.db.get(
                sql`SELECT state, desired_active FROM runtime_execution WHERE session_id = ${child.id}`,
              ),
            ).toEqual({ state: "cancelled", desired_active: 0 })
            const childMessages = yield* Effect.promise(() => sdk.session.messages({ sessionID: child.id }))
            expect(childMessages.data).toEqual(history.data)
            yield* awaitWithTimeout(llm.wait(1), "parent did not continue after child cancellation", "10 seconds")
            const parentMessages = yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))
            expect(parentMessages.response.status).toBe(200)
            expect(parentMessages.data?.filter((message) => message.info.id === parentMessageID)).toHaveLength(1)
            const original = parentMessages.data?.find((message) => message.info.id === parentMessageID)
            expect(original?.info.role === "assistant" && original.info.finish).toBe("tool-calls")
            expect(original?.info.role === "assistant" && original.info.time.completed).toBeNumber()
            const task = original?.parts.filter((part) => part.type === "tool" && part.id === taskPartID)
            expect(task).toHaveLength(1)
            expect(task?.[0]?.type === "tool" && task[0].state).toMatchObject({
              status: "error",
              metadata: { sessionId: child.id },
            })
            if (task?.[0]?.type !== "tool" || task[0].state.status !== "error")
              return yield* Effect.die("Cancelled Task did not settle")
            expect(task[0].state.error.toLowerCase()).toContain("cancel")
            expect(task[0].state.error).not.toContain("previous task answer")
            expect(
              parentMessages.data?.filter(
                (message) => message.info.id === MessageID.ascending(`msg_task_summary_${callID}`),
              ),
            ).toHaveLength(1)
            expect(
              parentMessages.data
                ?.flatMap((message) => message.parts)
                .filter((part) => part.id === PartID.ascending(`prt_task_summary_${callID}`)),
            ).toHaveLength(1)
            expect(JSON.stringify((yield* llm.inputs)[0])).toContain(task[0].state.error)
            expect(JSON.stringify((yield* llm.inputs)[0])).not.toContain("previous task answer")
            expect(yield* llm.calls).toBe(1)
            yield* Deferred.succeed(releaseGate, undefined)
            releaseTurn.resolve()
            yield* pollWithTimeout(
              Effect.promise(() => sdk.session.status()).pipe(
                Effect.map((result) => (!result.data?.[session.id] ? true : undefined)),
              ),
              "parent did not finish after child cancellation",
            )
            expect((yield* Effect.promise(() => sdk.session.messages({ sessionID: child.id }))).data).toEqual(
              history.data,
            )
            expect(yield* llm.calls).toBe(1)
            return
          }
          if (child) {
            yield* awaitWithTimeout(llm.wait(1), "reconstructed child did not start", "10 seconds")
            const childRow = yield* database.db.get<{
              parent_session_id: string
              parent_call_id: string
              parent_mode: string
            }>(
              sql`SELECT parent_session_id, parent_call_id, parent_mode FROM runtime_execution WHERE session_id = ${child.id}`,
            )
            expect(childRow).toEqual({
              parent_session_id: session.id,
              parent_call_id: callID,
              parent_mode: "foreground",
            })
            const pending = yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))
            const pendingTask = pending.data?.flatMap((message) => message.parts).find((part) => part.id === taskPartID)
            expect(pendingTask?.type === "tool" && pendingTask.state.status).toBe("running")
            expect(yield* llm.calls).toBe(1)
            releaseChild.resolve()
            yield* awaitWithTimeout(llm.wait(2), "parent did not continue after child settlement", "10 seconds")
            const parentMessages = yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))
            expect(parentMessages.data?.filter((message) => message.info.id === parentMessageID)).toHaveLength(1)
            const original = parentMessages.data?.find((message) => message.info.id === parentMessageID)
            const settled = original?.parts.filter((part) => part.type === "tool" && part.id === taskPartID)
            expect(settled).toHaveLength(1)
            expect(settled?.[0]?.type === "tool" && settled[0].state).toMatchObject({
              status: "completed",
              metadata: { sessionId: child.id },
            })
            if (settled?.[0]?.type !== "tool" || settled[0].state.status !== "completed")
              return yield* Effect.die("Task did not settle")
            expect(settled[0].state.output).toContain("child completed")
            expect(original?.info.role === "assistant" && original.info.finish).toBe("tool-calls")
            const summaryID = MessageID.ascending(`msg_task_summary_${callID}`)
            const summaryPartID = PartID.ascending(`prt_task_summary_${callID}`)
            expect(parentMessages.data?.filter((message) => message.info.id === summaryID)).toHaveLength(1)
            expect(
              parentMessages.data?.flatMap((message) => message.parts).filter((part) => part.id === summaryPartID),
            ).toHaveLength(1)
            const childMessages = yield* Effect.promise(() => sdk.session.messages({ sessionID: child.id }))
            expect(childMessages.data?.filter((message) => message.info.id === childMessageID)).toHaveLength(1)
            expect(
              childMessages.data
                ?.flatMap((message) => message.parts)
                .filter((part) => part.id === PartID.ascending(`prt_task_recovery_${childMessageID}_0`)),
            ).toHaveLength(1)
            expect(JSON.stringify((yield* llm.inputs)[0])).toContain("perform child task")
            expect(JSON.stringify((yield* llm.inputs)[1])).toContain("child completed")
            expect(yield* llm.calls).toBe(2)
            releaseTurn.resolve()
            yield* pollWithTimeout(
              Effect.promise(() => sdk.session.status()).pipe(
                Effect.map((result) => (!result.data?.[session.id] ? true : undefined)),
              ),
              "parent did not finish",
            )
            return
          }
          if (scenario === "foreground") {
            const result = yield* Effect.promise(() =>
              sdk.session.promptAsync({
                sessionID: session.id,
                agent: "build",
                model,
                parts: [{ type: "text", text: "initial request" }],
              }),
            )
            expect(result.response.status).toBe(204)
          }
          if (scenario === "cancel") {
            yield* awaitWithTimeout(
              Deferred.await(entered),
              "nested admission never reached the plugin gate",
              "10 seconds",
            )
            const stopped = yield* awaitWithTimeout(
              Effect.promise(() => sdk.session.abort({ sessionID: session.id })),
              "abort blocked on nested admission",
              "10 seconds",
            )
            expect(stopped.response.status).toBe(200)
            yield* Deferred.succeed(releaseGate, undefined)
            yield* awaitWithTimeout(
              Deferred.await(nestedFinished),
              "nested request did not settle after stop",
              "10 seconds",
            )
            yield* pollWithTimeout(
              database.db
                .get<{
                  state: string
                  desired_active: number
                }>(sql`SELECT state, desired_active FROM runtime_execution WHERE session_id = ${session.id}`)
                .pipe(Effect.map((row) => (row?.state === "cancelled" && row.desired_active === 0 ? true : undefined))),
              "cancelled execution did not settle",
            )
            const before = yield* llm.calls
            expect(before).toBe(1)
            const messages = yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))
            expect(messages.response.status).toBe(200)
            expect(
              messages.data
                ?.flatMap((message) => message.parts)
                .filter((part) => part.type === "text" && part.text === "nested notification"),
            ).toHaveLength(1)
            const tools = messages.data
              ?.flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
              .filter((part) => part.tool === "nested")
            expect(tools).toHaveLength(1)
            expect(tools?.[0]?.state).toMatchObject({ status: "error", metadata: { interrupted: true } })
            expect(yield* runtime.beforeTurn(session.id)).toBe(false)
            const late = yield* Effect.promise(() =>
              sdk.session.prompt({
                sessionID: session.id,
                agent: "build",
                model,
                noReply: true,
                parts: [{ type: "text", text: "late notification" }],
              }),
            )
            expect(late.response.status).toBe(409)
            expect(
              yield* database.db.get(
                sql`SELECT state, desired_active FROM runtime_execution WHERE session_id = ${session.id}`,
              ),
            ).toEqual({ state: "cancelled", desired_active: 0 })
            const afterLate = yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))
            expect(
              afterLate.data
                ?.flatMap((message) => message.parts)
                .filter((part) => part.type === "text" && part.text === "late notification"),
            ).toHaveLength(0)
            expect(
              afterLate.data
                ?.flatMap((message) => message.parts)
                .filter((part) => part.type === "text" && part.text === "nested notification"),
            ).toHaveLength(1)
            expect(yield* llm.calls).toBe(1)
            releaseTurn.resolve()
            const next = yield* Effect.promise(() =>
              sdk.session.prompt({
                sessionID: session.id,
                agent: "build",
                model,
                parts: [{ type: "text", text: "fresh request" }],
              }),
            )
            expect(next.response.status).toBe(200)
            expect(next.data?.parts.some((part) => part.type === "text" && part.text === "continued")).toBe(true)
            expect(yield* llm.calls).toBe(2)
            const final = yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))
            expect(
              final.data
                ?.flatMap((message) => message.parts)
                .filter((part) => part.type === "tool" && part.tool === "nested"),
            ).toHaveLength(1)
            expect(
              final.data
                ?.flatMap((message) => message.parts)
                .filter((part) => part.type === "text" && part.text === "nested notification"),
            ).toHaveLength(1)
            return
          }
          yield* awaitWithTimeout(llm.wait(2), "nested notification did not reach the next provider turn", "10 seconds")
          const row = yield* database.db.get<{ state: string; desired_active: number; owner_instance: string }>(
            sql`SELECT state, desired_active, owner_instance FROM runtime_execution WHERE session_id = ${session.id}`,
          )
          expect(row).toEqual({ state: "active", desired_active: 1, owner_instance: runtime.identity.instance })
          const messages = yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))
          expect(messages.response.status).toBe(200)
          expect(
            messages.data
              ?.flatMap((message) => message.parts)
              .filter((part) => part.type === "text" && part.text === "nested notification"),
          ).toHaveLength(1)
          const tools = messages.data
            ?.flatMap((message) => message.parts)
            .filter((part) => part.type === "tool")
            .filter((part) => part.tool === "nested")
          expect(tools).toHaveLength(1)
          expect(tools?.[0]?.state).toMatchObject({ status: "completed", output: "notification delivered" })
          releaseTurn.resolve()
          yield* pollWithTimeout(
            Effect.promise(() => sdk.session.status()).pipe(
              Effect.map((result) => (!result.data?.[session.id] ? true : undefined)),
            ),
            "session did not finish",
          )
        }),
      30_000,
    )
  }
})
