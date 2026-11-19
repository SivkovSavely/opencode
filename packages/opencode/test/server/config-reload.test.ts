import { NodeHttpServer } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Queue, Scope, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Account } from "../../src/account/account"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { withInstanceActivity } from "../../src/effect/instance-registry"
import { InstanceState } from "../../src/effect/instance-state"
import { Installation } from "../../src/installation"
import { MCP } from "../../src/mcp"
import { Plugin } from "../../src/plugin"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceStore } from "../../src/project/instance-store"
import { Provider } from "../../src/provider/provider"
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
import { ServerScheduler } from "../../src/server/scheduler"
import { SessionQueue } from "../../src/session/queue"
import { SessionSchedule } from "../../src/session/schedule"
import { SessionID } from "../../src/session/schema"
import { Skill } from "../../src/skill"
import { AccountTest } from "../fake/account"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const databaseLayer = Database.layerFromPath(":memory:")
const services = LayerNode.compile(
  LayerNode.group([
    Config.node,
    InstanceStore.node,
    CrossSpawnSpawner.node,
    FSUtil.node,
    Database.node,
    Agent.node,
    Provider.node,
    Skill.node,
    Command.node,
    MCP.node,
    SessionQueue.node,
    SessionSchedule.node,
  ]),
  [
    [Auth.node, Layer.mock(Auth.Service)({ all: () => Effect.succeed({}), get: () => Effect.succeed(undefined) })],
    [Account.node, AccountTest.empty],
    [Npm.node, Layer.mock(Npm.Service)({ install: () => Effect.void })],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected HTTP request")),
      ),
    ],
    [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
    [Database.node, databaseLayer],
    [
      Plugin.node,
      Layer.mock(Plugin.Service)({
        list: () => Effect.succeed([]),
        trigger: (_name, _input, output) => Effect.succeed(output),
      }),
    ],
  ],
)

const runtimeLayer = Layer.effect(
  RuntimeLifecycle.Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const database = yield* Database.Service
    return RuntimeLifecycle.make({ lineage: "config-reload-test" }, scope, database)
  }),
).pipe(Layer.provide(databaseLayer))

const apiLayer = (password?: string) =>
  HttpRouter.serve(
    HttpApiBuilder.layer(
      HttpApi.make("opencode-root").addHttpApi(GlobalApi).middleware(SchemaErrorMiddleware).middleware(Authorization),
    ).pipe(
      Layer.provide(globalHandlers),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      // Raw SSE routes intentionally receive their request-level context at the boundary.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(services.pipe(Layer.provideMerge(runtimeLayer))),
    Layer.provide(Layer.mock(Installation.Service)({})),
    Layer.provide(Layer.mock(GlobalProjectList.Service)({})),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.fromUndefinedOr(password), username: "opencode" })),
  )

const it = testEffect(apiLayer())

test("reload contract advertises the event and each typed error status", () => {
  const spec = OpenApi.fromApi(GlobalApi)
  expect(spec.paths["/global/config/reload"]?.post?.responses).toMatchObject({
    "200": expect.any(Object),
    "400": expect.any(Object),
    "409": expect.any(Object),
    "500": expect.any(Object),
  })
  expect(spec.components.schemas["Event.config.reloaded"]).toMatchObject({
    properties: { type: { enum: ["config.reloaded"] } },
    required: ["id", "type", "properties"],
  })
})

const globalFile = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const files = ["config.json", "opencode.json", "opencode.jsonc", "config"].map((name) =>
    path.join(Global.Path.config, name),
  )
  const previous = yield* Effect.forEach(files, (file) => fs.readFileStringSafe(file))
  yield* Effect.addFinalizer(() =>
    Effect.forEach(files, (file, index) =>
      previous[index] === undefined ? fs.remove(file, { force: true }) : fs.writeWithDirs(file, previous[index]),
    ).pipe(Effect.orDie),
  )
  yield* Effect.forEach(files, (file) => fs.remove(file, { force: true }))
  const file = path.join(Global.Path.config, "opencode.json")
  yield* fs.writeWithDirs(file, JSON.stringify({ model: "reload/old" }))
  return file
})

