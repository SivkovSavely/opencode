import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { McpActivation } from "@/session/mcp-activation"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()
const observed = { fence: undefined as number | undefined }

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

function fakeMcp() {
  return MCP.Service.of({
    tools: (activated = []) =>
      Effect.succeed(
        activated.includes("lazy")
          ? {
              lazy_lookup: {
                server: "lazy",
                def: { name: "lookup", inputSchema: { type: "object", properties: {} } },
                client: {} as MCP.McpTool["client"],
              },
            }
          : {},
      ),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(
    Session.Service,
    Session.Service.of({
      get: () => Effect.succeed({ id: sessionID, metadata: {} } as unknown as Session.Info),
    } as Partial<Session.Interface> as Session.Interface),
  ),
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed([
          {
            id: "timing",
            description: "updates metadata more than once",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                observed.fence = ctx.executionFence
                yield* ctx.metadata({ metadata: { output: "first" } })
                yield* ctx.metadata({ metadata: { output: "second" } })
                return { title: "timing", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
        ]),
    }),
  ),
)

const it = testEffect(layer)

it.live("managed parent allow exceptions intersect child and ancestor restrictions", () =>
  Effect.gen(function* () {
    const previous = process.env.OPENCODE_MANAGED_PROFILE
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.OPENCODE_MANAGED_PROFILE = "1"
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
          else process.env.OPENCODE_MANAGED_PROFILE = previous
        }),
    )
    const sessions = yield* Session.Service
    const registry = yield* ToolRegistry.Service
    const current = {
      ...(yield* sessions.get(sessionID)),
      parentID: SessionID.make("ses_parent"),
      permission: Permission.fromConfig({ bash: { "echo session": "deny" } }),
    }
    const executed: string[] = []
    const readOnly: (boolean | undefined)[] = []
    const decisions: { command: string | undefined; action: string }[] = []
    const tools = yield* SessionTools.resolve({
      agent: {
        ...agent,
        permission: [
          ...agent.permission,
          ...Permission.fromConfig({ bash: { "*": "allow", "echo secret": "deny", "echo ask": "ask" } }),
        ],
      },
      model,
      session: current,
      processor: {
        message: { id: messageID },
        updateToolCall: () => Effect.void,
        completeToolCall: () => Effect.void,
      } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    }).pipe(
      Effect.provideService(Permission.Service, {
        ...fakePermission,
        ask: (input) =>
          Effect.sync(() => {
            decisions.push({
              command: input.patterns[0],
              action: Permission.evaluate(input.permission, input.patterns[0] ?? "", input.ruleset).action,
            })
          }),
      }),
      Effect.provideService(Session.Service, {
        ...sessions,
        get: () => Effect.succeed(current),
        managedPolicies: () =>
          Effect.succeed([
            Permission.fromConfig({ bash: { "*": "deny", "echo *": "allow" } }),
            Permission.fromConfig({ "*": "allow", edit: "deny", bash: { "echo ancestor": "deny" } }),
          ]),
      }),
      Effect.provideService(ToolRegistry.Service, {
        ...registry,
        tools: () =>
          Effect.succeed([
            {
              id: "bash",
              description: "Permission-only shell fixture",
              parameters: Schema.Struct({ command: Schema.String }),
              jsonSchema: { type: "object", properties: { command: { type: "string" } } },
              execute: (args: { command: string }, ctx: Tool.Context) =>
                Effect.gen(function* () {
                  yield* ctx.ask({ permission: "bash", patterns: [args.command], always: ["*"], metadata: {} })
                  readOnly.push(ctx.managedReadOnly)
                  executed.push(args.command)
                  return { title: "bash", metadata: {}, output: args.command }
                }),
            },
          ]),
      }),
    )
    const execute = tools.bash?.execute
    if (!execute) throw new Error("Parent allow exception should keep bash visible")
    const call = (command: string) =>
      Effect.promise(async () =>
        execute(
          { command },
          {
            toolCallId: callID,
            messages: [],
            abortSignal: new AbortController().signal,
          },
        ),
      )
    expect(yield* call("echo ok")).toMatchObject({ output: "echo ok" })
    expect(yield* call("echo ask")).toMatchObject({ output: "echo ask" })
    for (const command of ["rm file", "echo secret", "echo session", "echo ancestor"])
      expect(yield* call(command).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
    expect(executed).toEqual(["echo ok", "echo ask"])
    expect(readOnly).toEqual([true, true])
    expect(decisions).toEqual([
      { command: "echo ok", action: "allow" },
      { command: "echo ask", action: "ask" },
    ])
  }),
)

