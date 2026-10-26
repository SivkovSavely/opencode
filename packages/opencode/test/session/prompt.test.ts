import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq, sql } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Scope } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { randomUUID } from "node:crypto"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { Runner } from "@/effect/runner"
import { SessionQueue } from "../../src/session/queue"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { InstanceStore } from "@/project/instance-store"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { ServerRecovery } from "@/server/recovery"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"

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

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      lazyServers: () => Effect.succeed([]),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      ensureConnected: () => Effect.succeed({ status: "failed", error: "unexpected MCP connection" }),
      configuredServer: () => Effect.succeed(false),
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)
const interruptedSnapshot = Layer.mock(Snapshot.Service)({
  init: () => Effect.void,
  cleanup: () => Effect.void,
  track: () => Effect.interrupt,
})

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  SessionQueue.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

function makePrompt(input?: {
  mcpInstructions?: MCP.ServerInstructions[]
  processor?: "blocking"
  snapshot?: Layer.Layer<Snapshot.Service>
  plugin?: Layer.Layer<Plugin.Service>
}) {
  const snapshotReplacement = input?.snapshot ? [[Snapshot.node, input.snapshot] as const] : []
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
    ...snapshotReplacement,
  ] as const
  if (input?.plugin) {
    const withPlugin = [...replacements, [Plugin.node, input.plugin]] as const
    if (input.processor === "blocking")
      return LayerNode.compile(promptRoot, [...withPlugin, [SessionProcessor.node, blockingProcessor]])
    return LayerNode.compile(promptRoot, withPlugin)
  }
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: {
  mcpInstructions?: MCP.ServerInstructions[]
  processor?: "blocking"
  snapshot?: Layer.Layer<Snapshot.Service>
  plugin?: Layer.Layer<Plugin.Service>
}) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const snapshotReplacement = input?.snapshot ? [[Snapshot.node, input.snapshot] as const] : []
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
    ...snapshotReplacement,
  ] as const
  if (input?.plugin) {
    const withPlugin = [...replacements, [Plugin.node, input.plugin]] as const
    if (input.processor === "blocking")
      return LayerNode.compile(root, [...withPlugin, [SessionProcessor.node, blockingProcessor]])
    return LayerNode.compile(root, withPlugin)
  }
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const makeOwnedRuntime = (
  archiveAfterAdmission = false,
  processor?: "blocking",
  snapshot?: Layer.Layer<Snapshot.Service>,
  failInterruptedReleaseOnce = false,
) =>
  makeHttp({ processor, snapshot }).pipe(
    Layer.provideMerge(
      Layer.effect(
        RuntimeLifecycle.Service,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const scope = yield* Scope.Scope
          const previous = RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable()
          const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, scope, database)
          let shouldFailInterruptedRelease = failInterruptedReleaseOnce
          const service = archiveAfterAdmission
            ? {
                ...runtime,
                admit: (input: Parameters<RuntimeLifecycle.Interface["admit"]>[0]) =>
                  runtime
                    .admit(input)
                    .pipe(
                      Effect.tap(() =>
                        database.db
                          .run(sql`UPDATE session SET time_archived = ${Date.now()} WHERE id = ${input.sessionID}`)
                          .pipe(Effect.orDie),
                      ),
                    ),
              }
            : runtime
          const decorated = failInterruptedReleaseOnce
            ? {
                ...service,
                releaseInterrupted: (sessionID: string, fence: number, onPark?: Effect.Effect<void>) => {
                  if (shouldFailInterruptedRelease) {
                    shouldFailInterruptedRelease = false
                    return Effect.die(new Error("simulated interrupted release failure"))
                  }
                  return runtime.releaseInterrupted(sessionID, fence, onPark)
                },
              }
            : service
          RuntimeLifecycle.setCurrent(decorated)
          yield* Effect.addFinalizer(() => Effect.sync(() => RuntimeLifecycle.setCurrent(previous)))
          return decorated
        }),
      ).pipe(Layer.provide(LayerNode.compile(Database.node))),
    ),
  )
const ownedRuntime = testEffect(makeOwnedRuntime())
const ownedBlockingRuntime = testEffect(makeOwnedRuntime(false, "blocking"))
const archivingRuntime = testEffect(makeOwnedRuntime(true))
const interruptedReleaseRetryRuntime = testEffect(makeOwnedRuntime(false, undefined, interruptedSnapshot, true))
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const mutatingTaskPlugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    trigger: ((name: string, input: { tool?: string }, output: { args: Record<string, string> }) => {
      if (name === "tool.execute.before" && input.tool === "task") {
        output.args.prompt = "plugin-mutated prompt"
        output.args.description = "plugin-mutated description"
        output.args.subagent_type = "missing-agent"
      }
      return Effect.succeed(output)
    }) as Plugin.Interface["trigger"],
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }),
)
const withMutatingTaskPlugin = testEffect(makeHttp({ plugin: mutatingTaskPlugin }))
const shellEnvStarted = Deferred.makeUnsafe<void>()
const shellEnvFailed = Deferred.makeUnsafe<void>()
const withFailingShellPlugin = testEffect(
  makeHttp({
    plugin: Layer.succeed(
      Plugin.Service,
      Plugin.Service.of({
        trigger: (name, _input, output) =>
          name === "shell.env"
            ? Deferred.succeed(shellEnvStarted, undefined).pipe(
                Effect.andThen(Deferred.await(shellEnvFailed)),
                Effect.andThen(Effect.die("shell environment failed")),
              )
            : Effect.succeed(output),
        list: () => Effect.succeed([]),
        init: () => Effect.void,
      }),
    ),
  }),
)
const withCallbackPlugin = testEffect(
  makeHttp({
    plugin: Layer.effect(
      Plugin.Service,
      Effect.gen(function* () {
        const database = yield* Database.Service
        const trigger: Plugin.Interface["trigger"] = (name, _input, output) =>
          name === "chat.message"
            ? // Emulate a plugin HTTP callback without inheriting the caller's transaction.
              Effect.promise(() =>
                Effect.runPromise(database.db.get(sql`SELECT value FROM queue_callback_probe`)),
              ).pipe(Effect.as(output))
            : Effect.succeed(output)
        return Plugin.Service.of({ trigger, list: () => Effect.succeed([]), init: () => Effect.void })
      }),
    ).pipe(Layer.provide(LayerNode.compile(Database.node))),
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
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

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
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

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref, agent = "general") =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent,
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

const queuedPrompt = (text: string): SessionQueueV1.Payload => ({
  kind: "prompt",
  agent: "build",
  model: ref,
  parts: [{ type: "text", text }],
})

it.instance("native queue waits for success and drains only one input at a time", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const first = yield* Deferred.make<void>()
    const second = yield* Deferred.make<void>()
    yield* llm.hold("initial result", deferredAsPromise(first))
    yield* llm.hold("first queued result", deferredAsPromise(second))
    yield* llm.text("second queued result")
    const running = yield* prompt
      .prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "initial input" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, { id: "queue-one", payload: queuedPrompt("queued-one") })
    yield* prompt.queueSubmit(chat.id, { id: "queue-two", payload: queuedPrompt("queued-two") })
    expect(
      (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "user"),
    ).toHaveLength(1)
    expect((yield* queue.list(chat.id)).items.map((item) => item.state)).toEqual(["pending", "pending"])
    yield* Deferred.succeed(first, undefined)
    yield* llm.wait(2)
    expect((yield* queue.get(chat.id, "queue-one")).state).toBe("delivered")
    expect((yield* queue.get(chat.id, "queue-one")).messageID).toBe(MessageID.make("msg_queue_queue-one"))
    expect((yield* queue.get(chat.id, "queue-two")).state).toBe("pending")
    expect(JSON.stringify((yield* llm.hits)[1].body)).not.toContain("queued-two")
    yield* Deferred.succeed(second, undefined)
    yield* Fiber.join(running)
    expect(yield* llm.calls).toBe(3)
    expect((yield* queue.list(chat.id)).items).toEqual([])
  }),
)

it.instance("native queue idle admission respects pause and front ordering", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const paused = yield* queue.list(chat.id)
    yield* prompt.queueUpdate(chat.id, { revision: paused.revision, mutation: { action: "pause", paused: true } })
    yield* prompt.queueSubmit(chat.id, { id: "back", payload: queuedPrompt("back-input") })
    yield* prompt.queueSubmit(chat.id, { id: "front", front: true, payload: queuedPrompt("front-input") })
    expect(yield* llm.calls).toBe(0)
    yield* llm.text("front-result")
    yield* llm.text("back-result")
    yield* prompt.queueResume(chat.id)
    yield* llm.wait(2)
    const hits = yield* llm.hits
    expect(JSON.stringify(hits[0].body)).toContain("front-input")
    expect(JSON.stringify(hits[0].body)).not.toContain("back-input")
    expect(JSON.stringify(hits[1].body)).toContain("back-input")
    yield* prompt.loop({ sessionID: chat.id })
    expect((yield* queue.list(chat.id)).items).toEqual([])
  }),
)

