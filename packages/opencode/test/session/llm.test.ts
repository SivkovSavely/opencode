import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { tool, type ModelMessage } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import z from "zod"
import { LLM } from "../../src/session/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ModelsDev } from "@opencode-ai/core/models-dev"

import { testEffect } from "../lib/effect"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { Session as SessionNs } from "@/session/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { ProviderError } from "@/provider/error"
import { Plugin } from "@/plugin"
import { isRecord } from "@/util/record"
import { Auth } from "@/auth"
import { Env } from "@/env"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { createCodexServer } from "../lib/codex-server"
import { SessionProcessor } from "@/session/processor"
import { DispatchTransport } from "@/provider/dispatch-transport"
import { LLMDispatchGuard } from "@/session/llm/dispatch-guard"
import WebSocket from "ws"

type ConfigModel = NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]

const openAIConfig = (model: ModelsDev.Provider["models"][string], baseURL: string): Partial<ConfigV1.Info> => {
  const { experimental: _experimental, ...configModel } = model
  return {
    enabled_providers: ["openai"],
    provider: {
      openai: {
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: {
          [model.id]: JSON.parse(JSON.stringify(configModel)) as ConfigModel,
        },
        options: {
          apiKey: "test-openai-key",
          baseURL,
        },
      },
    },
  }
}

const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))

// LLM.stream returns a Stream, not an Effect, so we can't use the serviceUse proxy.
const drain = (input: LLM.StreamInput) => LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain))

// drainWith builds an isolated runtime so custom replacements fully own LLM and
// its transitive deps.
const drainWith = (layer: Layer.Layer<LLM.Service>, input: LLM.StreamInput) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* Effect.promise(() =>
      Effect.runPromise(
        LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain)).pipe(
          Effect.provide(layer),
          Effect.provideService(InstanceRef, ctx),
        ),
      ),
    )
  })

function llmLayerWithExecutor(
  options: {
    executor?: Layer.Layer<RequestExecutor.Service>
    flags?: Partial<RuntimeFlags.Info>
  } = {},
) {
  return AppNodeBuilder.build(LLM.node, [
    [RuntimeFlags.node, RuntimeFlags.layer(options.flags)],
    ...(options.executor ? ([[LayerNodePlatform.requestExecutor, options.executor]] as const) : []),
  ])
}

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

