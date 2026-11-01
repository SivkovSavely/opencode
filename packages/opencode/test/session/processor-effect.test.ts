import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import path from "path"
import z from "zod"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { EffectBridge } from "@/effect/bridge"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

const ownedRuntimeEnv = env.pipe(
  Layer.provideMerge(
    Layer.effect(
      RuntimeLifecycle.Service,
      Effect.gen(function* () {
        const database = yield* Database.Service
        const scope = yield* Scope.Scope
        const previous = RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable()
        const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, scope, database)
        RuntimeLifecycle.setCurrent(runtime)
        yield* Effect.addFinalizer(() => Effect.sync(() => RuntimeLifecycle.setCurrent(previous)))
        return runtime
      }),
    ).pipe(Layer.provide(LayerNode.compile(Database.node))),
  ),
)
const itOwnedRuntime = testEffect(ownedRuntimeEnv)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry OpenAI-compatible midstream server errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(raw({ chunks: [{ error: { type: "server_error", code: "server_error", message: "xxx" } }] }))
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry midstream server error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry midstream server error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor records reused tool call IDs on provider retry", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const bridge = yield* EffectBridge.make()
        const completed = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => completed.resolve()))
        const first = reply().tool("lookup", { query: "first" }).item()
        if (first.type !== "sse") throw new Error("expected stream")
        yield* llm.push(
          raw({
            head: [...first.head, ...first.tail],
            wait: completed.promise,
            tail: [{ error: { type: "server_error", code: "server_error", message: "connection lost" } }],
          }),
          reply().tool("lookup", { query: "second" }),
        )
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const executed: string[] = []
        const off = yield* events.listen((event) => {
          if (event.type !== SessionV1.Event.PartUpdated.type) return Effect.void
          const data = event.data as typeof SessionV1.Event.PartUpdated.data.Type
          if (
            data.part.messageID === msg.id &&
            data.part.type === "tool" &&
            data.part.state.status === "completed" &&
            data.part.state.output === "first"
          )
            completed.resolve()
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)
        const result = yield* handle.process({
          user: parent,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry tool" }],
          tools: {
            lookup: tool({
              inputSchema: z.object({ query: z.string() }),
              execute: (input, options) => {
                const call = handle.toolCall(options.toolCallId)
                return bridge.promise(
                  Effect.gen(function* () {
                    executed.push(input.query)
                    const metadata = { sessionId: `ses_${input.query}` }
                    yield* call.update((part) => ({
                      ...part,
                      state: { status: "running", input, metadata, time: { start: Date.now() } },
                    }))
                    return { title: input.query, output: input.query, metadata }
                  }),
                )
              },
            }),
          },
        })
        const calls = (yield* MessageV2.parts(msg.id)).filter((part) => part.type === "tool")
        expect(result).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(executed).toEqual(["first", "second"])
        expect(calls).toHaveLength(2)
        expect(calls.map((part) => part.callID)).toEqual(["call_1", "call_1"])
        expect(calls.map((part) => part.state)).toMatchObject([
          { status: "completed", input: { query: "first" }, output: "first", metadata: { sessionId: "ses_first" } },
          { status: "completed", input: { query: "second" }, output: "second", metadata: { sessionId: "ses_second" } },
        ])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

for (const phase of ["before retry registration", "while retry is running"] as const) {
  it.live(`session.processor isolates aborted tool callbacks ${phase}`, () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const events = yield* EventV2Bridge.Service
          const bridge = yield* EffectBridge.make()
          const started = Promise.withResolvers<void>()
          const entered = yield* Deferred.make<void>()
          const resume = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const completing = yield* Deferred.make<void>()
          const finished = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => started.resolve()))
          const first = reply().tool("lookup", { query: "first" }).item()
          if (first.type !== "sse") throw new Error("expected stream")
          yield* llm.push(
            raw({
              head: [...first.head, ...first.tail],
              wait: started.promise,
              tail: [{ error: { type: "server_error", code: "server_error", message: "connection lost" } }],
            }),
            reply().tool("lookup", { query: "second" }),
          )
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "retry tool")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
          const executed: string[] = []
          let steps = 0
          let gated = false
          const off = yield* events.listen((event) => {
            if (event.type !== SessionV1.Event.PartUpdated.type) return Effect.void
            const data = event.data as typeof SessionV1.Event.PartUpdated.data.Type
            if (data.part.messageID !== msg.id) return Effect.void
            if (data.part.type === "step-start") steps++
            if (
              data.part.type === "tool" &&
              data.part.state.status === "running" &&
              data.part.state.metadata?.sessionId === "ses_first"
            )
              started.resolve()
            const blocked =
              phase === "before retry registration"
                ? steps === 2 && data.part.type === "step-start"
                : data.part.type === "tool" &&
                  data.part.state.status === "running" &&
                  data.part.state.input.query === "second"
            if (!blocked || gated) return Effect.void
            gated = true
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
          })
          yield* Effect.addFinalizer(() => off)
          const processing = yield* handle
            .process({
              user: parent,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "retry tool" }],
              tools: {
                lookup: tool({
                  inputSchema: z.object({ query: z.string() }),
                  execute: (input, options) => {
                    const call = handle.toolCall(options.toolCallId)
                    return bridge.promise(
                      Effect.gen(function* () {
                        executed.push(input.query)
                        const metadata = { sessionId: `ses_${input.query}` }
                        yield* call.update((part) => ({
                          ...part,
                          state: { status: "running", input, metadata, time: { start: Date.now() } },
                        }))
                        const output = { title: input.query, output: input.query, metadata }
                        if (input.query === "second") {
                          yield* Deferred.await(finished)
                          return output
                        }
                        yield* Deferred.await(release)
                        expect(options.abortSignal?.aborted).toBe(true)
                        yield* Deferred.succeed(completing, undefined)
                        yield* call.complete(output)
                        yield* Deferred.succeed(finished, undefined)
                        return output
                      }),
                    )
                  },
                }),
              },
            })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(completing)
          if (phase === "before retry registration") yield* Deferred.await(finished)
          yield* Deferred.succeed(resume, undefined)
          expect(yield* Fiber.join(processing)).toBe("continue")
          const calls = (yield* MessageV2.parts(msg.id)).filter((part) => part.type === "tool")
          expect(yield* llm.calls).toBe(2)
          expect(executed).toEqual(["first", "second"])
          expect(calls).toHaveLength(2)
          expect(calls.map((part) => part.callID)).toEqual(["call_1", "call_1"])
          expect(calls.map((part) => part.state)).toMatchObject([
            { status: "completed", input: { query: "first" }, output: "first", metadata: { sessionId: "ses_first" } },
            { status: "completed", input: { query: "second" }, output: "second", metadata: { sessionId: "ses_second" } },
          ])
        }),
      { config: (url) => providerCfg(url) },
    ),
  )
}