const events = Effect.acquireRelease(
  Effect.sync(() => {
    const values: GlobalEvent[] = []
    const listener = (event: GlobalEvent) => values.push(event)
    GlobalBus.on("event", listener)
    return { values, listener }
  }),
  ({ listener }) =>
    Effect.sync(() => {
      GlobalBus.off("event", listener)
    }),
).pipe(Effect.map((value) => value.values))

const seedHistory = Effect.fnUntraced(function* (ctx: InstanceContext) {
  const database = yield* Database.Service
  const id = SessionID.descending()
  yield* database.db
    .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (${id}, ${ctx.project.id}, ${id}, ${ctx.directory}, 'Preserved history', '1', 1, 1)`)
  yield* database.db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (${`${id}-message`}, ${id}, 1, 1, '{"role":"user","agent":"build"}')`)
  yield* database.db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (${`${id}-part`}, ${`${id}-message`}, ${id}, 1, 1, '{"type":"text","text":"Keep this conversation"}')`)
  return id
})

const history = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      session: yield* database.db.get(sql`SELECT * FROM session WHERE id = ${id}`),
      messages: yield* database.db.all(sql`SELECT * FROM message WHERE session_id = ${id} ORDER BY id`),
      parts: yield* database.db.all(sql`SELECT * FROM part WHERE session_id = ${id} ORDER BY id`),
    }
  })

const writeProject = (directory: string, name: string, version: string) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* fs.writeJson(path.join(directory, "opencode.json"), { model: `reload/${name}-${version}` })
    yield* fs.writeWithDirs(
      path.join(directory, ".opencode", "agent", "reload.md"),
      `---\ndescription: ${name}-${version}\nmode: primary\n---\n${name} ${version} agent`,
    )
    yield* fs.writeWithDirs(
      path.join(directory, ".opencode", "command", "reload-command.md"),
      `---\ndescription: ${name}-${version}\n---\n${name} ${version} command`,
    )
    yield* fs.writeWithDirs(
      path.join(directory, ".opencode", "skill", "reload-skill", "SKILL.md"),
      `---\nname: reload-skill\ndescription: ${name}-${version}\n---\n${name} ${version} skill`,
    )
  })

const readCaches = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agent = yield* Agent.Service
    const provider = yield* Provider.Service
    const skill = yield* Skill.Service
    const command = yield* Command.Service
    const info = yield* config.get()
    yield* config.waitForDependencies()
    return {
      config: info,
      agent: yield* agent.get("reload"),
      provider: (yield* provider.list())[ProviderV2.ID.make("reload")],
      skill: yield* skill.get("reload-skill"),
      command: yield* command.get("reload-command"),
    }
  }).pipe(Effect.provideService(InstanceRef, ctx))

it.live("POST /global/config/reload refreshes cached global configuration", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const observed = yield* events
    const stream = yield* HttpClientRequest.get("/global/event").pipe(HttpClient.execute)
    const received = yield* Queue.unbounded<string>()
    yield* stream.stream.pipe(
      Stream.decodeText,
      Stream.pipeThroughChannel(Sse.decode()),
      Stream.runForEach((event) => Queue.offer(received, event.data)),
      Effect.forkScoped,
    )
    expect(JSON.parse(yield* awaitWithTimeout(Queue.take(received), "global SSE did not connect"))).toMatchObject({
      payload: { type: "server.connected" },
    })
    expect((yield* config.getGlobal()).model).toBe("reload/old")
    yield* fs.writeJson(file, { model: "reload/new" })
    const response = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
    expect(response.status).toBe(200)
    expect(yield* response.json).toBe(true)
    expect((yield* config.getGlobal()).model).toBe("reload/new")
    expect(observed).toEqual([
      { directory: "global", payload: { id: expect.any(String), type: "config.reloaded", properties: {} } },
    ])
    expect(
      JSON.parse(yield* awaitWithTimeout(Queue.take(received), "reload was not delivered to the connected SSE client")),
    ).toEqual(observed[0])
  }),
)

it.live("reload rebuilds real caches for every loaded project without replacing contexts or session history", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const store = yield* InstanceStore.Service
    yield* fs.writeJson(file, {
      shell: "old-shell",
      provider: {
        reload: {
          name: "Old provider",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "fixture-key" },
          models: { model: { name: "Old model" } },
        },
      },
    })
    const directories = yield* Effect.forEach(["one", "two"], (name) =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        yield* writeProject(directory, name, "old")
        return yield* store.load({ directory })
      }),
    )
    const previous = yield* Effect.forEach(directories, readCaches)
    expect(
      previous.map((value) => [
        value.config.model,
        value.agent?.description,
        value.provider?.name,
        value.skill?.description,
        value.command?.template,
      ]),
    ).toEqual([
      ["reload/one-old", "one-old", "Old provider", "one-old", "one old command"],
      ["reload/two-old", "two-old", "Old provider", "two-old", "two old command"],
    ])
    const session = yield* seedHistory(directories[0])
    const persisted = yield* history(session)
    const observed = yield* events
    yield* fs.writeJson(file, {
      shell: "new-shell",
      provider: {
        reload: {
          name: "New provider",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "fixture-key" },
          models: { model: { name: "New model" } },
        },
      },
    })
    yield* Effect.forEach(directories, (ctx, index) => writeProject(ctx.directory, index === 0 ? "one" : "two", "new"))
    const response = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
    expect([response.status, yield* response.json]).toEqual([200, true])
    const next = yield* Effect.forEach(directories, readCaches)
    expect(
      next.map((value) => [
        value.config.model,
        value.config.shell,
        value.agent?.description,
        value.provider?.name,
        value.skill?.description,
        value.command?.template,
      ]),
    ).toEqual([
      ["reload/one-new", "new-shell", "one-new", "New provider", "one-new", "one new command"],
      ["reload/two-new", "new-shell", "two-new", "New provider", "two-new", "two new command"],
    ])
    expect(yield* history(session)).toEqual(persisted)
    expect(yield* store.list()).toEqual(directories)
    expect(yield* store.load({ directory: directories[0].directory })).toBe(directories[0])
    expect(observed.filter((event) => event.payload.type === "config.reloaded")).toEqual([
      { directory: "global", payload: { id: expect.any(String), type: "config.reloaded", properties: {} } },
    ])
    expect(observed.some((event) => event.payload.type.endsWith("disposed"))).toBe(false)
  }),
)

it.live("reload adds, modifies and removes cached markdown definitions and provider models, options and variants", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const store = yield* InstanceStore.Service
    const provider = yield* Provider.Service
    const command = yield* Command.Service
    const directory = yield* tmpdirScoped({ git: true })
    yield* fs.writeJson(file, {})
    const ctx = yield* store.load({ directory })
    const empty = yield* readCaches(ctx)
    expect([empty.agent, empty.provider, empty.command, empty.skill]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])

    yield* writeProject(directory, "definitions", "old")
    yield* fs.writeJson(file, {
      provider: {
        reload: {
          name: "Old provider",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "old-key", baseURL: "https://old.example.invalid/v1", timeout: 1000 },
          models: {
            model: {
              name: "Old model",
              options: { temperature: 0.1, removedOption: true },
              variants: {
                tuned: { reasoningEffort: "low", removedOption: true },
                removed: { reasoningEffort: "high" },
              },
            },
            removed: { name: "Removed model" },
          },
        },
        "reload-removed": {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "removed-key" },
          models: { model: { name: "Removed provider model" } },
        },
      },
    })
    expect(yield* readCaches(ctx)).toEqual(empty)
    const created = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
    expect([created.status, yield* created.json]).toEqual([200, true])
    const added = yield* readCaches(ctx)
    expect(added.agent).toMatchObject({
      description: "definitions-old",
      mode: "primary",
      prompt: "definitions old agent",
    })
    expect(added.command).toMatchObject({ description: "definitions-old", template: "definitions old command" })
    expect(added.skill).toMatchObject({ description: "definitions-old", content: "definitions old skill" })
    expect(added.provider).toMatchObject({ name: "Old provider" })
    expect(added.provider.options).toEqual({
      apiKey: "old-key",
      baseURL: "https://old.example.invalid/v1",
      timeout: 1000,
    })
    expect(added.provider.models.model).toMatchObject({ name: "Old model" })
    expect(added.provider.models.model.options).toEqual({ temperature: 0.1, removedOption: true })
    expect(added.provider.models.model.variants).toEqual({
      tuned: { reasoningEffort: "low", removedOption: true },
      removed: { reasoningEffort: "high" },
    })
    expect(added.provider.models.removed).toMatchObject({ name: "Removed model" })
    expect(
      (yield* provider.list().pipe(Effect.provideService(InstanceRef, ctx)))[ProviderV2.ID.make("reload-removed")],
    ).toMatchObject({ models: { model: { name: "Removed provider model" } } })
    expect(
      (yield* command.list().pipe(Effect.provideService(InstanceRef, ctx))).find(
        (item) => item.name === "reload-skill",
      ),
    ).toMatchObject({
      source: "skill",
      description: "definitions-old",
      template: expect.stringContaining("definitions old skill"),
    })

    yield* writeProject(directory, "definitions", "new")
    yield* fs.writeJson(file, {
      provider: {
        reload: {
          name: "New provider",
          npm: "@ai-sdk/openai-compatible",
          options: {
            apiKey: "new-key",
            baseURL: "https://new.example.invalid/v1",
            headers: { "X-Reload": "new" },
          },
          models: {
            model: {
              name: "New model",
              options: { temperature: 0.7, addedOption: true },
              variants: {
                tuned: { reasoningEffort: "medium" },
                added: { reasoningEffort: "high", addedOption: true },
              },
            },
            added: { name: "Added model", options: { temperature: 0.3 } },
          },
        },
      },
    })
    const retained = yield* readCaches(ctx)
    expect(retained.agent).toBe(added.agent)
    expect(retained.provider).toBe(added.provider)
    expect(retained.command).toBe(added.command)
    expect(retained.skill).toBe(added.skill)
    const modified = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
    expect([modified.status, yield* modified.json]).toEqual([200, true])
    const next = yield* readCaches(ctx)
    expect(next.agent).toMatchObject({
      description: "definitions-new",
      mode: "primary",
      prompt: "definitions new agent",
    })
    expect(next.command).toMatchObject({ description: "definitions-new", template: "definitions new command" })
    expect(next.skill).toMatchObject({ description: "definitions-new", content: "definitions new skill" })
    expect(next.provider).toMatchObject({ name: "New provider" })
    expect(next.provider.options).toEqual({
      apiKey: "new-key",
      baseURL: "https://new.example.invalid/v1",
      headers: { "X-Reload": "new" },
    })
    expect(next.provider.models.model).toMatchObject({ name: "New model" })
    expect(next.provider.models.model.options).toEqual({ temperature: 0.7, addedOption: true })
    expect(next.provider.models.model.variants).toEqual({
      tuned: { reasoningEffort: "medium" },
      added: { reasoningEffort: "high", addedOption: true },
    })
    expect(next.provider.models.added).toMatchObject({ name: "Added model", options: { temperature: 0.3 } })
    expect(next.provider.models.removed).toBeUndefined()
    expect(
      (yield* provider.list().pipe(Effect.provideService(InstanceRef, ctx)))[ProviderV2.ID.make("reload-removed")],
    ).toBeUndefined()
    expect(
      (yield* command.list().pipe(Effect.provideService(InstanceRef, ctx))).find(
        (item) => item.name === "reload-skill",
      ),
    ).toMatchObject({
      source: "skill",
      description: "definitions-new",
      template: expect.stringContaining("definitions new skill"),
    })

    yield* Effect.forEach(
      [
        path.join(directory, ".opencode", "agent", "reload.md"),
        path.join(directory, ".opencode", "command", "reload-command.md"),
        path.join(directory, ".opencode", "skill", "reload-skill", "SKILL.md"),
      ],
      (source) => fs.remove(source),
    )
    yield* fs.writeJson(file, {})
    yield* fs.writeJson(path.join(directory, "opencode.json"), {})
    const deleted = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
    expect([deleted.status, yield* deleted.json]).toEqual([200, true])
    const removed = yield* readCaches(ctx)
    expect([removed.agent, removed.provider, removed.command, removed.skill]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(
      (yield* command.list().pipe(Effect.provideService(InstanceRef, ctx))).some(
        (item) => item.name === "reload-skill",
      ),
    ).toBe(false)
  }),
)

for (const invalid of [
  {
    name: "global JSON syntax",
    scope: "global",
    text: '{"provider":{"reload":{"options":{"apiKey":"reload-private-secret"}}},',
    field: undefined,
  },
  {
    name: "global provider schema",
    scope: "global",
    text: JSON.stringify({ provider: { reload: { npm: 42, options: { apiKey: "reload-private-secret" } } } }),
    field: "provider.reload.npm",
  },
  {
    name: "compatibility agent schema",
    scope: "global",
    text: JSON.stringify({ agents: { reload: { steps: "reload-private-secret" } } }),
    field: "agents.reload",
  },
  { name: "project JSON syntax", scope: "project", text: '{"model":"reload-private-secret",', field: undefined },
  {
    name: "agent frontmatter",
    scope: "agent",
    text: "---\ndescription: [reload-private-secret\n---\nPrompt",
    field: undefined,
  },
  {
    name: "skill frontmatter",
    scope: "skill",
    text: "---\nname: [reload-private-secret\n---\nSkill",
    field: undefined,
  },
  {
    name: "skill schema",
    scope: "skill",
    text: "---\nname: reload-skill\ndescription: [reload-private-secret]\n---\nSkill",
    field: undefined,
  },
]) {
  it.live(
    `invalid ${invalid.name} returns sanitized diagnostics and preserves all cached projects until correction`,
    () =>
      Effect.gen(function* () {
        const file = yield* globalFile
        const fs = yield* FSUtil.Service
        const config = yield* Config.Service
        const store = yield* InstanceStore.Service
        const one = yield* tmpdirScoped({ git: true })
        const two = yield* tmpdirScoped({ git: true })
        yield* writeProject(one, "one", "old")
        yield* writeProject(two, "two", "old")
        const contexts = yield* Effect.forEach([one, two], (directory) => store.load({ directory }))
        const previous = yield* Effect.forEach(contexts, readCaches)
        const global = yield* config.getGlobal()
        const observed = yield* events
        yield* writeProject(one, "one", "new")
        yield* writeProject(two, "two", "new")
        const source =
          invalid.scope === "global"
            ? file
            : invalid.scope === "project"
              ? path.join(two, "opencode.json")
              : invalid.scope === "skill"
                ? path.join(two, ".opencode", "skill", "reload-skill", "SKILL.md")
                : path.join(two, ".opencode", "agent", "reload.md")
        yield* fs.writeFileString(source, invalid.text)
        const response = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
        expect(response.status).toBe(400)
        const text = yield* response.text
        expect(text).not.toContain("reload-private-secret")
        expect(JSON.parse(text)).toMatchObject({
          _tag: "ConfigReloadError",
          kind: "invalid",
          message: expect.stringContaining(source),
        })
        if (invalid.field) expect(text).toContain(invalid.field)
        expect(yield* config.getGlobal()).toBe(global)
        const retained = yield* Effect.forEach(contexts, readCaches)
        for (const [index, value] of retained.entries()) {
          expect(value.config).toBe(previous[index].config)
          expect(value.agent).toBe(previous[index].agent)
          expect(value.provider).toBe(previous[index].provider)
          expect(value.skill).toBe(previous[index].skill)
          expect(value.command).toBe(previous[index].command)
        }
        expect(
          observed.some((event) => event.payload.type === "config.reloaded" || event.payload.type.endsWith("disposed")),
        ).toBe(false)
        yield* fs.writeJson(file, { model: "reload/new" })
        yield* writeProject(two, "two", "new")
        const corrected = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
        expect([corrected.status, yield* corrected.json]).toEqual([200, true])
        expect((yield* Effect.forEach(contexts, readCaches)).map((value) => value.config.model)).toEqual([
          "reload/one-new",
          "reload/two-new",
        ])
        expect(observed.filter((event) => event.payload.type === "config.reloaded")).toHaveLength(1)
      }),
  )
}

it.live("failed PATCH staging preserves caches and an identical retry publishes after correction", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const store = yield* InstanceStore.Service
    const directory = yield* tmpdirScoped({ git: true })
    const ctx = yield* store.load({ directory })
    const previous = yield* config.get().pipe(Effect.provideService(InstanceRef, ctx))
    const global = yield* config.getGlobal()
    const observed = yield* events
    yield* fs.writeFileString(path.join(directory, "opencode.json"), '{"reload-private-secret":')
    const response = yield* HttpClientRequest.patch("/global/config").pipe(
      HttpClientRequest.bodyJsonUnsafe({ shell: "patched-shell" }),
      HttpClient.execute,
    )
    expect(response.status).toBe(400)
    expect(yield* response.text).not.toContain("reload-private-secret")
    expect(yield* config.getGlobal()).toBe(global)
    expect(yield* config.get().pipe(Effect.provideService(InstanceRef, ctx))).toBe(previous)
    expect(
      observed.some((event) => event.payload.type === "config.reloaded" || event.payload.type.endsWith("disposed")),
    ).toBe(false)
    yield* fs.writeJson(path.join(directory, "opencode.json"), {})
    const corrected = yield* HttpClientRequest.patch("/global/config").pipe(
      HttpClientRequest.bodyJsonUnsafe({ shell: "patched-shell" }),
      HttpClient.execute,
    )
    expect(corrected.status).toBe(200)
    expect(yield* corrected.json).toMatchObject({ shell: "patched-shell" })
    expect(yield* config.getGlobal()).toMatchObject({ shell: "patched-shell" })
    expect(yield* config.get().pipe(Effect.provideService(InstanceRef, ctx))).toMatchObject({
      model: "reload/old",
      shell: "patched-shell",
    })
    expect(yield* fs.readJson(file)).toMatchObject({ shell: "patched-shell" })
    expect(observed.filter((event) => event.payload.type === "config.reloaded")).toHaveLength(1)
  }),
)

for (const state of ["active", "retry_wait", "released-slot"] as const) {
  it.live(`reload and PATCH reject ${state} ownership without mutating files, runtime or history`, () =>
    Effect.gen(function* () {
      const file = yield* globalFile
      const fs = yield* FSUtil.Service
      const config = yield* Config.Service
      const runtime = yield* RuntimeLifecycle.Service
      const store = yield* InstanceStore.Service
      const database = yield* Database.Service
      const directory = yield* tmpdirScoped({ git: true })
      const ctx = yield* store.load({ directory })
      const id = yield* seedHistory(ctx)
      const admission = yield* runtime.admit({ sessionID: id, directory })
      if (state === "retry_wait") yield* runtime.retry(id, Date.now() + 60_000)
      if (state === "released-slot") {
        yield* runtime.admit({ sessionID: id, directory })
        yield* runtime.release(id, admission.fence)
      }
      const before = yield* history(id)
      const execution = yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${id}`)
      const status = yield* runtime.status()
      const original = yield* config.getGlobal()
      const text = yield* fs.readFileString(file)
      const observed = yield* events
      for (const request of [
        HttpClientRequest.post("/global/config/reload"),
        HttpClientRequest.patch("/global/config").pipe(HttpClientRequest.bodyJsonUnsafe({ model: "reload/patch" })),
      ]) {
        const response = yield* request.pipe(HttpClient.execute)
        expect(response.status).toBe(409)
        expect(yield* response.json).toMatchObject({ _tag: "ConfigReloadError", kind: "busy" })
      }
      expect(yield* fs.readFileString(file)).toBe(text)
      expect(yield* config.getGlobal()).toBe(original)
      expect(yield* history(id)).toEqual(before)
      expect(yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${id}`)).toEqual(execution)
      expect(yield* runtime.status()).toEqual(status)
      expect(observed).toEqual([])
      yield* runtime.release(id, admission.fence)
      const reloaded = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
      expect([reloaded.status, yield* reloaded.json]).toEqual([200, true])
    }),
  )
}

it.live("ordinary instance activity rejects reload until its full lease has released", () =>
  Effect.gen(function* () {
    yield* globalFile
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    const reader = yield* Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
    }).pipe(withInstanceActivity, Effect.forkChild)
    yield* Deferred.await(entered)
    const response = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
    expect(response.status).toBe(409)
    expect(yield* response.json).toMatchObject({ _tag: "ConfigReloadError", kind: "busy" })
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(reader)
    const reloaded = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
    expect([reloaded.status, yield* reloaded.json]).toEqual([200, true])
  }),
)

it.live("scheduler preparation blocks config reload until its full step releases the activity lease", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const store = yield* InstanceStore.Service
    const database = yield* Database.Service
    const runtime = yield* RuntimeLifecycle.Service
    const schedules = yield* SessionSchedule.Service
    const queue = yield* SessionQueue.Service
    const directory = yield* tmpdirScoped({ git: true })
    const ctx = yield* store.load({ directory })
    const id = yield* seedHistory(ctx)
    // Bind only the context: store.provide would mask a missing scheduler activity lease.
    yield* Effect.gen(function* () {
      const original = yield* config.get()
      expect(original.model).toBe("reload/old")
      const schedule = yield* schedules.create(id, {
        message: "scheduled input",
        spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
        sessionState: "always",
        deferUntilIdle: false,
        missed: "all",
      })
      const before = yield* history(id)
      const queued = yield* queue.list(id)
      const ownership = yield* runtime.status()
      const observed = yield* events
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const scheduler = ServerScheduler.engine({
        database,
        runtime,
        store,
        startup: 0,
        prepare: (row) =>
          Effect.gen(function* () {
            yield* queue.prepareScheduled(id)
            const cfg = yield* config.get()
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            expect(yield* config.get()).toBe(cfg)
            return {
              kind: "prompt" as const,
              agent: "build",
              model: Provider.parseModel(cfg.model ?? ""),
              parts: [{ type: "text" as const, text: row.input.message }],
            }
          }),
        dispatch: (row, occurrence, _session, prepared) =>
          prepared?._tag === "Success"
            ? queue
                .enqueueScheduled(
                  id,
                  { id: occurrence.id, payload: prepared.success },
                  { type: "scheduled", scheduleID: row.id, occurrenceID: occurrence.id },
                  { prepared: true },
                )
                .pipe(Effect.as("idle" as const))
            : Effect.die("Scheduled input was not prepared"),
      })
      const step = yield* scheduler.step(schedule.anchor).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(entered), "scheduler did not enter config-dependent preparation")
      yield* fs.writeJson(file, { model: "reload/new" })
      const rejected = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
      expect(rejected.status).toBe(409)
      expect(yield* rejected.json).toMatchObject({ _tag: "ConfigReloadError", kind: "busy" })
      expect(yield* config.get()).toBe(original)
      expect(yield* schedules.get(id, schedule.id)).toEqual(schedule)
      expect((yield* schedules.history(id, schedule.id)).items).toEqual([])
      expect(yield* queue.list(id)).toEqual(queued)
      expect(yield* runtime.status()).toEqual(ownership)
      expect(yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${id}`)).toBeUndefined()
      expect(observed.some((event) => event.payload.type === "config.reloaded")).toBe(false)
      yield* Deferred.succeed(release, undefined)
      const occurrenceID = `occ_${schedule.id}_${schedule.anchor}`
      expect(
        yield* awaitWithTimeout(Fiber.join(step), "scheduler step deadlocked after preparation released"),
      ).toMatchObject({
        id: schedule.id,
        blocked: false,
        accepted: occurrenceID,
      })
      expect(yield* schedules.get(id, schedule.id)).toMatchObject({
        next: schedule.anchor + 60_000,
        status: "active",
        completed: 0,
      })
      const occurrences = (yield* schedules.history(id, schedule.id)).items
      expect(occurrences).toHaveLength(1)
      expect(occurrences[0]).toMatchObject({ id: occurrenceID, scheduled: schedule.anchor, state: "accepted" })
      const accepted = yield* queue.list(id)
      expect(accepted.items).toHaveLength(1)
      expect(accepted.items[0]).toMatchObject({
        id: occurrenceID,
        state: "pending",
        payload: { kind: "prompt", model: { providerID: "reload", modelID: "old" } },
        origin: { type: "scheduled", scheduleID: schedule.id, occurrenceID },
      })
      expect(yield* history(id)).toEqual(before)
      const reloaded = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
      expect([reloaded.status, yield* reloaded.json]).toEqual([200, true])
      expect((yield* config.get()).model).toBe("reload/new")
      expect(yield* queue.list(id)).toEqual(accepted)
    }).pipe(Effect.provideService(InstanceRef, ctx))
  }),
)

