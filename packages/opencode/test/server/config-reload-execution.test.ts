import { NodeHttpServer } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Fiber, Layer, Option, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import path from "node:path"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { BackgroundJob } from "../../src/background/job"
import { Config } from "../../src/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { withInstanceActivity } from "../../src/effect/instance-registry"
import { Installation } from "../../src/installation"
import { MCP } from "../../src/mcp"
import { Plugin } from "../../src/plugin"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { GlobalProjectList } from "../../src/server/global-project-list"
import { GlobalApi } from "../../src/server/routes/instance/httpapi/groups/global"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { Authorization, authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import {
  SchemaErrorMiddleware,
  schemaErrorLayer,
} from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session/session"
import { AccountTest } from "../fake/account"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const titleGate = Context.Reference<{ entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined>(
  "@test/ConfigReloadTitleGate",
  { defaultValue: () => undefined },
)

const databaseLayer = Database.layerFromPath(":memory:")
const services = LayerNode.compile(
  LayerNode.group([
    SessionPrompt.node,
    Session.node,
    SessionProjector.node,
    BackgroundJob.node,
    Config.node,
    InstanceStore.node,
    MCP.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Database.node,
    LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
  ]),
  [
    [Database.node, databaseLayer],
    [Auth.node, Layer.mock(Auth.Service)({ all: () => Effect.succeed({}), get: () => Effect.succeed(undefined) })],
    [Account.node, AccountTest.empty],
    [Npm.node, Layer.mock(Npm.Service)({ install: () => Effect.void })],
    [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
    [
      Plugin.node,
      Layer.mock(Plugin.Service)({
        list: () => Effect.succeed([]),
        trigger: (name, input, output) =>
          Effect.gen(function* () {
            const gate = yield* titleGate
            if (
              gate &&
              name === "chat.params" &&
              typeof input === "object" &&
              input &&
              "agent" in input &&
              input.agent === "title"
            ) {
              yield* Deferred.succeed(gate.entered, undefined)
              yield* Deferred.await(gate.release)
            }
            return output
          }),
      }),
    ],
  ],
)

const runtimeLayer = Layer.effect(
  RuntimeLifecycle.Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const database = yield* Database.Service
    const previous = RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable()
    const runtime = RuntimeLifecycle.make({ lineage: "config-reload-execution-test" }, scope, database)
    RuntimeLifecycle.setCurrent(runtime)
    yield* Effect.addFinalizer(() => Effect.sync(() => RuntimeLifecycle.setCurrent(previous)))
    return runtime
  }),
).pipe(Layer.provide(databaseLayer))

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(
    HttpApi.make("opencode-root").addHttpApi(GlobalApi).middleware(SchemaErrorMiddleware).middleware(Authorization),
  ).pipe(
    Layer.provide(globalHandlers),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Match the root API boundary without an instance request activity lease.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services.pipe(Layer.provideMerge(runtimeLayer))),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(Layer.mock(GlobalProjectList.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)

const it = testEffect(apiLayer)

const fixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const store = yield* InstanceStore.Service
  const directory = yield* tmpdirScoped({
    git: true,
    config: {
      ...testProviderConfig(llm.url),
      model: "test/test-model",
      username: "before-reload",
      snapshot: false,
      compaction: { auto: false, prune: false },
    },
  })
  const ctx = yield* store.load({ directory })
  yield* Effect.addFinalizer(() => store.dispose(ctx))
  return ctx
})

const changeConfig = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die("missing test instance")
  const fs = yield* FSUtil.Service
  const file = path.join(ctx.directory, "opencode.json")
  const info = yield* fs.readJson(file)
  if (!info || typeof info !== "object") return yield* Effect.die("invalid test config")
  yield* fs.writeJson(file, { ...info, username: "after-reload" })
})

const reload = (status: 200 | 409) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute, (effect) =>
      awaitWithTimeout(effect, "reload did not respond", "5 seconds"),
    )
    expect(response.status).toBe(status)
    expect(yield* response.json).toEqual(status === 200 ? true : expect.objectContaining({ kind: "busy" }))
  })