it.live("session.processor effect tests retry network_error finish reasons", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-network-error",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
              },
            ],
          }),
        )
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry network error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry network error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after retry")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itOwnedRuntime.live("session.processor resumes the owned execution on manual retry and rejects the old generation", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const runtime = yield* RuntimeLifecycle.Service
        const database = yield* Database.Service
        const events = yield* EventV2Bridge.Service
        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } }, { "retry-after-ms": "600000" })
        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } }, { "retry-after-ms": "600000" })
        yield* llm.text("after manual retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "manual retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const first = yield* Deferred.make<{ attempt: number; next: number }>()
        const second = yield* Deferred.make<{ attempt: number; next: number }>()
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID !== chat.id || data.status.type !== "retry") return Effect.void
          if (data.status.attempt === 1) return Deferred.succeed(first, data.status)
          if (data.status.attempt === 2) return Deferred.succeed(second, data.status)
          return Effect.void
        })
        yield* runtime.admit({ sessionID: chat.id, directory: dir })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const fiber = yield* Effect.forkScoped(
          handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "manual retry" }],
            tools: {},
          }),
        )

        const scheduled = yield* Deferred.await(first)
        expect(yield* llm.calls).toBe(1)
        expect(scheduled.next).toBeGreaterThan(Date.now() + 500_000)
        const waitingExecution = yield* database.db.get<{ id: string; fence: number; state: string; retry_at: number }>(sql`
          SELECT id, fence, state, retry_at FROM runtime_execution WHERE session_id = ${chat.id}
        `)
        expect(waitingExecution).toMatchObject({ state: "retry_wait", retry_at: scheduled.next })
        expect(scheduled.attempt).toBe(1)
        expect(yield* runtime.wakeRetry(chat.id, scheduled.attempt, scheduled.next)).toBe(true)
        expect(yield* runtime.wakeRetry(chat.id, scheduled.attempt, scheduled.next)).toBe(false)
        yield* llm.wait(2)
        expect(yield* llm.calls).toBe(2)
        expect(yield* database.db.get<{ id: string; fence: number; state: string }>(sql`
          SELECT id, fence, state FROM runtime_execution WHERE session_id = ${chat.id}
        `)).toMatchObject({ id: waitingExecution?.id, fence: waitingExecution?.fence, state: "active" })

        const next = yield* Deferred.await(second)
        expect(next.attempt).toBe(2)
        expect(next.next).toBeGreaterThan(Date.now() + 500_000)
        expect(yield* runtime.wakeRetry(chat.id, scheduled.attempt, scheduled.next)).toBe(false)
        expect(yield* runtime.wakeRetry(chat.id, next.attempt, next.next)).toBe(true)
        yield* llm.wait(3)
        expect(yield* llm.calls).toBe(3)
        expect(yield* Fiber.join(fiber)).toBe("continue")
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "after manual retry")).toBe(true)
        expect(handle.message.error).toBeUndefined()
        yield* off
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

