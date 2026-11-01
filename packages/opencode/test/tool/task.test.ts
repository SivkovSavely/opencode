import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { Format } from "../../src/format"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { CompressTool } from "../../src/tool/compress"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ManagedCommand } from "@opencode-ai/core/managed-command"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { Permission } from "@/permission"
import { ManagedAccess } from "@/tool/managed-access"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      FSUtil.node,
      Format.node,
      LSP.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  onPromptEffect?: (input: SessionPrompt.PromptInput) => Effect.Effect<void>
  text?: string
  error?: NonNullable<SessionV1.Assistant["error"]>
  toolError?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        opts?.onPrompt?.(input)
        yield* opts?.onPromptEffect?.(input) ?? Effect.void
        return reply(input, opts?.text ?? "done", opts?.error, opts?.toolError)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
  toolError?: string,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
      error,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      ...(toolError
        ? [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "tool" as const,
              tool: "read",
              callID: "call-1",
              state: {
                status: "error" as const,
                input: { filePath: "/external" },
                error: toolError,
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ]
        : []),
    ],
  }
}

describe("tool.task", () => {
  it.instance("read-only managed children preserve their ceiling through nested task creation and resume", () =>
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
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const config = yield* Config.Service
      const cfg = yield* config.get()
      const { chat, assistant } = yield* seed()
      const runtime = RuntimeLifecycle.make({ lineage: "managed-read-only-task-test" }, yield* Effect.scope, database)
      const root = yield* runtime.admit({ sessionID: chat.id, directory: chat.directory })
      const task = yield* TaskTool.pipe(
        Effect.flatMap((tool) => tool.init()),
        Effect.provideService(Config.Service, { ...config, get: () => Effect.succeed({ ...cfg, subagent_depth: 3 }) }),
      )
      const compress = yield* CompressTool.pipe(Effect.flatMap((tool) => tool.init()))
      let compactions = 0
      const seen: { agent: string; id: SessionID; readOnly: boolean }[] = []
      let nestedID: string | undefined
      const ops: TaskPromptOps = {
        ...stubOps(),
        prompt: (input, parent) =>
          Effect.acquireUseRelease(
            runtime.admit({
              sessionID: input.sessionID,
              directory: chat.directory,
              parentSessionID: parent?.parentMessageID === assistant.id ? chat.id : seen[0]!.id,
              parentMode: "foreground",
              managedChildAuthorization: parent?.managedChildAuthorization?.prompt,
            }),
            (admitted) =>
              Effect.gen(function* () {
                const current = yield* sessions.get(input.sessionID)
                const selected = yield* agents.get(input.agent!)
                if (!selected) throw new Error("Missing selected agent")
                const policies = yield* sessions.managedPolicies(current.id)
                const readOnly = ManagedAccess.readOnly(selected.name, [
                  selected.permission,
                  current.permission ?? [],
                  ...policies,
                ])
                seen.push({ agent: selected.name, id: current.id, readOnly })
                expect(readOnly).toBe(true)
                if (current.parentID === chat.id) {
                  const user = yield* sessions.updateMessage({
                    id: MessageID.ascending(),
                    role: "user",
                    sessionID: current.id,
                    agent: selected.name,
                    model: ref,
                    time: { created: Date.now() },
                  })
                  const nestedAssistant = {
                    ...assistant,
                    id: MessageID.ascending(),
                    parentID: user.id,
                    sessionID: current.id,
                    agent: selected.name,
                  }
                  yield* sessions.updateMessage(nestedAssistant)
                  const compressed = yield* compress.execute(
                    {},
                    {
                      sessionID: current.id,
                      messageID: nestedAssistant.id,
                      agent: selected.name,
                      abort: new AbortController().signal,
                      managedRuntime: runtime,
                      managedReadOnly: readOnly,
                      executionFence: admitted.fence,
                      extra: {
                        requestCompaction: () =>
                          Effect.sync(() => {
                            compactions++
                          }),
                      },
                      messages: [],
                      metadata: () => Effect.void,
                      ask: () => Effect.void,
                    },
                  )
                  expect(compressed.metadata.queued).toBe(true)
                  const result = yield* task.execute(
                    { description: "nested", prompt: "verify", subagent_type: "general", task_id: nestedID },
                    {
                      sessionID: current.id,
                      messageID: nestedAssistant.id,
                      agent: selected.name,
                      abort: new AbortController().signal,
                      callID: "nested",
                      managedRuntime: runtime,
                      managedReadOnly: readOnly,
                      executionFence: admitted.fence,
                      extra: { promptOps: ops },
                      messages: [],
                      metadata: () => Effect.void,
                      ask: () => Effect.void,
                    },
                  )
                  nestedID = result.metadata.sessionId
                } else {
                  expect(
                    policies.some((policy) => Permission.evaluate("edit", "anything", policy).action === "deny"),
                  ).toBe(true)
                }
                yield* runtime.complete(input.sessionID)
                return reply(input, "complete")
              }),
            (admitted) => runtime.release(input.sessionID, admitted.fence),
          ).pipe(Effect.orDie),
      }
      const run = (task_id?: string) =>
        task.execute(
          { description: "review", prompt: "review", subagent_type: "general", task_id },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            callID: "review",
            managedRuntime: runtime,
            managedReadOnly: true,
            executionFence: root.fence,
            extra: { promptOps: ops },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
      const first = yield* run()
      expect(nestedID).toBeDefined()
      const firstNested = nestedID
      yield* run(first.metadata.sessionId)
      expect(nestedID).toBe(firstNested)
      expect(seen.map((entry) => [entry.agent, entry.readOnly])).toEqual([
        ["general", true],
        ["general", true],
        ["general", true],
        ["general", true],
      ])
      expect(seen[0]?.id).toBe(seen[2]?.id)
      expect(seen[1]?.id).toBe(seen[3]?.id)
      expect(compactions).toBe(2)
      yield* runtime.complete(chat.id)
      yield* runtime.release(chat.id, root.fence)
      expect(yield* runtime.commandStatus(chat.id)).toBe("drained")
      yield* runtime.retireRoot(chat.id).pipe(Effect.orDie)
      expect(yield* runtime.admit({ sessionID: chat.id, directory: chat.directory }).pipe(Effect.exit)).toMatchObject({
        _tag: "Failure",
      })
    }),
  )

  it.instance(
    "managed reviewers and verifiers are independent joined foreground children",
    () =>
      Effect.gen(function* () {
        // Load the test's trusted agent configuration before enabling managed project-config isolation.
        const agents = yield* Agent.Service
        expect(yield* agents.get("reviewer")).toBeDefined()
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
        const database = yield* Database.Service
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const runtime = RuntimeLifecycle.make({ lineage: "managed-task-test" }, yield* Effect.scope, database)
        const parent = yield* runtime.admit({ sessionID: chat.id, directory: chat.directory })
        const tool = yield* TaskTool.pipe(Effect.flatMap((tool) => tool.init()))
        const children: SessionID[] = []
        const ops: TaskPromptOps = {
          ...stubOps(),
          resolvePromptParts: () => Effect.die("Managed Task text must not enter trusted mention expansion"),
          prompt: (input, parent) =>
            Effect.acquireUseRelease(
              runtime.admit({
                sessionID: input.sessionID,
                directory: chat.directory,
                parentSessionID: chat.id,
                parentMode: "foreground",
                managedChildAuthorization: parent?.managedChildAuthorization?.prompt,
              }),
              () =>
                Effect.gen(function* () {
                  children.push(input.sessionID)
                  expect(yield* jobs.get(input.sessionID)).toBeUndefined()
                  const child = yield* sessions.get(input.sessionID)
                  expect(child.parentID).toBe(chat.id)
                  expect(child.workspaceID).toBe(chat.workspaceID)
                  expect(child.directory).toBe(chat.directory)
                  const selected = yield* agents.get(input.agent ?? "reviewer")
                  const policies = yield* sessions.managedPolicies(child.id)
                  if (children.length <= 2)
                    expect(
                      policies.every((policy) => Permission.evaluate("bash", "echo ok", policy).action === "allow"),
                    ).toBe(true)
                  expect(
                    policies.some((policy) => Permission.evaluate("bash", "rm file", policy).action === "deny"),
                  ).toBe(true)
                  expect(
                    Permission.evaluate(
                      "task",
                      "verifier",
                      Permission.merge(selected?.permission ?? [], child.permission ?? []),
                    ).action,
                  ).toBe("allow")
                  yield* runtime.complete(input.sessionID)
                  return reply(input, `${input.agent} complete`)
                }),
              (admitted) => runtime.release(input.sessionID, admitted.fence),
            ).pipe(Effect.orDie),
        }
        const execute = (name: string, background?: boolean, task_id?: string) =>
          tool.execute(
            {
              description: `${name} review`,
              prompt: "Review without detaching",
              subagent_type: name,
              background,
              task_id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              callID: `call-${name}`,
              managedRuntime: runtime,
              executionFence: parent.fence,
              extra: { promptOps: ops },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
        expect(yield* execute("reviewer", true).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
        expect(children).toHaveLength(0)
        expect(yield* execute("build").pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
        const results = yield* Effect.all([execute("reviewer"), execute("verifier")], { concurrency: "unbounded" })
        expect(results.map((result) => result.output)).toEqual([
          expect.stringContaining("reviewer complete"),
          expect.stringContaining("verifier complete"),
        ])
        expect(children).toHaveLength(2)
        expect(new Set(children).size).toBe(2)
        const firstChild = SessionID.make(results[0]!.metadata.sessionId)
        const reviewer = yield* agents.get("reviewer")
        if (!reviewer) throw new Error("Missing reviewer")
        const general = yield* agents.get("general")
        if (!general) throw new Error("Missing general agent")
        yield* sessions.setPermission({
          sessionID: firstChild,
          permission: [{ permission: "edit", pattern: "*", action: "allow" }],
        })
        const before = yield* sessions.get(firstChild)
        const ancestry = yield* sessions.managedPolicies(firstChild)
        expect(before.agent).toBe("reviewer")
        expect(Permission.evaluate("edit", "file", reviewer.permission).action).toBe("allow")
        expect(ManagedAccess.readOnly(general.name, [general.permission, before.permission ?? [], ...ancestry])).toBe(
          false,
        )
        expect(ManagedAccess.readOnly(reviewer.name, [reviewer.permission, before.permission ?? [], ...ancestry])).toBe(
          true,
        )
        expect(
          ManagedAccess.readOnly("general", [
            Permission.fromConfig({ edit: "deny" }),
            Permission.fromConfig({ edit: "allow" }),
          ]),
        ).toBe(true)
        const switched = yield* execute("general", false, firstChild).pipe(Effect.exit)
        expect(Exit.isFailure(switched)).toBe(true)
        if (Exit.isFailure(switched)) expect(Cause.pretty(switched.cause)).toContain("different agent")
        expect(children).toHaveLength(2)
        expect(yield* sessions.get(firstChild)).toEqual(before)
        expect(yield* sessions.managedPolicies(firstChild)).toEqual(ancestry)
        yield* sessions.setPermission({
          sessionID: chat.id,
          permission: [{ permission: "bash", pattern: "echo *", action: "deny" }],
        })
        yield* execute("reviewer", false, firstChild)
        const resumed = yield* sessions.get(firstChild)
        expect(resumed.agent).toBe("reviewer")
        expect(ManagedAccess.readOnly(reviewer.name, [reviewer.permission, resumed.permission ?? []])).toBe(true)
        const policies = yield* sessions.managedPolicies(firstChild)
        expect(policies.some((policy) => Permission.evaluate("bash", "echo unsafe", policy).action === "deny")).toBe(
          true,
        )
        // Managed reuse is valid only for an explicitly reserved child, never an old root.
        expect(yield* execute("reviewer", false, chat.id).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
        yield* runtime.complete(chat.id)
        yield* runtime.release(chat.id, parent.fence)
        expect(yield* runtime.commandStatus(chat.id)).toBe("drained")
        expect(yield* ManagedCommand.status(database, chat.id)).toBe("drained")
      }),
    {
      config: {
        agent: {
          build: { permission: { bash: { "*": "deny", "echo *": "allow", "rm *": "deny" }, task: "deny" } },
          reviewer: { mode: "subagent", permission: { bash: { "*": "allow", "echo secret": "deny" }, task: "allow" } },
          verifier: { mode: "subagent", permission: { bash: { "*": "allow", "echo secret": "deny" }, task: "allow" } },
        },
      },
    },
  )

  for (const concurrentCancel of [false, true]) {
    it.instance(
      `managed interruption joins the child's cleanup before returning (${concurrentCancel ? "already cancelling" : "active"})`,
      () =>
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
          const database = yield* Database.Service
          const { chat, assistant } = yield* seed()
          const runtime = RuntimeLifecycle.make(
            { lineage: "managed-task-interrupt-test" },
            yield* Effect.scope,
            database,
          )
          const parent = yield* runtime.admit({ sessionID: chat.id, directory: chat.directory })
          const started = yield* Deferred.make<void>()
          const cleaning = yield* Deferred.make<void>()
          const joined = yield* Deferred.make<void>()
          const reserved = yield* Deferred.make<void>()
          const proceed = yield* Deferred.make<void>()
          const parentCancelling = yield* Deferred.make<void>()
          const tool = yield* TaskTool.pipe(Effect.flatMap((tool) => tool.init()))
          let cancelled = 0
          const runners = yield* SessionRunState.Service
          const ops: TaskPromptOps = {
            ...stubOps(),
            cancel: (sessionID) =>
              Effect.gen(function* () {
                cancelled++
                if (cancelled === (concurrentCancel ? 2 : 1)) yield* Deferred.succeed(parentCancelling, undefined)
                yield* Effect.acquireUseRelease(
                  runtime.cancel(sessionID),
                  () => runners.cancel(sessionID),
                  (owner) => (owner ? runtime.finishCancel(sessionID) : Effect.void),
                )
              }),
            prompt: (input, parent) =>
              Effect.acquireUseRelease(
                runtime.admit({
                  sessionID: input.sessionID,
                  directory: chat.directory,
                  parentSessionID: chat.id,
                  parentMode: "foreground",
                  managedChildAuthorization: parent?.managedChildAuthorization?.prompt,
                }),
                () =>
                  runners.enqueue(
                    input.sessionID,
                    Effect.succeed(reply(input, "idle")),
                    Effect.acquireUseRelease(
                      runtime
                        .admit({
                          sessionID: input.sessionID,
                          directory: chat.directory,
                          parentSessionID: chat.id,
                          managedChildAuthorization: parent?.managedChildAuthorization?.runner,
                        })
                        .pipe(Effect.orDie),
                      () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
                      (admitted) =>
                        Effect.gen(function* () {
                          yield* Deferred.succeed(cleaning, undefined)
                          yield* Deferred.await(joined)
                          yield* runtime.complete(input.sessionID)
                          yield* runtime.release(input.sessionID, admitted.fence)
                        }),
                    ),
                  ),
                (admitted) => runtime.release(input.sessionID, admitted.fence),
              ).pipe(Effect.orDie),
          }
          const abort = new AbortController()
          const task = yield* tool
            .execute(
              { description: "Review", prompt: "Review", subagent_type: "general" },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: abort.signal,
                callID: "call-review",
                managedRuntime: runtime,
                executionFence: parent.fence,
                extra: { promptOps: ops },
                messages: [],
                metadata: () => Deferred.succeed(reserved, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
                ask: () => Effect.void,
              },
            )
            .pipe(Effect.forkScoped)
          yield* Deferred.await(reserved)
          const sessions = yield* Session.Service
          const child = (yield* sessions.children(chat.id))[0]
          if (!child) throw new Error("Missing owned managed child")
          const competingAbort = new AbortController()
          const resume = () =>
            tool.execute(
              { description: "Concurrent review", prompt: "Resume", subagent_type: "general", task_id: child.id },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: competingAbort.signal,
                callID: "competing-review",
                managedRuntime: runtime,
                executionFence: parent.fence,
                extra: { promptOps: ops },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
          expect(yield* resume().pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
          expect(yield* Deferred.isDone(started)).toBe(false)
          yield* Deferred.succeed(proceed, undefined)
          yield* Deferred.await(started)
          expect(yield* resume().pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
          competingAbort.abort()
          expect(cancelled).toBe(0)
          expect(yield* Deferred.isDone(cleaning)).toBe(false)
          expect(task.pollUnsafe()).toBeUndefined()
          const firstCancel = concurrentCancel ? yield* ops.cancel(child.id).pipe(Effect.forkScoped) : undefined
          if (firstCancel) yield* Deferred.await(cleaning)
          yield* Effect.gen(function* () {
            abort.abort()
            yield* Deferred.await(parentCancelling)
            yield* Deferred.await(cleaning)
            yield* Effect.yieldNow
            expect(cancelled).toBe(concurrentCancel ? 2 : 1)
            expect(task.pollUnsafe()).toBeUndefined()
            // The claim remains exclusive until the original child's cleanup has joined.
            expect(yield* resume().pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
            expect(cancelled).toBe(concurrentCancel ? 2 : 1)
            if (firstCancel) expect(firstCancel.pollUnsafe()).toBeUndefined()
            expect(yield* runtime.commandStatus(chat.id)).toBe("draining")
          }).pipe(Effect.ensuring(Deferred.succeed(joined, undefined)))
          expect(yield* Fiber.await(task)).toMatchObject({ _tag: "Failure" })
          if (firstCancel) yield* Fiber.join(firstCancel)
          expect(cancelled).toBe(concurrentCancel ? 2 : 1)
          yield* runtime.authorizeChild(child.id, chat.id, parent.fence).pipe(Effect.scoped)
          yield* runtime.complete(chat.id)
          yield* runtime.release(chat.id, parent.fence)
          expect(yield* runtime.commandStatus(chat.id)).toBe("drained")
        }),
    )
  }

  it.instance("managed abort fences a paused admission before cancelling the instance runner", () =>
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
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const runners = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const runtime = RuntimeLifecycle.make({ lineage: "paused-child-admission" }, yield* Effect.scope, database)
      const parent = yield* runtime.admit({ sessionID: chat.id, directory: chat.directory })
      const entered = yield* Deferred.make<SessionID>()
      const admit = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const joined = yield* Deferred.make<void>()
      const events: string[] = []
      let providerCalls = 0
      const ops: TaskPromptOps = {
        ...stubOps(),
        cancel: (sessionID) =>
          Effect.gen(function* () {
            events.push("cancel")
            yield* Effect.acquireUseRelease(
              runtime.cancel(sessionID),
              () => runners.cancel(sessionID),
              (owner) => (owner ? runtime.finishCancel(sessionID) : Effect.void),
            )
          }),
        prompt: (input, task) =>
          Effect.acquireUseRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, input.sessionID)
              yield* Deferred.await(admit)
              events.push("admit")
              return yield* runtime.admit({
                sessionID: input.sessionID,
                directory: chat.directory,
                parentSessionID: chat.id,
                managedChildAuthorization: task?.managedChildAuthorization?.prompt,
              })
            }),
            () =>
              runners.enqueue(
                input.sessionID,
                Effect.succeed(reply(input, "idle")),
                Effect.gen(function* () {
                  providerCalls++
                  return reply(input, "late provider could launch bash")
                }),
              ),
            (owner) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(cleaning, undefined)
                yield* Deferred.await(joined)
                yield* runtime.release(input.sessionID, owner.fence)
                events.push("caller-joined")
              }),
          ).pipe(Effect.orDie),
      }
      const tool = yield* TaskTool.pipe(Effect.flatMap((tool) => tool.init()))
      const abort = new AbortController()
      const task = yield* tool
        .execute(
          { description: "Review", prompt: "Review", subagent_type: "general" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            callID: "paused-review",
            managedRuntime: runtime,
            executionFence: parent.fence,
            extra: { promptOps: ops },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkScoped)
      const child = yield* Deferred.await(entered)
      abort.abort()
      expect(
        yield* runtime.authorizeChild(child, chat.id, parent.fence).pipe(Effect.scoped, Effect.flip),
      ).toMatchObject({ message: "Managed child already has a foreground Task owner" })
      yield* Deferred.succeed(admit, undefined)
      yield* Deferred.await(cleaning)
      expect(task.pollUnsafe()).toBeUndefined()
      expect(providerCalls).toBe(0)
      expect(events).toEqual(["admit"])
      expect(
        yield* runtime.authorizeChild(child, chat.id, parent.fence).pipe(Effect.scoped, Effect.flip),
      ).toMatchObject({ message: "Managed child already has a foreground Task owner" })
      yield* Deferred.succeed(joined, undefined)
      expect(yield* Fiber.await(task)).toMatchObject({ _tag: "Failure" })
      expect(events).toEqual(["admit", "caller-joined", "cancel"])
      expect(providerCalls).toBe(0)
      yield* runtime.authorizeChild(child, chat.id, parent.fence).pipe(Effect.scoped)
      yield* runtime.release(chat.id, parent.fence)
      expect(yield* runtime.commandStatus(chat.id)).toBe("drained")
      expect(yield* sessions.messages({ sessionID: child })).toEqual([])
    }),
  )

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("rejects a task_id owned by another parent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const otherParent = yield* sessions.create({ title: "Other parent" })
      const child = yield* sessions.create({ parentID: otherParent.id, title: "Foreign child" })
      const otherDirectory = yield* tmpdirScoped({ git: true })
      const foreignChild = yield* sessions
        .create({ parentID: otherParent.id, title: "Foreign child in another directory" })
        .pipe(provideInstance(otherDirectory))
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let promptCalls = 0
      const ctx = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps({ onPrompt: () => promptCalls++ }) },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const exits = yield* Effect.forEach([child, foreignChild], (session) =>
        def
          .execute(
            {
              description: "resume foreign task",
              prompt: "write a relative file",
              subagent_type: "general",
              task_id: session.id,
            },
            ctx,
          )
          .pipe(Effect.exit),
      )

      expect(exits.every((exit) => Exit.isFailure(exit))).toBe(true)
      expect(promptCalls).toBe(0)
      expect((yield* sessions.get(child.id)).parentID).toBe(otherParent.id)
      expect((yield* sessions.get(foreignChild.id)).directory).toBe(otherDirectory)
    }),
  )

  it.instance(
    "runs a subagent relative patch inside the parent worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const directory = path.join(path.dirname(test.directory), `task-isolation-${crypto.randomUUID()}`)
        const runGit = (args: string[]) => {
          const result = Bun.spawnSync(["git", ...args], { cwd: test.directory })
          if (result.exitCode !== 0) throw new Error(result.stderr.toString())
          return result.stdout.toString()
        }

        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            runGit(["worktree", "add", "--detach", directory, "HEAD"])
            return directory
          }),
          (worktree) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const { chat, assistant } = yield* seed().pipe(provideInstance(worktree))
              const info = yield* ApplyPatchTool
              const patch = yield* info.init()
              const tool = yield* TaskTool
              const def = yield* tool.init()
              const promptOps = stubOps({
                onPromptEffect: (input) =>
                  patch
                    .execute(
                      {
                        patchText: "*** Begin Patch\n*** Add File: subagent-relative.txt\n+child\n*** End Patch",
                      },
                      {
                        sessionID: input.sessionID,
                        messageID: input.messageID ?? MessageID.ascending(),
                        callID: "task-tool",
                        agent: "general",
                        abort: new AbortController().signal,
                        messages: [],
                        metadata: () => Effect.void,
                        ask: () => Effect.void,
                      },
                    )
                    .pipe(Effect.asVoid),
              })
              const result = yield* def
                .execute(
                  {
                    description: "write in worktree",
                    prompt: "create a relative file",
                    subagent_type: "general",
                  },
                  {
                    sessionID: chat.id,
                    messageID: assistant.id,
                    agent: "build",
                    abort: new AbortController().signal,
                    extra: { promptOps },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  },
                )
                .pipe(provideInstance(worktree))

              expect(
                (yield* sessions.get(SessionID.make(result.metadata.sessionId)).pipe(provideInstance(worktree)))
                  .directory,
              ).toBe(worktree)
              expect(yield* Effect.promise(() => Bun.file(path.join(worktree, "subagent-relative.txt")).text())).toBe(
                "child\n",
              )
              expect(
                yield* Effect.promise(() => Bun.file(path.join(test.directory, "subagent-relative.txt")).exists()),
              ).toBe(false)
              expect(runGit(["status", "--porcelain=v1", "--untracked-files=all"]).trim()).toBe("")
            }),
          (worktree) =>
            Effect.sync(() => {
              runGit(["worktree", "remove", "--force", worktree])
            }),
        )
      }),
    { git: true },
  )

  it.instance("execute surfaces child errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "",
                error: new SessionV1.APIError({ message: "Network connection lost", isRetryable: false }).toObject(),
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      expect(child).toBeDefined()
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(`Subagent failed (task_id: ${child?.id}): Network connection lost`)
    }),
  )

  it.instance("execute surfaces terminal child tool errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect external directory",
            prompt: "read the external directory",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "I will inspect the directory.",
                toolError: "The user rejected permission to use this specific tool call.",
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(
        `Subagent failed (task_id: ${child?.id}): The user rejected permission to use this specific tool call.`,
      )
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})