for (const execution of ["provider", "tool"] as const) {
  it.live(`reload rejects actual foreground ${execution} execution without aborting or retrying it`, () =>
    Effect.gen(function* () {
      const ctx = yield* fixture
      yield* Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const runtime = yield* RuntimeLifecycle.Service
        const database = yield* Database.Service
        const config = yield* Config.Service
        const fs = yield* FSUtil.Service
        const release = Promise.withResolvers<void>()
        const ready = path.join(ctx.directory, "tool-ready")
        const unblock = path.join(ctx.directory, "tool-release")
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => release.resolve()).pipe(
            Effect.andThen(fs.writeFileString(unblock, "release")),
            Effect.orDie,
          ),
        )
        const chat = yield* sessions.create({
          title: "Reload execution probe",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        if (execution === "provider") yield* llm.hold("provider survived reload", release.promise)
        if (execution === "tool") {
          yield* llm.tool("bash", {
            command: `printf ready > '${ready}'; while [ ! -f '${unblock}' ]; do sleep 0.02; done; printf 'tool survived reload'`,
          })
          yield* llm.text("tool execution completed")
        }
        const running = yield* prompt
          .prompt({ sessionID: chat.id, parts: [{ type: "text", text: `Run the ${execution} reload probe` }] })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          Effect.raceFirst(
            llm.wait(1),
            Fiber.join(running).pipe(
              Effect.flatMap((result) => Effect.die(`prompt exited before provider: ${JSON.stringify(result)}`)),
            ),
          ),
          "prompt never reached the provider",
          "10 seconds",
        )
        if (execution === "tool")
          yield* pollWithTimeout(
            fs.exists(ready).pipe(Effect.map((exists) => (exists ? true : undefined))),
            "bash tool never started",
          )
        const user = (yield* sessions.messages({ sessionID: chat.id })).filter(
          (message) => message.info.role === "user",
        )
        expect(user).toHaveLength(1)
        expect((yield* runtime.status()).active).toBe(1)
        const owner = yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${chat.id}`)
        expect(owner).toMatchObject({ state: "active", desired_active: 1, retry_at: null })
        expect((yield* config.get()).username).toBe("before-reload")
        yield* changeConfig
        yield* reload(409)
        expect((yield* config.get()).username).toBe("before-reload")
        expect(yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${chat.id}`)).toEqual(
          owner,
        )
        expect(
          (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "user"),
        ).toEqual(user)
        release.resolve()
        yield* fs.writeFileString(unblock, "release")
        const result = yield* awaitWithTimeout(
          Fiber.join(running),
          "prompt did not complete after release",
          "10 seconds",
        )
        expect(result.info).toMatchObject({ role: "assistant", finish: "stop" })
        expect(result.info).not.toHaveProperty("error")
        const history = yield* sessions.messages({ sessionID: chat.id })
        expect(history.filter((message) => message.info.role === "user")).toEqual(user)
        expect(history.flatMap((message) => message.parts).filter((part) => part.type === "text")).toContainEqual(
          expect.objectContaining({
            text: execution === "provider" ? "provider survived reload" : "tool execution completed",
          }),
        )
        if (execution === "tool")
          expect(history.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toEqual([
            expect.objectContaining({
              tool: "bash",
              state: expect.objectContaining({ status: "completed", output: "tool survived reload" }),
            }),
          ])
        expect(yield* llm.calls).toBe(execution === "provider" ? 1 : 2)
        expect((yield* runtime.status()).active).toBe(0)
        yield* reload(200)
        expect((yield* config.get()).username).toBe("after-reload")
        expect(yield* sessions.messages({ sessionID: chat.id })).toEqual(history)
      }).pipe(Effect.provideService(InstanceRef, ctx))
    }),
  )
}