for (const phase of ["before registration", "during registration", "during tool call"] as const) {
  it.live(`session.processor retains AI SDK metadata emitted ${phase}`, () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const events = yield* EventV2Bridge.Service
          const bridge = yield* EffectBridge.make()
          const early = yield* Deferred.make<void>()
          const entered = yield* Deferred.make<void>()
          const reporting = yield* Deferred.make<void>()
          yield* llm.tool("lookup", { query: "weather" })
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "tool")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
          const order: string[] = []
          // Gate the stream consumer while the real AI SDK dispatches and reports progress.
          const off = yield* events.listen((event) => {
            if (event.type !== SessionV1.Event.PartUpdated.type) return Effect.void
            const data = event.data as typeof SessionV1.Event.PartUpdated.data.Type
            if (data.part.messageID !== msg.id) return Effect.void
            const blocked =
              phase === "before registration"
                ? data.part.type === "step-start"
                : data.part.type === "tool" &&
                  data.part.state.status === (phase === "during registration" ? "pending" : "running")
            if (!blocked) return Effect.void
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(early)))
          })
          yield* Effect.addFinalizer(() => off)
          const processing = yield* handle
            .process({
              user: parent,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "tool" }],
              tools: {
                lookup: tool({
                  description: "Look up information",
                  inputSchema: z.object({ query: z.string() }),
                  execute: (input, options): Promise<string> => {
                    const call = handle.toolCall(options.toolCallId)
                    return bridge.promise(
                      Effect.gen(function* () {
                        yield* Deferred.await(entered)
                        if (phase === "before registration")
                          expect((yield* MessageV2.parts(msg.id)).some((part) => part.type === "tool")).toBe(false)
                        order.push(`metadata ${phase}`)
                        yield* Deferred.succeed(reporting, undefined)
                        yield* call.update((part) => ({
                          ...part,
                          state: {
                            status: "running",
                            input,
                            title: "Weather lookup",
                            metadata: { sessionId: "ses_existing_child" },
                            time: { start: 123 },
                          },
                        }))
                        if (phase === "before registration") yield* Deferred.succeed(early, undefined)
                        return yield* Effect.fail(new Error("lookup failed"))
                      }),
                    )
                  },
                }),
              },
            })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(reporting)
          if (phase !== "before registration") yield* Deferred.succeed(early, undefined)
          yield* Fiber.join(processing)
          const calls = (yield* MessageV2.parts(msg.id)).filter((part) => part.type === "tool")
          expect(order).toEqual([`metadata ${phase}`])
          expect(calls).toHaveLength(1)
          expect(calls[0]?.state).toMatchObject({
            status: "error",
            input: { query: "weather" },
            metadata: { sessionId: "ses_existing_child" },
            time: { start: 123 },
          })
        }),
      { config: (url) => providerCfg(url) },
    ),
  )
}

for (const metadata of [false, true]) {
  itProviderError.live(
    `session.processor orders early completion and ignores late updates (metadata: ${metadata})`,
    () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { processors, session, provider } = yield* boot()
            const chat = yield* session.create({})
            const parent = yield* user(chat.id, "tool")
            const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
            const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
            const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
            const call = handle.toolCall("call-1")
            if (metadata) {
              yield* call.update((part) => ({
                ...part,
                state: { status: "running", input: { stale: true }, metadata: { order: [1] }, time: { start: 123 } },
              }))
              yield* call.update((part) => {
                expect(part.state).toMatchObject({ status: "running", metadata: { order: [1] } })
                return { ...part, state: { ...part.state, metadata: { order: [1, 2] } } }
              })
            }
            const output = { title: "done", output: "completed early", metadata: { order: [1, 2] } }
            yield* call.complete(output)
            yield* call.complete({ ...output, output: "duplicate" })
            yield* handle.process({
              user: parent,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "tool" }],
              tools: {},
            })
            const parts = yield* MessageV2.parts(msg.id)
            const calls = parts.filter((part) => part.type === "tool")
            expect(calls).toHaveLength(1)
            expect(calls[0]?.state).toMatchObject({
              status: "completed",
              input: {},
              output: "completed early",
              metadata: { order: [1, 2] },
              ...(metadata ? { time: { start: 123 } } : {}),
            })
            yield* call.update(() => {
              throw new Error("late update must not run")
            })
            yield* call.complete({ ...output, output: "late completion" })
            expect(yield* MessageV2.parts(msg.id)).toEqual(parts)
          }),
        { config: cfg },
      ),
  )
}

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)