it.instance("native queue steer reorder changes provider history and the selected parent", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const ready = yield* Deferred.make<void>()
    yield* llm.hold("initial result", deferredAsPromise(ready))
    yield* llm.text("steered result")
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    const one = yield* prompt.prompt({
      sessionID: chat.id,
      noReply: true,
      parts: [{ type: "text", text: "steer-one" }],
    })
    const two = yield* prompt.prompt({
      sessionID: chat.id,
      noReply: true,
      parts: [{ type: "text", text: "steer-two" }],
    })
    const active = (yield* sessions.messages({ sessionID: chat.id })).find(
      (message) => message.info.role === "assistant",
    )
    if (!active) throw new Error("missing active assistant")
    // A steer can persist after the snapshot but before its assistant is created.
    yield* sessions.updateMessage({ ...one.info, time: { created: active.info.time.created - 1 } })
    const pending = yield* queue.list(chat.id)
    expect(pending.items.map((item) => item.messageID)).toEqual([one.info.id, two.info.id])
    yield* prompt.queueUpdate(chat.id, {
      revision: pending.revision,
      mutation: { action: "reorder", delivery: "steer", ids: [two.info.id, one.info.id] },
    })
    yield* Deferred.succeed(ready, undefined)
    const result = yield* Fiber.join(running)
    const body = JSON.stringify((yield* llm.hits)[1].body)
    expect(body.indexOf("initial result")).toBeLessThan(body.indexOf("steer-two"))
    expect(body.indexOf("steer-two")).toBeLessThan(body.indexOf("steer-one"))
    expect(result.info.role === "assistant" && result.info.parentID).toBe(one.info.id)
    yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.calls).toBe(2)
    const consumed = yield* prompt
      .queueUpdate(chat.id, {
        revision: (yield* queue.list(chat.id)).revision,
        mutation: { action: "convert", id: one.info.id, delivery: "queue" },
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(consumed)).toBe(true)
  }),
)

it.instance("native queue conversion removes the steer bubble before the next boundary", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const ready = yield* Deferred.make<void>()
    yield* llm.hold("initial result", deferredAsPromise(ready))
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    const steer = yield* prompt.prompt({
      sessionID: chat.id,
      noReply: true,
      parts: [{ type: "text", text: "not-yet" }],
    })
    yield* prompt.queueUpdate(chat.id, {
      revision: (yield* queue.list(chat.id)).revision,
      mutation: { action: "convert", id: steer.info.id, delivery: "queue" },
    })
    expect(
      (yield* sessions.messages({ sessionID: chat.id })).some((message) => message.info.id === steer.info.id),
    ).toBe(false)
    yield* prompt.queueUpdate(chat.id, {
      revision: (yield* queue.list(chat.id)).revision,
      mutation: { action: "pause", paused: true },
    })
    yield* Deferred.succeed(ready, undefined)
    yield* Fiber.join(running)
    expect(yield* llm.calls).toBe(1)
    expect((yield* queue.get(chat.id, steer.info.id)).state).toBe("pending")
  }),
)

it.instance("native queue conversion to steer bypasses queue pause but not the running turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const ready = yield* Deferred.make<void>()
    yield* llm.hold("initial result", deferredAsPromise(ready))
    yield* llm.text("converted result")
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, { id: "converted", payload: queuedPrompt("converted-input") })
    yield* prompt.queueUpdate(chat.id, {
      revision: (yield* queue.list(chat.id)).revision,
      mutation: { action: "pause", paused: true },
    })
    yield* prompt.queueUpdate(chat.id, {
      revision: (yield* queue.list(chat.id)).revision,
      mutation: { action: "convert", id: "converted", delivery: "steer" },
    })
    expect(
      (yield* sessions.messages({ sessionID: chat.id })).some((message) => message.info.id === "msg_queue_converted"),
    ).toBe(true)
    expect(yield* llm.calls).toBe(1)
    yield* Deferred.succeed(ready, undefined)
    yield* Fiber.join(running)
    expect(JSON.stringify((yield* llm.hits)[1].body)).toContain("converted-input")
    expect((yield* queue.get(chat.id, "converted")).state).toBe("delivered")
  }),
)

it.instance("native queue wakes retain pending steering when a paused enqueue replaces a shell advisory", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const state = yield* SessionRunState.Service
    const seeded = yield* seed(chat.id, { finish: "stop" })
    const release = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<void>()
    const shell = yield* state
      .startShell(
        chat.id,
        Effect.succeed({ info: seeded.assistant, parts: [] }),
        Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ info: seeded.assistant, parts: [] }),
        ),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(ready)
    yield* prompt.queueUpdate(chat.id, { revision: 0, mutation: { action: "pause", paused: true } })
    yield* prompt.queueSubmit(chat.id, { id: "steering-wake", payload: queuedPrompt("must steer") })
    yield* prompt.queueUpdate(chat.id, {
      revision: (yield* queue.list(chat.id)).revision,
      mutation: { action: "convert", id: "steering-wake", delivery: "steer" },
    })
    yield* prompt.queueSubmit(chat.id, { id: "paused-wake", payload: queuedPrompt("must wait") })
    yield* llm.text("steered after shell")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(shell)
    yield* llm.wait(1)
    yield* prompt.loop({ sessionID: chat.id })
    expect(JSON.stringify((yield* llm.hits)[0].body)).toContain("must steer")
    expect(JSON.stringify((yield* llm.hits)[0].body)).not.toContain("must wait")
    expect((yield* queue.get(chat.id, "steering-wake")).state).toBe("delivered")
    expect((yield* queue.get(chat.id, "paused-wake")).state).toBe("pending")
  }),
)

it.instance("native queue requeued legacy steers preserve resolved parts without expanding attachments twice", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const original = yield* prompt.prompt({
      sessionID: chat.id,
      model: ref,
      agent: "build",
      variant: "default",
      noReply: true,
      parts: [
        { type: "file", mime: "text/plain", filename: "inline.txt", url: "data:text/plain;base64,YXR0YWNobWVudA==" },
      ],
    })
    const entry = yield* queue.get(chat.id, original.info.id)
    expect(entry.payload.agent).toBe("build")
    expect(entry.payload.model).toEqual(ref)
    expect(entry.payload.variant).toBe("default")
    expect(entry.payload.kind === "prompt" && entry.payload.parts.length).toBe(original.parts.length)
    yield* prompt.queueUpdate(chat.id, {
      revision: (yield* queue.list(chat.id)).revision,
      mutation: { action: "convert", id: original.info.id, delivery: "queue" },
    })
    yield* llm.text("attachment result")
    yield* prompt.queueResume(chat.id)
    yield* llm.wait(1)
    yield* prompt.loop({ sessionID: chat.id })
    const replayed = (yield* sessions.messages({ sessionID: chat.id })).find((message) => message.info.role === "user")
    expect(replayed?.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(
      original.parts.filter((part) => part.type === "text").map((part) => part.text),
    )
    expect(replayed?.info.role === "user" && replayed.info.model.variant).toBe("default")
  }),
)

it.instance("native queue concurrent flushes coalesce at a successful boundary", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const ready = yield* Deferred.make<void>()
    yield* llm.hold("initial result", deferredAsPromise(ready))
    yield* llm.text("first flushed result")
    yield* llm.text("second flushed result")
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, { id: "flush-one", payload: queuedPrompt("flush-one-input") })
    yield* prompt.queueSubmit(chat.id, { id: "flush-two", payload: queuedPrompt("flush-two-input") })
    yield* prompt.queueUpdate(chat.id, {
      revision: (yield* queue.list(chat.id)).revision,
      mutation: { action: "pause", paused: true },
    })
    yield* Effect.all([prompt.queueFlush(chat.id), prompt.queueFlush(chat.id)], { concurrency: "unbounded" })
    yield* Deferred.succeed(ready, undefined)
    yield* Fiber.join(running)
    expect(yield* llm.calls).toBe(3)
    expect((yield* queue.get(chat.id, "flush-two")).state).toBe("delivered")
  }),
)

it.instance("native queue cancellation blocks pending inputs until explicit resume", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    yield* llm.hang
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, { id: "cancel-one", payload: queuedPrompt("cancel-one-input") })
    yield* prompt.cancel(chat.id)
    yield* Fiber.join(running)
    yield* prompt.queueSubmit(chat.id, { id: "cancel-two", payload: queuedPrompt("cancel-two-input") })
    const blocked = yield* queue.list(chat.id)
    expect(blocked.blocked).toBe(true)
    expect(blocked.items.map((item) => item.state)).toEqual(["pending", "pending"])
    expect(yield* llm.calls).toBe(1)
    yield* llm.text("resumed-one")
    yield* llm.text("resumed-two")
    const resumed = yield* prompt.queueUpdate(chat.id, {
      revision: blocked.revision,
      mutation: { action: "pause", paused: false },
    })
    expect(resumed.blocked).toBe(false)
    yield* llm.wait(3)
    yield* prompt.loop({ sessionID: chat.id })
    expect((yield* queue.list(chat.id)).items).toEqual([])
  }),
)

it.instance("native queue provider errors discard an in-flight explicit flush", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const ready = yield* Deferred.make<void>()
    yield* llm.push(reply().wait(deferredAsPromise(ready)).contentFilter())
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, { id: "after-error", payload: queuedPrompt("after-error-input") })
    yield* prompt.queueFlush(chat.id)
    yield* Deferred.succeed(ready, undefined)
    yield* Fiber.join(running)
    const status = yield* SessionStatus.Service
    yield* pollWithTimeout(
      status.get(chat.id).pipe(Effect.map((value) => (value.type === "idle" ? true : undefined))),
      "error completion left queue advisory active",
    )
    expect(yield* llm.calls).toBe(1)
    expect((yield* queue.get(chat.id, "after-error")).state).toBe("pending")
  }),
)

noLLMServer.instance(
  "native queue recovery blocks pending inputs without replaying them",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      const seeded = yield* seed(chat.id, { finish: "stop" })
      yield* sessions.updateMessage({ ...seeded.assistant, time: { ...seeded.assistant.time, completed: Date.now() } })
      yield* queue.enqueue(chat.id, { id: "after-recovery", payload: queuedPrompt("after-recovery-input") })
      yield* prompt.recover(chat.id)
      const snapshot = yield* queue.list(chat.id)
      expect(snapshot.blocked).toBe(true)
      expect(snapshot.items.map((item) => item.state)).toEqual(["pending"])
    }),
  { config: cfg },
)

