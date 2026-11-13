import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Cause, Effect, Exit, Fiber, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(
    input: SessionPrompt.PromptInput,
    parent?: {
      parentMessageID?: MessageID
      parentCallID?: string
      parentMode?: "foreground" | "background"
      notification?: boolean
      managedChildAuthorization?: { prompt: object; runner: object }
    },
  ): Effect.Effect<SessionV1.WithParts>
  claimParentNotification?(sessionID: SessionID, parentCallID?: string): Effect.Effect<boolean>
  releaseParentNotificationClaim?(sessionID: SessionID, parentCallID?: string): Effect.Effect<void>
  setParentMode?(sessionID: SessionID, mode: "foreground" | "background"): Effect.Effect<void>
  acknowledgeParentNotification?(sessionID: SessionID, parentCallID?: string): Effect.Effect<void>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  model: Schema.optional(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. Use "providerID/modelID" or "providerID/modelID#variant". Omitting the variant uses the model default, ignoring agent and parent variants.',
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

export function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const provider = yield* Provider.Service

    const resolveModel = Effect.fn("TaskTool.resolveModel")(function* (input: string) {
      const [value, variant, ...rest] = input.split("#")
      const selected = Provider.parseModel(value)
      if (!selected.providerID || !selected.modelID || rest.length > 0 || variant === "")
        return yield* Effect.fail(
          new Error(`Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`),
        )
      const available = yield* provider.list()
      if (
        !Object.hasOwn(available, selected.providerID) ||
        !Object.hasOwn(available[selected.providerID].models, selected.modelID)
      )
        return yield* new Provider.ModelNotFoundError(selected)
      const model = available[selected.providerID].models[selected.modelID]
      if (variant !== undefined && !Object.hasOwn(model.variants ?? {}, variant)) {
        const variants = Object.keys(model.variants ?? {})
        return yield* Effect.fail(
          new Error(
            variants.length === 0
              ? `Model "${value}" has no variants. Omit the variant.`
              : `Variant "${variant}" is not available for "${value}". Available: ${variants.join(", ")}.`,
          ),
        )
      }
      if (!model.capabilities.input.text || !model.capabilities.output.text)
        return yield* Effect.fail(new Error(`Model "${value}" must support both text input and text output.`))
      // Empty bypasses SessionPrompt's nullish agent fallback without selecting a named variant.
      return { model: selected, variant: variant ?? "" }
    })

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const managed = process.env.OPENCODE_MANAGED_PROFILE === "1"
      const runInBackground = params.background === true
      if (managed && (runInBackground || !ctx.managedRuntime?.authorizeChild || ctx.executionFence === undefined))
        return yield* Effect.fail(new Error("Managed tasks require a tracked parent and foreground execution"))
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }
      if (managed && next.mode !== "subagent")
        return yield* Effect.fail(new Error("Managed tasks require an agent configured with mode subagent"))

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      if (managed && params.task_id && !session)
        return yield* Effect.fail(new Error("Cannot resume a missing managed task session"))
      if (
        session &&
        (session.parentID !== parent.id ||
          session.directory !== parent.directory ||
          session.workspaceID !== parent.workspaceID)
      ) {
        return yield* Effect.fail(new Error("Cannot resume a task session from another parent or workspace"))
      }
      if (managed && session && session.agent !== next.name)
        return yield* Effect.fail(new Error("Cannot resume a managed task session with a different agent"))
      const parentAgent = managed ? yield* agent.get(ctx.agent) : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: managed ? [] : (parent.permission ?? []),
        subagent: next,
      })
      const managedParentPolicy = managed
        ? [
            ...(parentAgent?.permission ?? []),
            ...(parent.permission ?? []),
            ...(ctx.managedReadOnly ? [{ permission: "edit", pattern: "*", action: "deny" as const }] : []),
          ]
        : undefined
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant
      const override = params.model ? yield* resolveModel(params.model) : undefined
      const model = override?.model ??
        next.model ?? {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        }
      const childVariant = override?.variant ?? (next.model ? undefined : variant)

      const previousTask = session?.metadata?.task
      const reusableMessageID =
        previousTask &&
        typeof previousTask === "object" &&
        previousTask.parentSessionId === ctx.sessionID &&
        previousTask.parentMessageID === ctx.messageID &&
        previousTask.parentCallID === ctx.callID &&
        typeof previousTask.messageID === "string" &&
        previousTask.messageID.startsWith("msg")
          ? MessageID.make(previousTask.messageID)
          : undefined
      const childMessageID = reusableMessageID ?? MessageID.ascending()
      const taskLink = {
        parentSessionId: ctx.sessionID,
        parentMessageID: ctx.messageID,
        parentCallID: ctx.callID,
        messageID: childMessageID,
        model,
        inheritVariant: override === undefined && next.model === undefined,
        variant: childVariant,
        ...(runInBackground ? { background: true } : {}),
      }
      const permission = [
        ...childPermission,
        ...childToolDenies.filter(
          (deny) =>
            !childPermission.some(
              (rule) =>
                rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
            ),
        ),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          managedParentFence: managed ? ctx.executionFence : undefined,
          managedParentPolicy,
          workspaceID: parent.workspaceID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          metadata: { task: taskLink },
          permission,
        }))
      const metadata = { ...taskLink, sessionId: nextSession.id }
      const managedChildAuthorization =
        managed && ctx.executionFence !== undefined && ctx.managedRuntime?.authorizeChild
          ? yield* ctx.managedRuntime.authorizeChild(nextSession.id, parent.id, ctx.executionFence).pipe(Effect.orDie)
          : undefined
      if (managed && session && ctx.executionFence !== undefined)
        yield* sessions.setPermission({
          sessionID: session.id,
          permission: [...(session.permission ?? []), ...permission],
          managedParent: { sessionID: parent.id, fence: ctx.executionFence, policy: managedParentPolicy },
        })

      const taskDiagnostic = (event: string, fields: Record<string, unknown> = {}) =>
        Effect.logInfo(`restart diagnostic TaskTool ${event}`, {
          parentSessionID: ctx.sessionID,
          parentAssistantMessageID: ctx.messageID,
          parentCallID: ctx.callID,
          childSessionID: nextSession.id,
          mode: runInBackground ? "background" : "foreground",
          childAgent: next.name,
          ...fields,
        })

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        yield* taskDiagnostic("runTask started")
        // Model-authored text cannot grant file attachment or agent-mention authority.
        const parts = managed
          ? [{ type: "text" as const, text: params.prompt }]
          : yield* ops.resolvePromptParts(params.prompt)
        const job = managed ? undefined : yield* background.get(nextSession.id)
        const result = yield* ops.prompt(
          {
            messageID: childMessageID,
            sessionID: nextSession.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            variant: childVariant,
            agent: next.name,
            parts,
          },
          {
            parentMessageID: ctx.messageID,
            parentCallID: ctx.callID,
            parentMode: runInBackground || job?.metadata?.background === true ? "background" : "foreground",
            managedChildAuthorization,
          },
        )
        const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
        const assistant = result.info.role === "assistant" ? result.info : undefined
        yield* taskDiagnostic("child prompt returned", {
          childAssistantMessageID: assistant?.id,
          finish: assistant?.finish,
          containsError: assistant?.error !== undefined,
          textResultLength: text.length,
        })
        if (result.info.role === "assistant" && result.info.error) {
          yield* taskDiagnostic("TaskTool reports child error", { status: "error", outputLength: 0 })
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          yield* taskDiagnostic("TaskTool reports child error", { status: "error", outputLength: 0 })
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
        }
        return text
      })

      if (managed) {
        // Never register a BackgroundJob: managed children have no promotion or late-notification path.
        // The finalizer joins interruption, so the parent's execution lease outlives child cleanup.
        const text = yield* Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* runTask().pipe(Effect.forkScoped)
            // Join the admitting waiter before cancelling any instance runner it may have created.
            const cancel = Fiber.interrupt(fiber).pipe(Effect.andThen(ops.cancel(nextSession.id)))
            const abort = Effect.callback<never>((resume) => {
              if (ctx.abort.aborted) return resume(Effect.interrupt)
              const onAbort = () => resume(Effect.interrupt)
              ctx.abort.addEventListener("abort", onAbort, { once: true })
              return Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort))
            })
            return yield* Effect.acquireUseRelease(
              Effect.void,
              () => Effect.raceFirst(Fiber.join(fiber), abort),
              (_, exit) => (Exit.isFailure(exit) ? cancel : Effect.void),
            )
          }),
        )
        return {
          title: params.description,
          metadata,
          output: renderOutput({ sessionID: nextSession.id, state: "completed", text }),
        }
      }

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        const notification = {
          sessionID: ctx.sessionID,
          messageID: MessageID.ascending(`msg_task_notification_${nextSession.id}`),
          agent: currentParent.agent ?? ctx.agent,
          variant,
          idempotent: true,
          parts: [
            {
              id: PartID.ascending(`prt_task_notification_${nextSession.id}`),
              type: "text" as const,
              synthetic: true,
              text: renderOutput({
                sessionID: nextSession.id,
                state,
                summary:
                  state === "completed"
                    ? `Background task completed: ${params.description}`
                    : `Background task failed: ${params.description}`,
                text,
              }),
            },
          ],
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) yield* Effect.sleep(attempt === 1 ? "1 second" : "5 seconds")
          const claimed = yield* ops.claimParentNotification?.(nextSession.id, ctx.callID) ?? Effect.succeed(true)
          if (!claimed) {
            yield* taskDiagnostic("background notification not claimed", {
              childSessionID: nextSession.id,
              attempt: attempt + 1,
            })
            return
          }
          const delivered = yield* Effect.exit(
            ops
              .prompt(notification, { notification: true })
              .pipe(Effect.tap(() => ops.acknowledgeParentNotification?.(nextSession.id, ctx.callID) ?? Effect.void)),
          )
          if (Exit.isSuccess(delivered)) return
          yield* ops.releaseParentNotificationClaim?.(nextSession.id, ctx.callID) ?? Effect.void
          const error = Cause.squash(delivered.cause)
          yield* taskDiagnostic("background notification retry scheduled", {
            childSessionID: nextSession.id,
            attempt: attempt + 1,
            errorType: error instanceof Error ? error.name : typeof error,
          })
        }
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* Effect.gen(function* () {
          yield* taskDiagnostic("background wait started", { jobID, wait: "notification" })
          const result = yield* background.wait({ id: jobID })
          yield* taskDiagnostic("background wait returned", {
            jobID,
            status: result.info?.status,
            outputLength: result.info?.output?.length ?? 0,
          })
          if (result.info?.status === "completed") yield* inject("completed", result.info.output ?? "")
          if (result.info?.status === "error") yield* inject("error", result.info.error ?? "")
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            return taskDiagnostic("background notification remains pending", {
              jobID,
              errorType: error instanceof Error ? error.name : typeof error,
            })
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      const extended = yield* background.extend({ id: nextSession.id, run: runTask() })
      yield* taskDiagnostic("background extend returned", { extended, jobID: nextSession.id })
      if (extended) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          ops.setParentMode?.(nextSession.id, "background") ?? Effect.void,
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })
      yield* taskDiagnostic("background job started", {
        jobID: info.id,
        status: info.status,
        outputLength: info.output?.length ?? 0,
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            yield* taskDiagnostic("foreground wait started", { jobID: nextSession.id, wait: "completion_or_promotion" })
            const wake = yield* Effect.raceFirst(
              background
                .wait({ id: nextSession.id })
                .pipe(Effect.map((waited) => ({ source: "completion" as const, info: waited.info }))),
              background
                .waitForPromotion(nextSession.id)
                .pipe(Effect.map((promoted) => ({ source: "promotion" as const, info: promoted }))),
            )
            const result = wake.info
            yield* taskDiagnostic("foreground wait woke", {
              jobID: nextSession.id,
              wake: wake.source,
              status: result?.status,
              promoted: result?.metadata?.background === true,
              outputLength: result?.output?.length ?? 0,
            })
            if (result?.metadata?.background === true) {
              yield* taskDiagnostic("TaskTool reports child promoted", {
                status: "promoted",
                outputLength: 0,
              })
              return backgroundResult()
            }
            if (result?.status === "error") {
              yield* taskDiagnostic("TaskTool reports child error", { status: "error", outputLength: 0 })
              return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            }
            if (result?.status === "cancelled") {
              yield* taskDiagnostic("TaskTool reports child cancelled", { status: "cancelled", outputLength: 0 })
              return yield* Effect.fail(new Error("Task cancelled"))
            }
            yield* taskDiagnostic("TaskTool reports child completed", {
              status: "completed",
              outputLength: result?.output?.length ?? 0,
            })
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description:
        process.env.OPENCODE_MANAGED_PROFILE === "1"
          ? [
              DESCRIPTION,
              "Managed delegation is foreground only, with at most eight nested child levels. Use configured subagents for independent reviews and verification. Background execution and promotion are prohibited; the caller waits for joined child completion. Children inherit the same managed tool restrictions and workspace. The prompt is literal text: @file paths and @agent mentions do not attach files or grant agent permissions.",
            ].join("\n\n")
          : flags.experimentalBackgroundSubagents
            ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
            : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.scoped, Effect.orDie),
    }
  }),
)
