import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { CompressTool } from "./compress"
import { Database } from "@opencode-ai/core/database/database"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { McpEnableTool } from "./mcp-enable"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { WebSearchTool } from "./websearch"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Cause, Effect, Layer, Context } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { McpActivation } from "@/session/mcp-activation"
import { SessionID } from "@/session/schema"
import { ManagedSkill } from "@/skill/managed"
import { TuiEvent } from "@/server/tui-event"
import { diagnosticErrorFields, diagnosticText } from "@/util/diagnostic"

export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) {
  return (
    providerID === ProviderV2.ID.opencode ||
    providerID === ProviderV2.ID.make("opencode-go") ||
    flags.exa ||
    flags.parallel
  )
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
    sessionID?: SessionID
    mcpActivated?: readonly string[]
  }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const mcp = yield* MCP.Service
    const skills = yield* Skill.Service
    const events = yield* EventV2Bridge.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const compress = yield* CompressTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const mcpEnable = yield* McpEnableTool
    const agent = yield* Agent.Service
    const codeMode = flags.experimentalCodeMode ? yield* Effect.promise(() => import("./code-mode")) : undefined
    const codeModeTool = codeMode ? yield* codeMode.CodeModeTool : undefined

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          if (typeof def.description !== "string") throw new TypeError("Tool description must be a string")
          if (typeof def.execute !== "function") throw new TypeError("Tool execute must be a function")
          // Plugin tools still expose Zod args publicly; keep that compatibility
          // boxed at the registry boundary and give the LLM the original JSON Schema.
          // Normalize missing args to `{}` once — pre-1.14.49 the code was
          // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
          const args = def.args ?? {}
          if (typeof args !== "object" || Array.isArray(args)) throw new TypeError("Tool args must be an object")
          const entries = Object.entries(args)
          const allZod = entries.every((entry) => isZodType(entry[1]))
          const zodParams = allZod ? z.object(args) : undefined
          const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
          const parameters = zodParams
            ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
            : Schema.Unknown
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                // Bridge the host's Effect-based `ask` into a Promise-returning
                // function for the plugin to make sure context persists
                const bridge = yield* EffectBridge.make()
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => bridge.promise(toolCtx.ask(req)),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const attachments = typeof result === "string" ? undefined : result.attachments
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: typeof result === "string" ? "" : (result.title ?? ""),
                  output: out.truncated ? out.content : output,
                  attachments,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const skip = Effect.fnUntraced(function* (
          source: string,
          stage: "discovery" | "import" | "registration",
          error: unknown,
          id?: string,
        ) {
          const fields = {
            source: diagnosticText(source, 1024),
            stage,
            ...(id ? { tool: diagnosticText(id, 128) } : {}),
            ...diagnosticErrorFields(error),
          }
          yield* Effect.logWarning("optional custom tool skipped", fields)
          yield* events
            .publish(TuiEvent.ToastShow, {
              title: "Custom tool skipped",
              message: `${fields.source}${fields.tool ? ` (${fields.tool})` : ""}: ${stage}: ${fields.errorType}: ${fields.errorMessage}. Other tools remain available; see server logs.`,
              variant: "warning",
              duration: 10000,
            })
            .pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterrupts(cause),
                () => Effect.logWarning("custom tool warning notification failed", { source: fields.source, stage }),
              ),
            )
        })

        const register = Effect.fnUntraced(function* (
          source: string,
          id: string,
          get: () => unknown,
          origin: "named" | "default" | "plugin",
        ) {
          const tool = yield* Effect.try({
            try: () => {
              const def = get()
              if (!isPluginTool(def)) {
                if (
                  origin === "named" &&
                  !(typeof def === "object" && def !== null && ("args" in def || "execute" in def))
                )
                  return
                throw new TypeError("Expected a tool definition with description and execute")
              }
              if (origin !== "plugin" && !("args" in def)) return
              return fromPlugin(id, def)
            },
            catch: (error) => error,
          }).pipe(Effect.catch((error) => skip(source, "registration", error, id).pipe(Effect.as(undefined))))
          if (tool) custom.push(tool)
        })

        const dirs = yield* config.directories()
        const matches = (yield* Effect.forEach(dirs, (dir) =>
          Effect.try({
            try: () => Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              process.env.OPENCODE_MANAGED_PROFILE === "1"
                ? Effect.die(error)
                : skip(dir, "discovery", error).pipe(Effect.as([])),
            ),
          ),
        )).flat()
        if (process.env.OPENCODE_MANAGED_PROFILE === "1" && matches.length)
          throw new Error("Custom tools are unavailable in the managed profile: their execution is not accounted")
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          // Convert import/link/evaluation rejections to typed failures only at this optional boundary.
          const mod = yield* Effect.tryPromise({
            try: () => import(pathToFileURL(match).href),
            catch: (error) => error,
          }).pipe(Effect.catch((error) => skip(match, "import", error).pipe(Effect.as(undefined))))
          if (!mod) continue
          const ids = yield* Effect.try({ try: () => Object.keys(mod), catch: (error) => error }).pipe(
            Effect.catch((error) => skip(match, "registration", error).pipe(Effect.as([]))),
          )
          for (const id of ids) {
            yield* register(
              match,
              id === "default" ? namespace : `${namespace}_${id}`,
              () => mod[id],
              id === "default" ? "default" : "named",
            )
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          const source = Plugin.source(p) ?? "configured plugin"
          const tools = yield* Effect.try({ try: () => p.tool ?? {}, catch: (error) => error }).pipe(
            Effect.catch((error) => skip(source, "registration", error).pipe(Effect.as(undefined))),
          )
          if (!tools) continue
          const ids = yield* Effect.try({ try: () => Object.keys(tools), catch: (error) => error }).pipe(
            Effect.catch((error) => skip(source, "registration", error).pipe(Effect.as([]))),
          )
          for (const id of ids) {
            yield* register(source, id, () => tools[id], "plugin")
          }
        }

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          compress: Tool.init(compress),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          mcpEnable: Tool.init(mcpEnable),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          ...(codeModeTool ? { execute: Tool.init(codeModeTool) } : {}),
        })

        return {
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            ...(process.env.OPENCODE_MANAGED_PROFILE === "1" ? [tool.compress] : []),
            tool.fetch,
            tool.todo,
            tool.search,
            tool.skill,
            tool.mcpEnable,
            tool.patch,
            ...(tool.execute ? [tool.execute] : []),
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) =>
        process.env.OPENCODE_MANAGED_PROFILE === "1" ? item.mode === "subagent" : item.mode !== "primary",
      )
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const describeCodeMode = Effect.fn("ToolRegistry.describeCodeMode")(function* (input: {
      agent: Agent.Info
      permission?: PermissionV1.Ruleset
      sessionID?: SessionID
      mcpActivated?: readonly string[]
    }) {
      if (!codeMode) return
      const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
      const current = input.mcpActivated
        ? undefined
        : input.sessionID
          ? yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          : undefined
      const activated = input.mcpActivated ?? McpActivation.names(current?.metadata)
      const tools = Permission.visibleTools(yield* mcp.tools(activated), ruleset)
      if (Object.keys(tools).length === 0) return
      return codeMode.describeCatalog(tools)
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const filtered = (yield* all()).filter((tool) => {
        if (ManagedSkill.enabled) return ["bash", "task", "compress", "skill"].includes(tool.id)
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      const codeModeDescription = filtered.some((tool) => tool.id === "execute")
        ? yield* describeCodeMode(input)
        : undefined
      const visible = filtered.filter((tool) => tool.id !== "execute" || codeModeDescription)

      return yield* Effect.forEach(
        visible,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          if (!ManagedSkill.enabled) yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          if (ManagedSkill.enabled && tool.id === SkillTool.id) {
            const rules = Permission.merge(input.agent.permission, input.permission ?? [])
            const available = (yield* skills.all()).filter(
              (item) => Permission.evaluate("skill", item.name, rules).action !== "deny",
            )
            output.description = [
              "Load an operator-approved skill by exact name. Its output is plain-text instructions, not executable resources.",
              'Providing a reason is strongly recommended, but not required. Briefly explain why the selected skill is relevant to the current user request or task. Prefer one short, specific sentence. Avoid generic explanations such as "This skill is useful" or simply repeating the skill description.',
              available.length
                ? available.map((item) => `- ${item.name}${item.description ? `: ${item.description}` : ""}`).join("\n")
                : "No skills are currently available.",
            ].join("\n\n")
          }
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          return {
            id: tool.id,
            description: [
              output.description,
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === "execute" ? codeModeDescription : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "description" in value && "execute" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Config.node,
    Plugin.node,
    Question.node,
    Todo.node,
    Agent.node,
    Skill.node,
    Session.node,
    BackgroundJob.node,
    Provider.node,
    LSP.node,
    Instruction.node,
    FSUtil.node,
    EventV2Bridge.node,
    httpClient,
    CrossSpawnSpawner.node,
    Format.node,
    Truncate.node,
    RuntimeFlags.node,
    MCP.node,
    Database.node,
    Ripgrep.node,
  ],
})

export * as ToolRegistry from "./registry"