it.instance("native queue idle flush serializes its snapshot past later front insertions", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    yield* prompt.queueUpdate(chat.id, { revision: 0, mutation: { action: "pause", paused: true } })
    yield* prompt.queueSubmit(chat.id, { id: "idle-one", payload: queuedPrompt("idle-one-input") })
    yield* prompt.queueSubmit(chat.id, { id: "idle-two", payload: queuedPrompt("idle-two-input") })
    const release = yield* Deferred.make<void>()
    yield* llm.hold("idle result", deferredAsPromise(release))
    yield* llm.text("second flushed result")
    yield* prompt.queueFlush(chat.id)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, { id: "idle-three", front: true, payload: queuedPrompt("later-input") })
    yield* prompt.queueFlush(chat.id)
    yield* Deferred.succeed(release, undefined)
    yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.calls).toBe(2)
    expect((yield* queue.get(chat.id, "idle-two")).state).toBe("delivered")
    expect((yield* queue.get(chat.id, "idle-three")).state).toBe("pending")
    const hits = yield* llm.hits
    expect(JSON.stringify(hits[1].body)).toContain("idle-two-input")
    expect(JSON.stringify(hits[1].body)).not.toContain("later-input")
  }),
)

it.instance("native queue an empty flush does not bypass pause for a later submission", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    yield* prompt.queueUpdate(chat.id, { revision: 0, mutation: { action: "pause", paused: true } })
    yield* prompt.queueFlush(chat.id)
    const snapshot = yield* prompt.queueSubmit(chat.id, {
      id: "after-empty-flush",
      payload: queuedPrompt("still paused"),
    })
    expect(snapshot.items.map((item) => item.state)).toEqual(["pending"])
    expect(yield* llm.calls).toBe(0)
  }),
)

it.instance("native queue explicit flush stops its remaining snapshot after a provider error", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    yield* prompt.queueUpdate(chat.id, { revision: 0, mutation: { action: "pause", paused: true } })
    yield* prompt.queueSubmit(chat.id, { id: "flush-error", payload: queuedPrompt("first input") })
    yield* prompt.queueSubmit(chat.id, { id: "flush-after-error", payload: queuedPrompt("must remain pending") })
    yield* llm.push(reply().contentFilter())
    yield* prompt.queueFlush(chat.id)
    yield* llm.wait(1)
    const status = yield* SessionStatus.Service
    yield* pollWithTimeout(
      status.get(chat.id).pipe(Effect.map((value) => (value.type === "idle" ? true : undefined))),
      "failed flush did not finish",
    )
    expect(yield* llm.calls).toBe(1)
    expect((yield* queue.get(chat.id, "flush-after-error")).state).toBe("pending")
    expect((yield* queue.list(chat.id)).blocked).toBe(true)
  }),
)

it.instance("native queue commands materialize inside the runner without recursive admission", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { queued: { template: "queued command $ARGUMENTS" } },
    }))
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    yield* llm.text("command result")
    yield* prompt.queueSubmit(chat.id, {
      id: "command-entry",
      payload: { kind: "command", agent: "build", model: ref, command: "queued", arguments: "example" },
    })
    yield* llm.wait(1)
    yield* prompt.loop({ sessionID: chat.id })
    expect(JSON.stringify((yield* llm.hits)[0].body)).toContain("queued command example")
    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(messages.filter((message) => message.info.role === "user").map((message) => message.info.id)).toEqual([
      MessageID.make("msg_queue_command-entry"),
    ])
    expect((yield* queue.get(chat.id, "command-entry")).state).toBe("delivered")
    expect(yield* llm.calls).toBe(1)
  }),
)

unix("pending command conversions defer interpolation until an irreversible claim", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const file = path.join(directory, "converted-command-side-effect")
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { once: { template: `resolved !\`printf 'once\\n' >> '${file}'; printf command-output\`` } },
    }))
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const release = yield* Deferred.make<void>()
    yield* llm.hold("initial result", deferredAsPromise(release))
    yield* llm.text("command result")
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, {
      id: "roundtrip-command",
      payload: { kind: "command", agent: "build", model: ref, command: "once", arguments: "" },
    })
    for (const delivery of ["steer", "queue", "steer"] as const) {
      yield* prompt.queueUpdate(chat.id, {
        revision: (yield* queue.list(chat.id)).revision,
        mutation: { action: "convert", id: "roundtrip-command", delivery },
      })
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
    }
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(running)
    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("once\n")
    expect((yield* queue.get(chat.id, "roundtrip-command")).state).toBe("delivered")
    const body = JSON.stringify((yield* llm.hits)[1].body)
    expect(body).toContain("resolved command-output")
    expect(body).not.toContain("/once")
    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(messages.filter((message) => message.info.id === "msg_queue_roundtrip-command")).toHaveLength(1)
    expect(yield* llm.calls).toBe(2)
  }),
)

unix("cancelling a queued command terminates its interpolation process before returning", () =>
  withSh(() =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const pid = path.join(directory, "interpolation-pid")
      const gate = path.join(directory, "interpolation-release")
      const sideEffect = path.join(directory, "interpolation-side-effect")
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        command: {
          waiting: {
            template: `!\`printf '%s' $$ > '${pid}'; while [ ! -f '${gate}' ]; do sleep 0.01; done; touch '${sideEffect}'\``,
          },
        },
      }))
      const { prompt, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      yield* prompt.queueSubmit(chat.id, {
        id: "cancel-interpolation",
        payload: { kind: "command", agent: "build", model: ref, command: "waiting", arguments: "" },
      })
      yield* pollWithTimeout(
        Effect.promise(() => Bun.file(pid).exists()).pipe(Effect.map((exists) => (exists ? true : undefined))),
        "queued interpolation did not start",
      )
      const processID = Number(yield* Effect.promise(() => Bun.file(pid).text()))
      yield* awaitWithTimeout(prompt.cancel(chat.id), "cancellation did not terminate interpolation")
      expect(Exit.isFailure(yield* Effect.sync(() => process.kill(processID, 0)).pipe(Effect.exit))).toBe(true)
      yield* writeText(gate, "release")
      expect(yield* Effect.promise(() => Bun.file(sideEffect).exists())).toBe(false)
      expect((yield* queue.list(chat.id)).blocked).toBe(true)
      expect(yield* llm.calls).toBe(0)
    }),
  ),
)

withFailingShellPlugin.instance(
  "a failed shell discards queued flush authorization",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      const snapshot = yield* queue.list(chat.id)
      yield* prompt.queueUpdate(chat.id, { revision: snapshot.revision, mutation: { action: "pause", paused: true } })
      yield* prompt.queueSubmit(chat.id, { id: "before-shell-failure", payload: queuedPrompt("A") })
      const shell = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", model: ref, command: "echo shell" })
        .pipe(Effect.exit, Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(shellEnvStarted), "shell did not reach environment hook")
      yield* prompt.queueFlush(chat.id)
      yield* Deferred.succeed(shellEnvFailed, undefined)
      expect(Exit.isFailure(yield* Fiber.join(shell))).toBe(true)
      yield* prompt.queueSubmit(chat.id, { id: "after-shell-failure", payload: queuedPrompt("B") })
      const after = yield* queue.list(chat.id)
      expect(after.paused).toBe(true)
      expect(after.blocked).toBe(true)
      expect(after.items.map((entry) => entry.state)).toEqual(["pending", "pending"])
    }),
  { config: cfg },
)

unix("native queue shells persist delivery before executing and do not replay exact submissions", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const file = path.join(dir, "queue-side-effect")
    const submit = {
      id: "shell-entry",
      payload: { kind: "shell" as const, agent: "build", model: ref, command: `printf 'once\\n' >> '${file}'` },
    }
    yield* llm.text("shell result")
    yield* prompt.queueSubmit(chat.id, submit)
    yield* llm.wait(1)
    yield* prompt.loop({ sessionID: chat.id })
    yield* prompt.queueSubmit(chat.id, submit)
    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("once\n")
    expect((yield* queue.get(chat.id, submit.id)).state).toBe("delivered")
    expect(
      (yield* sessions.messages({ sessionID: chat.id })).some((message) => message.info.id === "msg_queue_shell-entry"),
    ).toBe(true)
    expect(yield* llm.calls).toBe(1)
  }),
)

unix("native queue converted shell steers execute only at the runner boundary", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const file = path.join(dir, "converted-shell-side-effect")
    const release = yield* Deferred.make<void>()
    yield* llm.hold("initial result", deferredAsPromise(release))
    yield* llm.text("converted shell result")
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, {
      id: "converted-shell",
      payload: { kind: "shell", agent: "build", model: ref, command: `printf 'once\\n' >> '${file}'` },
    })
    yield* prompt.queueUpdate(chat.id, {
      revision: (yield* queue.list(chat.id)).revision,
      mutation: { action: "convert", id: "converted-shell", delivery: "steer" },
    })
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(running)
    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("once\n")
    expect(
      (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "user"),
    ).toHaveLength(2)
    expect((yield* queue.get(chat.id, "converted-shell")).state).toBe("delivered")
  }),
)

