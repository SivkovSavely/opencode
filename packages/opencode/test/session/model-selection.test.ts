import { expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionQueue } from "@/session/queue"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, LayerNode.compile(CrossSpawnSpawner.node)))

it.live("session_control sends the selected model variant to the provider", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const config = testProviderConfig(llm.url)
    const directory = yield* tmpdirScoped({
      git: true,
      config: {
        ...config,
        model: "test/test-model",
        provider: {
          test: {
            ...config.provider.test,
            models: {
              "test-model": {
                ...config.provider.test.models["test-model"],
                variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
              },
            },
          },
        },
      },
    })
    const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope)
    const context = yield* Layer.build(
      AppNodeBuilderV1.build(
        LayerNode.group([
          Session.node,
          SessionPrompt.node,
          SessionQueue.node,
          ToolRegistry.node,
          Agent.node,
          Permission.node,
          InstanceStore.node,
          Database.node,
          SessionProjector.node,
        ]),
      ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime))),
    )
    runtime.bindDatabase(Context.get(context, Database.Service))
    const store = Context.get(context, InstanceStore.Service)
    yield* store.provide(
      { directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const registry = yield* ToolRegistry.Service
        const caller = yield* sessions.create({ title: "controller" })
        const tool = (yield* registry.all()).find((item) => item.id === "session_control")
        if (!tool) throw new Error("session_control is not registered")
        const ctx: Tool.Context = {
          sessionID: caller.id,
          messageID: MessageID.ascending(),
          callID: randomUUID(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          extra: { sessionControlOps: prompt },
          ask: () => Effect.void,
        }
        for (const [index, selection] of [
          { model: "test/test-model#low", variant: undefined, expected: "low" },
          { model: "test/test-model#low", variant: "high", expected: "high" },
        ].entries()) {
          const before = (yield* llm.inputs).length
          yield* llm.text("response")
          const result = JSON.parse(
            (yield* tool.execute(
              {
                action: "create",
                model: selection.model,
                variant: selection.variant,
                prompt: "hello",
                requestID: `variant-${index}`,
              },
              ctx,
            )).output,
          )
          const id = SessionID.make(result.sessionID)
          const request = yield* pollWithTimeout(
            llm.inputs.pipe(
              Effect.map((inputs) =>
                inputs.slice(before).find((input) => Array.isArray(input.tools) && input.tools.length > 0),
              ),
            ),
            "provider request did not start",
          )
          yield* awaitWithTimeout(runtime.waitForIdle(id), "session did not finish")
          const users = (yield* sessions.messages({ sessionID: id })).filter((message) => message.info.role === "user")
          expect(users).toHaveLength(1)
          expect(users[0]?.info).toMatchObject({
            model: { providerID: "test", modelID: "test-model", variant: selection.expected },
          })
          expect(request.model).toBe("test-model")
          expect(request.reasoning_effort).toBe(selection.expected)
        }
      }).pipe(Effect.provide(context), Effect.provideService(RuntimeLifecycle.Service, runtime)),
    )
  }),
)
