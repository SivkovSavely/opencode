import { expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { Context, Effect, Fiber, Layer } from "effect"
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
import { SessionControl } from "@/session/control"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { registerAdapter } from "@/control-plane/adapters"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, LayerNode.compile(CrossSpawnSpawner.node)))
const fixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const directory = yield* tmpdirScoped({
    git: true,
    config: { ...testProviderConfig(llm.url), model: "test/test-model" },
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
  const database = Context.get(context, Database.Service)
  runtime.bindDatabase(database)
  return {
    llm,
    directory,
    runtime,
    context,
    database,
    store: Context.get(context, InstanceStore.Service),
    agents: Context.get(context, Agent.Service),
  }
})

const control = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const registry = yield* ToolRegistry.Service
  const prompt = yield* SessionPrompt.Service
  const queue = yield* SessionQueue.Service
  const caller = yield* sessions.create({ title: "controller" })
  const tool = (yield* registry.all()).find((tool) => tool.id === "session_control")
  if (!tool) throw new Error("session_control is not registered")
  const permissions: string[] = []
  const ctx: Tool.Context = {
    sessionID: caller.id,
    messageID: MessageID.ascending(),
    callID: randomUUID(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    extra: { sessionControlOps: prompt },
    ask: (request) =>
      Effect.sync(() => {
        permissions.push(request.permission)
      }),
  }
  return { sessions, prompt, queue, caller, tool, ctx, permissions }
})