noLLMServer.instance(
  "native queue recovery does not start an unconsumed shell steer",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { prompt, sessions, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      const database = yield* Database.Service
      const seeded = yield* seed(chat.id, { finish: "stop" })
      yield* sessions.updateMessage({ ...seeded.assistant, time: { ...seeded.assistant.time, completed: Date.now() } })
      const file = path.join(directory, "never-started-shell")
      const snapshot = yield* queue.enqueue(chat.id, {
        id: "recovered-shell",
        payload: { kind: "shell", agent: "build", model: ref, command: `touch '${file}'` },
      })
      yield* database.db.transaction(
        () =>
          Effect.gen(function* () {
            yield* queue.update(chat.id, {
              revision: snapshot.revision,
              mutation: { action: "convert", id: "recovered-shell", delivery: "steer" },
            })
            const bubble = yield* user(chat.id, "unconsumed shell")
            yield* queue.attachSteer(chat.id, "recovered-shell", bubble.id)
          }),
        { behavior: "immediate" },
      )
      yield* prompt.recover(chat.id)
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
      expect((yield* queue.get(chat.id, "recovered-shell")).state).toBe("pending")
      expect((yield* queue.list(chat.id)).blocked).toBe(true)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "recovery excludes an unresolved claimed command instead of replaying its template or sending its source",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      const seeded = yield* seed(chat.id, { finish: "stop" })
      yield* sessions.updateMessage({ ...seeded.assistant, time: { ...seeded.assistant.time, completed: Date.now() } })
      const snapshot = yield* queue.enqueue(chat.id, {
        id: "uncertain-command",
        payload: { kind: "command", agent: "build", model: ref, command: "must-not-resolve", arguments: "" },
      })
      yield* queue.update(chat.id, {
        revision: snapshot.revision,
        mutation: { action: "convert", id: "uncertain-command", delivery: "steer" },
      })
      const bubble = yield* user(chat.id, "/must-not-resolve")
      yield* queue.attachSteer(chat.id, "uncertain-command", bubble.id)
      expect((yield* queue.claimSteers(chat.id, [bubble.id]))[0].state).toBe("claimed")
      yield* prompt.recover(chat.id)
      expect((yield* queue.get(chat.id, "uncertain-command")).state).toBe("claimed")
      expect((yield* queue.list(chat.id)).blocked).toBe(true)
    }),
  { config: cfg },
)

it.instance("native queue compaction creates a stable transcript boundary and drains the next input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updateMessage({ ...seeded.assistant, time: { ...seeded.assistant.time, completed: Date.now() } })
    yield* queue.enqueue(chat.id, { id: "compact-entry", payload: { kind: "compact", agent: "build", model: ref } })
    yield* queue.enqueue(chat.id, { id: "after-compact", payload: queuedPrompt("after-compact-input") })
    yield* llm.text("compacted summary")
    yield* llm.text("after compaction result")
    yield* prompt.queueResume(chat.id)
    yield* llm.wait(2)
    yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(
      messages
        .find((message) => message.info.id === "msg_queue_compact-entry")
        ?.parts.some((part) => part.type === "compaction"),
    ).toBe(true)
    expect((yield* queue.get(chat.id, "compact-entry")).state).toBe("delivered")
    expect((yield* queue.get(chat.id, "after-compact")).state).toBe("delivered")
  }),
)

archivingRuntime.instance("native queue releases admission when a session is archived before its claim", () =>
  Effect.gen(function* () {
    const { prompt, chat } = yield* boot()
    const runtime = yield* RuntimeLifecycle.Service
    const state = yield* SessionRunState.Service
    const database = yield* Database.Service
    yield* prompt.queueSubmit(chat.id, { id: "archive-race", payload: queuedPrompt("not delivered") }).pipe(Effect.exit)
    expect((yield* runtime.status()).active).toBe(0)
    yield* state.assertNotBusy(chat.id)
    expect(
      yield* database.db.get<{ state: string }>(sql`SELECT state FROM runtime_execution WHERE session_id = ${chat.id}`),
    ).toMatchObject({ state: "completed" })
    yield* runtime.request("shutdown")
    yield* awaitWithTimeout(runtime.awaitDrain, "leaked queue admission prevented graceful drain")
  }),
)

ownedRuntime.instance("native queue automatic admission cannot revive a cancelled runtime", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const runtime = yield* RuntimeLifecycle.Service
    const queue = yield* SessionQueue.Service
    yield* runtime.admit({ sessionID: chat.id, directory: chat.directory })
    yield* runtime.cancel(chat.id)
    yield* runtime.finishCancel(chat.id)
    yield* prompt.queueSubmit(chat.id, { id: "runtime-cancelled", payload: queuedPrompt("runtime-cancelled-input") })
    expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
    expect((yield* queue.get(chat.id, "runtime-cancelled")).state).toBe("pending")
    expect((yield* queue.list(chat.id)).blocked).toBe(true)
    expect(yield* llm.calls).toBe(0)
    yield* llm.text("explicitly resumed")
    yield* prompt.queueResume(chat.id)
    yield* llm.wait(1)
    yield* prompt.loop({ sessionID: chat.id })
    expect((yield* queue.get(chat.id, "runtime-cancelled")).state).toBe("delivered")
  }),
)

ownedRuntime.instance("native queue admission never performs manual recovery", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const database = yield* Database.Service
    const runtime = yield* RuntimeLifecycle.Service
    const queue = yield* SessionQueue.Service
    yield* runtime.admit({ sessionID: chat.id, directory: chat.directory })
    yield* runtime.release(chat.id)
    yield* database.db.run(sql`UPDATE runtime_execution SET state = 'recovery_needed' WHERE session_id = ${chat.id}`)
    yield* prompt.queueSubmit(chat.id, { id: "runtime-recovery", payload: queuedPrompt("runtime-recovery-input") })
    yield* prompt.queueResume(chat.id)
    expect((yield* queue.get(chat.id, "runtime-recovery")).state).toBe("pending")
    expect((yield* queue.list(chat.id)).blocked).toBe(true)
    expect(yield* llm.calls).toBe(0)
  }),
)

ownedRuntime.instance("native queue shutdown checkpoints leave queued inputs pending", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const runtime = yield* RuntimeLifecycle.Service
    const queue = yield* SessionQueue.Service
    const release = yield* Deferred.make<void>()
    yield* llm.hold("last result", deferredAsPromise(release))
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, { id: "during-shutdown", payload: queuedPrompt("during-shutdown-input") })
    yield* runtime.request("shutdown")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(running)
    expect((yield* queue.get(chat.id, "during-shutdown")).state).toBe("pending")
    expect(yield* llm.calls).toBe(1)
  }),
)

ownedRuntime.instance("native queue lost ownership cannot claim the next input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const database = yield* Database.Service
    const queue = yield* SessionQueue.Service
    const release = yield* Deferred.make<void>()
    yield* llm.hold("last owned result", deferredAsPromise(release))
    const running = yield* prompt
      .prompt({ sessionID: chat.id, model: ref, parts: [{ type: "text", text: "initial" }] })
      .pipe(Effect.exit, Effect.forkChild)
    yield* llm.wait(1)
    yield* prompt.queueSubmit(chat.id, { id: "after-fence", payload: queuedPrompt("after-fence-input") })
    yield* database.db.run(sql`UPDATE runtime_execution SET fence = fence + 1 WHERE session_id = ${chat.id}`)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(running)
    expect((yield* queue.get(chat.id, "after-fence")).state).toBe("pending")
    expect(yield* llm.calls).toBe(1)
  }),
)

noLLMServer.instance(
  "native queue registration failure rolls back the ordinary prompt bubble",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      const id = MessageID.make("msg_registration-conflict")
      yield* queue.enqueue(chat.id, { id, payload: queuedPrompt("reserved") })
      const result = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: id,
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "must roll back" }],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
      expect((yield* queue.get(chat.id, id)).delivery).toBe("queue")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "native queue delivery cannot overwrite a colliding legacy message ID",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      const existing = yield* user(chat.id, "preserve this message")
      yield* sessions.updateMessage({ ...existing, id: MessageID.make("msg_queue_collision") })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: MessageID.make("msg_queue_collision"),
        type: "text",
        text: "original collision content",
      })
      yield* prompt.queueSubmit(chat.id, { id: "collision", payload: queuedPrompt("must not overwrite") })
      yield* pollWithTimeout(
        queue.list(chat.id).pipe(Effect.map((snapshot) => (snapshot.blocked ? true : undefined))),
        "colliding delivery did not block",
      )
      const preserved = (yield* sessions.messages({ sessionID: chat.id })).find(
        (message) => message.info.id === "msg_queue_collision",
      )
      expect(preserved?.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "original collision content",
      ])
      expect((yield* queue.get(chat.id, "collision")).state).toBe("uncertain")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "stale queue conversions do not change session agent or model defaults",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "build",
        model: { providerID: ref.providerID, id: ref.modelID },
        time: Date.now(),
      })
      const before = yield* sessions.get(chat.id)
      const snapshot = yield* queue.enqueue(chat.id, {
        id: "stale-conversion",
        payload: { ...queuedPrompt("stale"), agent: "plan", variant: "different" },
      })
      yield* queue.update(chat.id, { revision: snapshot.revision, mutation: { action: "pause", paused: true } })
      const result = yield* prompt
        .queueUpdate(chat.id, {
          revision: snapshot.revision,
          mutation: { action: "convert", id: "stale-conversion", delivery: "steer" },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      const after = yield* sessions.get(chat.id)
      expect(after.agent).toBe(before.agent)
      expect(after.model).toEqual(before.model)
      expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
    }),
  { config: cfg },
)

noLLMServer.instance(
  "native queue conversion and attachment roll back together when resolution fails",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      const snapshot = yield* queue.enqueue(chat.id, {
        id: "invalid-conversion",
        payload: { ...queuedPrompt("invalid"), agent: "missing-agent" },
      })
      const result = yield* prompt
        .queueUpdate(chat.id, {
          revision: snapshot.revision,
          mutation: { action: "convert", id: "invalid-conversion", delivery: "steer" },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* queue.list(chat.id)).toEqual(snapshot)
      expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
    }),
  { config: cfg },
)