const sessionWithActivation = (activated: string[]) =>
  Session.Service.of({
    get: () =>
      Effect.succeed({
        id: sessionID,
        metadata: { [McpActivation.METADATA_KEY]: activated },
      } as unknown as Session.Info),
  } as Partial<Session.Interface> as Session.Interface)

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      executionFence: 42,
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(observed.fence).toBe(42)
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

it.effect("refreshes MCP tools from current session metadata without leaking them to another session", () =>
  Effect.gen(function* () {
    const input = {
      agent,
      model,
      session: { id: sessionID, metadata: {}, permission: [] } as unknown as Session.Info,
      processor: {
        message: { id: messageID },
        updateToolCall: () => Effect.void,
        completeToolCall: () => Effect.void,
      } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    }
    const activated = yield* SessionTools.resolve(input).pipe(
      Effect.provideService(Session.Service, sessionWithActivation(["lazy"])),
    )
    const hidden = yield* SessionTools.resolve(input).pipe(
      Effect.provideService(Session.Service, sessionWithActivation([])),
    )

    expect(activated.lazy_lookup).toBeDefined()
    expect(hidden.lazy_lookup).toBeUndefined()
  }),
)

it.live("managed WorkQueue wrapper applies inherited permissions, tracked dispatch and truncation", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const calls: string[] = []
    const hold = { metadata: false }
    const listed = Promise.withResolvers<void>()
    const metadata = Promise.withResolvers<void>()
    const called = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const route = new URL(request.url).pathname
            if (route === "/test/hold-metadata") {
              hold.metadata = true
              return new Response()
            }
            if (route === "/test/listed") {
              await listed.promise
              return new Response()
            }
            if (route === "/test/release-metadata") {
              metadata.resolve()
              return new Response()
            }
            if (route === "/test/called") {
              await called.promise
              return new Response()
            }
            if (route === "/test/release-response") {
              response.resolve()
              return new Response()
            }
            const body = await request.json()
            if (body.method === "initialize")
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: body.id,
                  result: {
                    protocolVersion: "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "workqueue-gateway", version: "0.1.0" },
                  },
                },
                { headers: { "mcp-session-id": "session" } },
              )
            if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
            if (body.method === "tools/list") {
              if (hold.metadata) {
                listed.resolve()
                await metadata.promise
              }
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  tools: [
                    { name: "wq_ping", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
                    {
                      name: "wq_update_progress",
                      inputSchema: {
                        type: "object",
                        properties: {
                          issueId: { type: "string" },
                        },
                        required: ["issueId"],
                        additionalProperties: false,
                      },
                    },
                  ],
                },
              })
            }
            expect(body.method).toBe("tools/call")
            calls.push(body.params.name)
            if (body.params.arguments.issueId === "BAILA-3") {
              called.resolve()
              await response.promise
            }
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: "completed" }] },
            })
          },
        }),
      ),
      (server) =>
        Effect.promise(() => {
          metadata.resolve()
          response.resolve()
          return server.stop(true)
        }),
    )
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn([process.execPath, "test/session/fixtures/managed-workqueue.ts"], {
          cwd: new URL("../..", import.meta.url).pathname,
          env: {
            ...process.env,
            OPENCODE_MANAGED_PROFILE: "1",
            OPENCODE_MANAGED_PLUGIN_ALLOWLIST: "[]",
            OPENCODE_MANAGED_WORK_QUEUE: JSON.stringify({
              url: `http://127.0.0.1:${server.port}/mcp?project=BAILA`,
              project: "BAILA",
              directory: tmp.path,
              tools: ["wq_ping", "wq_update_progress"],
            }),
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      ),
      (child) =>
        Effect.sync(() => {
          child.kill()
        }),
    )
    const result = yield* Effect.promise(async () => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, code }
    })
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("managed WorkQueue wrapper passed")
    expect(calls).toEqual(["wq_update_progress", "wq_update_progress"])
    const readonly = yield* Effect.promise(async () => {
      const source = `
        import assert from "node:assert/strict"
        import { Effect, Layer, Schema } from "effect"
        import { SessionTools } from "@/session/tools"
        import { Session } from "@/session/session"
        import { SessionID, MessageID } from "@/session/schema"
        import { ToolRegistry } from "@/tool/registry"
        import { Plugin } from "@/plugin"
        import { Permission } from "@/permission"
        import { Truncate } from "@/tool/truncate"
        import { RuntimeFlags } from "@/effect/runtime-flags"
        import { ProviderV2 } from "@opencode-ai/core/provider"
        const allow = [{ permission: "*", pattern: "*", action: "allow" }]
        const deny = [{ permission: "edit", pattern: "*", action: "deny" }]
        const id = SessionID.make("ses_readonly")
        const directory = JSON.parse(process.env.OPENCODE_MANAGED_WORK_QUEUE).directory
        let session = { id, directory, parentID: SessionID.make("ses_parent"), permission: allow, metadata: {} }
        let inherited = []
        const registry = ["bash", "task", "compress"].map(id => ({
          id, description: id, parameters: Schema.Struct({}), jsonSchema: { type: "object", properties: {} },
          execute: (_args, ctx) => Effect.succeed({ title: id, output: String(ctx.managedReadOnly), metadata: {} }),
        }))
        const input = {
          agent: { name: "general", mode: "subagent", options: {}, permission: allow },
          model: { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } },
          session, processor: { message: { id: MessageID.ascending() }, updateToolCall: () => Effect.void, completeToolCall: () => Effect.void },
          bypassAgentCheck: false, messages: [], promptOps: {}, executionFence: 42,
          managedRuntime: { runManagedCommand: () => Effect.die("unexpected WorkQueue dispatch") },
        }
        const layer = Layer.mergeAll(
          Layer.mock(Session.Service, { get: () => Effect.succeed(session), managedPolicies: () => Effect.succeed(inherited) }),
          Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed(registry) }),
          Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
          Layer.mock(Permission.Service, { ask: () => Effect.void }), Layer.mock(Truncate.Service, {}), RuntimeFlags.layer(),
        )
        await Effect.runPromise(Effect.gen(function* () {
          for (const kind of ["identity", "agent", "session", "ancestor"]) {
            session = { ...session, permission: kind === "session" ? [...allow, ...deny] : allow }
            inherited = kind === "ancestor" ? [deny, allow] : []
            const selected = { ...input.agent, name: kind === "identity" ? "audit" : "general", permission: kind === "agent" ? [...allow, ...deny] : allow }
            const tools = yield* SessionTools.resolve({ ...input, session, agent: selected })
            assert.deepEqual(Object.keys(tools).sort(), ["bash", "compress", "task", "wq_ping"])
            const result = yield* Effect.promise(() => tools.bash.execute({}, { toolCallId: "bash", messages: [], abortSignal: new AbortController().signal }))
            assert.equal(result.output, "true")
          }
          inherited = []
          const writable = yield* SessionTools.resolve({ ...input, session: { ...session, permission: allow } })
          assert.ok(writable.wq_update_progress)
        }).pipe(Effect.provide(layer)))
      `
      const proc = Bun.spawn([process.execPath, "-e", source], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: {
          ...process.env,
          OPENCODE_MANAGED_PROFILE: "1",
          OPENCODE_MANAGED_READ_ONLY_AGENTS: '["audit"]',
          OPENCODE_MANAGED_WORK_QUEUE: JSON.stringify({
            url: `http://127.0.0.1:${server.port}/mcp?project=BAILA`,
            project: "BAILA",
            directory: tmp.path,
            tools: ["wq_ping", "wq_update_progress"],
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, code }
    })
    expect(readonly.stderr).toBe("")
    expect(readonly.code).toBe(0)
    expect(calls).toEqual(["wq_update_progress", "wq_update_progress"])
  }),
)

it.live("managed tools without WorkQueue policy do not require a runtime for resolution", () =>
  Effect.gen(function* () {
    const previous = process.env.OPENCODE_MANAGED_PROFILE
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.OPENCODE_MANAGED_PROFILE = "1"
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
          else process.env.OPENCODE_MANAGED_PROFILE = previous
        }),
    )
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: {
        message: { id: messageID },
        updateToolCall: () => Effect.void,
        completeToolCall: () => Effect.void,
      } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    expect(tools).toEqual({})
  }),
)
