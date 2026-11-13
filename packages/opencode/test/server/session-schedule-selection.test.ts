import { expect } from "bun:test"
import { Context, Effect, Fiber, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
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
import { waitGlobalBusEvent } from "./global-bus"

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

for (const [changed, variant] of [
  [false, "xhigh"],
  [true, "xhigh"],
  [false, "default"],
] as const) {
  it.live(
    `scheduled delivery preserves the selected agent, model and variant ${variant}${changed ? " after a later selection change" : ""}`,
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
            variant,
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
          variant,
          selection: { variant },
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
          model: { providerID: "test", modelID: "selected", variant },
        })
        yield* awaitWithTimeout(llm.wait(1), "scheduled LLM was not invoked")
        const request = yield* pollWithTimeout(
          llm.inputs.pipe(
            Effect.map((inputs) => inputs.find((input) => JSON.stringify(input).includes('"scheduled"'))),
          ),
          "scheduled message did not reach the LLM",
        )
        expect(request.model).toBe("selected")
        if (variant === "xhigh") expect(request).toMatchObject({ reasoning_effort: "xhigh" })
        if (variant === "default") expect(request).not.toHaveProperty("reasoning_effort")
        const current = (yield* Effect.promise(() => sdk.session.get({ sessionID: session.id }))).data
        expect(current).toMatchObject({
          agent: changed ? "build" : "selected",
          model: {
            providerID: "test",
            id: changed ? "test-model" : "selected",
            variant: changed ? "default" : variant,
          },
        })
        const historyURL = new URL(`${url.pathname}/${accepted?.origin?.scheduleID}/history`, url)
        historyURL.searchParams.set("directory", directory)
        const history = yield* pollWithTimeout(
          Effect.promise(async () => {
            const history = (await (await fetch(historyURL)).json()) as SessionScheduleV1.History
            return history.items[0]?.state === "delivered" ? history : undefined
          }),
          "scheduled delivery was not reconciled",
        )
        expect(history.items).toHaveLength(1)
        expect(history.items[0].id).toBe(accepted?.id ?? "missing")
        expect((yield* llm.inputs).filter((input) => JSON.stringify(input).includes('"scheduled"'))).toHaveLength(1)
      }),
    30_000,
  )
}

