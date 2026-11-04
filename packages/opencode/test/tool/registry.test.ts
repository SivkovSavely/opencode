import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { Cause, Effect, Exit, Layer, Logger, Result, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"

import { ToolJsonSchema } from "@/tool/json-schema"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MCP } from "@/mcp"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { TuiEvent } from "@/server/tui-event"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

// Fake Plugin.Service that returns a single plugin whose `tool` map contains
// one definition with `args: undefined`. Used to exercise the plugin entry
// point of `fromPlugin` for the #27451 / #27630 regression.
const brokenPluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            broken_plugin_tool: {
              description: "plugin tool with missing args",
              args: undefined as unknown as Record<string, never>,
              execute: async () => "ok",
            },
          },
        },
      ]),
  }),
)

const root = LayerNode.group([ToolRegistry.node, Agent.node, EventV2Bridge.node, CrossSpawnSpawner.node])
const replacements = [
  [Config.node, configLayer],
  [RuntimeFlags.node, RuntimeFlags.layer()],
] as const

const it = testEffect(LayerNode.compile(root, replacements))
const withCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            weather_current: {
              server: "weather",
              def: {
                name: "current",
                description: "current weather",
                inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              } as MCPToolDef,
              client: {} as MCP.McpTool["client"],
            },
          }),
        clients: () => Effect.succeed({ weather: {} as any }),
      }),
    ],
  ]),
)
const withEmptyCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () => Effect.succeed({}),
        clients: () => Effect.succeed({}),
      }),
    ],
  ]),
)
const withBrokenPlugin = testEffect(LayerNode.compile(root, [...replacements, [Plugin.node, brokenPluginLayer]]))
const withConfiguredPlugin = testEffect(
  LayerNode.compile(root, [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
        get: () =>
          InstanceState.directory.pipe(
            Effect.map((dir) => ({
              plugin_origins: [
                { spec: pathToFileURL(path.join(dir, "plugin.ts")).href, source: dir, scope: "local" as const },
              ],
            })),
          ),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

function withDiagnostics<A, E, R>(
  run: (input: { logs: unknown[]; notifications: unknown[] }) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const logs: unknown[] = []
    const notifications: unknown[] = []
    const off = yield* events.listen((event) => {
      if (event.type === TuiEvent.ToastShow.type || event.type === "session.error") notifications.push(event)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => off)
    return yield* run({ logs, notifications }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            if (Array.isArray(options.message) && options.message[0] === "optional custom tool skipped")
              logs.push(options.message)
          }),
        ]),
      ),
    )
  })
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
    }),
  )

  it.instance("does not expose execute unless code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("execute")
    }),
  )

  withCodeMode.instance("exposes execute when code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = yield* registry.ids()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const execute = tools.find((tool) => tool.id === "execute")

      expect(ids).toContain("execute")
      expect(tools.map((tool) => tool.id)).toContain("execute")
      expect(execute?.description).toContain("tools.weather.current(input: {\n  city: string,\n})")
    }),
  )

  withEmptyCodeMode.instance("does not expose execute when code mode has no visible tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      expect(tools.map((tool) => tool.id)).not.toContain("execute")
    }),
  )

  it.instance("hides task background parameter unless experimental background subagents are enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )

  it.instance("loads tools from .opencode/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tool = path.join(opencode, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  for (const directory of ["tool", "tools"]) {
    it.instance(`ignores helpers without args in .opencode/${directory} files`, () =>
      withDiagnostics(({ logs, notifications }) =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          yield* Effect.promise(() =>
            Bun.write(
              path.join(test.directory, ".opencode", directory, "mixed.ts"),
              [
                "export const label = 'not a tool'",
                "export const helper = { description: 'Internal utility', execute: async () => 'internal result' }",
                "export default helper",
                "export const intended = { description: 'mixed tool', args: {}, execute: async () => 'ok' }",
                "",
              ].join("\n"),
            ),
          )

          const registry = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const ids = yield* registry.ids()
          const tools = yield* registry.tools({
            providerID: ProviderV2.ID.opencode,
            modelID: ModelV2.ID.make("test"),
            agent: yield* agents.defaultInfo(),
          })
          expect(ids.filter((id) => id.startsWith("mixed"))).toEqual(["mixed_intended"])
          expect(tools.filter((tool) => tool.id.startsWith("mixed")).map((tool) => tool.id)).toEqual(["mixed_intended"])
          expect(logs).toEqual([])
          expect(notifications).toEqual([])
        }),
      ),
    )
  }

  for (const directory of ["tool", "tools"]) {
    it.instance(`skips missing V2 exports in ${directory} without poisoning the registry`, () =>
      withDiagnostics(({ logs, notifications }) =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const opencode = path.join(test.directory, ".opencode")
          const broken = path.join(opencode, directory, "broken.ts")
          yield* Effect.promise(() => Bun.write(path.join(opencode, "plugin-v2.ts"), "export const Plugin = {}\n"))
          yield* Effect.promise(() =>
            Bun.write(broken, "import { tool } from '../plugin-v2'\nexport default tool({})\n"),
          )
          yield* Effect.promise(() =>
            Bun.write(
              path.join(opencode, directory === "tool" ? "tools" : "tool", "working.ts"),
              "export default { description: 'working tool', args: {}, execute: async () => 'ok' }\n",
            ),
          )
          const registry = yield* ToolRegistry.Service
          const results = yield* Effect.all([registry.ids(), registry.ids()], { concurrency: 2 })
          expect(results[0]).toEqual(results[1])
          expect(results[0]).toContain("working")
          expect(results[0]).toContain("read")
          expect(results[0]).toContain("bash")
          expect(results[0]).not.toContain("broken")
          expect(yield* registry.ids()).toEqual(results[0])
          expect(logs).toEqual([
            [
              "optional custom tool skipped",
              expect.objectContaining({
                source: broken,
                stage: "import",
                errorType: "SyntaxError",
                errorMessage: expect.stringContaining("Missing export tool"),
              }),
            ],
          ])
          expect(JSON.stringify(logs)).toContain("plugin-v2.ts")
          expect(JSON.stringify(logs)).toContain("API versions")
          expect(notifications).toEqual([
            expect.objectContaining({
              type: TuiEvent.ToastShow.type,
              location: expect.objectContaining({ directory: test.directory }),
              data: expect.objectContaining({ variant: "warning", message: expect.stringContaining(broken) }),
            }),
          ])
        }),
      ),
    )
  }

  it.instance("isolates evaluation, resolution and individual definition conversion failures", () =>
    withDiagnostics(({ logs }) =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const tools = path.join(test.directory, ".opencode", "tools")
        yield* Effect.promise(() =>
          Bun.write(path.join(tools, "evaluate.ts"), "throw new Error('evaluation failed')\n"),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(tools, "resolve.ts"),
            "import { missing } from 'nonexistent-custom-tool-package'\nexport default missing()\n",
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(tools, "mixed.ts"),
            [
              `import { tool } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href)}`,
              "export const helper = { value: 'not a tool' }",
              "export const bad_args = { description: 'bad args', args: 42, execute: async () => '' }",
              "export const bad_description = { description: 42, args: {}, execute: async () => '' }",
              "export const bad_execute = { description: 'bad execute', args: {}, execute: 42 }",
              "export const bad_getter = { description: 'bad getter', get args() { throw new Error('args getter failed') }, execute: async () => '' }",
              "export const bad_schema = tool({ description: 'bad schema', args: { date: tool.schema.date() }, execute: async () => '' })",
              "export const incomplete = { args: {} }",
              "export const named = { description: 'named', args: {}, execute: async () => 'named' }",
              "export default { description: 'default', args: {}, execute: async () => 'default' }",
              "",
            ].join("\n"),
          ),
        )
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).toContain("read")
        expect(ids.filter((id) => id.startsWith("mixed"))).toEqual(["mixed", "mixed_named"])
        expect(ids).not.toContain("evaluate")
        expect(ids).not.toContain("resolve")
        expect(logs).toHaveLength(8)
        expect(logs).toContainEqual([
          "optional custom tool skipped",
          expect.objectContaining({
            source: path.join(tools, "resolve.ts"),
            stage: "import",
            errorMessage: expect.stringContaining("dependencies"),
          }),
        ])
        expect(logs).toContainEqual([
          "optional custom tool skipped",
          expect.objectContaining({
            source: path.join(tools, "evaluate.ts"),
            stage: "import",
            errorMessage: "evaluation failed",
          }),
        ])
        expect(logs).toContainEqual([
          "optional custom tool skipped",
          expect.objectContaining({
            source: path.join(tools, "mixed.ts"),
            stage: "registration",
            tool: "mixed_bad_schema",
          }),
        ])
        expect(logs).toContainEqual([
          "optional custom tool skipped",
          expect.objectContaining({
            stage: "registration",
            tool: "mixed_bad_execute",
            errorMessage: "Tool execute must be a function",
          }),
        ])
      }),
    ),
  )

  it.instance("bounds and sanitizes skip diagnostics without evaluating error accessors or payloads", () =>
    withDiagnostics(({ logs, notifications }) =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const tools = path.join(test.directory, ".opencode", "tools")
        for (const [name, code] of Object.entries({
          accessor:
            "const error = new Error(); Object.defineProperty(error, 'message', { get() { throw new Error('private accessor executed') } }); throw error",
          object:
            "throw { message: 'private object message', payload: 'private payload', toString() { throw new Error('private coercion') } }",
          huge: "throw Object.assign(new Error('evaluation failed https://user:private-url@example.com password=private-password Bearer private-bearer ' + 'x'.repeat(10000)), { payload: 'private payload' })",
          syntax: "throw new SyntaxError('Unexpected token private-source-code')",
          bounded: "throw new Error('x'.repeat(10000))",
        }))
          yield* Effect.promise(() => Bun.write(path.join(tools, `${name}.ts`), code))
        const registry = yield* ToolRegistry.Service
        expect(yield* registry.ids()).toContain("read")
        yield* registry.ids()
        expect(logs).toHaveLength(5)
        expect(notifications).toHaveLength(5)
        const rendered = JSON.stringify({ logs, notifications })
        expect(rendered).not.toContain("private")
        expect(rendered).not.toContain("x".repeat(513))
        expect(rendered).toContain("accessor omitted")
        expect(rendered).toContain("Non-Error failure")
        expect(rendered).toContain("redacted data")
        expect(rendered).toContain("Unexpected token")
        expect(logs).toContainEqual([
          "optional custom tool skipped",
          expect.objectContaining({ errorMessage: "x".repeat(512) }),
        ])
      }),
    ),
  )

  it.instance("does not let a warning notification observer poison optional tool loading", () =>
    withDiagnostics(({ logs }) =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, ".opencode", "tool", "broken.ts"),
            "throw new Error('optional failure')\n",
          ),
        )
        const events = yield* EventV2Bridge.Service
        const off = yield* events.listen((event) =>
          event.type === TuiEvent.ToastShow.type ? Effect.die(new Error("notification observer failed")) : Effect.void,
        )
        yield* Effect.addFinalizer(() => off)
        const registry = yield* ToolRegistry.Service
        expect(yield* registry.ids()).toContain("read")
        expect(yield* registry.ids()).not.toContain("broken")
        expect(logs).toHaveLength(1)
      }),
    ),
  )

  withConfiguredPlugin.instance(
    "retains configured plugin tools and attributes malformed definitions to their source",
    () =>
      withDiagnostics(({ logs }) =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const source = path.join(test.directory, "plugin.ts")
          yield* Effect.promise(() =>
            Bun.write(
              source,
              "export default async () => ({ tool: { compatible_plugin: { description: 'compatible', execute: async () => 'ok' }, malformed_plugin: { description: 'malformed', args: {}, execute: false } } })\n",
            ),
          )
          yield* Effect.promise(() =>
            Bun.write(
              path.join(test.directory, ".opencode", "tool", "broken.ts"),
              "throw new Error('optional failure')\n",
            ),
          )
          const registry = yield* ToolRegistry.Service
          const ids = yield* registry.ids()
          expect(ids).toContain("read")
          expect(ids).toContain("compatible_plugin")
          expect(ids).not.toContain("malformed_plugin")
          expect(ids).not.toContain("broken")
          expect(logs).toContainEqual([
            "optional custom tool skipped",
            expect.objectContaining({
              source: pathToFileURL(source).href,
              tool: "malformed_plugin",
              stage: "registration",
            }),
          ])
        }),
      ),
  )

  it.instance(
    "reloads directory-scoped discovery without invalidating healthy directories or promising module reload",
    () =>
      withDiagnostics(({ logs }) =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const healthy = yield* tmpdirScoped()
          const tools = path.join(test.directory, ".opencode", "tool")
          yield* Effect.promise(() =>
            Bun.write(path.join(tools, "broken.ts"), "throw new Error('cached evaluation failure')\n"),
          )
          const registry = yield* ToolRegistry.Service
          const store = yield* InstanceStore.Service
          const first = yield* registry.all()
          const other = yield* registry.all().pipe(provideInstance(healthy))
          expect(first.some((tool) => tool.id === "read")).toBe(true)
          expect(logs).toHaveLength(1)
          yield* Effect.promise(() => fs.unlink(path.join(tools, "broken.ts")))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tools, "fixed.ts"),
              "export default { description: 'fixed at a new module URL', args: {}, execute: async () => 'ok' }\n",
            ),
          )
          expect(yield* registry.all()).toEqual(first)
          yield* store.reload({ directory: test.directory })
          expect(yield* registry.ids()).toContain("fixed")
          expect((yield* registry.all().pipe(provideInstance(healthy)))[0]).toBe(other[0])
          expect(logs).toHaveLength(1)
          yield* store.disposeDirectory(test.directory)
          expect(yield* registry.ids()).toContain("fixed")
        }),
      ),
  )

  it.instance("does not swallow custom tool execution failures", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          path.join(test.directory, ".opencode", "tool", "execution.ts"),
          "export default { description: 'execution failure', args: {}, execute: async () => { throw new Error('execution failed') } }\n",
        ),
      )
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "execution")
      if (!loaded) throw new Error("execution tool missing")
      const exit = yield* loaded
        .execute(
          {},
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            agent: (yield* agents.defaultInfo()).name,
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "execution failed" })
    }),
  )

  it.instance("keeps managed-profile custom tool rejection fatal before importing", () =>
    withDiagnostics(({ logs, notifications }) =>
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
        const test = yield* TestInstance
        const marker = path.join(test.directory, "must-not-import")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, ".opencode", "tool", "restricted.ts"),
            `await Bun.write(${JSON.stringify(marker)}, 'imported'); export default {}\n`,
          ),
        )
        const registry = yield* ToolRegistry.Service
        const exit = yield* registry.ids().pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({
            message: expect.stringContaining("Custom tools are unavailable in the managed profile"),
          })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect(logs).toEqual([])
        expect(notifications).toEqual([])
      }),
    ),
  )

  // Regression for #27451 / #27630: a custom tool that omits `args` must not
  // crash registry initialization with
  // `Object.entries requires that input parameter not be null or undefined`.
  // Pre-1.14.49 the code path was `z.object(def.args)`, and `z.object(undefined)`
  // silently produced an empty schema — so the tool registered as no-args.
  // Preserve that tolerance.
  it.instance("tolerates a custom tool exporting null/undefined args (no-args fallback)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".opencode", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "noargs.ts"),
          [
            "export default {",
            "  description: 'tool with no args',",
            "  args: undefined,",
            "  execute: async () => 'ok',",
            "}",
            "export const nullargs = { description: 'tool with null args', args: null, execute: async () => 'ok' }",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      // Built-in tools must still load — a single malformed custom tool must
      // not poison the whole registry.
      expect(ids).toContain("read")
      const loaded = (yield* registry.all()).find((t) => t.id === "noargs")
      if (!loaded) throw new Error("noargs tool was not loaded")
      expect(loaded.jsonSchema).toMatchObject({ type: "object", properties: {} })
      const nullargs = (yield* registry.all()).find((t) => t.id === "noargs_nullargs")
      if (!nullargs) throw new Error("nullargs tool was not loaded")
      expect(nullargs.jsonSchema).toMatchObject({ type: "object", properties: {} })
    }),
  )

  // Same regression, plugin entry point. The original reports (#27451, #27630)
  // came in through `plugin.list()` — `oh-my-opencode` was registering a tool
  // with `args: undefined` and crashing every message submit. The file-scan
  // and plugin-list loops both funnel through `fromPlugin`, but covering both
  // entry points means a future refactor that splits them won't silently lose
  // protection.
  withBrokenPlugin.instance("tolerates a plugin tool registered with null/undefined args", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("read")
      expect(ids).toContain("broken_plugin_tool")
    }),
  )

  it.instance("loads tools from .opencode/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads Zod-schema custom tools with JSON Schema and validation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".opencode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "sql.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'query database',",
            "  args: { query: tool.schema.string().describe('SQL query to execute') },",
            "  execute: async ({ query }) => query,",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "sql")
      if (!loaded) throw new Error("custom sql tool was not loaded")
      expect(loaded?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({ query: "select 1" }))).toBe(true)
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({}))).toBe(false)

      const agents = yield* Agent.Service
      const promptTools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const promptTool = promptTools.find((tool) => tool.id === "sql")
      if (!promptTool) throw new Error("custom sql tool was not returned for prompts")
      expect(ToolJsonSchema.fromTool(promptTool)).toMatchObject({
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
    }),
  )

  it.instance(
    "preserves Zod arg descriptions from older config-scoped plugin packages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const opencode = path.join(test.directory, ".opencode")
        const customTools = path.join(opencode, "tools")
        const plugin = path.join(opencode, "node_modules", "@opencode-ai", "plugin")
        yield* Effect.promise(() => fs.mkdir(path.join(plugin, "dist"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
        yield* Effect.promise(() =>
          fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(opencode, "node_modules", "zod"), {
            dereference: true,
            recursive: true,
          }),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "package.json"),
            JSON.stringify({ name: "@opencode-ai/plugin", type: "module", exports: { ".": "./dist/index.js" } }),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "dist", "index.js"),
            [
              "import { z } from 'zod'",
              "export function tool(input) {",
              "  return input",
              "}",
              "tool.schema = z",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(customTools, "addition.ts"),
            [
              'import { tool } from "@opencode-ai/plugin"',
              "export default tool({",
              "  description: 'Use this tool to add two numbers and return their sum.',",
              "  args: {",
              "    left: tool.schema.number().describe('The first number to add'),",
              "    right: tool.schema.number().describe('The second number to add'),",
              "  },",
              "  execute: async (args) => `${args.left} + ${args.right} = ${args.left + args.right}`,",
              "})",
              "",
            ].join("\n"),
          ),
        )

        const registry = yield* ToolRegistry.Service
        const loaded = (yield* registry.all()).find((tool) => tool.id === "addition")
        if (!loaded) throw new Error("custom addition tool was not loaded")

        expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
          properties: {
            left: { type: "number", description: "The first number to add" },
            right: { type: "number", description: "The second number to add" },
          },
        })
      }),
    20_000,
  )

  it.instance("preserves attachments from structured custom tool results", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".opencode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "image.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'image tool',",
            "  args: {},",
            "  execute: async () => ({",
            "    output: 'here is an image',",
            "    attachments: [{ type: 'file', mime: 'image/png', filename: 'picture.png', url: 'data:image/png;base64,AAAA' }],",
            "  }),",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "image")
      if (!loaded) throw new Error("custom image tool was not loaded")
      const agents = yield* Agent.Service
      const result = yield* loaded.execute({}, {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        agent: (yield* agents.defaultInfo()).name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context)

      expect(result.output).toBe("here is an image")
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/png", filename: "picture.png", url: "data:image/png;base64,AAAA" },
      ])
    }),
  )

  it.instance("loads legacy JSON-schema-shaped custom tools with wire schema", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = path.join(test.directory, ".opencode", "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "legacy.ts"),
          [
            "export default {",
            "  description: 'legacy schema tool',",
            "  args: { text: { type: 'string', description: 'Text to render' } },",
            "  execute: async ({ text }) => text,",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "legacy")
      if (!loaded) throw new Error("legacy custom tool was not loaded")
      expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
        type: "object",
        properties: {
          text: { type: "string", description: "Text to render" },
        },
        required: ["text"],
      })
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@opencode-ai/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@opencode-ai/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(opencode, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )
})
