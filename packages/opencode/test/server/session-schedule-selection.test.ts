import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "../../src/server/server"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { ServerScheduler } from "../../src/server/scheduler"
import { Session } from "../../src/session/session"
import { SessionSchedule } from "../../src/session/schedule"
import { SessionQueue } from "../../src/session/queue"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  Layer.mergeAll(TestLLMServer.layer, NodeServices.layer).pipe(
    Layer.provide(
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await disposeAllInstances()
            await resetDatabase()
            RuntimeLifecycle.setCurrent(RuntimeLifecycle.unavailable())
          }),
        ),
      ),
    ),
  ),
)

for (const changed of [false, true]) {
  it.live(
    `scheduled delivery preserves the selected agent, model and variant${changed ? " after a later selection change" : ""}`,
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const config = testProviderConfig(llm.url)
        const model = config.provider.test.models["test-model"]
        const directory = yield* tmpdirScoped({
          git: true,
          config: {
            ...config,
            model: "test/test-model",
            agent: { build: { model: "test/test-model" }, selected: { mode: "primary", model: "test/test-model" } },
            provider: {
              test: {
                ...config.provider.test,
                models: {
                  "test-model": model,
                  selected: { ...model, id: "selected", variants: { xhigh: { reasoningEffort: "xhigh" } } },
                },
              },
            },
          },
        })
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.toString(), directory, throwOnError: true })
        const session = (yield* Effect.promise(() => sdk.session.create({ title: "selection" }))).data!
        yield* Effect.promise(() =>
          sdk.session.prompt({
            sessionID: session.id,
            agent: "selected",
            model: { providerID: "test", modelID: "selected" },
            variant: "xhigh",
            noReply: true,
            parts: [{ type: "text", text: "select" }],
          }),
        )
        const initial = (yield* Effect.promise(() => sdk.session.queueList({ sessionID: session.id }))).data!
        yield* Effect.promise(() =>
          sdk.session.queueUpdate({
            sessionID: session.id,
            revision: initial.revision,
            mutation: { action: "pause", paused: true },
          }),
        )
        yield* llm.text("scheduled response")
        const url = new URL(`/session/${session.id}/schedule`, listener.url)
        url.searchParams.set("directory", directory)
        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message: "scheduled",
              spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
              sessionState: "always",
              deferUntilIdle: false,
              missed: "all",
              limit: 1,
            }),
          }),
        )
        expect(response.status).toBe(200)
        const queue = yield* pollWithTimeout(
          Effect.gen(function* () {
            const value = (yield* Effect.promise(() => sdk.session.queueList({ sessionID: session.id }))).data
            return value?.items.some((item) => item.origin?.type === "scheduled") ? value : undefined
          }),
          "scheduled message not accepted",
        )
        const accepted = queue.items.find((item) => item.origin?.type === "scheduled")
        expect(accepted?.payload).toMatchObject({
          model: { providerID: "test", modelID: "selected" },
          variant: "xhigh",
        })
        if (changed)
          yield* Effect.promise(() =>
            sdk.session.prompt({
              sessionID: session.id,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              noReply: true,
              parts: [{ type: "text", text: "change selection" }],
            }),
          )
        const beforeResume = (yield* Effect.promise(() => sdk.session.queueList({ sessionID: session.id }))).data!
        yield* Effect.promise(() =>
          sdk.session.queueUpdate({
            sessionID: session.id,
            revision: beforeResume.revision,
            mutation: { action: "pause", paused: false },
          }),
        )
        const user = yield* pollWithTimeout(
          Effect.gen(function* () {
            const messages = (yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))).data ?? []
            return messages.find((message) => message.info.role === "user" && message.info.origin?.type === "scheduled")
          }),
          "scheduled message not delivered",
        )
        expect(user.info).toMatchObject({
          agent: "selected",
          model: { providerID: "test", modelID: "selected", variant: "xhigh" },
        })
        yield* awaitWithTimeout(llm.wait(1), "scheduled LLM was not invoked")
        const request = yield* pollWithTimeout(
          llm.inputs.pipe(
            Effect.map((inputs) => inputs.find((input) => JSON.stringify(input).includes('"scheduled"'))),
          ),
          "scheduled message did not reach the LLM",
        )
        expect(request.model).toBe("selected")
        const current = (yield* Effect.promise(() => sdk.session.get({ sessionID: session.id }))).data
        expect(current).toMatchObject({
          agent: changed ? "build" : "selected",
          model: {
            providerID: "test",
            id: changed ? "test-model" : "selected",
            variant: changed ? "default" : "xhigh",
          },
        })
      }),
    30_000,
  )
}

