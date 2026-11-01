// A separate process preserves the adapter's import-time, operator-only environment snapshot.
import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionTools } from "@/session/tools"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "@/permission"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import type { RuntimeLifecycle } from "@/server/runtime-lifecycle"

const requests: string[] = []
const permits: number[] = []
const approval = { denied: false }
const policy = JSON.parse(process.env.OPENCODE_MANAGED_WORK_QUEUE!)
const sessionID = SessionID.make("ses_managed_workqueue")
const agent: Agent.Info = {
  name: "review",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}
const input = {
  agent,
  model: { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model,
  session: { id: sessionID, directory: policy.directory, permission: [] } as unknown as Session.Info,
  processor: {
    message: { id: MessageID.ascending(), modelID: ModelV2.ID.make("test-model") },
    updateToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
  } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
  bypassAgentCheck: false,
  messages: [],
  promptOps: {} as never,
  executionFence: 42,
  managedRuntime: {
    runManagedCommand: (id, prepare, fence, options) =>
      Effect.promise(async () => {
        assert.equal(id, sessionID)
        assert.equal(fence, 42)
        assert.deepEqual(options, { preparation: "process-free" })
        permits.push(fence!)
        const handle = await prepare(async (open) => {
          open()
          return true
        })
        return handle.start()
      }),
  } satisfies Pick<RuntimeLifecycle.Interface, "runManagedCommand">,
}

await Effect.runPromise(
  Effect.gen(function* () {
    const tools = yield* SessionTools.resolve(input)
    assert.deepEqual(Object.keys(tools).sort(), ["wq_ping", "wq_update_progress"])
    const hidden = yield* SessionTools.resolve({
      ...input,
      session: {
        ...input.session,
        permission: [{ permission: "wq_update_progress", pattern: "*", action: "deny" }],
      },
    })
    assert.deepEqual(Object.keys(hidden), ["wq_ping"])
    const denied = yield* SessionTools.resolve({
      ...input,
      agent: { ...agent, permission: [{ permission: "wq_*", pattern: "*", action: "deny" }] },
    })
    assert.deepEqual(Object.keys(denied), [])
    const options = { toolCallId: "call-workqueue", messages: [], abortSignal: new AbortController().signal }
    const execute = tools.wq_update_progress.execute
    assert.ok(execute)
    approval.denied = true
    const rejection = yield* Effect.promise(() => Promise.resolve(execute({ issueId: "BAILA-1" }, options))).pipe(
      Effect.exit,
    )
    assert.equal(rejection._tag, "Failure")
    assert.deepEqual(permits, [])
    approval.denied = false
    const result = yield* Effect.promise(() => Promise.resolve(execute({ issueId: "BAILA-1" }, options)))
    assert.deepEqual(result, {
      title: "wq_update_progress",
      output: "bounded output",
      metadata: {
        project: "BAILA",
        cleanup: "confirmed",
        isError: false,
        truncated: true,
        outputPath: "output.txt",
      },
    })
    assert.deepEqual(permits, [42])
    assert.deepEqual(requests, ["wq_update_progress", "wq_update_progress"])
    yield* Effect.promise(async () => {
      await fetch(new URL("/test/hold-metadata", policy.url))
      const before = new AbortController()
      const cancelled = Promise.resolve(execute({ issueId: "BAILA-2" }, { ...options, abortSignal: before.signal }))
      await fetch(new URL("/test/listed", policy.url))
      before.abort()
      const settled = { value: false }
      void cancelled.then(() => {
        settled.value = true
      })
      await Promise.resolve()
      assert.equal(settled.value, false)
      await fetch(new URL("/test/release-metadata", policy.url))
      const noOperation = await cancelled
      assert.ok(noOperation && typeof noOperation === "object" && "metadata" in noOperation)
      assert.deepEqual(noOperation.metadata, {
        project: "BAILA",
        cleanup: "confirmed",
        isError: true,
        truncated: true,
        outputPath: "output.txt",
      })
      const after = new AbortController()
      const joined = Promise.resolve(execute({ issueId: "BAILA-3" }, { ...options, abortSignal: after.signal }))
      await fetch(new URL("/test/called", policy.url))
      after.abort()
      settled.value = false
      void joined.then(() => {
        settled.value = true
      })
      await Promise.resolve()
      assert.equal(settled.value, false)
      await fetch(new URL("/test/release-response", policy.url))
      assert.deepEqual(await joined, result)
      assert.deepEqual(permits, [42, 42, 42])
      assert.deepEqual(requests, Array(4).fill("wq_update_progress"))
    })
    const missing = yield* SessionTools.resolve({ ...input, managedRuntime: undefined }).pipe(Effect.exit)
    assert.equal(missing._tag, "Failure")
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Session.Service, { get: () => Effect.succeed(input.session) }),
        Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([]) }),
        Layer.mock(MCP.Service, {}),
        Layer.mock(Plugin.Service, { trigger: () => Effect.die("managed WorkQueue must not invoke plugins") }),
        Layer.mock(Permission.Service, {
          ask: (request) => {
            requests.push(request.permission)
            assert.equal(request.sessionID, sessionID)
            assert.deepEqual(request.ruleset, agent.permission)
            return approval.denied ? Effect.die("permission denied") : Effect.void
          },
        }),
        Layer.mock(Truncate.Service, {
          output: (text) => {
            assert.ok(text === "completed" || text === "WorkQueue cancelled before dispatch")
            return Effect.succeed({ content: "bounded output", truncated: true, outputPath: "output.txt" })
          },
        }),
        RuntimeFlags.layer(),
      ),
    ),
  ),
)
console.log("managed WorkQueue wrapper passed")