describe("session.llm.ai-sdk adapter", () => {
  type AISDKAdapterEvent = Parameters<typeof LLMAISDK.toLLMEvents>[1]

  const adapt = (events: ReadonlyArray<AISDKAdapterEvent>) => {
    const state = LLMAISDK.adapterState()
    return Effect.runPromise(
      Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
    )
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests defensive adapter branches outside AI SDK's current typed surface
  const uncheckedAdapterEvent = (input: unknown) => input as AISDKAdapterEvent

  test("maps AI SDK stream chunks without losing session-visible fields", async () => {
    const metadata = { openai: { itemID: "item-1" } }
    const events = await adapt([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "text-1", providerMetadata: metadata },
      { type: "text-delta", id: "text-1", text: "Hel", providerMetadata: { openai: { delta: 1 } } },
      { type: "text-delta", id: "text-1", text: "lo", providerMetadata: { openai: { delta: 2 } } },
      { type: "text-end", id: "text-1", providerMetadata: { openai: { done: true } } },
      { type: "reasoning-start", id: "reasoning-1", providerMetadata: metadata },
      { type: "reasoning-delta", id: "reasoning-1", text: "Think", providerMetadata: { openai: { delta: 3 } } },
      { type: "reasoning-end", id: "reasoning-1", providerMetadata: { openai: { done: true } } },
      { type: "tool-input-start", id: "call-1", toolName: "lookup", providerMetadata: metadata },
      { type: "tool-input-delta", id: "call-1", delta: '{"query":' },
      { type: "tool-input-delta", id: "call-1", delta: '"weather"}' },
      { type: "tool-input-end", id: "call-1", providerMetadata: { openai: { inputDone: true } } },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        input: { query: "weather" },
        providerExecuted: true,
        providerMetadata: { openai: { called: true } },
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "lookup",
        input: { query: "weather" },
        output: { title: "Lookup", output: "sunny", metadata: { ok: true } },
        providerExecuted: true,
        providerMetadata: { openai: { result: true } },
      },
      {
        type: "finish-step",
        response: { id: "response-1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "other",
        rawFinishReason: "other",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
          outputTokenDetails: { textTokens: 4, reasoningTokens: 1 },
        },
        providerMetadata: { openai: { step: true } },
      },
      {
        type: "finish",
        finishReason: "other",
        rawFinishReason: "other",
        totalUsage: {
          inputTokens: 11,
          outputTokens: 6,
          totalTokens: 17,
          cachedInputTokens: 4,
          reasoningTokens: 2,
          inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 4, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 4, reasoningTokens: 2 },
        },
      },
    ])

    expect(events).toMatchObject([
      { type: "step-start", index: 0 },
      { type: "text-start", id: "text-1", providerMetadata: metadata },
      { type: "text-delta", id: "text-1", text: "Hel", providerMetadata: { openai: { delta: 1 } } },
      { type: "text-delta", id: "text-1", text: "lo", providerMetadata: { openai: { delta: 2 } } },
      { type: "text-end", id: "text-1", providerMetadata: { openai: { done: true } } },
      { type: "reasoning-start", id: "reasoning-1", providerMetadata: metadata },
      { type: "reasoning-delta", id: "reasoning-1", text: "Think", providerMetadata: { openai: { delta: 3 } } },
      { type: "reasoning-end", id: "reasoning-1", providerMetadata: { openai: { done: true } } },
      { type: "tool-input-start", id: "call-1", name: "lookup", providerMetadata: metadata },
      { type: "tool-input-delta", id: "call-1", name: "lookup", text: '{"query":' },
      { type: "tool-input-delta", id: "call-1", name: "lookup", text: '"weather"}' },
      { type: "tool-input-end", id: "call-1", name: "lookup", providerMetadata: { openai: { inputDone: true } } },
      {
        type: "tool-call",
        id: "call-1",
        name: "lookup",
        input: { query: "weather" },
        providerExecuted: true,
        providerMetadata: { openai: { called: true } },
      },
      {
        type: "tool-result",
        id: "call-1",
        name: "lookup",
        result: { type: "json", value: { title: "Lookup", output: "sunny", metadata: { ok: true } } },
        providerExecuted: true,
        providerMetadata: { openai: { result: true } },
      },
      {
        type: "step-finish",
        index: 0,
        reason: "unknown",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          reasoningTokens: 1,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
        },
        providerMetadata: { openai: { step: true } },
      },
      {
        type: "finish",
        reason: "unknown",
        usage: {
          inputTokens: 11,
          outputTokens: 6,
          totalTokens: 17,
          reasoningTokens: 2,
          cacheReadInputTokens: 4,
        },
      },
    ])
  })

  test("creates stable block ids when AI SDK omits them", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({ type: "text-delta", text: "implicit text" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "implicit reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
    ])

    expect(events).toMatchObject([
      { type: "text-delta", id: "text-0", text: "implicit text" },
      { type: "text-end", id: "text-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "implicit reasoning" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })

  test("explicitly ignores non-session-visible AI SDK chunks", async () => {
    expect(
      await adapt([
        uncheckedAdapterEvent({ type: "abort" }),
        uncheckedAdapterEvent({ type: "source" }),
        uncheckedAdapterEvent({ type: "file" }),
        uncheckedAdapterEvent({ type: "raw" }),
        uncheckedAdapterEvent({ type: "tool-output-denied" }),
        uncheckedAdapterEvent({ type: "tool-approval-request" }),
      ]),
    ).toEqual([])
  })

  test("preserves tool-error cause", async () => {
    const error = new PermissionV1.RejectedError()
    const events = await Effect.runPromise(
      LLMAISDK.toLLMEvents(LLMAISDK.adapterState(), {
        type: "tool-error",
        toolCallId: "call_123",
        toolName: "bash",
        input: {},
        error,
      }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool-error",
      id: "call_123",
      name: "bash",
      message: error.message,
      error,
    })
  })

  test("emits undefined usage when every AI SDK usage field is missing", async () => {
    // If every numeric field is undefined the translator should signal "no usage info"
    // by emitting undefined, not by polluting the event with usage: {}. Downstream cost
    // telemetry distinguishes "missing" from "zero," so emitting an empty object causes
    // false positives ("usage was tracked, just empty") instead of correct nulls.
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "response-1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          reasoningTokens: undefined,
          cachedInputTokens: undefined,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
    ])

    expect(events).toHaveLength(1)
    const stepFinish = events[0]
    if (stepFinish.type !== "step-finish") throw new Error("expected step-finish")
    expect(stepFinish.usage).toBeUndefined()
  })

  test("reuses adapter state cleanly across streams once finish has fired", async () => {
    // adapterState() is meant to be per-stream, but the only thing finish currently clears
    // is toolNames — step, text counters, and the current text/reasoning IDs all leak
    // forward. A caller that reuses a state across two streams sees text-1/reasoning-1/
    // step index 1 on the second stream's first events. The test pins the intended
    // contract: after finish, the same state can be reused and starts fresh.
    const state = LLMAISDK.adapterState()
    const run = (events: ReadonlyArray<AISDKAdapterEvent>) =>
      Effect.runPromise(
        Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
      )

    await run([
      { type: "start-step", request: {}, warnings: [] },
      uncheckedAdapterEvent({ type: "text-delta", text: "first" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "first reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
      {
        type: "finish-step",
        response: { id: "r1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
    ])

    const secondStream = await run([
      { type: "start-step", request: {}, warnings: [] },
      uncheckedAdapterEvent({ type: "text-delta", text: "second" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "second reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
    ])

    expect(secondStream).toMatchObject([
      { type: "step-start", index: 0 },
      { type: "text-delta", id: "text-0", text: "second" },
      { type: "text-end", id: "text-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "second reasoning" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })

  // Anthropic emits cache write counts in providerMetadata.anthropic.cacheCreationInputTokens
  // rather than usage.inputTokenDetails.cacheWriteTokens. Session.getUsage falls back to the
  // metadata path — but only if the adapter preserves providerMetadata on step-finish.
  test("preserves providerMetadata on step-finish so Anthropic cache writes survive getUsage", async () => {
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "msg_test", timestamp: new Date(0), modelId: "claude-3-5-sonnet" },
        finishReason: "stop",
        rawFinishReason: "stop",
        // Anthropic's AI SDK shape: cacheWriteTokens is NOT in usage, it arrives via providerMetadata.
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 500, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 300 } },
      },
    ])

    expect(events).toHaveLength(1)
    const stepFinish = events[0]
    if (stepFinish.type !== "step-finish") throw new Error("expected step-finish")
    expect(stepFinish.providerMetadata).toEqual({ anthropic: { cacheCreationInputTokens: 300 } })
    expect(stepFinish.usage?.cacheWriteInputTokens).toBeUndefined()
    expect(stepFinish.usage?.cacheReadInputTokens).toBe(200)

    // End-to-end: with the metadata preserved, getUsage extracts cache.write from the fallback path.
    const result = SessionNs.getUsage({
      model: {
        id: "claude-3-5-sonnet",
        providerID: "anthropic",
        name: "Claude",
        limit: { context: 200_000, output: 8_000 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        capabilities: {
          toolcall: true,
          attachment: false,
          reasoning: false,
          temperature: true,
          input: { text: true, image: false, audio: false, video: false },
          output: { text: true, image: false, audio: false, video: false },
        },
        api: { npm: "@ai-sdk/anthropic" },
        options: {},
      } as never,
      usage: stepFinish.usage!,
      metadata: stepFinish.providerMetadata,
    })
    expect(result.tokens.cache.write).toBe(300)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("captures Copilot billed usage from raw Anthropic message deltas per step", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({
        type: "raw",
        rawValue: {
          type: "message_delta",
          copilot_usage: { total_nano_aiu: 4_473_525_000 },
        },
      }),
      {
        type: "finish-step",
        response: { id: "msg_test", timestamp: new Date(0), modelId: "claude-sonnet-4.6" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 11_774,
          outputTokens: 39,
          totalTokens: 11_813,
          inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 11_771 },
          outputTokenDetails: { textTokens: 39, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 11_771 } },
      },
      {
        type: "finish-step",
        response: { id: "msg_follow_up", timestamp: new Date(0), modelId: "claude-sonnet-4.6" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 1, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: {} },
      },
    ])

    expect(events[0]).toMatchObject({
      type: "step-finish",
      providerMetadata: {
        anthropic: { cacheCreationInputTokens: 11_771 },
        copilot: { totalNanoAiu: 4_473_525_000 },
      },
    })
    expect(events[1]).toMatchObject({ type: "step-finish", providerMetadata: { anthropic: {} } })
    if (events[1].type !== "step-finish") throw new Error("expected step-finish")
    expect(events[1].providerMetadata?.copilot).toBeUndefined()
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response)
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

function waitStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-abort",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return typeof next.response === "function"
        ? next.response(req, { url, headers: req.headers, body })
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

const MODELS_FIXTURE = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelsDev.Provider>

function loadFixture(providerID: string, modelID: string) {
  const provider = MODELS_FIXTURE[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return { provider, model }
}

function configModel(model: ModelsDev.Model) {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    release_date: model.release_date,
    attachment: model.attachment,
    reasoning: model.reasoning,
    temperature: model.temperature,
    tool_call: model.tool_call,
    interleaved: model.interleaved,
    cost: model.cost ? { ...model.cost, tiers: undefined } : undefined,
    limit: model.limit,
    modalities: model.modalities,
    status: model.status,
    provider: model.provider,
  }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  for (const scenario of [
    "responses-sol-xhigh",
    "responses-leaf-rejection",
    "responses-sol-max",
    "responses-terra-xhigh",
    "responses-terra-max",
    "responses-default",
    "responses-default-medium",
    "responses-max-alias",
    "responses-plugin-auth",
    "responses-plugin-effort",
    "responses-plugin-wire-model",
    "responses-plugin-nested-reasoning",
    "responses-plugin-reasoning-mode",
    "responses-plugin-unknown",
    "responses-plugin-effort-getter",
    "responses-plugin-mapping",
    "responses-cached-fetch",
    "responses-oauth",
    "responses-oauth-refresh",
    "responses-oauth-default",
    "responses-oauth-max-alias",
    "responses-oauth-plugin-effort",
    "responses-oauth-callback-failure",
    "responses-oauth-processor-rejection",
    "responses-oauth-leaf-rejection",
    "responses-websocket",
    "responses-websocket-refresh",
    "responses-websocket-reconnect-continuation",
    "responses-websocket-terra-max",
    "responses-websocket-default",
    "responses-websocket-plugin-effort",
    "responses-websocket-callback-failure",
    "responses-websocket-processor-rejection",
    "responses-websocket-leaf-rejection",
    "responses-api-websocket",
    "responses-native",
    "responses-callback-failure",
    "responses-callback-mutation",
    "chat-xhigh",
    "chat-max",
    "chat-default",
  ] as const) {
    testEffect(
      AppNodeBuilder.build(
        LayerNode.group([
          LLM.node,
          Provider.node,
          Plugin.node,
          Auth.node,
          Env.node,
          ...(scenario.endsWith("processor-rejection") ? [SessionProcessor.node, SessionNs.node] : []),
        ]),
        [
          [
            RuntimeFlags.node,
            RuntimeFlags.layer({
              experimentalNativeLlm: scenario === "responses-native",
              experimentalWebSockets: scenario.includes("websocket"),
            }),
          ],
        ],
      ),
    ).instance(
      `native OpenAI dispatch ${scenario}`,
      () =>
        Effect.gen(function* () {
          const chat = scenario.startsWith("chat-")
          const oauth =
            scenario.includes("oauth") || (scenario.includes("websocket") && scenario !== "responses-api-websocket")
          const websocket = scenario.includes("websocket")
          const providerID = ProviderV2.ID.make(chat ? "github-copilot" : "openai")
          const modelID = ModelV2.ID.make(
            chat ? "gpt-5-mini" : scenario.includes("-terra-") ? "gpt-6.1-terra" : "gpt-6.1-sol",
          )
          const variant = scenario.includes("default")
            ? "default"
            : scenario.endsWith("-max") || scenario.endsWith("-max-alias")
              ? "max"
              : "xhigh"
          const auth = yield* Auth.Service
          const env = yield* Env.Service
          yield* env.set("DISPATCH_R2_TOKEN", "synthetic-key-r2")
          const previous = yield* auth.get(providerID)
          yield* Effect.addFinalizer(() =>
            (previous ? auth.set(providerID, previous) : auth.remove(providerID)).pipe(Effect.orDie),
          )
          const codex =
            oauth || websocket
              ? yield* Effect.promise(() => createCodexServer(`http://127.0.0.1:${state.server!.port}`))
              : undefined
          if (codex) {
            yield* Effect.addFinalizer(() => Effect.promise(() => codex.close()))
            const plugin = yield* Plugin.Service
            const hooks = yield* plugin.list()
            const builtin = yield* Effect.promise(() =>
              CodexAuthPlugin({} as never, {
                issuer: codex.issuer,
                codexApiEndpoint: codex.endpoint,
                experimentalWebSockets: websocket,
              }),
            )
            const index = hooks.findIndex((hook) => hook.auth?.provider === "openai")
            expect(index).toBeGreaterThanOrEqual(0)
            hooks.splice(index, 1, builtin)
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                await builtin.dispose?.()
              }),
            )
          }
          if (oauth)
            yield* auth.set(providerID, {
              type: "oauth",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: scenario.includes("refresh") ? 0 : Date.now() + 3_600_000,
            })
          if (scenario === "responses-api-websocket")
            yield* auth.set(providerID, { type: "api", key: "synthetic-stored-key" })
          const model = yield* Provider.use.getModel(providerID, modelID)
          if (scenario.endsWith("default-medium")) model.options.reasoningEffort = "medium"
          if (scenario.endsWith("-max-alias") && model.variants?.max) model.variants.max.reasoningEffort = "xhigh"
          const provider = yield* Provider.use.getProvider(providerID)
          if (oauth || websocket) expect(typeof provider.options.fetch).toBe("function")
          if (scenario === "responses-api-websocket" && codex)
            provider.options.baseURL = `${codex.issuer}/backend-api/codex`
          if (scenario === "responses-cached-fetch") {
            provider.options.fetch = (url: RequestInfo | URL, init?: RequestInit) =>
              fetch(url, {
                ...init,
                body: JSON.stringify({
                  ...JSON.parse(String(init?.body)),
                  model: "other-model",
                  reasoning: { effort: "low" },
                }),
              })
            yield* Provider.use.getLanguage(model)
            delete provider.options.fetch
          }
          const plugin = yield* Plugin.Service
          const hooks = yield* plugin.list()
          const options: { value?: Record<string, unknown> } = {}
          hooks.push({
            "chat.params": async (_input, output) => {
              options.value = output.options
              if (scenario.endsWith("-plugin-effort")) output.options.reasoningEffort = "low"
              if (scenario === "responses-plugin-wire-model") output.options.model = "other-model"
              if (scenario === "responses-plugin-nested-reasoning") output.options.reasoning = { effort: "low" }
              if (scenario === "responses-plugin-reasoning-mode") output.options.reasoningMode = "pro"
              if (scenario === "responses-plugin-unknown") output.options.unproved = "never-disclose-r2-secret"
              if (scenario === "responses-plugin-mapping" && model.variants?.xhigh) {
                model.variants.xhigh.reasoningEffort = "low"
                output.options.reasoningEffort = "low"
              }
              if (scenario === "responses-plugin-effort-getter") {
                let reads = 0
                Object.defineProperty(output.options, "reasoningEffort", {
                  enumerable: true,
                  get: () => (++reads === 1 ? "xhigh" : "low"),
                })
              }
            },
            "chat.headers": async (_input, output) => {
              output.headers["x-dispatch-r2"] = "retained"
              if (scenario === "responses-plugin-auth") output.headers.Authorization = "Bearer synthetic-plugin-key"
            },
          })
          const request = waitRequest(
            chat ? "/chat/completions" : "/responses",
            chat
              ? createEventResponse(
                  [
                    {
                      id: "chat-r2",
                      object: "chat.completion.chunk",
                      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
                    },
                    {
                      id: "chat-r2",
                      object: "chat.completion.chunk",
                      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    },
                  ],
                  true,
                )
              : createEventResponse(
                  [
                    {
                      type: "response.created",
                      response: { id: "resp-guard-r2", created_at: 1, model: modelID, service_tier: null },
                    },
                    {
                      type: "response.completed",
                      response: {
                        incomplete_details: null,
                        usage: {
                          input_tokens: 1,
                          input_tokens_details: null,
                          output_tokens: 1,
                          output_tokens_details: null,
                        },
                        service_tier: null,
                      },
                    },
                  ],
                  true,
                ),
          )
          const dispatched: LLM.DispatchSelection[] = []
          const failure = new ProviderError.ResponseStreamError("synthetic persistence failure")
          const sessionID = scenario.endsWith("processor-rejection")
            ? (yield* SessionNs.use.create({})).id
            : SessionID.make("session-dispatch-r2")
          const agent = { name: "test", mode: "primary", options: {}, permission: [] } satisfies Agent.Info
          const input: LLM.StreamInput = {
            sessionID,
            model,
            agent,
            system: [],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            user: {
              id: MessageID.make("msg-dispatch-r2"),
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: agent.name,
              model: { providerID, modelID, ...(variant === "default" ? {} : { variant }) },
            },
            expectedSelection: { providerID, modelID, variant },
            onDispatch: (selection) =>
              Effect.gen(function* () {
                expect(state.queue).toHaveLength(1)
                expect(Object.isFrozen(selection)).toBe(true)
                dispatched.push(selection)
                yield* Effect.yieldNow
                expect(state.queue).toHaveLength(1)
                if (scenario.endsWith("-callback-failure")) return yield* Effect.fail(failure)
                if (scenario.endsWith("processor-rejection")) return yield* new DispatchTransport.UnsupportedDispatch()
                if (scenario === "responses-callback-mutation") {
                  if (!options.value) throw new Error("Missing plugin options")
                  options.value.reasoningEffort = "low"
                  model.api.id = "other-model"
                }
              }),
          }
          if (scenario.endsWith("leaf-rejection")) {
            const language = yield* Provider.use.getLanguage(model)
            const guard = yield* Effect.promise(() =>
              LLMDispatchGuard.prepare(model, language, { providerID, modelID, variant }, provider),
            )
            const unsupported: unknown[] = []
            const attempt = guard.attempt(
              { openai: { reasoningEffort: "xhigh", forceReasoning: true } },
              async () => {
                dispatched.push(guard.selection)
              },
              (error) => {
                unsupported.push(error)
              },
            )
            const fetch: unknown = Reflect.get(Reflect.get(attempt.model, "config"), "fetch")
            if (typeof fetch !== "function") throw new Error("Private adapter fetch was not found")
            const rejected = yield* Effect.exit(
              Effect.tryPromise({
                try: () =>
                  fetch(`${state.server!.url.origin}/v1/responses`, {
                    method: "POST",
                    headers: { "session-id": sessionID, authorization: "never-disclose-final-header" },
                    body: JSON.stringify({
                      stream: true,
                      model: "wrong-model",
                      reasoning: { effort: "low" },
                      sentinel: "never-disclose-final-body",
                    }),
                  }),
                catch: (error) => error,
              }),
            )
            expect(Exit.isFailure(rejected)).toBe(true)
            if (Exit.isFailure(rejected)) {
              expect(Cause.squash(rejected.cause)).toMatchObject({ _tag: "UnsupportedDispatch" })
              expect(Cause.pretty(rejected.cause)).not.toContain("never-disclose-final")
            }
            expect(unsupported.length).toBeGreaterThan(0)
            expect(dispatched).toHaveLength(0)
            expect(state.queue).toHaveLength(1)
            if (codex) expect(codex.frames).toHaveLength(0)
            return
          }
          if (scenario.endsWith("processor-rejection")) {
            const session = yield* SessionNs.Service
            const context = yield* InstanceRef
            if (!context) throw new Error("Instance was not provided")
            yield* session.updateMessage(input.user)
            const assistant = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              sessionID,
              parentID: input.user.id,
              providerID,
              modelID,
              agent: "build",
              mode: "build",
              path: { cwd: context.directory, root: context.directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now() },
            } satisfies SessionV1.Assistant)
            const processor = yield* SessionProcessor.Service
            const handle = yield* processor.create({ assistantMessage: assistant, sessionID, model })
            const unsupported: boolean[] = []
            const result = yield* handle.process({
              ...input,
              onUnsupportedDispatch: () =>
                Effect.sync(() => {
                  unsupported.push(true)
                }),
            })
            expect(result).toBe("stop")
            expect(unsupported).toHaveLength(1)
            expect(dispatched).toHaveLength(1)
            expect(state.queue).toHaveLength(1)
            expect(codex?.frames).toHaveLength(0)
            return
          }
          const exit = yield* Effect.exit(drain(input))
          const valid =
            scenario.startsWith("chat-") ||
            ((oauth || websocket) && !scenario.endsWith("-plugin-effort") && !scenario.endsWith("-callback-failure")) ||
            [
              "responses-sol-xhigh",
              "responses-sol-max",
              "responses-terra-xhigh",
              "responses-terra-max",
              "responses-default",
              "responses-default-medium",
              "responses-max-alias",
              "responses-plugin-auth",
              "responses-plugin-effort-getter",
              "responses-callback-mutation",
              "responses-oauth",
            ].includes(scenario)
          if (!valid) {
            expect(Exit.isFailure(exit)).toBe(true)
            expect(state.queue).toHaveLength(1)
            expect(dispatched).toHaveLength(scenario.endsWith("-callback-failure") ? 1 : 0)
            if (codex) expect(codex.frames).toHaveLength(0)
            if (Exit.isFailure(exit)) {
              if (scenario.endsWith("-callback-failure")) expect(Cause.squash(exit.cause)).toBe(failure)
              if (!scenario.endsWith("-callback-failure"))
                expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "UnsupportedDispatch" })
              expect(Cause.pretty(exit.cause)).not.toContain("never-disclose-r2-secret")
            }
            return
          }
          if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
          const capture = yield* Effect.promise(() => request)
          const effort =
            variant === "default"
              ? scenario === "responses-default-medium" || chat
                ? "medium"
                : undefined
              : scenario.endsWith("-max-alias")
                ? "xhigh"
                : variant
          expect(capture.body.model).toBe(modelID)
          if (chat) expect(capture.body.reasoning_effort).toBe(effort)
          if (!chat && effort === undefined) expect(capture.body.reasoning).toBeUndefined()
          if (!chat && effort !== undefined) expect(capture.body.reasoning).toMatchObject({ effort })
          if (codex) {
            expect(codex.frames).toHaveLength(1)
            expect(codex.frames[0].model).toBe(modelID)
            expect(codex.frames[0].type).toBe(websocket ? "response.create" : undefined)
            if (websocket) expect(codex.frames[0].stream).toBeUndefined()
            expect(codex.refreshes()).toBe(scenario.includes("refresh") ? 1 : 0)
            if (scenario.includes("refresh")) {
              const refreshed = yield* auth.get(providerID)
              expect(refreshed?.type === "oauth" && refreshed.access === "fixture-refreshed-access").toBe(true)
            }
          }
          if (!codex) {
            expect(
              capture.headers.get("authorization") ===
                (scenario === "responses-plugin-auth" ? "Bearer synthetic-plugin-key" : "Bearer synthetic-key-r2"),
            ).toBe(true)
            expect(capture.headers.get("x-dispatch-r2")).toBe("retained")
          }
          if (!chat) {
            if (!codex) {
              expect(capture.headers.get("originator")).toBe("opencode")
              expect(capture.headers.get("session-id")).toBe(sessionID)
            }
            expect(capture.body.max_output_tokens).toBeUndefined()
          }
          expect(dispatched).toEqual([
            {
              providerID,
              modelID,
              variant,
              apiModelID: modelID,
              reasoningEffort: effort ?? null,
              adapter: chat ? "openai-chat" : "openai-responses",
              phase: "prepared",
            },
          ])
          expect(JSON.stringify(dispatched)).not.toContain("synthetic-key")
          if (variant !== "default")
            expect(model.variants?.[variant]?.reasoningEffort).toBe(scenario.endsWith("-max-alias") ? "xhigh" : variant)
          if (scenario === "responses-websocket-reconnect-continuation") {
            if (!codex) throw new Error("Codex fixture was not provided")
            const closed = Promise.withResolvers<void>()
            const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
            const emit = WebSocket.prototype.emit
            // Observe the real owned client close; dropConnections does not await its peer.
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                Object.defineProperty(WebSocket.prototype, "emit", {
                  configurable: true,
                  value(this: WebSocket, event: string | symbol, ...args: unknown[]) {
                    const result = Reflect.apply(emit, this, [event, ...args])
                    if (event === "close" && this.url === codex.endpoint.replace(/^http/, "ws")) closed.resolve()
                    return result
                  },
                }),
              ),
              () =>
                Effect.sync(() => {
                  if (descriptor) Object.defineProperty(WebSocket.prototype, "emit", descriptor)
                  if (!descriptor) Reflect.deleteProperty(WebSocket.prototype, "emit")
                }),
            )
            codex.dropConnections()
            yield* Effect.promise(() => closed.promise)
            const nextID = ModelV2.ID.make("gpt-6.1-terra")
            const next = yield* Provider.use.getModel(providerID, nextID)
            const continuation = "resp-explicit-after-reconnect"
            const reconnected = waitRequest(
              "/responses",
              createEventResponse(
                [
                  {
                    type: "response.created",
                    response: { id: "resp-reconnected", created_at: 1, model: nextID, service_tier: null },
                  },
                  {
                    type: "response.completed",
                    response: {
                      incomplete_details: null,
                      usage: {
                        input_tokens: 1,
                        input_tokens_details: null,
                        output_tokens: 1,
                        output_tokens_details: null,
                      },
                      service_tier: null,
                    },
                  },
                ],
                true,
              ),
            )
            yield* drain({
              ...input,
              model: next,
              agent: { ...agent, options: { previousResponseId: continuation } },
              user: {
                ...input.user,
                id: MessageID.make("msg-dispatch-reconnected"),
                model: { providerID, modelID: nextID, variant: "max" },
              },
              expectedSelection: { providerID, modelID: nextID, variant: "max" },
            })
            const second = yield* Effect.promise(() => reconnected)
            expect(second.body).toMatchObject({
              model: nextID,
              reasoning: { effort: "high" },
              previous_response_id: continuation,
            })
            expect(codex.frames).toHaveLength(2)
            expect(codex.frames[0]).toMatchObject({
              type: "response.create",
              model: modelID,
              reasoning: { effort: "xhigh" },
            })
            expect(codex.frames[0].previous_response_id).toBeUndefined()
            expect(codex.frames[1]).toMatchObject({
              type: "response.create",
              model: nextID,
              reasoning: { effort: "high" },
              previous_response_id: continuation,
            })
            expect(codex.frames[1].stream).toBeUndefined()
            expect(codex.observations.map((observation) => observation.transport)).toEqual(["ws", "ws"])
            expect(dispatched).toHaveLength(2)
            expect(dispatched[1]).toEqual({
              providerID,
              modelID: nextID,
              variant: "max",
              apiModelID: nextID,
              reasoningEffort: "high",
              adapter: "openai-responses",
              phase: "prepared",
            })
            expect(next.variants?.max.reasoningEffort).toBe("high")
          }
        }),
      {
        config: () => {
          const providerID = scenario.startsWith("chat-") ? "github-copilot" : "openai"
          const modelID = scenario.startsWith("chat-")
            ? "gpt-5-mini"
            : scenario.includes("-terra-")
              ? "gpt-6.1-terra"
              : "gpt-6.1-sol"
          return {
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                npm: "@ai-sdk/openai",
                env: ["DISPATCH_R2_TOKEN"],
                models: {
                  ...(scenario === "responses-websocket-reconnect-continuation"
                    ? {
                        "gpt-6.1-terra": {
                          id: "gpt-6.1-terra",
                          reasoning: true,
                          limit: { context: 8192, output: 1024 },
                          variants: {
                            max: {
                              reasoningEffort: "high",
                              reasoningSummary: "auto",
                              include: ["reasoning.encrypted_content"],
                            },
                          },
                        },
                      }
                    : {}),
                  [modelID]: {
                    id: modelID,
                    reasoning: true,
                    limit: { context: 8192, output: 1024 },
                    variants: {
                      xhigh: {
                        reasoningEffort: "xhigh",
                        reasoningSummary: "auto",
                        include: ["reasoning.encrypted_content"],
                      },
                      max: {
                        reasoningEffort: "max",
                        reasoningSummary: "auto",
                        include: ["reasoning.encrypted_content"],
                      },
                    },
                  },
                },
                options: { apiKey: "synthetic-key-r2", baseURL: `${state.server!.url.origin}/v1` },
              },
            },
          }
        },
      },
    )
  }

  for (const scenario of [
    "exact",
    "default",
    "default-then-xhigh",
    "default-no-variants",
    "default-empty-mapping",
    "default-known",
    "default-contradictory",
    "default-rewrite",
    "default-unsupported-mapping",
    "xhigh",
    "callback-success",
    "callback-failure",
    "callback-defect",
    "callback-interrupt",
    "callback-mismatch",
    "callback-mutation",
    "callback-uncontrolled",
    "plugin-effort",
    "effort-getter",
    "effort-proxy",
    "mapping-getter",
    "model-id-getter",
    "language-model-getter",
    "language-config-getter",
    "global-fetch-before",
    "global-fetch-after",
    "global-fetch-before-uncontrolled",
    "global-fetch-after-uncontrolled",
    "nested-reasoning",
    "enable-thinking",
    "unknown-option",
    "wire-model",
    "wire-json",
    "plugin-mapping",
    "wrong-provider",
    "wrong-model",
    "unknown-variant",
    "unsupported-mapping",
    "unsupported-adapter",
    "custom-fetch",
    "cached-model-fetch",
    "cached-sdk-fetch",
    "cached-model-uncontrolled",
    "cached-sdk-uncontrolled",
    "body-transform",
    "native",
    "uncontrolled",
  ] as const) {
    testEffect(
      AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node, Plugin.node]), [
        [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: scenario === "native" })],
      ]),
    ).instance(
      `controlled dispatch ${scenario}`,
      () =>
        Effect.gen(function* () {
          const original = yield* Effect.acquireRelease(
            Effect.sync(() => globalThis.fetch),
            (value) =>
              Effect.sync(() => {
                globalThis.fetch = value
              }),
          )
          const changedFetch: typeof fetch = Object.assign(
            (url: RequestInfo | URL, init?: RequestInit) =>
              original(url, {
                ...init,
                body: JSON.stringify({
                  ...JSON.parse(String(init?.body)),
                  model: "global-other-model",
                  reasoning_effort: "low",
                }),
              }),
            { preconnect: original.preconnect },
          )
          if (scenario.startsWith("global-fetch-before")) globalThis.fetch = changedFetch
          const model = yield* Provider.use.getModel(ProviderV2.ID.make("dispatch-test"), ModelV2.ID.make("target"))
          const variant = scenario.startsWith("default") ? "default" : scenario === "xhigh" ? "xhigh" : "high"
          if (scenario === "default-no-variants") delete model.variants
          if (scenario === "default-empty-mapping") model.variants = { default: {} }
          if (scenario === "default-known") model.options.reasoningEffort = "medium"
          if (scenario === "default-unsupported-mapping")
            model.variants = { default: { thinking: { budgetTokens: 1024 } } }
          if (scenario === "mapping-getter") {
            const variant = model.variants?.high
            if (!variant) throw new Error("Missing test variant")
            Object.defineProperty(variant, "reasoningEffort", { enumerable: true, get: () => "high" })
          }
          if (scenario === "unsupported-mapping") model.variants = { high: { thinking: { budgetTokens: 1024 } } }
          const provider = yield* Provider.use.getProvider(model.providerID)
          const language = scenario.startsWith("language-") ? yield* Provider.use.getLanguage(model) : undefined
          if (scenario === "custom-fetch")
            provider.options.fetch = (url: RequestInfo | URL, init?: RequestInit) => fetch(url, init)
          if (scenario.startsWith("cached-")) {
            provider.options.fetch = (url: RequestInfo | URL, init?: RequestInit) =>
              fetch(url, {
                ...init,
                body: JSON.stringify({
                  ...JSON.parse(String(init?.body)),
                  model: "transport-other-model",
                  reasoning_effort: "low",
                }),
              })
            const cached = scenario.startsWith("cached-model-")
              ? model
              : yield* Provider.use.getModel(model.providerID, ModelV2.ID.make("sibling"))
            yield* Provider.use.getLanguage(cached)
            delete provider.options.fetch
          }
          if (scenario === "body-transform")
            provider.options.transformRequestBody = (body: Record<string, unknown>) => ({ ...body, model: "changed" })
          const plugin = yield* Plugin.Service
          const hooks = yield* plugin.list()
          const pluginOptions: { value?: Record<string, unknown> } = {}
          const dispatched: unknown[] = []
          const failure = new ProviderError.ResponseStreamError("dispatch evidence unavailable")
          hooks.push({
            "chat.params": async (_input, output) => {
              pluginOptions.value = output.options
              if (scenario === "callback-mismatch") output.options.reasoningEffort = "low"
              if (scenario === "default-contradictory") output.options.enable_thinking = false
              if (scenario === "default-rewrite") output.options.reasoningEffort = "high"
              if (scenario === "effort-proxy") output.options = new Proxy(output.options, {})
              if (scenario === "model-id-getter")
                Object.defineProperty(model, "id", { enumerable: true, get: () => "target" })
              if (scenario === "language-model-getter") {
                let reads = 0
                Object.defineProperty(language, "modelId", {
                  get: () => (++reads === 1 ? "wire-target" : "wrong-wire-model"),
                })
              }
              if (scenario === "language-config-getter" && language) {
                const config: unknown = Reflect.get(language, "config")
                if (!isRecord(config)) throw new Error("Missing test adapter config")
                const transport = config.fetch
                let reads = 0
                Object.defineProperty(config, "fetch", { get: () => (++reads === 1 ? transport : changedFetch) })
              }
              if (scenario.startsWith("global-fetch-after")) globalThis.fetch = changedFetch
              if (scenario === "effort-getter") {
                let reads = 0
                Object.defineProperty(output.options, "reasoningEffort", {
                  enumerable: true,
                  get: () => (++reads === 1 ? "high" : "low"),
                })
              }
              if (scenario === "plugin-effort" || scenario === "uncontrolled") {
                output.options.reasoningEffort = "low"
                output.options.secret = "never-include-this-secret"
              }
              if (scenario === "wire-model") output.options.model = "wrong-wire-model"
              if (scenario === "nested-reasoning") output.options.reasoning = { effort: "low" }
              if (scenario === "enable-thinking") output.options.enable_thinking = false
              if (scenario === "unknown-option") output.options.unqualified_option = "never-include-this-secret"
              if (scenario === "wire-json") output.options.toJSON = () => ({ model: "wrong-wire-model" })
              if (scenario === "plugin-mapping") {
                model.variants = { high: { reasoningEffort: "low" } }
                output.options.reasoningEffort = "low"
              }
            },
          })
          const request = waitRequest(
            "/chat/completions",
            new Response(createChatStream("ok"), {
              headers: { "Content-Type": "text/event-stream" },
            }),
          )
          const sessionID = SessionID.make("session-dispatch")
          const agent = { name: "test", mode: "primary", options: {}, permission: [] } satisfies Agent.Info
          const input = {
            sessionID,
            user: {
              id: MessageID.make("msg-dispatch"),
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: agent.name,
              model: { providerID: model.providerID, modelID: model.id, ...(variant === "default" ? {} : { variant }) },
            },
            model,
            agent,
            system: [],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            ...(scenario === "uncontrolled" || scenario.endsWith("-uncontrolled")
              ? {}
              : {
                  expectedSelection: {
                    providerID: scenario === "wrong-provider" ? "other" : "dispatch-test",
                    modelID: scenario === "wrong-model" ? "other" : "target",
                    variant: scenario === "unknown-variant" ? "missing" : variant,
                  },
                }),
            ...(!scenario.startsWith("default") && scenario !== "xhigh" && !scenario.startsWith("callback-")
              ? {}
              : {
                  onDispatch: (selection: unknown) =>
                    Effect.gen(function* () {
                      expect(state.queue).toHaveLength(1)
                      expect(Object.isFrozen(selection)).toBe(true)
                      dispatched.push(selection)
                      yield* Effect.yieldNow
                      expect(state.queue).toHaveLength(1)
                      if (scenario === "callback-mutation") {
                        if (!pluginOptions.value) throw new Error("Missing plugin options")
                        pluginOptions.value.reasoningEffort = "low"
                        model.api.id = "wrong-wire-model"
                      }
                      if (scenario === "callback-failure") return yield* Effect.fail(failure)
                      if (scenario === "callback-defect") return yield* Effect.die(failure)
                      if (scenario === "callback-interrupt") return yield* Effect.interrupt
                    }),
                }),
          } satisfies LLM.StreamInput
          const exit = yield* Effect.exit(drain(input))
          if (scenario === "callback-failure" || scenario === "callback-defect" || scenario === "callback-interrupt") {
            expect(Exit.isFailure(exit)).toBe(true)
            expect(state.queue).toHaveLength(1)
            expect(dispatched).toHaveLength(1)
            if (Exit.isFailure(exit)) {
              if (scenario === "callback-interrupt") {
                expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
                return
              }
              expect(Cause.squash(exit.cause)).toBe(failure)
              expect(Cause.hasDies(exit.cause)).toBe(scenario === "callback-defect")
              expect(Cause.hasFails(exit.cause)).toBe(scenario === "callback-failure")
            }
            return
          }
          if (scenario === "effort-getter" && Exit.isSuccess(exit)) {
            const capture = yield* Effect.promise(() => request)
            expect(capture.body.reasoning_effort).toBe("high")
          }
          if (
            scenario === "exact" ||
            [
              "default",
              "default-then-xhigh",
              "default-no-variants",
              "default-empty-mapping",
              "default-known",
              "xhigh",
              "callback-success",
              "callback-mutation",
            ].includes(scenario) ||
            scenario.startsWith("global-fetch-") ||
            scenario === "uncontrolled" ||
            (scenario.endsWith("-uncontrolled") && scenario !== "callback-uncontrolled")
          ) {
            expect(Exit.isSuccess(exit)).toBe(true)
            const capture = yield* Effect.promise(() => request)
            expect(capture.body.model).toBe(
              scenario.startsWith("cached-")
                ? "transport-other-model"
                : scenario.startsWith("global-fetch-") && scenario.endsWith("-uncontrolled")
                  ? "global-other-model"
                  : "wire-target",
            )
            expect(capture.body.reasoning_effort).toBe(
              variant === "default"
                ? scenario === "default-known"
                  ? "medium"
                  : undefined
                : scenario === "xhigh"
                  ? "xhigh"
                  : scenario === "exact" ||
                      scenario.startsWith("callback-") ||
                      (scenario.startsWith("global-fetch-") && !scenario.endsWith("-uncontrolled"))
                    ? "high"
                    : "low",
            )
            if (scenario.startsWith("default") || scenario === "xhigh" || scenario.startsWith("callback-")) {
              expect(dispatched).toEqual([
                {
                  providerID: "dispatch-test",
                  modelID: "target",
                  variant,
                  apiModelID: "wire-target",
                  reasoningEffort: capture.body.reasoning_effort ?? null,
                  adapter: "openai-compatible-chat",
                  phase: "prepared",
                },
              ])
              if (variant === "default" && scenario !== "default-known")
                expect(Object.hasOwn(capture.body, "reasoning_effort")).toBe(false)
            }
            if (scenario === "default-then-xhigh") {
              const targetRequest = waitRequest(
                "/chat/completions",
                new Response(createChatStream("target"), {
                  headers: { "Content-Type": "text/event-stream" },
                }),
              )
              yield* drain({
                ...input,
                user: { ...input.user, model: { ...input.user.model, variant: "xhigh" } },
                expectedSelection: { providerID: "dispatch-test", modelID: "target", variant: "xhigh" },
              })
              const target = yield* Effect.promise(() => targetRequest)
              expect(target.body.model).toBe("wire-target")
              expect(target.body.reasoning_effort).toBe("xhigh")
              expect(dispatched).toHaveLength(2)
              expect(dispatched[1]).toEqual({
                providerID: "dispatch-test",
                modelID: "target",
                variant: "xhigh",
                apiModelID: "wire-target",
                reasoningEffort: "xhigh",
                adapter: "openai-compatible-chat",
                phase: "prepared",
              })
            }
            return
          }
          expect(Exit.isFailure(exit)).toBe(true)
          expect(state.queue).toHaveLength(1)
          expect(dispatched).toEqual([])
          if (Exit.isFailure(exit)) {
            const error = Cause.pretty(exit.cause)
            expect(error).toContain("unsupported_dispatch")
            expect(error).not.toContain("never-include-this-secret")
          }
        }),
      {
        config: () => ({
          enabled_providers: ["dispatch-test"],
          provider: {
            "dispatch-test": {
              npm: scenario === "unsupported-adapter" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
              models: {
                target: {
                  id: "wire-target",
                  reasoning: true,
                  limit: { context: 8192, output: 1024 },
                  variants: { high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } },
                },
                sibling: { id: "wire-sibling", limit: { context: 8192, output: 1024 } },
              },
              options: { apiKey: "synthetic-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }),
      },
    )
  }

  const vivgridFixture = { providerID: "vivgrid", modelID: "gemini-3.1-pro-preview" }
  const opencodeFixture = { providerID: "opencode-test", modelID: vivgridFixture.modelID }

  it.instance(
    "sends the parent session header for opencode providers",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(opencodeFixture.providerID),
          ModelV2.ID.make(opencodeFixture.modelID),
        )
        const sessionID = SessionID.make("session-child")
        const parentSessionID = SessionID.make("session-parent")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-parent-header"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: {
            providerID: ProviderV2.ID.make(opencodeFixture.providerID),
            modelID: resolved.id,
          },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          parentSessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        expect((yield* Effect.promise(() => request)).headers.get("x-parent-session-id")).toBe(parentSessionID)
      }),
    {
      config: () => {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        return {
          enabled_providers: [opencodeFixture.providerID],
          provider: {
            [opencodeFixture.providerID]: {
              name: "OpenCode Test",
              npm: "@ai-sdk/openai-compatible",
              models: { [fixture.model.id]: configModel(fixture.model) as ConfigModel },
              options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  it.instance(
    "sends temperature, tokens, and reasoning options for openai-compatible models",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(vivgridFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(vivgridFixture.providerID), modelID: resolved.id, variant: "high" },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      }),
    {
      config: () => ({
        enabled_providers: [vivgridFixture.providerID],
        provider: {
          [vivgridFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "surfaces network_error finish reasons as retryable stream failures",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          createEventResponse(
            [
              {
                id: "chatcmpl-network-error",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
              },
            ],
            true,
          ),
        )
        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(vivgridFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-network-error")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-network-error"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(vivgridFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        const error = yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        }).pipe(Effect.flip)
        yield* Effect.promise(() => request)

        if (!(error instanceof ProviderError.ResponseStreamError)) throw error
        expect(error.message).toBe("Provider finish_reason: network_error")
      }),
    {
      config: () => ({
        enabled_providers: [vivgridFixture.providerID],
        provider: {
          [vivgridFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  const cerebrasFixture = { providerID: "cerebras", modelID: "gpt-oss-120b" }
  it.instance(
    "replays Cerebras assistant reasoning using the provider-supported field",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(cerebrasFixture.providerID, cerebrasFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(cerebrasFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-cerebras-reasoning")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-cerebras-reasoning"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(cerebrasFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            { role: "user", content: "Hello" },
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "thinking" },
                { type: "text", text: "Previous answer" },
              ],
            },
            { role: "user", content: "Continue" },
          ] satisfies ModelMessage[],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const messages = capture.body.messages as Array<Record<string, unknown>>
        const assistant = messages.find((msg) => msg.role === "assistant")

        expect(assistant?.reasoning).toBe("thinking")
        expect(assistant && "reasoning_content" in assistant).toBe(false)
      }),
    {
      config: () => ({
        enabled_providers: [cerebrasFixture.providerID],
        provider: {
          [cerebrasFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  const mistralFixture = { providerID: "mistral", modelID: "mistral-small-latest" }
  it.instance(
    "replays native Mistral reasoning from chat history",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(mistralFixture.providerID, mistralFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          createEventResponse(
            [
              {
                id: "chatcmpl-mistral",
                object: "chat.completion.chunk",
                created: 0,
                model: fixture.model.id,
                choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
              },
              {
                id: "chatcmpl-mistral",
                object: "chat.completion.chunk",
                created: 0,
                model: fixture.model.id,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            ],
            true,
          ),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(mistralFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-mistral-reasoning")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-mistral-reasoning"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(mistralFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        const thinking = {
          type: "thinking",
          thinking: [
            { type: "text", text: "thinking" },
            {
              type: "tool_reference",
              tool: "web_search",
              title: "Example result",
              url: "https://example.com/tool",
              favicon: "https://example.com/favicon.ico",
              description: "Example description",
            },
            { type: "reference", reference_ids: [1, "source-2"] },
          ],
          closed: true,
          signature: "sig-123",
        }

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            { role: "user", content: "Hello" },
            {
              role: "assistant",
              content: [
                {
                  type: "reasoning",
                  text: "thinking",
                  providerOptions: { mistral: { thinking } },
                },
                { type: "text", text: "Previous answer" },
              ],
            },
            { role: "user", content: "Continue" },
          ] satisfies ModelMessage[],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const messages = capture.body.messages as Array<Record<string, unknown>>
        expect(messages.find((message) => message.role === "assistant")).toEqual({
          role: "assistant",
          content: [thinking, { type: "text", text: "Previous answer" }],
        })
      }),
    {
      config: () => ({
        enabled_providers: [mistralFixture.providerID],
        provider: {
          [mistralFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  const alibabaQwenFixture = { providerID: "alibaba", modelID: "qwen-plus" }
  it.instance(
    "service stream cancellation cancels provider response body promptly",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(alibabaQwenFixture.providerID, alibabaQwenFixture.modelID)
        const pending = waitStreamingRequest("/chat/completions")

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(alibabaQwenFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-service-abort")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-service-abort"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(alibabaQwenFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        const fiber = yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        }).pipe(Effect.exit, Effect.forkScoped)

        yield* Effect.promise(() => pending.request)
        yield* Fiber.interrupt(fiber)

        yield* Effect.promise(() => Promise.race([pending.responseCanceled, timeout(500)]))
        const exit = yield* Fiber.await(fiber)
        // Fiber.await returns an Exit<Exit<...>>. Unwrap once.
        const inner = Exit.isSuccess(exit) ? exit.value : exit
        expect(Exit.isFailure(inner)).toBe(true)
        if (Exit.isFailure(inner)) {
          expect(Cause.hasInterrupts(inner.cause)).toBe(true)
        }
        yield* Effect.promise(() => Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined))
      }),
    {
      config: () => ({
        enabled_providers: [alibabaQwenFixture.providerID],
        provider: {
          [alibabaQwenFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "keeps tools enabled by prompt permissions",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(alibabaQwenFixture.providerID, alibabaQwenFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(alibabaQwenFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(alibabaQwenFixture.providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      }),
    {
      config: () => ({
        enabled_providers: [alibabaQwenFixture.providerID],
        provider: {
          [alibabaQwenFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "sends responses API payload for OpenAI models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model

        const responseChunks = [
          {
            type: "response.created",
            response: {
              id: "resp-1",
              created_at: Math.floor(Date.now() / 1000),
              model: model.id,
              service_tier: null,
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "item-1", status: "in_progress", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "item-1",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-1",
            delta: "Hello",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(responseChunks, true))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: { reasoningMode: "pro" },
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")
        expect((body.reasoning as { mode?: string } | undefined)?.mode).toBe("pro")

        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(undefined) // match codex cli behavior
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  it.instance(
    "keeps supported OpenAI models on AI SDK path when native flag is off",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const request = waitRequest(
          "/responses",
          createEventResponse(
            [
              {
                type: "response.created",
                response: {
                  id: "resp-flag-off",
                  created_at: Math.floor(Date.now() / 1000),
                  model: model.id,
                  service_tier: null,
                },
              },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "item-flag-off", status: "in_progress", role: "assistant", content: [] },
              },
              {
                type: "response.content_part.added",
                item_id: "item-flag-off",
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              },
              {
                type: "response.output_text.delta",
                item_id: "item-flag-off",
                delta: "Flag off",
                logprobs: null,
              },
              {
                type: "response.completed",
                response: {
                  incomplete_details: null,
                  usage: {
                    input_tokens: 1,
                    input_tokens_details: null,
                    output_tokens: 1,
                    output_tokens_details: null,
                  },
                  service_tier: null,
                },
              },
            ],
            true,
          ),
        )
        const failingNativeClient = Layer.succeed(
          LLMClient.Service,
          LLMClient.Service.of({
            prepare: () => Effect.die(new Error("native LLM client should not be used when the flag is off")),
            stream: () => Stream.die(new Error("native LLM client should not be used when the flag is off")),
            generate: () => Effect.die(new Error("native LLM client should not be used when the flag is off")),
          }),
        )

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-flag-off")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(
          AppNodeBuilder.build(LLM.node, [
            [LayerNodePlatform.llmClient, failingNativeClient],
            [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: false })],
          ]),
          {
            user: {
              id: MessageID.make("msg_user-native-flag-off"),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: agent.name,
              model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
            } satisfies SessionV1.User,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          },
        )

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.body.model).toBe(resolved.api.id)
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  it.instance(
    "streams OpenAI through native runtime when opted in",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          { type: "response.created", response: { id: "resp-native" } },
          {
            type: "response.output_item.added",
            item: { type: "message", id: "item-native", status: "in_progress" },
          },
          { type: "response.output_text.delta", item_id: "item-native", delta: "Hello native" },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.headers.get("Authorization")).toBe("Bearer test-openai-key")
        expect(capture.body.model).toBe(model.id)
        expect(capture.body.stream).toBe(true)
        expect((capture.body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")
        expect(capture.body.include).toEqual(["reasoning.encrypted_content"])
        expect(JSON.stringify(capture.body.input)).toContain("You are a helpful assistant.")
        expect(capture.body.input).toContainEqual({ role: "user", content: [{ type: "input_text", text: "Hello" }] })
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  it.instance(
    "uses injected native request executor for tool calls",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item-injected-tool", call_id: "call-injected-tool", name: "lookup" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-injected-tool",
            delta: '{"query":"weather"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item-injected-tool",
              call_id: "call-injected-tool",
              name: "lookup",
              arguments: '{"query":"weather"}',
            },
          },
          {
            type: "response.completed",
            response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
        let captured: Record<string, unknown> | undefined
        let executed: unknown
        const executor = Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
                captured = (yield* Effect.promise(() => web.json())) as Record<string, unknown>
                return HttpClientResponse.fromWeb(request, createEventResponse(chunks, true))
              }),
          }),
        )

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-injected-tool")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ executor, flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native-injected-tool"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "Use lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup data",
              inputSchema: z.object({ query: z.string() }),
              execute: async (args, options) => {
                executed = { args, toolCallId: options.toolCallId }
                return { output: "looked up" }
              },
            }),
          },
        })

        expect(captured?.model).toBe(model.id)
        expect(captured?.tools).toEqual([
          {
            type: "function",
            name: "lookup",
            description: "Lookup data",
            strict: false,
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        ])
        expect(executed).toEqual({ args: { query: "weather" }, toolCallId: "call-injected-tool" })
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, "https://injected-openai.test/v1") },
  )

  it.instance(
    "executes OpenAI tool calls through native runtime",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item-native-tool", call_id: "call-native-tool", name: "lookup" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-native-tool",
            delta: '{"query":"weather"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item-native-tool",
              call_id: "call-native-tool",
              name: "lookup",
              arguments: '{"query":"weather"}',
            },
          },
          {
            type: "response.completed",
            response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))
        let executed: unknown

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-tool")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor({ flags: { experimentalNativeLlm: true } }), {
          user: {
            id: MessageID.make("msg_user-native-tool"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "Use lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup data",
              inputSchema: z.object({ query: z.string() }),
              execute: async (args, options) => {
                executed = { args, toolCallId: options.toolCallId }
                return { output: "looked up" }
              },
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.body.tools).toEqual([
          {
            type: "function",
            name: "lookup",
            description: "Lookup data",
            strict: false,
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        ])
        expect(executed).toEqual({ args: { query: "weather" }, toolCallId: "call-native-tool" })
      }),
    {
      config: () => {
        const model = loadFixture("openai", "gpt-5.2").model
        return {
          enabled_providers: ["openai"],
          provider: {
            openai: {
              name: "OpenAI",
              env: ["OPENAI_API_KEY"],
              npm: "@ai-sdk/openai",
              api: "https://api.openai.com/v1",
              models: { [model.id]: JSON.parse(JSON.stringify(model)) as ConfigModel },
              options: { apiKey: "test-openai-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  it.instance(
    "accepts user image attachments as data URLs for OpenAI models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.created",
            response: {
              id: "resp-data-url",
              created_at: Math.floor(Date.now() / 1000),
              model: model.id,
              service_tier: null,
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "item-data-url", status: "in_progress", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "item-data-url",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-data-url",
            delta: "Looks good",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))
        const image = `data:image/png;base64,${Buffer.from(
          yield* Effect.promise(() =>
            Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
          ),
        ).toString("base64")}`

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-data-url")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-data-url"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image" },
                { type: "file", mediaType: "image/png", filename: "large-image.png", data: image },
              ],
            },
          ] as ModelMessage[],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  const minimaxFixture = { providerID: "minimax", modelID: "MiniMax-M2.5" }
  it.instance(
    "sends messages API payload for Anthropic Compatible models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture(minimaxFixture.providerID, minimaxFixture.modelID).model

        const chunks = [
          {
            type: "message_start",
            message: {
              id: "msg-1",
              model: model.id,
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
          { type: "message_stop" },
        ]
        const request = waitRequest("/messages", createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(minimaxFixture.providerID),
          ModelV2.ID.make(model.id),
        )
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("minimax"), modelID: ModelV2.ID.make("MiniMax-M2.5") },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      }),
    {
      config: () => ({
        enabled_providers: [minimaxFixture.providerID],
        provider: {
          [minimaxFixture.providerID]: {
            options: { apiKey: "test-anthropic-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "sends anthropic tool_use blocks with tool_result immediately after them",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("anthropic", "claude-opus-4-6").model
        const chunks = [
          {
            type: "message_start",
            message: {
              id: "msg-tool-order",
              model: model.id,
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
          { type: "message_stop" },
        ]
        const request = waitRequest("/messages", createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("anthropic"), ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-anthropic-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-anthropic-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("anthropic"), modelID: resolved.id, variant: "max" },
        } satisfies SessionV1.User

        const input = [
          {
            info: {
              id: "msg_user",
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "gentleman",
              model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
            },
            parts: [
              {
                id: "p_user",
                sessionID,
                messageID: "msg_user",
                type: "text",
                text: "Can you check whether there are any PDF files in my home directory?",
              },
            ],
          },
          {
            info: {
              id: "msg_call",
              sessionID,
              parentID: "msg_user",
              role: "assistant",
              mode: "gentleman",
              agent: "gentleman",
              variant: "max",
              path: { cwd: "/root", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "claude-opus-4-6",
              providerID: "anthropic",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            },
            parts: [
              {
                id: "p_step",
                sessionID,
                messageID: "msg_call",
                type: "step-start",
              },
              {
                id: "p_read",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "read",
                callID: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                state: {
                  status: "completed",
                  input: { filePath: "/root" },
                  output: "<path>/root</path>",
                  metadata: {},
                  title: "root",
                  time: { start: 10, end: 11 },
                },
              },
              {
                id: "p_glob",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "glob",
                callID: "toolu_01APxrADs7VozN8uWzw9WwHr",
                state: {
                  status: "completed",
                  input: { pattern: "**/*.pdf", path: "/root" },
                  output: "No files found",
                  metadata: {},
                  title: "root",
                  time: { start: 12, end: 13 },
                },
              },
              {
                id: "p_text",
                sessionID,
                messageID: "msg_call",
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                time: { start: 14, end: 15 },
              },
            ],
          },
        ] as any[]

        const modelMessages = yield* Effect.promise(() => MessageV2.toModelMessages(input as any, resolved))
        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: modelMessages,
          tools: {
            read: tool({
              description: "Stub read tool",
              inputSchema: z.object({ filePath: z.string() }),
              execute: async () => ({ output: "stub" }),
            }),
            glob: tool({
              description: "Stub glob tool",
              inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
              execute: async () => ({ output: "stub" }),
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
        expect(messages[0]?.role).toBe("user")
        expect(messages[0]?.content[0]).toMatchObject({
          type: "text",
          text: "Can you check whether there are any PDF files in my home directory?",
        })
        expect(messages.some((message) => message.content.some((part) => "cache_control" in part))).toBe(true)
        const toolUseIndex = messages.findIndex((message) => message.content.some((part) => part.type === "tool_use"))
        expect(toolUseIndex).toBeGreaterThan(0)
        expect(messages[toolUseIndex].role).toBe("assistant")
        expect(messages[toolUseIndex].content.filter((part) => part.type === "tool_use")).toMatchObject([
          {
            type: "tool_use",
            id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
            name: "read",
            input: { filePath: "/root" },
          },
          {
            type: "tool_use",
            id: "toolu_01APxrADs7VozN8uWzw9WwHr",
            name: "glob",
            input: { pattern: "**/*.pdf", path: "/root" },
          },
        ])
        expect(messages[toolUseIndex + 1]).toMatchObject({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT", content: "<path>/root</path>" },
            { type: "tool_result", tool_use_id: "toolu_01APxrADs7VozN8uWzw9WwHr", content: "No files found" },
          ],
        })
      }),
    {
      config: () => {
        const model = loadFixture("anthropic", "claude-opus-4-6").model
        return {
          enabled_providers: ["anthropic"],
          provider: {
            anthropic: {
              name: "Anthropic",
              env: ["ANTHROPIC_API_KEY"],
              npm: "@ai-sdk/anthropic",
              api: "https://api.anthropic.com/v1",
              models: { [model.id]: configModel(model) as ConfigModel },
              options: { apiKey: "test-anthropic-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  const geminiFixture = { providerID: "google", modelID: "gemini-2.5-flash" }
  it.instance(
    "sends Google API payload for Gemini models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture(geminiFixture.providerID, geminiFixture.modelID).model
        const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

        const chunks = [
          {
            candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          },
        ]
        const request = waitRequest(pathSuffix, createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(geminiFixture.providerID),
          ModelV2.ID.make(model.id),
        )
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(geminiFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: [{ type: "reasoning", text: "" }] },
          ],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }])
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      }),
    {
      config: () => ({
        enabled_providers: [geminiFixture.providerID],
        provider: {
          [geminiFixture.providerID]: {
            options: { apiKey: "test-google-key", baseURL: `${state.server!.url.origin}/v1beta` },
          },
        },
      }),
    },
  )
})