withCallbackPlugin.instance(
  "queue conversion resolves database-calling message hooks outside its writer transaction",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, sessions, chat } = yield* boot()
      const queue = yield* SessionQueue.Service
      const database = yield* Database.Service
      // A temporary table also verifies the callback shares this exact connection.
      yield* database.db.run(sql`CREATE TEMP TABLE queue_callback_probe (value INTEGER)`)
      yield* database.db.run(sql`INSERT INTO queue_callback_probe VALUES (1)`)
      yield* Effect.addFinalizer(() => database.db.run(sql`DROP TABLE queue_callback_probe`).pipe(Effect.orDie))
      yield* llm.text("converted")
      const snapshot = yield* queue.enqueue(chat.id, { id: "callback", payload: queuedPrompt("callback prompt") })
      yield* awaitWithTimeout(
        prompt.queueUpdate(chat.id, {
          revision: snapshot.revision,
          mutation: { action: "convert", id: "callback", delivery: "steer" },
        }),
        "conversion deadlocked on its message hook's independent database request",
      )
      const status = yield* SessionStatus.Service
      yield* pollWithTimeout(
        status.get(chat.id).pipe(Effect.map((value) => (value.type === "idle" ? true : undefined))),
        "converted prompt did not finish",
      )
      expect((yield* queue.get(chat.id, "callback")).state).toBe("delivered")
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "user"),
      ).toHaveLength(1)
    }),
)

it.instance("native queue retires a failed command claim without replaying it or blocking explicit continuation", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const file = path.join(directory, "command-template-side-effect")
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { unsafe: { template: `!\`printf 'once\\n' >> '${file}'\`` } },
    }))
    const { prompt, sessions, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    yield* prompt.queueSubmit(chat.id, {
      id: "failed-command",
      payload: { kind: "command", agent: "missing-agent", model: ref, command: "unsafe", arguments: "" },
    })
    yield* pollWithTimeout(
      queue.list(chat.id).pipe(Effect.map((snapshot) => (snapshot.blocked ? true : undefined))),
      "failed command did not block the queue",
    )
    expect((yield* queue.get(chat.id, "failed-command")).state).toBe("uncertain")
    expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
    yield* prompt.queueSubmit(chat.id, { id: "after-failed-command", payload: queuedPrompt("safe continuation") })
    yield* llm.text("continued")
    yield* prompt.queueResume(chat.id)
    yield* pollWithTimeout(
      queue
        .get(chat.id, "after-failed-command")
        .pipe(Effect.map((entry) => (entry.state === "delivered" ? true : undefined))),
      "failed command claim prevented explicit continuation",
    )
    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("once\n")
    yield* llm.wait(1)
    const status = yield* SessionStatus.Service
    yield* pollWithTimeout(
      status.get(chat.id).pipe(Effect.map((value) => (value.type === "idle" ? true : undefined))),
      "queue continuation did not finish",
    )
    expect(yield* llm.calls).toBe(1)
    expect((yield* queue.get(chat.id, "failed-command")).state).toBe("uncertain")
  }),
)

it.instance("unknown queued commands become uncertain and Start can deliver the remaining backlog", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, chat } = yield* boot()
    const queue = yield* SessionQueue.Service
    const initial = yield* queue.list(chat.id)
    yield* prompt.queueUpdate(chat.id, { revision: initial.revision, mutation: { action: "pause", paused: true } })
    yield* prompt.queueSubmit(chat.id, {
      id: "unknown-command",
      payload: { kind: "command", agent: "build", model: ref, command: "missing-command", arguments: "" },
    })
    yield* prompt.queueSubmit(chat.id, { id: "remaining-valid", payload: queuedPrompt("continue after failure") })
    yield* prompt.queueResume(chat.id)
    yield* pollWithTimeout(
      queue
        .get(chat.id, "unknown-command")
        .pipe(Effect.map((entry) => (entry.state === "uncertain" ? true : undefined))),
      "failed command reservation remained claimed",
    )
    expect((yield* queue.list(chat.id)).blocked).toBe(true)
    expect((yield* queue.get(chat.id, "remaining-valid")).state).toBe("pending")
    expect(yield* llm.calls).toBe(0)
    yield* llm.text("continued")
    const blocked = yield* queue.list(chat.id)
    yield* prompt.queueUpdate(chat.id, { revision: blocked.revision, mutation: { action: "pause", paused: false } })
    yield* llm.wait(1)
    const status = yield* SessionStatus.Service
    yield* pollWithTimeout(
      status.get(chat.id).pipe(Effect.map((value) => (value.type === "idle" ? true : undefined))),
      "remaining queue did not finish",
    )
    expect((yield* queue.get(chat.id, "remaining-valid")).state).toBe("delivered")
    expect((yield* queue.get(chat.id, "unknown-command")).state).toBe("uncertain")
    expect(yield* llm.calls).toBe(1)
  }),
)

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits for a completed parent turn with nonmonotonic message IDs",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const userID = MessageID.make("msg_z_user")
      const assistantID = MessageID.make("msg_a_assistant")
      yield* sessions.updateMessage({
        id: userID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: userID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 200, completed: 201 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.id).toBe(assistantID)
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("loop continues when finish is unknown", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("crash recovery preserves completed tools and continues after uncertain tool execution", () =>
  Effect.gen(function* () {
    const { dir: directory, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const { assistant } = yield* seed(session.id, { finish: "stop" })
    const sideEffect = path.join(directory, "must-not-replay")
    const running: SessionV1.ToolPart = {
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: session.id,
      type: "tool",
      callID: "crashed-shell-call",
      tool: "bash",
      state: {
        status: "running",
        input: { command: `touch ${sideEffect}` },
        title: `touch ${sideEffect}`,
        metadata: { output: "partial shell output", outputPath: "/tmp/incomplete-output" },
        time: { start: Date.now() },
      },
    }
    const completed: SessionV1.ToolPart = {
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: session.id,
      type: "tool",
      callID: "completed-call",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/tmp/known" },
        title: "read known file",
        output: "durably completed result",
        metadata: { preserved: true },
        time: { start: 1, end: 2 },
      },
    }
    const failed: SessionV1.ToolPart = {
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: session.id,
      type: "tool",
      callID: "failed-call",
      tool: "edit",
      state: {
        status: "error",
        input: { filePath: "/tmp/failure" },
        error: "original tool failure",
        metadata: { failureCode: "EACCES" },
        time: { start: 3, end: 4 },
      },
    }
    yield* sessions.updatePart(running)
    yield* sessions.updatePart(completed)
    yield* sessions.updatePart(failed)
    yield* llm.push(reply().text("recovered continuation").stop())

    const result = yield* prompt.recover(session.id)
    const messages = yield* sessions.messages({ sessionID: session.id })
    const userMessages = messages.filter((message) => message.info.role === "user")
    const parts = messages.flatMap((message) => message.parts)
    const restored = parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === running.callID,
    )
    const preserved = parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === completed.callID,
    )
    const preservedFailure = parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === failed.callID,
    )

    expect(result.parts.some((part) => part.type === "text" && part.text === "recovered continuation")).toBe(true)
    expect(userMessages).toHaveLength(1)
    expect(restored?.state.status).toBe("error")
    if (restored?.state.status === "error") {
      expect(restored.state.input).toEqual(running.state.input)
      expect(restored.state.metadata).toMatchObject({
        interrupted: true,
        crashInterrupted: true,
        output: "partial shell output",
        outputPath: "/tmp/incomplete-output",
      })
      expect(restored.state.error).toContain("Its final outcome is unknown")
      expect(restored.state.error).toContain("partial shell output")
      expect(restored.state.error).toContain("/tmp/incomplete-output")
    }
    expect(preserved).toEqual(completed)
    expect(preservedFailure).toEqual(failed)
    expect(yield* Effect.promise(() => Bun.file(sideEffect).exists())).toBe(false)
    expect(JSON.stringify(yield* llm.inputs)).toContain("partial shell output")
    expect(JSON.stringify(yield* llm.inputs)).toContain("unexpected OpenCode shutdown")
  }),
)