for (const delivery of ["scheduled", "resume", "flush"] as const) {
  it.live(
    `${delivery} delivery retains a scheduled occurrence until its missing variant is restored`,
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const config = testProviderConfig(llm.url)
        const projectConfig = {
          ...config,
          model: "test/test-model",
          provider: {
            test: {
              ...config.provider.test,
              models: {
                ...config.provider.test.models,
                selected: {
                  ...config.provider.test.models["test-model"],
                  id: "selected",
                  variants: { xhigh: { reasoningEffort: "xhigh" } },
                },
              },
            },
          },
        }
        const directory = yield* tmpdirScoped({ git: true, config: projectConfig })
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const sdk = createOpencodeClient({ baseUrl: listener.url.toString(), directory, throwOnError: true })
        const request = (pathname: string, body?: unknown, method = "POST") =>
          Effect.promise(async () => {
            const url = new URL(pathname, listener.url)
            url.searchParams.set("directory", directory)
            const response = await fetch(url, {
              method,
              headers: { "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            })
            expect(response.status).toBe(200)
            return response
          })
        const session = (yield* Effect.promise(() => sdk.session.create({ title: "variant recovery" }))).data!
        yield* llm.text("initial selection response")
        yield* Effect.promise(() =>
          sdk.session.prompt({
            sessionID: session.id,
            model: { providerID: "test", modelID: "selected" },
            variant: "xhigh",
            parts: [{ type: "text", text: "select xhigh" }],
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
        const root = `/session/${session.id}/schedule`
        yield* request(root, {
          message: "wait for xhigh",
          spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
          sessionState: "always",
          deferUntilIdle: false,
          missed: "all",
          limit: 1,
        })
        const accepted = yield* pollWithTimeout(
          Effect.promise(async () => {
            const queue = (await sdk.session.queueList({ sessionID: session.id })).data!
            return queue.items.find((entry) => entry.origin?.type === "scheduled")
          }),
          "scheduled snapshot was not accepted",
        )
        if (!accepted.origin) return yield* Effect.die("Missing scheduled origin")
        const historyURL = `${root}/${accepted.origin.scheduleID}/history`
        const history = () =>
          request(historyURL, undefined, "GET").pipe(
            Effect.flatMap((response) => Effect.promise(() => response.json() as Promise<SessionScheduleV1.History>)),
          )
        const configure = (disabled: boolean) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                `${directory}/opencode.json`,
                JSON.stringify({
                  ...projectConfig,
                  provider: {
                    test: {
                      ...projectConfig.provider.test,
                      models: {
                        ...projectConfig.provider.test.models,
                        selected: {
                          ...projectConfig.provider.test.models.selected,
                          variants: { xhigh: { reasoningEffort: "xhigh", disabled } },
                        },
                      },
                    },
                  },
                }),
              ),
            )
            const disposed = yield* waitGlobalBusEvent({
              predicate: (event) => event.directory === directory && event.payload.type === "server.instance.disposed",
            }).pipe(Effect.forkScoped({ startImmediately: true }))
            yield* request("/instance/dispose")
            yield* Fiber.join(disposed)
          })
        yield* configure(true)
        const providers = yield* request("/provider", undefined, "GET").pipe(
          Effect.flatMap((response) =>
            Effect.promise(
              () =>
                response.json() as Promise<{
                  all: { id: string; models: Record<string, { variants?: Record<string, unknown> }> }[]
                }>,
            ),
          ),
        )
        expect(providers.all.find((provider) => provider.id === "test")?.models.selected.variants).not.toHaveProperty(
          "xhigh",
        )
        yield* llm.text("restored variant response")
        if (delivery === "resume") {
          const queue = (yield* Effect.promise(() => sdk.session.queueList({ sessionID: session.id }))).data!
          yield* Effect.promise(() =>
            sdk.session.queueUpdate({
              sessionID: session.id,
              revision: queue.revision,
              mutation: { action: "pause", paused: false },
            }),
          )
        }
        if (delivery === "flush") yield* Effect.promise(() => sdk.session.queueFlush({ sessionID: session.id }))
        const rejected = yield* pollWithTimeout(
          history().pipe(Effect.map((value) => (value.items[0]?.error?.includes("xhigh") ? value : undefined))),
          "missing scheduled variant was not diagnosed",
        )
        expect(rejected.items[0]).toMatchObject({ id: accepted.id, state: "accepted" })
        expect(rejected.items[0].error).toContain("test/selected")
        const retained = (yield* Effect.promise(() => sdk.session.queueList({ sessionID: session.id }))).data!
        expect(retained.items.find((entry) => entry.id === accepted.id)).toMatchObject({
          state: "pending",
          payload: accepted.payload,
          origin: accepted.origin,
        })
        expect(yield* llm.calls).toBe(1)
        const messages = (yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))).data!
        expect(messages.filter((message) => message.info.role === "user" && message.info.origin)).toEqual([])
        const schedules = yield* request(root, undefined, "GET").pipe(
          Effect.flatMap((response) => Effect.promise(() => response.json() as Promise<SessionScheduleV1.Info[]>)),
        )
        expect(schedules[0].completed).toBe(0)
        yield* configure(false)
        const queue = (yield* Effect.promise(() => sdk.session.queueList({ sessionID: session.id }))).data!
        yield* Effect.promise(() =>
          sdk.session.queueUpdate({
            sessionID: session.id,
            revision: queue.revision,
            mutation: { action: "pause", paused: false },
          }),
        )
        yield* pollWithTimeout(
          history().pipe(Effect.map((value) => (value.items[0]?.state === "delivered" ? value : undefined))),
          "restored variant did not deliver",
        )
        yield* awaitWithTimeout(llm.wait(2), "restored scheduled message did not execute")
        const delivered = (yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))).data!.filter(
          (message) => message.info.role === "user" && message.info.origin,
        )
        expect(delivered).toHaveLength(1)
        expect(delivered[0].info).toMatchObject({ model: { modelID: "selected", variant: "xhigh" } })
        const completed = yield* request(root, undefined, "GET").pipe(
          Effect.flatMap((response) => Effect.promise(() => response.json() as Promise<SessionScheduleV1.Info[]>)),
        )
        expect(completed[0]).toMatchObject({ status: "completed", completed: 1 })
        expect((yield* Effect.promise(() => sdk.session.get({ sessionID: session.id }))).data?.model).toMatchObject({
          id: "selected",
          variant: "xhigh",
        })
        yield* Effect.promise(() => sdk.session.queueFlush({ sessionID: session.id }))
        expect(yield* llm.calls).toBe(2)
        expect((yield* history()).items).toHaveLength(1)
        if (delivery === "scheduled") {
          yield* llm.text("ordinary queued response")
          yield* Effect.promise(() =>
            sdk.session.queueSubmit({
              sessionID: session.id,
              id: "ordinary-fallback",
              payload: {
                kind: "prompt",
                agent: "build",
                model: { providerID: "test", modelID: "selected" },
                variant: "missing-manual-variant",
                selection: {},
                parts: [{ type: "text", text: "ordinary fallback" }],
              },
            }),
          )
          yield* awaitWithTimeout(llm.wait(3), "ordinary queue fallback did not execute")
          const ordinary = yield* pollWithTimeout(
            Effect.promise(async () => {
              const messages = (await sdk.session.messages({ sessionID: session.id })).data ?? []
              return messages.find((message) =>
                message.parts.some((part) => part.type === "text" && part.text === "ordinary fallback"),
              )
            }),
            "ordinary queued message did not materialize",
          )
          expect(ordinary.info).toMatchObject({ model: { modelID: "selected", variant: "default" } })
          expect((yield* Effect.promise(() => sdk.session.get({ sessionID: session.id }))).data?.model).toMatchObject({
            id: "selected",
            variant: "xhigh",
          })
        }
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

for (const missing of ["agent", "model", "variant", "agent variant"] as const) {
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
            model:
              missing === "agent variant"
                ? null
                : {
                    providerID: "test",
                    id: missing === "model" ? "missing-model" : "test-model",
                    ...(missing === "variant" ? { variant: "xhigh" } : {}),
                  },
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
          schedules.history(session.id, schedule.id).pipe(Effect.map((history) => history.items[0])),
          "unavailable selection did not fail",
        )
        expect(occurrence.state).toBe("failed")
        expect(occurrence.error).toContain(
          missing === "agent" ? "Scheduled agent is unavailable" : missing === "model" ? "missing-model" : "xhigh",
        )
        if (missing === "variant" || missing === "agent variant") expect(occurrence.error).toContain("test/test-model")
        expect((yield* queue.list(session.id)).items).toEqual([])
      }),
    {
      config: {
        ...testProviderConfig("http://127.0.0.1:1"),
        ...(missing === "agent variant" ? { agent: { build: { model: "test/test-model", variant: "xhigh" } } } : {}),
      },
    },
  )
}