it.live("native create produces one independent root on exact retries without copying caller grants", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const registry = yield* ToolRegistry.Service
        const prompt = yield* SessionPrompt.Service
        const caller = yield* sessions.create({
          title: "controller",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const tool = (yield* registry.all()).find((tool) => tool.id === "session_control")
        expect(tool).toBeDefined()
        if (!tool) throw new Error("session_control is not registered")
        const permissions: string[] = []
        const ctx: Tool.Context = {
          sessionID: caller.id,
          messageID: MessageID.ascending(),
          callID: randomUUID(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          extra: { sessionControlOps: prompt },
          ask: (request) =>
            Effect.sync(() => {
              permissions.push(request.permission)
            }),
        }
        const params = { action: "create", title: "independent", requestID: "one-root" }
        const first = JSON.parse((yield* tool.execute(params, ctx)).output)
        const retry = JSON.parse((yield* tool.execute(params, { ...ctx, callID: randomUUID() })).output)
        expect(retry.sessionID).toBe(first.sessionID)
        const created = yield* sessions.get(SessionID.make(first.sessionID))
        expect(created.parentID).toBeUndefined()
        expect(created.permission).toBeUndefined()
        expect(created.directory).toBe(f.directory)
        expect(permissions).toContain("session_control")
        expect(yield* f.llm.calls).toBe(0)
        expect((yield* Effect.exit(tool.execute({ ...params, title: "conflict" }, ctx)))._tag).toBe("Failure")
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("execution-targeted cancellation cannot mutate a later generation", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "cancel target" })
        const old = yield* f.runtime.admit({ sessionID: session.id, directory: f.directory })
        yield* f.runtime.release(session.id, old.fence)
        const current = yield* f.runtime.admit({ sessionID: session.id, directory: f.directory })
        const cancelled = yield* f.runtime.cancel(session.id, {
          ownerLineage: f.runtime.identity.lineage,
          ownerInstance: f.runtime.identity.instance,
          fence: old.fence,
        })
        expect(cancelled).toBe(false)
        expect(yield* f.runtime.beforeTurn(session.id)).toBe(true)
        yield* f.runtime.release(session.id, current.fence)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("create-and-start returns after admission and survives controller completion and cancellation", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const gate = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
    yield* f.llm.hold("independent result", gate.promise)
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        const params = { action: "create", title: "independent", prompt: "keep working", requestID: "start-one" }
        const out = JSON.parse(
          (yield* awaitWithTimeout(c.tool.execute(params, c.ctx), "create waited for execution")).output,
        )
        const id = SessionID.make(out.sessionID)
        yield* awaitWithTimeout(f.llm.wait(1), "independent session did not start")
        const callerRun = yield* f.runtime.admit({ sessionID: c.caller.id, directory: f.directory })
        yield* f.runtime.release(c.caller.id, callerRun.fence)
        yield* c.prompt.cancel(c.caller.id)
        expect(yield* f.runtime.beforeTurn(id)).toBe(true)
        const retry = JSON.parse((yield* c.tool.execute(params, c.ctx)).output)
        expect(retry.sessionID).toBe(id)
        gate.resolve()
        yield* awaitWithTimeout(f.runtime.waitForIdle(id), "independent execution never finished")
        expect(
          (yield* c.sessions.messages({ sessionID: id })).filter((item) => item.info.role === "user"),
        ).toHaveLength(1)
        expect(yield* f.llm.calls).toBe(1)
        const status = JSON.parse((yield* c.tool.execute({ action: "status", sessionID: id }, c.ctx)).output)
        expect(status).toMatchObject({ sessionID: id, execution: { result: "completed", state: "terminal" } })
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("cross-directory creation and prompts use the target configuration with fresh authorization", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const provider = testProviderConfig(f.llm.url)
    const other = yield* tmpdirScoped({
      git: true,
      config: {
        ...provider,
        model: "test/external-model",
        provider: {
          test: {
            ...provider.provider.test,
            models: { "external-model": { ...provider.provider.test.models["test-model"], id: "external-model" } },
          },
        },
        agent: { external: { mode: "primary", model: "test/external-model", prompt: "external directory" } },
      },
    })
    yield* f.llm.text("external response")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        const denied = yield* Effect.exit(
          c.tool.execute(
            { action: "create", directory: other, title: "denied" },
            {
              ...c.ctx,
              ask: (request) =>
                request.permission === "external_directory" ? Effect.die(new Error("denied")) : Effect.void,
            },
          ),
        )
        expect(denied._tag).toBe("Failure")
        expect(yield* f.database.db.all(sql`SELECT id FROM session WHERE directory = ${other}`)).toHaveLength(0)
        const out = JSON.parse(
          (yield* c.tool.execute(
            { action: "create", directory: other, title: "external", agent: "external", requestID: "external" },
            c.ctx,
          )).output,
        )
        const id = SessionID.make(out.sessionID)
        expect(yield* c.sessions.get(id)).toMatchObject({ directory: other, agent: "external" })
        expect(c.permissions).toContain("external_directory")
        expect(
          (yield* Effect.exit(
            c.tool.execute(
              { action: "prompt", sessionID: id, prompt: "check" },
              {
                ...c.ctx,
                ask: () => Effect.die(new Error("denied")),
              },
            ),
          ))._tag,
        ).toBe("Failure")
        yield* c.tool.execute({ action: "prompt", sessionID: id, prompt: "check", requestID: "external-prompt" }, c.ctx)
        yield* awaitWithTimeout(f.runtime.waitForIdle(id), "external prompt did not finish")
        const message = (yield* c.sessions.messages({ sessionID: id })).find((item) => item.info.role === "user")
        expect(message?.info).toMatchObject({
          agent: "external",
          model: { providerID: "test", modelID: "external-model" },
        })
        expect((yield* c.sessions.get(id)).directory).toBe(other)
        expect(yield* f.llm.calls).toBe(1)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

for (const reply of ["once", "reject"] as const) {
  it.live(
    `cross-directory creation can be ${reply === "once" ? "approved" : "rejected"} from the caller's permission scope`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const other = yield* tmpdirScoped({ git: true, config: testProviderConfig(f.llm.url) })
        const target = yield* f.store.load({ directory: other })
        yield* f.store.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const c = yield* control
            const permission = yield* Permission.Service
            const pattern = `create:${target.project.id}:${target.directory}:local`
            const execution = yield* c.tool
              .execute(
                { action: "create", directory: other, title: "approval target", requestID: "permission-scope" },
                {
                  ...c.ctx,
                  ask: (request) =>
                    permission
                      .ask({
                        ...request,
                        sessionID: c.caller.id,
                        tool: { messageID: c.ctx.messageID, callID: c.ctx.callID ?? "control" },
                        ruleset: [
                          { permission: "*", pattern: "*", action: "allow" },
                          { permission: "session_control", pattern, action: "ask" },
                        ],
                      })
                      .pipe(Effect.orDie),
                },
              )
              .pipe(Effect.exit, Effect.forkScoped)
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const callerPending = yield* permission.list()
                const targetPending = yield* f.store.provide({ directory: other }, permission.list())
                return callerPending.length + targetPending.length > 0 ? true : undefined
              }),
              "creation never requested its final approval",
            )
            const pending = yield* permission.list()
            expect(pending).toHaveLength(1)
            expect(yield* f.store.provide({ directory: other }, permission.list())).toHaveLength(0)
            expect(yield* f.database.db.all(sql`SELECT id FROM session WHERE directory = ${other}`)).toHaveLength(0)
            const request = pending[0]
            if (!request) throw new Error("Creation approval is not visible from its caller")
            expect(request).toMatchObject({
              sessionID: c.caller.id,
              permission: "session_control",
              patterns: [pattern],
              metadata: { action: "create", directory: other, projectID: target.project.id },
            })
            yield* permission.reply({ requestID: request.id, reply })
            const result = yield* awaitWithTimeout(Fiber.join(execution), "caller-scope reply did not settle creation")
            expect(result._tag).toBe(reply === "once" ? "Success" : "Failure")
            expect(yield* f.database.db.all(sql`SELECT id FROM session WHERE directory = ${other}`)).toHaveLength(
              reply === "once" ? 1 : 0,
            )
            expect(yield* permission.list()).toHaveLength(0)
            expect(yield* f.store.provide({ directory: other }, permission.list())).toHaveLength(0)
          }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
        )
      }),
  )
}