it.instance("runtime takeover continues persisted history after an abandoned owner", () =>
  Effect.gen(function* () {
    const { dir: directory, llm } = yield* useServerConfig(providerCfg)
    const database = yield* Database.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const session = yield* sessions.create({
      title: "Abrupt runtime death",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const { user: input, assistant } = yield* seed(session.id, { finish: "stop" })
    const sideEffect = path.join(directory, "must-not-rerun")
    const call: SessionV1.ToolPart = {
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: session.id,
      type: "tool",
      callID: "abandoned-shell-call",
      tool: "bash",
      state: {
        status: "running",
        input: { command: `touch ${sideEffect}` },
        title: `touch ${sideEffect}`,
        metadata: { output: "partial" },
        time: { start: Date.now() },
      },
    }
    yield* sessions.updatePart(call)

    const lineage = randomUUID()
    const abandoned = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
    yield* abandoned.admit({ sessionID: session.id, directory: session.directory })
    yield* database.db.run(sql`
      UPDATE runtime_execution SET owner_start_time = ${"0"} WHERE session_id = ${session.id}
    `)
    yield* llm.push(reply().text("continued from persisted history").stop())

    const recovered = RuntimeLifecycle.make({ lineage, instance: randomUUID() }, scope, database)
    yield* recovered.recover((record) => prompt.recover(SessionID.make(record.sessionID)))
    yield* pollWithTimeout(
      database.db
        .get<{ state: string }>(
          sql`
        SELECT state FROM runtime_execution WHERE session_id = ${session.id}
      `,
        )
        .pipe(Effect.map((row) => (row?.state === "completed" ? (true as const) : undefined))),
      "recovered execution did not complete",
    )

    const messages = yield* sessions.messages({ sessionID: session.id })
    const users = messages.filter((message) => message.info.role === "user")
    const tool = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.callID === call.callID)
    expect(yield* llm.calls).toBe(1)
    expect(users).toHaveLength(1)
    expect(tool?.type).toBe("tool")
    if (tool?.type === "tool" && tool.state.status === "error") {
      expect(tool.state.metadata?.crashInterrupted).toBe(true)
      expect(tool.state.error).toContain("final outcome is unknown")
    }
    expect(
      messages
        .flatMap((message) => message.parts)
        .some((part) => part.type === "text" && part.text === "continued from persisted history"),
    ).toBe(true)
    expect(yield* Effect.promise(() => Bun.file(sideEffect).exists())).toBe(false)
    expect(JSON.stringify(yield* llm.inputs)).toContain("touch " + sideEffect)
    expect(JSON.stringify(yield* llm.inputs)).toContain("final outcome is unknown")
    expect(
      (yield* database.db.get<{ session_id: string }>(sql`
      SELECT session_id FROM runtime_execution WHERE session_id = ${session.id}
    `))?.session_id,
    ).toBe(session.id)
    expect(input.id).toBe(users[0]?.info.id)
  }),
)

it.instance("crash recovery does not repeat an assistant turn with durable completion", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Pinned" })
    const { assistant } = yield* seed(session.id, { finish: "stop" })
    assistant.time.completed = Date.now()
    yield* sessions.updateMessage(assistant)

    const result = yield* prompt.recover(session.id)
    expect(result.info.id).toBe(assistant.id)
    expect(yield* llm.calls).toBe(0)
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("reuses a recovered slash-command Task result without repeating its child side effect", () =>
  Effect.gen(function* () {
    const { dir: directory, llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: { general: { mode: "subagent" } },
      command: {
        review: {
          template: "Perform the observable child action",
          description: "perform child action",
          agent: "general",
          subtask: true,
        },
      },
    }))
    const database = yield* Database.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const parent = yield* sessions.create({
      title: "Interrupted slash command",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const sideEffect = path.join(directory, "task-side-effect")
    yield* llm.tool("bash", { command: `printf 'once\\n' >> '${sideEffect}'` })
    yield* llm.text("child completed")
    yield* llm.text("command summary")
    yield* prompt.command({ sessionID: parent.id, command: "review", arguments: "" })

    const original = yield* sessions.messages({ sessionID: parent.id })
    const taskMessage = original.find(
      (message) =>
        message.info.role === "assistant" && message.parts.some((part) => part.type === "tool" && part.tool === "task"),
    )
    expect(taskMessage?.info.role).toBe("assistant")
    if (!taskMessage || taskMessage.info.role !== "assistant") throw new Error("missing slash-command Task message")
    const taskPart = taskMessage.parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
    )
    expect(taskPart?.state.status).toBe("completed")
    if (taskPart?.type !== "tool" || taskPart.state.status !== "completed")
      throw new Error("slash-command Task did not complete")
    const childID = taskPart.state.metadata?.sessionId
    expect(typeof childID).toBe("string")
    if (typeof childID !== "string") throw new Error("missing Task child session linkage")
    expect(yield* Effect.promise(() => Bun.file(sideEffect).text())).toBe("once\n")

    const child = yield* sessions.get(SessionID.make(childID))
    expect(child.metadata?.task).toMatchObject({
      parentSessionId: parent.id,
      parentMessageID: taskMessage.info.id,
      parentCallID: taskPart.callID,
    })
    yield* sessions.updatePart({
      ...taskPart,
      state: {
        status: "running",
        input: taskPart.state.input,
        time: { start: taskPart.state.time.start },
      },
    } satisfies SessionV1.ToolPart)
    yield* sessions.removeMessage({
      sessionID: parent.id,
      messageID: MessageID.make(`msg_task_summary_${taskPart.callID}`),
    })

    delete taskMessage.info.time.completed
    taskMessage.info.finish = undefined
    yield* sessions.updateMessage(taskMessage.info)
    const owner = RuntimeLifecycle.make({ lineage: randomUUID() }, scope, database)
    yield* owner.admit({ sessionID: parent.id, directory: parent.directory })
    yield* owner.release(parent.id)
    yield* database.db.run(sql`
      UPDATE runtime_execution
      SET state = ${"active"}, desired_active = 1, owner_start_time = ${"0"}
      WHERE session_id = ${parent.id}
    `)

    const row = yield* database.db.get<{ owner_lineage: string }>(sql`
      SELECT owner_lineage FROM runtime_execution WHERE session_id = ${parent.id}
    `)
    if (!row) throw new Error("missing parent runtime execution")
    const replacement = RuntimeLifecycle.make({ lineage: row.owner_lineage, instance: randomUUID() }, scope, database)
    yield* replacement.recover((record) => prompt.recover(SessionID.make(record.sessionID)))
    while (
      (yield* database.db.get<{ state: string }>(sql`
        SELECT state FROM runtime_execution WHERE session_id = ${parent.id}
      `))?.state !== "completed"
    )
      yield* Effect.yieldNow

    const recovered = yield* sessions.messages({ sessionID: parent.id })
    const repairedAssistant = recovered.find((message) => message.info.id === taskMessage.info.id)
    const repairedTask = repairedAssistant?.parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === taskPart.callID,
    )
    expect(repairedAssistant?.info.role).toBe("assistant")
    if (repairedAssistant?.info.role === "assistant") {
      expect(repairedAssistant.info.finish).toBe("tool-calls")
      expect(repairedAssistant.info.time.completed).toBeDefined()
    }
    expect(repairedTask?.type).toBe("tool")
    if (repairedTask?.type !== "tool") throw new Error("recovered slash-command Task was missing")
    expect(repairedTask.state.status).toBe("completed")
    if (repairedTask.state.status !== "completed") throw new Error("recovered slash-command Task did not complete")
    expect(repairedTask.state.metadata?.sessionId).toBe(childID)
    expect(repairedTask.state.output).toContain("child completed")
    expect((yield* sessions.children(parent.id)).map((child) => child.id)).toEqual([SessionID.make(childID)])
    expect(yield* Effect.promise(() => Bun.file(sideEffect).text())).toBe("once\n")
    expect(yield* llm.calls).toBe(3)
    expect(
      recovered.filter(
        (message) => message.info.role === "user" && message.info.id === `msg_task_summary_${taskPart.callID}`,
      ),
    ).toHaveLength(1)
  }),
)