for (const scenario of ["agent", "latest", "provider"] as const) {
  it.live(
    `scheduled delivery falls back to the ${scenario} model without a session selection`,
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const config = testProviderConfig(llm.url)
        const model = config.provider.test.models["test-model"]
        const directory = yield* tmpdirScoped({
          git: true,
          config: {
            ...config,
            model: "test/test-model",
            default_agent: "fallback",
            agent: {
              fallback: {
                mode: "primary",
                ...(scenario === "agent" ? { model: "test/agent-model", variant: "high" } : {}),
              },
            },
            provider: {
              test: {
                ...config.provider.test,
                models: {
                  "test-model": model,
                  "agent-model": { ...model, id: "agent-model", variants: { high: { reasoningEffort: "high" } } },
                  "history-model": { ...model, id: "history-model", variants: { xhigh: { reasoningEffort: "xhigh" } } },
                },
              },
            },
          },
        })
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.toString(), directory, throwOnError: true })
        const session = (yield* Effect.promise(() => sdk.session.create({ title: `fallback ${scenario}` }))).data!
        if (scenario !== "provider") {
          yield* Effect.promise(() =>
            sdk.session.prompt({
              sessionID: session.id,
              agent: "fallback",
              model: { providerID: "test", modelID: "history-model" },
              variant: "xhigh",
              selection: {},
              noReply: true,
              parts: [{ type: "text", text: "history" }],
            }),
          )
        }
        expect((yield* Effect.promise(() => sdk.session.get({ sessionID: session.id }))).data?.model).toBeUndefined()
        yield* llm.text("fallback response")
        const url = new URL(`/session/${session.id}/schedule`, listener.url)
        url.searchParams.set("directory", directory)
        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message: "fallback scheduled",
              spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
              sessionState: "always",
              deferUntilIdle: false,
              missed: "all",
              limit: 1,
            }),
          }),
        )
        expect(response.status).toBe(200)
        const user = yield* pollWithTimeout(
          Effect.gen(function* () {
            const messages = (yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))).data ?? []
            return messages.find((message) => message.info.role === "user" && message.info.origin?.type === "scheduled")
          }),
          "fallback scheduled message not delivered",
        )
        expect(user.info).toMatchObject({
          agent: "fallback",
          model: {
            providerID: "test",
            modelID: scenario === "agent" ? "agent-model" : scenario === "latest" ? "history-model" : "test-model",
            variant: scenario === "agent" ? "high" : scenario === "latest" ? "xhigh" : "default",
          },
        })
        yield* awaitWithTimeout(llm.wait(1), "fallback LLM was not invoked")
        const request = yield* pollWithTimeout(
          llm.inputs.pipe(
            Effect.map((inputs) => inputs.find((input) => JSON.stringify(input).includes("fallback scheduled"))),
          ),
          "fallback scheduled message did not reach the LLM",
        )
        expect(request.model).toBe(
          scenario === "agent" ? "agent-model" : scenario === "latest" ? "history-model" : "test-model",
        )
        expect((yield* Effect.promise(() => sdk.session.get({ sessionID: session.id }))).data?.model).toBeUndefined()
      }),
    30_000,
  )
}

const workerTest = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionSchedule.node,
      SessionQueue.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
    ]),
  ),
)

for (const missing of ["agent", "model"] as const) {
  workerTest.instance(
    `records a failed occurrence for an unavailable selected ${missing}`,
    () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const sessions = yield* Session.Service
        const schedules = yield* SessionSchedule.Service
        const queue = yield* SessionQueue.Service
        const session = yield* sessions.create({})
        yield* Effect.addFinalizer(() =>
          database.db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie),
        )
        yield* database.db
          .update(SessionTable)
          .set({
            agent: missing === "agent" ? "missing-agent" : "build",
            model: { providerID: "test", id: missing === "model" ? "missing-model" : "test-model" },
          })
          .where(eq(SessionTable.id, session.id))
          .run()
        const schedule = yield* schedules.create(session.id, {
          message: "unavailable",
          spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
          sessionState: "always",
          deferUntilIdle: false,
          missed: "all",
          limit: 1,
        })
        const context = yield* Layer.build(
          ServerScheduler.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                LayerNode.compile(
                  LayerNode.group([
                    Database.node,
                    InstanceStore.node,
                    Agent.node,
                    Provider.node,
                    SessionStatus.node,
                    EventV2Bridge.node,
                  ]),
                  [
                    [Database.node, Layer.succeed(Database.Service, database)],
                    [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
                  ],
                ),
                Layer.succeed(SessionQueue.Service, queue),
                Layer.succeed(RuntimeLifecycle.Service, RuntimeLifecycle.unavailable()),
                Layer.mock(SessionPrompt.Service, {
                  queueSubmitScheduled: () => Effect.die("unavailable selection was dispatched"),
                }),
              ),
            ),
          ),
        )
        yield* Context.get(context, ServerScheduler.Service).start
        const occurrence = yield* pollWithTimeout(
          schedules
            .history(session.id, schedule.id)
            .pipe(Effect.map((history) => (history.items[0]?.state === "failed" ? history.items[0] : undefined))),
          "unavailable selection did not fail",
        )
        expect(occurrence.error).toContain(missing === "agent" ? "Scheduled agent is unavailable" : "missing-model")
        expect((yield* queue.list(session.id)).items).toEqual([])
      }),
    { config: testProviderConfig("http://127.0.0.1:1") },
  )
}