it.live("reload rejects escaped title generation after foreground runtime ownership has released", () =>
  Effect.gen(function* () {
    const ctx = yield* fixture
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    yield* Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runtime = yield* RuntimeLifecycle.Service
      const config = yield* Config.Service
      const chat = yield* sessions.create()
      yield* llm.text("foreground complete")
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        parts: [{ type: "text", text: "Generate a conversation title while testing reload" }],
      })
      expect(result.info).toMatchObject({ role: "assistant", finish: "stop" })
      yield* awaitWithTimeout(Deferred.await(entered), "title generation did not start")
      expect((yield* runtime.status()).active).toBe(0)
      expect((yield* config.get()).username).toBe("before-reload")
      yield* changeConfig
      yield* reload(409)
      expect((yield* config.get()).username).toBe("before-reload")
      expect((yield* sessions.get(chat.id)).title).toBe(chat.title)
      yield* Deferred.succeed(release, undefined)
      yield* pollWithTimeout(
        sessions.get(chat.id).pipe(Effect.map((info) => (info.title === "E2E Title" ? true : undefined))),
        "escaped title generation did not finish",
      )
      yield* reload(200)
      expect((yield* config.get()).username).toBe("after-reload")
      expect(yield* llm.calls).toBe(2)
    }).pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(titleGate, { entered, release }))
  }),
)

for (const execution of ["start", "extend"] as const) {
  it.live(`reload rejects an escaped background ${execution} without cancelling or replacing its registry entry`, () =>
    Effect.gen(function* () {
      const ctx = yield* fixture
      yield* Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const config = yield* Config.Service
        const runtime = yield* RuntimeLifecycle.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const first = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        yield* Effect.addFinalizer(() => Deferred.succeed(first, undefined))
        const run = Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return "background survived reload"
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
        const job = yield* jobs
          .start({
            type: "reload-probe",
            title: "Independent background work",
            metadata: { preserved: true },
            run: execution === "start" ? run : Deferred.await(first).pipe(Effect.as("first")),
          })
          .pipe(withInstanceActivity)
        if (execution === "extend") {
          expect(yield* jobs.extend({ id: job.id, run }).pipe(withInstanceActivity)).toBe(true)
          yield* Deferred.succeed(first, undefined)
        }
        yield* awaitWithTimeout(Deferred.await(entered), "background job did not enter its work")
        expect((yield* runtime.status()).active).toBe(0)
        expect((yield* config.get()).username).toBe("before-reload")
        yield* changeConfig
        yield* reload(409)
        expect(yield* jobs.get(job.id)).toEqual(job)
        expect(yield* jobs.list()).toEqual([job])
        expect(yield* Deferred.isDone(interrupted)).toBe(false)
        expect((yield* config.get()).username).toBe("before-reload")
        yield* Deferred.succeed(release, undefined)
        const completed = yield* awaitWithTimeout(jobs.wait({ id: job.id }), "background job did not complete")
        expect(completed).toMatchObject({
          timedOut: false,
          info: { status: "completed", output: "background survived reload", metadata: { preserved: true } },
        })
        yield* reload(200)
        expect((yield* config.get()).username).toBe("after-reload")
        expect(yield* jobs.get(job.id)).toEqual(completed.info)
        expect(yield* Deferred.isDone(interrupted)).toBe(false)
      }).pipe(Effect.provideService(InstanceRef, ctx))
    }),
  )
}

it.live("reload waits for a promotion callback even after the background run has completed", () =>
  Effect.gen(function* () {
    const ctx = yield* fixture
    yield* Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const config = yield* Config.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined))
      const job = yield* jobs.start({
        type: "reload-promotion",
        run: Deferred.await(finish).pipe(Effect.as("completed")),
        onPromote: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      })
      const promoting = yield* jobs.promote(job.id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(entered), "promotion callback did not start")
      yield* Deferred.succeed(finish, undefined)
      const completed = yield* awaitWithTimeout(jobs.wait({ id: job.id }), "background run did not complete")
      expect(completed.info).toMatchObject({ status: "completed", metadata: { background: true } })
      expect((yield* config.get()).username).toBe("before-reload")
      yield* changeConfig
      yield* reload(409)
      expect(yield* jobs.get(job.id)).toEqual(completed.info)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(promoting)
      yield* reload(200)
      expect((yield* config.get()).username).toBe("after-reload")
    }).pipe(Effect.provideService(InstanceRef, ctx))
  }),
)