it.instance("foreground recovery settles linked Tasks and leaves cancelled parents untouched", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const parent = yield* sessions.create({ title: "Foreground Task parent" })
    const child = yield* sessions.create({ title: "Foreground Task child", parentID: parent.id })
    const parentUser = yield* user(parent.id, "review")
    const callID = "call_foreground_recovery"
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: parentUser.id,
      sessionID: parent.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: parent.id,
      type: "tool",
      callID,
      tool: "task",
      state: {
        status: "running",
        input: { prompt: "review", description: "review", subagent_type: "general", command: "review" },
        metadata: { sessionId: child.id },
        time: { start: Date.now() },
      },
    })
    const childUser = yield* user(child.id, "child prompt")
    const childAssistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: childUser.id,
      sessionID: child.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      finish: "stop",
      time: { created: Date.now(), completed: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: childAssistant.id,
      sessionID: child.id,
      type: "text",
      text: "child result",
    })
    const childResult = (yield* sessions.messages({ sessionID: child.id })).findLast(
      (message) => message.info.id === childAssistant.id,
    )
    if (!childResult) throw new Error("missing completed child result")

    yield* ServerRecovery.settleForeground({
      database,
      sessions,
      record: {
        sessionID: randomUUID(),
        parentSessionID: parent.id,
        parentMessageID: assistant.id,
        parentCallID: callID,
      },
      result: childResult,
    })
    const unmatched = yield* sessions.messages({ sessionID: parent.id })
    const unmatchedAssistant = unmatched.find((message) => message.info.id === assistant.id)
    const unmatchedTask = unmatchedAssistant?.parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === callID,
    )
    expect(unmatchedTask?.type).toBe("tool")
    if (unmatchedTask?.type !== "tool") throw new Error("missing unmatched Task part")
    expect(unmatchedTask.state.status).toBe("running")
    expect(unmatchedAssistant?.info.role).toBe("assistant")
    if (unmatchedAssistant?.info.role !== "assistant") throw new Error("missing unmatched parent assistant")
    expect(unmatchedAssistant.info.time.completed).toBeUndefined()

    const lineage = randomUUID()
    const runtime = RuntimeLifecycle.make({ lineage }, scope, database)
    const createdAt = Date.now()
    yield* database.db.run(sql`
      INSERT INTO runtime_execution
        (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
      VALUES
        (${parent.id}, ${parent.id}, ${parent.directory}, ${lineage}, ${runtime.identity.instance}, 1,
         ${"active"}, 1, ${createdAt}, ${createdAt})
    `)
    const messagesStarted = yield* Deferred.make<void>()
    const resumeMessages = yield* Deferred.make<void>()
    const delayedSessions = {
      ...sessions,
      messages: (input: Parameters<typeof sessions.messages>[0]) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(messagesStarted, undefined)
          yield* Deferred.await(resumeMessages)
          return yield* sessions.messages(input)
        }),
    }
    const settlement = yield* ServerRecovery.settleForeground({
      database,
      sessions: delayedSessions,
      record: {
        sessionID: child.id,
        parentSessionID: parent.id,
        parentMessageID: assistant.id,
        parentCallID: callID,
      },
      result: childResult,
    }).pipe(Effect.forkChild)
    yield* Deferred.await(messagesStarted)
    const cancellation = yield* runtime.cancel(parent.id).pipe(Effect.forkChild)
    yield* Deferred.succeed(resumeMessages, undefined)
    yield* Fiber.join(settlement)
    expect(yield* Fiber.join(cancellation)).toBe(true)

    const recovered = yield* sessions.messages({ sessionID: parent.id })
    const repairedAssistant = recovered.find((message) => message.info.id === assistant.id)
    const repairedTask = repairedAssistant?.parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === callID,
    )
    expect(repairedAssistant?.info.role).toBe("assistant")
    if (repairedAssistant?.info.role !== "assistant") throw new Error("missing recovered parent assistant")
    expect(repairedAssistant.info.finish).toBe("tool-calls")
    expect(repairedAssistant.info.time.completed).toBeDefined()
    expect(repairedTask?.type).toBe("tool")
    if (repairedTask?.type !== "tool") throw new Error("missing recovered Task part")
    expect(repairedTask.state.status).toBe("completed")
    if (repairedTask.state.status !== "completed") throw new Error("foreground Task result was not settled")
    expect(repairedTask.state.output).toContain("child result")
    expect(recovered.filter((message) => message.info.id === `msg_task_summary_${callID}`)).toHaveLength(1)
    expect(
      (yield* database.db.get<{ state: string }>(sql`
      SELECT state FROM runtime_execution WHERE session_id = ${parent.id}
    `))?.state,
    ).toBe("cancelled")

    const cancelledParent = yield* sessions.create({ title: "Cancelled foreground Task parent" })
    const cancelledChild = yield* sessions.create({
      title: "Cancelled foreground Task child",
      parentID: cancelledParent.id,
    })
    const cancelledUser = yield* user(cancelledParent.id, "review")
    const cancelledCallID = "call_cancelled_foreground_recovery"
    const cancelledAssistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: cancelledUser.id,
      sessionID: cancelledParent.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: cancelledAssistant.id,
      sessionID: cancelledParent.id,
      type: "tool",
      callID: cancelledCallID,
      tool: "task",
      state: {
        status: "running",
        input: { prompt: "review", description: "review", subagent_type: "general", command: "review" },
        metadata: { sessionId: cancelledChild.id },
        time: { start: Date.now() },
      },
    })
    const now = Date.now()
    yield* database.db.run(sql`
      INSERT INTO runtime_execution
        (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
      VALUES
        (${cancelledParent.id}, ${cancelledParent.id}, ${"/tmp"}, ${randomUUID()}, ${randomUUID()}, 1,
         ${"cancelled"}, 0, ${now}, ${now})
    `)

    yield* ServerRecovery.settleForeground({
      database,
      sessions,
      record: {
        sessionID: cancelledChild.id,
        parentSessionID: cancelledParent.id,
        parentMessageID: cancelledAssistant.id,
        parentCallID: cancelledCallID,
      },
      result: childResult,
    })

    const cancelledTranscript = yield* sessions.messages({ sessionID: cancelledParent.id })
    const untouchedAssistant = cancelledTranscript.find((message) => message.info.id === cancelledAssistant.id)
    const untouchedTask = untouchedAssistant?.parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === cancelledCallID,
    )
    expect(untouchedAssistant?.info.role).toBe("assistant")
    if (untouchedAssistant?.info.role !== "assistant") throw new Error("missing cancelled parent assistant")
    expect(untouchedAssistant.info.time.completed).toBeUndefined()
    expect(untouchedTask?.type).toBe("tool")
    if (untouchedTask?.type !== "tool") throw new Error("missing cancelled parent Task part")
    expect(untouchedTask.state.status).toBe("running")
    expect(cancelledTranscript.some((message) => message.info.id === `msg_task_summary_${cancelledCallID}`)).toBe(false)
  }),
)

it.instance("foreground recovery fails a Task with an incomplete child result", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Incomplete foreground Task parent" })
    const child = yield* sessions.create({ title: "Incomplete foreground Task child", parentID: parent.id })
    const parentUser = yield* user(parent.id, "review")
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: parentUser.id,
      sessionID: parent.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    })
    const callID = "call_incomplete_foreground_recovery"
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: parent.id,
      type: "tool",
      callID,
      tool: "task",
      state: {
        status: "running",
        input: { prompt: "review", description: "review", subagent_type: "general" },
        metadata: { sessionId: child.id },
        time: { start: Date.now() },
      },
    })
    const childUser = yield* user(child.id, "child prompt")
    const childAssistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: childUser.id,
      sessionID: child.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: childAssistant.id,
      sessionID: child.id,
      type: "text",
      text: "partial child result",
    })
    const childResult = (yield* sessions.messages({ sessionID: child.id })).findLast(
      (message) => message.info.id === childAssistant.id,
    )
    if (!childResult) throw new Error("missing incomplete child result")

    yield* ServerRecovery.settleForeground({
      database,
      sessions,
      record: {
        sessionID: child.id,
        parentSessionID: parent.id,
        parentMessageID: assistant.id,
        parentCallID: callID,
      },
      result: childResult,
    })

    const recovered = yield* sessions.messages({ sessionID: parent.id })
    const recoveredAssistant = recovered.find((message) => message.info.id === assistant.id)
    const recoveredTask = recoveredAssistant?.parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === callID,
    )
    expect(recoveredTask?.type).toBe("tool")
    if (recoveredTask?.type !== "tool") throw new Error("missing failed Task part")
    expect(recoveredTask.state.status).toBe("error")
    if (recoveredTask.state.status !== "error") throw new Error("incomplete child result was reported as success")
    expect(recoveredTask.state.error).toContain("did not produce a completed assistant result")
    expect(recoveredAssistant?.info.role).toBe("assistant")
    if (recoveredAssistant?.info.role !== "assistant") throw new Error("missing failed parent assistant")
    expect(recoveredAssistant.info.finish).toBe("tool-calls")
    expect(recoveredAssistant.info.time.completed).toBeDefined()
  }),
)

it.instance("reuses persisted slash-command Task arguments after recovery", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Prepared slash-command Task",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* llm.text("child completed")
    yield* llm.text("parent completed")
    const userMessage = yield* user(chat.id, "run the command")
    yield* addSubtask(chat.id, userMessage.id)
    const original = yield* sessions.messages({ sessionID: chat.id })
    const subtask = original
      .find((message) => message.info.id === userMessage.id)
      ?.parts.find((part): part is SessionV1.SubtaskPart => part.type === "subtask")
    if (!subtask) throw new Error("missing slash-command subtask")

    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: userMessage.id,
      sessionID: chat.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "call_recovered_prepared_task",
      tool: "task",
      state: {
        status: "running",
        input: {
          prompt: "persisted effective task prompt",
          description: "persisted effective description",
          subagent_type: "general",
          subtaskPartID: subtask.id,
          subtaskArgsPrepared: true,
        },
        time: { start: Date.now() },
      },
    })

    yield* prompt.recover(chat.id)

    const child = (yield* sessions.children(chat.id))[0]
    expect(child?.title).toContain("persisted effective description")
    if (!child) throw new Error("recovered Task did not reuse its prepared arguments")
    const childMessages = yield* sessions.messages({ sessionID: child.id })
    expect(childMessages.find((message) => message.info.role === "user")?.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "persisted effective task prompt" }),
    )
  }),
)

it.instance("foreground recovery reports a completed child with a failed tool as an error", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Failed foreground Task parent" })
    const child = yield* sessions.create({ title: "Failed foreground Task child", parentID: parent.id })
    const parentUser = yield* user(parent.id, "review")
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: parentUser.id,
      sessionID: parent.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    })
    const callID = "call_failed_foreground_recovery"
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: parent.id,
      type: "tool",
      callID,
      tool: "task",
      state: {
        status: "running",
        input: { prompt: "review", description: "review", subagent_type: "general" },
        metadata: { sessionId: child.id },
        time: { start: Date.now() },
      },
    })
    const childUser = yield* user(child.id, "child prompt")
    const childAssistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: childUser.id,
      sessionID: child.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      finish: "stop",
      time: { created: Date.now(), completed: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: childAssistant.id,
      sessionID: child.id,
      type: "tool",
      callID: "failed_child_tool",
      tool: "bash",
      state: {
        status: "error",
        input: { command: "side effect" },
        error: "child tool failed",
        time: { start: Date.now(), end: Date.now() },
      },
    })
    const childResult = (yield* sessions.messages({ sessionID: child.id })).findLast(
      (message) => message.info.id === childAssistant.id,
    )
    if (!childResult) throw new Error("missing failed child result")

    yield* ServerRecovery.settleForeground({
      database,
      sessions,
      record: {
        sessionID: child.id,
        parentSessionID: parent.id,
        parentMessageID: assistant.id,
        parentCallID: callID,
      },
      result: childResult,
    })

    const recovered = yield* sessions.messages({ sessionID: parent.id })
    const recoveredAssistant = recovered.find((message) => message.info.id === assistant.id)
    const recoveredTask = recoveredAssistant?.parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === callID,
    )
    expect(recoveredTask?.type).toBe("tool")
    if (recoveredTask?.type !== "tool") throw new Error("missing failed foreground Task")
    expect(recoveredTask.state.status).toBe("error")
    if (recoveredTask.state.status !== "error") throw new Error("failed child tool was reported as success")
    expect(recoveredTask.state.error).toContain("child tool failed")
    expect(recoveredAssistant?.info.role).toBe("assistant")
    if (recoveredAssistant?.info.role !== "assistant") throw new Error("missing failed parent assistant")
    expect(recoveredAssistant.info.time.completed).toBeDefined()
  }),
)