it.live("unknown staging defects return a fixed sanitized 500 and preserve the previous generation", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const store = yield* InstanceStore.Service
    const directory = yield* tmpdirScoped({ git: true })
    const ctx = yield* store.load({ directory })
    const previous = yield* config.get().pipe(Effect.provideService(InstanceRef, ctx))
    const staged = yield* Deferred.make<void>()
    const state = yield* InstanceState.make(
      () =>
        Effect.gen(function* () {
          if (yield* InstanceState.reloading) {
            yield* Deferred.succeed(staged, undefined)
            return yield* Effect.die(new Error("reload-private-secret"))
          }
          return "old state"
        }),
      { reloadable: true },
    )
    yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, ctx))
    yield* fs.writeJson(file, { model: "reload/new" })
    const observed = yield* events
    const response = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute)
    expect(response.status).toBe(500)
    expect(yield* Deferred.isDone(staged)).toBe(true)
    expect(yield* response.json).toEqual({
      _tag: "ConfigReloadError",
      kind: "internal",
      message: "Configuration reload failed. Previous configuration remains active.",
    })
    expect(yield* config.get().pipe(Effect.provideService(InstanceRef, ctx))).toBe(previous)
    expect(yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, ctx))).toBe("old state")
    expect(
      observed.some((event) => event.payload.type === "config.reloaded" || event.payload.type.endsWith("disposed")),
    ).toBe(false)
  }),
)