it.live("concurrent exact prompt retries admit one input and steering uses the busy runner's next boundary", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const gate = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
    yield* f.llm.hold("first response", gate.promise)
    yield* f.llm.text("steered response")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        const target = yield* c.sessions.create({ title: "concurrent" })
        const params = { action: "prompt", sessionID: target.id, prompt: "initial", requestID: "concurrent" }
        yield* awaitWithTimeout(
          Effect.all([c.tool.execute(params, c.ctx), c.tool.execute(params, c.ctx)], { concurrency: "unbounded" }),
          "prompt admission waited",
        )
        yield* awaitWithTimeout(f.llm.wait(1), "prompt did not start")
        const steer = { action: "steer", sessionID: target.id, prompt: "new direction", requestID: "steer-once" }
        yield* awaitWithTimeout(c.tool.execute(steer, c.ctx), "steering waited for the active provider")
        yield* c.tool.execute(steer, c.ctx)
        expect(yield* f.llm.calls).toBe(1)
        gate.resolve()
        yield* awaitWithTimeout(f.runtime.waitForIdle(target.id), "steered session did not finish")
        expect(yield* f.llm.calls).toBe(2)
        expect(
          (yield* c.sessions.messages({ sessionID: target.id })).filter((item) => item.info.role === "user"),
        ).toHaveLength(2)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("native cancel retains pending work and an exact retry cannot cancel a replacement execution", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        first.resolve()
        second.resolve()
      }),
    )
    yield* f.llm.hold("cancelled response", first.promise)
    yield* f.llm.hold("replacement response", second.promise)
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        const target = yield* c.sessions.create({ title: "cancel target" })
        yield* c.tool.execute({ action: "prompt", sessionID: target.id, prompt: "first", requestID: "first" }, c.ctx)
        yield* awaitWithTimeout(f.llm.wait(1), "first execution did not start")
        yield* c.tool.execute(
          { action: "prompt", sessionID: target.id, prompt: "pending", requestID: "pending" },
          c.ctx,
        )
        const cancel = { action: "cancel", sessionID: target.id, requestID: "cancel-first" }
        yield* awaitWithTimeout(c.tool.execute(cancel, c.ctx), "cancellation did not join")
        expect((yield* c.queue.list(target.id)).items).toHaveLength(1)
        expect((yield* c.queue.list(target.id)).blocked).toBe(true)
        // The normal explicit user resume controls the barrier, not session_control.
        yield* c.prompt.queueResume(target.id)
        yield* awaitWithTimeout(f.llm.wait(2), "replacement execution did not start")
        yield* c.tool.execute(cancel, c.ctx)
        expect(yield* f.runtime.beforeTurn(target.id)).toBe(true)
        expect((yield* c.queue.list(target.id)).blocked).toBe(false)
        second.resolve()
        yield* awaitWithTimeout(f.runtime.waitForIdle(target.id), "replacement did not finish")
        expect((yield* c.sessions.get(target.id)).id).toBe(target.id)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("history previews are bounded and pagination cursors cannot name a different session", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        const target = yield* c.sessions.create({ title: "history" })
        const ids = [MessageID.ascending(), MessageID.ascending(), MessageID.ascending()]
        for (const [index, id] of ids.entries()) {
          yield* c.sessions.updateMessage({
            id,
            sessionID: target.id,
            role: "user",
            time: { created: index + 1 },
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          })
          yield* c.sessions.updatePart({
            id: PartID.ascending(),
            messageID: id,
            sessionID: target.id,
            type: "text",
            text: "large".repeat(20000),
          })
        }
        const page = JSON.parse(
          (yield* c.tool.execute({ action: "read", sessionID: target.id, limit: 2 }, c.ctx)).output,
        )
        expect(page.items).toHaveLength(2)
        expect(page.items[0].parts[0].text.length).toBe(2000)
        expect(page.more).toBe(true)
        const older = JSON.parse(
          (yield* c.tool.execute({ action: "read", sessionID: target.id, before: page.next }, c.ctx)).output,
        )
        expect(older.items).toHaveLength(1)
        expect(new Set([...page.items, ...older.items].map((item) => item.id)).size).toBe(3)
        expect(
          (yield* Effect.exit(c.tool.execute({ action: "read", sessionID: c.caller.id, before: ids[0] }, c.ctx)))._tag,
        ).toBe("Failure")
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("create with start false retains its initial prompt without executing it", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        const out = JSON.parse(
          (yield* c.tool.execute({ action: "create", title: "admit only", prompt: "later", start: false }, c.ctx))
            .output,
        )
        expect((yield* c.queue.list(SessionID.make(out.sessionID))).items).toHaveLength(1)
        yield* SessionControl.engine({ ...f, prompt: c.prompt, queue: c.queue }).tick
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("reconstructed control replay wakes committed input once without bypassing paused or revoked grants", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.llm.text("replayed input")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        const target = yield* c.sessions.create({ title: "replay" })
        yield* c.queue.update(target.id, {
          revision: (yield* c.queue.list(target.id)).revision,
          mutation: { action: "pause", paused: true },
        })
        yield* c.tool.execute({ action: "prompt", sessionID: target.id, prompt: "durable", requestID: "replay" }, c.ctx)
        yield* SessionControl.engine({ ...f, prompt: c.prompt, queue: c.queue }).tick
        expect(yield* f.llm.calls).toBe(0)
        yield* c.queue.update(target.id, {
          revision: (yield* c.queue.list(target.id)).revision,
          mutation: { action: "pause", paused: false },
        })
        const replay = SessionControl.engine({ ...f, prompt: c.prompt, queue: c.queue })
        yield* replay.tick
        yield* awaitWithTimeout(f.runtime.waitForIdle(target.id), "committed input did not replay")
        yield* replay.tick
        yield* SessionControl.engine({ ...f, prompt: c.prompt, queue: c.queue }).tick
        expect(yield* f.llm.calls).toBe(1)
        expect(
          (yield* c.sessions.messages({ sessionID: target.id })).filter((message) => message.info.role === "user"),
        ).toHaveLength(1)
        const revoked = yield* c.sessions.create({ title: "revoked replay" })
        yield* c.queue.update(revoked.id, {
          revision: (yield* c.queue.list(revoked.id)).revision,
          mutation: { action: "pause", paused: true },
        })
        yield* c.tool.execute(
          { action: "prompt", sessionID: revoked.id, prompt: "do not wake", requestID: "revoked" },
          c.ctx,
        )
        yield* c.sessions.setPermission({
          sessionID: c.caller.id,
          permission: [{ permission: "session_control", pattern: "*", action: "deny" }],
        })
        yield* c.queue.update(revoked.id, {
          revision: (yield* c.queue.list(revoked.id)).revision,
          mutation: { action: "pause", paused: false },
        })
        yield* SessionControl.engine({ ...f, prompt: c.prompt, queue: c.queue }).tick
        expect((yield* c.queue.list(revoked.id)).items).toHaveLength(1)
        expect(yield* f.llm.calls).toBe(1)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("native control rejects remote placement instead of executing a local mirror", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        const target = yield* c.sessions.create({ title: "remote mirror" })
        const workspaceID = WorkspaceV2.ID.make(`wrk_${randomUUID()}`)
        registerAdapter(target.projectID, "control-remote-test", {
          name: "Remote control fixture",
          description: "Never execute the local mirror",
          configure: (info) => info,
          create: async () => {},
          remove: async () => {},
          target: () => ({ type: "remote", url: "http://127.0.0.1:1" }),
        })
        yield* f.database.db.insert(WorkspaceTable).values({
          id: workspaceID,
          type: "control-remote-test",
          project_id: target.projectID,
          directory: f.directory,
        })
        yield* c.sessions.setWorkspace({ sessionID: target.id, workspaceID })
        const result = yield* Effect.exit(
          c.tool.execute({ action: "prompt", sessionID: target.id, prompt: "remote" }, c.ctx),
        )
        expect(result._tag).toBe("Failure")
        expect(
          yield* f.database.db.all(sql`SELECT id FROM session_queue WHERE session_id = ${target.id}`),
        ).toHaveLength(0)
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("text admission preserves the destination's selected model and variant", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const config = testProviderConfig(f.llm.url)
    const directory = yield* tmpdirScoped({
      git: true,
      config: {
        ...config,
        model: "test/test-model",
        provider: {
          test: {
            ...config.provider.test,
            models: {
              ...config.provider.test.models,
              selected: { ...config.provider.test.models["test-model"], id: "selected", variants: { deep: {} } },
            },
          },
        },
        agent: { build: { model: "test/selected" } },
      },
    })
    yield* f.store.provide(
      { directory },
      Effect.gen(function* () {
        const c = yield* control
        const target = yield* c.sessions.create({
          title: "selection",
          model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("selected"), variant: "deep" },
        })
        expect(yield* c.prompt.textPayload(target.id, "normal selection")).toMatchObject({
          model: { providerID: "test", modelID: "selected" },
          variant: "deep",
        })
        const created = JSON.parse(
          (yield* c.tool.execute({ action: "create", title: "agent selection", variant: "deep" }, c.ctx)).output,
        )
        expect((yield* c.sessions.get(SessionID.make(created.sessionID))).model).toMatchObject({
          id: "selected",
          variant: "deep",
        })
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("a model-issued session_control call creates an independent root through the normal tool context", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.llm.tool("session_control", { action: "create", title: "model-created root", requestID: "from-model" })
    yield* f.llm.text("Root created")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        yield* c.sessions.setPermission({
          sessionID: c.caller.id,
          permission: [{ permission: "session_control", pattern: "*", action: "allow" }],
        })
        yield* awaitWithTimeout(
          c.prompt.prompt({ sessionID: c.caller.id, parts: [{ type: "text", text: "Create another root" }] }),
          "native tool did not finish",
          "5 seconds",
        )
        const messages = yield* c.sessions.messages({ sessionID: c.caller.id })
        const part = messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "session_control")
        expect(part).toMatchObject({ type: "tool", state: { status: "completed" } })
        if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Native control tool failed")
        const created = yield* c.sessions.get(SessionID.make(JSON.parse(part.state.output).sessionID))
        expect(created.title).toBe("model-created root")
        expect(created.parentID).toBeUndefined()
        expect(created.permission).toBeUndefined()
        expect(yield* f.llm.calls).toBe(2)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("native prompts retain recovery-held input while steering cannot override the recovery barrier", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const c = yield* control
        const target = yield* c.sessions.create({ title: "recovery-held control" })
        const run = yield* f.runtime.admit({ sessionID: target.id, directory: f.directory })
        yield* f.runtime.park(target.id)
        yield* f.runtime.release(target.id, run.fence)
        yield* c.tool.execute(
          { action: "prompt", sessionID: target.id, prompt: "wait for recovery", requestID: "held" },
          c.ctx,
        )
        const steer = yield* Effect.exit(
          c.tool.execute(
            { action: "steer", sessionID: target.id, prompt: "cannot bypass", requestID: "held-steer" },
            c.ctx,
          ),
        )
        expect(steer._tag).toBe("Failure")
        expect((yield* c.queue.list(target.id)).items).toHaveLength(1)
        expect(
          (yield* c.sessions.messages({ sessionID: target.id })).filter((message) => message.info.role === "user"),
        ).toHaveLength(0)
        yield* SessionControl.engine({ ...f, prompt: c.prompt, queue: c.queue }).tick
        expect(yield* f.runtime.isParked(target.id)).toBe(true)
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)