it.instance("foreground recovery treats an interrupted child as an error", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Cancelled foreground Task parent" })
    const child = yield* sessions.create({ title: "Cancelled foreground Task child", parentID: parent.id })
    const parentUser = yield* user(parent.id, "review")
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: parentUser.id,
      sessionID: parent.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    })
    const callID = "call_cancelled_foreground_recovery"
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: parent.id,
      type: "tool",
      callID,
      tool: "task",
      state: {
        status: "running",
        input: { prompt: "review", description: "review", subagent_type: "general" },
        metadata: { sessionId: child.id },
        time: { start: Date.now() },
      },
    })
    const childUser = yield* user(child.id, "child prompt")
    const childAssistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: childUser.id,
      sessionID: child.id,
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      finish: "stop",
      error: MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
        providerID: ref.providerID,
        aborted: true,
      }),
      time: { created: Date.now(), completed: Date.now() },
    })
    const childResult = (yield* sessions.messages({ sessionID: child.id })).findLast(
      (message) => message.info.id === childAssistant.id,
    )
    if (!childResult) throw new Error("missing interrupted child result")

    yield* ServerRecovery.settleForeground({
      database,
      sessions,
      record: {
        sessionID: child.id,
        parentSessionID: parent.id,
        parentMessageID: assistant.id,
        parentCallID: callID,
      },
      result: childResult,
    })

    const recovered = yield* sessions.messages({ sessionID: parent.id })
    const recoveredAssistant = recovered.find((message) => message.info.id === assistant.id)
    const recoveredTask = recoveredAssistant?.parts.find(
      (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === callID,
    )
    expect(recoveredTask?.type).toBe("tool")
    if (recoveredTask?.type !== "tool") throw new Error("missing cancelled foreground Task")
    expect(recoveredTask.state.status).toBe("error")
    if (recoveredTask.state.status !== "error") throw new Error("interrupted child was reported as success")
    expect(recoveredTask.state.error).toContain("Aborted")
  }),
)

withMutatingTaskPlugin.instance("persists plugin-mutated Task arguments and settles an unavailable agent", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Unavailable slash-command agent" })
    yield* llm.text("parent completed")
    const userMessage = yield* user(chat.id, "run the command")
    yield* addSubtask(chat.id, userMessage.id)

    yield* prompt.loop({ sessionID: chat.id })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const task = messages
      .flatMap((message) => message.parts)
      .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task")
    expect(task?.state.status).toBe("error")
    if (!task || task.type !== "tool" || task.state.status !== "error")
      throw new Error("unavailable slash-command Task agent did not settle as an error")
    expect(task.state.error).toContain('Agent not found: "missing-agent"')
    expect(task.state.input).toMatchObject({
      prompt: "plugin-mutated prompt",
      description: "plugin-mutated description",
      subagent_type: "missing-agent",
      subtaskArgsPrepared: true,
    })
    expect(yield* sessions.children(chat.id)).toHaveLength(0)
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

ownedBlockingRuntime.instance(
  "does not park shared execution when a queued prompt waiter is interrupted",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* RuntimeLifecycle.Service
      const chat = yield* sessions.create({ title: "Interrupted queued prompt" })
      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      const second = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "second" }] })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const messages = yield* sessions.messages({ sessionID: chat.id })
          return messages.some(
            (message) =>
              message.info.role === "user" &&
              message.parts.some((part) => part.type === "text" && part.text === "second"),
          )
            ? true
            : undefined
        }),
        "second prompt was not admitted",
      )
      yield* Effect.yieldNow

      yield* Fiber.interrupt(second)
      const status = yield* runtime.status()
      expect(status.active).toBe(1)
      expect(status.parked).toBe(0)

      yield* prompt.cancel(chat.id)
      expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
    }),
  3_000,
)

ownedBlockingRuntime.instance(
  "parks and recovers an admitted prompt after its instance is disposed",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const database = yield* Database.Service
      const prompt = yield* SessionPrompt.Service
      const runtime = yield* RuntimeLifecycle.Service
      const sessions = yield* Session.Service
      const store = yield* InstanceStore.Service
      const scope = yield* Scope.Scope
      const chat = yield* sessions.create({ title: "Disposed prompt instance" })
      const processorStarted = defer<void>()
      processorCreateStarted.push(processorStarted.resolve)
      const result = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "diagnostic" }] })
        .pipe(Effect.exit, Effect.forkChild)
      yield* Effect.promise(() => processorStarted.promise)

      const instance = yield* store.load({ directory: chat.directory })
      yield* store.dispose(instance)

      const exit = yield* Fiber.join(result)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Interrupted)
        const error = Cause.squash(exit.cause)
        if (error instanceof Runner.Interrupted) expect(error.reason).toBe("scope")
      }
      expect(yield* runtime.status()).toMatchObject({ active: 0, parked: 1 })
      expect(
        yield* database.db.get<{ state: string }>(
          sql`SELECT state FROM runtime_execution WHERE session_id = ${chat.id}`,
        ),
      ).toEqual({ state: "parked" })

      const replacement = RuntimeLifecycle.make(
        { lineage: runtime.identity.lineage, instance: randomUUID() },
        scope,
        database,
      )
      let recovered = 0
      yield* replacement.recover((record) =>
        Effect.sync(() => {
          if (record.sessionID === chat.id) recovered++
        }),
      )
      yield* pollWithTimeout(
        database.db
          .get<{ state: string }>(sql`SELECT state FROM runtime_execution WHERE session_id = ${chat.id}`)
          .pipe(Effect.map((row) => (row?.state === "completed" ? (true as const) : undefined))),
        "disposed prompt was not recovered",
      )
      expect(recovered).toBe(1)
    }),
  5_000,
)

interruptedReleaseRetryRuntime.instance(
  "retries failed interrupted release instead of completing durable execution",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* RuntimeLifecycle.Service
      const sessionStatus = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Snapshot interruption" })

      const result = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "diagnostic" }] })
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.hasDies(result.cause)).toBe(true)
        expect(Cause.squash(result.cause)).toBeInstanceOf(Runner.Interrupted)
      }

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const assistant = messages.at(-1)
      expect(assistant?.info.role).toBe("assistant")
      expect(assistant?.parts).toHaveLength(0)
      const runtimeStatus = yield* runtime.status()
      expect(runtimeStatus.active).toBe(0)
      expect(runtimeStatus.parked).toBe(1)
      expect((yield* sessionStatus.get(chat.id)).type).toBe("busy")
      if (assistant?.info.role === "assistant") {
        expect(assistant.info.time.completed).toBeNumber()
        expect(assistant.info.error?.name).toBe("MessageAbortedError")
      }
    }),
  3_000,
)

interruptedReleaseRetryRuntime.instance(
  "keeps interrupted recovery quarantined for runtime recovery policy",
  () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const prompt = yield* SessionPrompt.Service
      const runtime = yield* RuntimeLifecycle.Service
      const sessions = yield* Session.Service
      const scope = yield* Scope.Scope
      const chat = yield* sessions.create({ title: "Interrupted recovery" })
      yield* seed(chat.id, { finish: "stop" })

      const abandoned = RuntimeLifecycle.make(
        { lineage: runtime.identity.lineage, instance: randomUUID() },
        scope,
        database,
      )
      yield* abandoned.admit({ sessionID: chat.id, directory: chat.directory })
      yield* database.db.run(sql`
        UPDATE runtime_execution SET owner_start_time = ${"0"} WHERE session_id = ${chat.id}
      `)

      yield* runtime.recover((record) => prompt.recover(SessionID.make(record.sessionID)))
      yield* pollWithTimeout(
        database.db
          .get<{ state: string }>(sql`SELECT state FROM runtime_execution WHERE session_id = ${chat.id}`)
          .pipe(Effect.map((row) => (row?.state === "recovery_needed" ? (true as const) : undefined))),
        "interrupted recovery was not quarantined",
      )
      expect(yield* runtime.isParked(chat.id)).toBe(false)
    }),
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

it.live("explicit default suppresses the configured agent variant", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("test-model") }

        yield* llm.text("configured agent variant")
        const configured = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "Use the configured variant" }],
        })
        if (configured.info.role !== "assistant" || !configured.info.parentID)
          throw new Error("expected assistant reply")
        const configuredUser = yield* MessageV2.get({
          sessionID: session.id,
          messageID: configured.info.parentID,
        })
        if (configuredUser.info.role !== "user") throw new Error("expected persisted user message")
        expect(configuredUser.info.model.variant).toBe("high")

        yield* llm.text("default variant")
        const result = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          variant: "default",
          parts: [{ type: "text", text: "Use the default variant" }],
        })
        if (result.info.role !== "assistant" || !result.info.parentID) throw new Error("expected assistant reply")
        const stored = yield* MessageV2.get({ sessionID: session.id, messageID: result.info.parentID })
        if (stored.info.role !== "user") throw new Error("expected persisted user message")
        expect(stored.info.model.variant).toBe("default")

        const inputs = yield* llm.inputs
        const request = (text: string) =>
          inputs.find((input) => input.model === "test-model" && JSON.stringify(input.messages).includes(text))
        expect(request("Use the configured variant")).toHaveProperty("reasoning_effort", "high")
        const defaultRequest = request("Use the default variant")
        expect(defaultRequest).toBeDefined()
        expect(defaultRequest).not.toHaveProperty("reasoning_effort")

        yield* sessions.remove(session.id)
      }),
    {
      config: (url) => ({
        enabled_providers: ["openai"],
        provider: {
          openai: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "test-key", baseURL: url },
            models: {
              "test-model": {
                ...cfg.provider.test.models["test-model"],
                variants: { high: { reasoningEffort: "high" } },
              },
            },
          },
        },
        agent: { build: { model: "openai/test-model", variant: "high" } },
      }),
    },
  ),
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