it.live("concurrent reload and PATCH requests serialize cache publication and finish without disposal", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const store = yield* InstanceStore.Service
    const config = yield* Config.Service
    const directory = yield* tmpdirScoped({ git: true })
    const ctx = yield* store.load({ directory })
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    const state = yield* InstanceState.make(
      () =>
        Effect.gen(function* () {
          if (yield* InstanceState.reloading) {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }
          return yield* config.get()
        }),
      { reloadable: true },
    )
    yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, ctx))
    const observed = yield* events
    yield* fs.writeJson(file, { model: "reload/new" })
    const reload = yield* HttpClientRequest.post("/global/config/reload").pipe(HttpClient.execute, Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(entered), "reload never entered cache staging")
    const patch = yield* HttpClientRequest.patch("/global/config").pipe(
      HttpClientRequest.bodyJsonUnsafe({ shell: "patched-shell" }),
      HttpClient.execute,
      Effect.forkChild,
    )
    expect(observed.filter((event) => event.payload.type === "config.reloaded")).toEqual([])
    yield* Deferred.succeed(release, undefined)
    const reloaded = yield* awaitWithTimeout(Fiber.join(reload), "reload failed to release the writer")
    expect([reloaded.status, yield* reloaded.json]).toEqual([200, true])
    const patched = yield* awaitWithTimeout(Fiber.join(patch), "PATCH deadlocked with reload")
    expect(patched.status).toBe(200)
    expect(yield* patched.json).toMatchObject({ model: "reload/new", shell: "patched-shell" })
    expect(yield* config.get().pipe(Effect.provideService(InstanceRef, ctx))).toMatchObject({
      model: "reload/new",
      shell: "patched-shell",
    })
    expect(observed.filter((event) => event.payload.type === "config.reloaded")).toHaveLength(2)
    expect(observed.some((event) => event.payload.type.endsWith("disposed"))).toBe(false)
  }),
)

const authenticated = testEffect(apiLayer("reload-password"))
authenticated.live("reload inherits root authentication and does not expose reload errors before authorization", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(file, '{"reload-private-secret":')
    for (const password of [undefined, "incorrect"]) {
      const request =
        password === undefined
          ? HttpClientRequest.post("/global/config/reload")
          : HttpClientRequest.post("/global/config/reload").pipe(
              HttpClientRequest.setHeader(
                "authorization",
                `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
              ),
            )
      const response = yield* request.pipe(HttpClient.execute)
      expect(response.status).toBe(401)
      expect(yield* response.text).not.toContain("reload-private-secret")
    }
    const authorized = yield* HttpClientRequest.post("/global/config/reload").pipe(
      HttpClientRequest.setHeader(
        "authorization",
        `Basic ${Buffer.from("opencode:reload-password").toString("base64")}`,
      ),
      HttpClient.execute,
    )
    expect(authorized.status).toBe(400)
    expect(yield* authorized.json).toMatchObject({ _tag: "ConfigReloadError", kind: "invalid" })
  }),
)
