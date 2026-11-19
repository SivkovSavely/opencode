import { expect } from "bun:test"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Npm } from "@opencode-ai/core/npm"
import { Cause, Context, Effect, Exit, Layer, Logger, Option } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { provideInstanceEffect, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const configLayer = (
  options: {
    account?: Layer.Layer<Account.Service>
    auth?: Layer.Layer<Auth.Service>
    client?: HttpClient.HttpClient
  } = {},
) =>
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, CrossSpawnSpawner.node]), [
    [Auth.node, options.auth ?? AuthTest.empty],
    [Account.node, options.account ?? AccountTest.empty],
    [
      Npm.node,
      Layer.mock(Npm.Service)({
        install: (directory) =>
          Effect.gen(function* () {
            if (yield* InstanceState.reloading)
              yield* Effect.promise(() => Bun.write(path.join(directory, "reload-install-started"), "started"))
          }),
      }),
    ],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        options.client ?? HttpClient.make(() => Effect.die(new Error("unexpected HTTP request"))),
      ),
    ],
  ])

const it = testEffect(configLayer())

const preserveFiles = (files: string[]) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const previous = yield* Effect.forEach(files, (file) => fs.readFileStringSafe(file))
    yield* Effect.addFinalizer(() =>
      Effect.forEach(files, (file, index) =>
        previous[index] === undefined ? fs.remove(file, { force: true }) : fs.writeWithDirs(file, previous[index]),
      ).pipe(Effect.asVoid, Effect.orDie),
    )
  })

const globalFile = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const files = ["config.json", "opencode.json", "opencode.jsonc"].map((name) => path.join(Global.Path.config, name))
  const legacy = path.join(Global.Path.config, "config")
  yield* preserveFiles([...files, legacy])
  yield* fs.remove(legacy, { force: true })
  yield* Effect.forEach(files, (file) => fs.writeWithDirs(file, "{}"))
  return path.join(Global.Path.config, "opencode.json")
})

const setEnv = (entries: Record<string, string | undefined>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(entries).map((key) => [key, process.env[key]]))
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )

class ReloadValue extends Context.Service<ReloadValue, string>()("@test/ConfigReloadValue") {}

it.live("reload reads fresh global config without loaded directories and preserves the supplied effect result", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    yield* fs.writeJson(file, { model: "global/old" })
    expect((yield* config.getGlobal()).model).toBe("global/old")
    yield* fs.writeJson(file, { model: "global/new" })
    const result = yield* config
      .reload(
        Effect.gen(function* () {
          expect((yield* config.getGlobal()).model).toBe("global/new")
          return yield* ReloadValue
        }),
      )
      .pipe(Effect.provideService(ReloadValue, "effect result"))
    expect(result).toBe("effect result")
    expect((yield* config.getGlobal()).model).toBe("global/new")
    yield* fs.writeJson(file, { model: "global/later" })
    expect((yield* config.getGlobal()).model).toBe("global/new")
    yield* config.invalidate()
    expect((yield* config.getGlobal()).model).toBe("global/later")
  }),
)

it.live("a failed supplied effect retains cached global config and its typed error", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    yield* fs.writeJson(file, { model: "global/old" })
    const previous = yield* config.getGlobal()
    yield* fs.writeJson(file, { model: "global/new" })
    const exit = yield* config
      .reload(
        Effect.gen(function* () {
          expect((yield* config.getGlobal()).model).toBe("global/new")
          return yield* Effect.fail("rebuild failed" as const)
        }),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBe("rebuild failed")
    expect(yield* config.getGlobal()).toBe(previous)
    yield* config.reload(Effect.void)
    expect((yield* config.getGlobal()).model).toBe("global/new")
  }),
)

it.live("reload rereads legacy TOML without migrating or changing config files", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    yield* fs.writeJson(file, { model: "global/old" })
    yield* config.getGlobal()
    const previousFile = yield* fs.readFileString(file)
    const previousLegacyTarget = yield* fs.readFileString(path.join(Global.Path.config, "config.json"))
    const legacy = path.join(Global.Path.config, "config")
    yield* fs.writeFileString(legacy, 'provider = "legacy"\nmodel = "first"')
    yield* config.reload(Effect.void)
    expect((yield* config.getGlobal()).model).toBe("legacy/first")
    expect(yield* fs.readFileStringSafe(legacy)).toBe('provider = "legacy"\nmodel = "first"')
    expect(yield* fs.readFileString(file)).toBe(previousFile)
    expect(yield* fs.readFileString(path.join(Global.Path.config, "config.json"))).toBe(previousLegacyTarget)
    yield* fs.writeFileString(legacy, 'provider = "legacy"\nmodel = "second"')
    yield* config.reload(Effect.void)
    expect((yield* config.getGlobal()).model).toBe("legacy/second")
  }),
)

for (const invalid of [
  { name: "syntax", text: 'model = ["reload-secret"' },
  { name: "schema", text: "username = 42" },
]) {
  it.live(`reload rejects invalid legacy TOML ${invalid.name} without migration`, () =>
    Effect.gen(function* () {
      const file = yield* globalFile
      const fs = yield* FSUtil.Service
      const config = yield* Config.Service
      yield* fs.writeJson(file, { model: "global/old" })
      const previous = yield* config.getGlobal()
      const target = path.join(Global.Path.config, "config.json")
      const previousTarget = yield* fs.readFileString(target)
      const legacy = path.join(Global.Path.config, "config")
      yield* fs.writeFileString(legacy, invalid.text)
      const exit = yield* config.reload(Effect.void).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* config.getGlobal()).toBe(previous)
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({ data: { path: legacy } })
      expect(yield* fs.readFileStringSafe(legacy)).toBe(invalid.text)
      expect(yield* fs.readFileString(target)).toBe(previousTarget)
    }),
  )
}

for (const invalid of [
  { name: "JSON syntax", text: '{"provider":{"example":{"options":{"apiKey":"reload-secret"}}},' },
  { name: "provider schema", text: JSON.stringify({ provider: { example: { npm: 42 } } }) },
  { name: "agent schema", text: JSON.stringify({ agent: { example: { steps: "reload-secret" } } }) },
  { name: "compatibility agent schema", text: JSON.stringify({ agents: { example: { steps: "reload-secret" } } }) },
]) {
  it.live(`invalid global ${invalid.name} is rejected before rebuilding`, () =>
    Effect.gen(function* () {
      const file = yield* globalFile
      const fs = yield* FSUtil.Service
      const config = yield* Config.Service
      yield* fs.writeJson(file, { model: "global/old" })
      const previous = yield* config.getGlobal()
      yield* fs.writeFileString(file, invalid.text)
      const logs: unknown[] = []
      let rebuilt = false
      const exit = yield* config
        .reload(Effect.sync(() => (rebuilt = true)))
        .pipe(Effect.exit, Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry))])))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(rebuilt).toBe(false)
      expect(yield* config.getGlobal()).toBe(previous)
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({ data: { path: file } })
      expect(JSON.stringify(logs)).not.toContain("reload-secret")
    }),
  )
}

it.live("failed project staging keeps every directory and global cache, then a corrected retry publishes all", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    yield* fs.writeJson(file, { shell: "global-old" })
    const one = yield* tmpdirScoped({ config: { model: "project/one-old" } })
    const two = yield* tmpdirScoped({ config: { model: "project/two-old" } })
    const previous = yield* Effect.forEach([one, two], (directory) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const value = yield* config.get()
        yield* config.waitForDependencies()
        return { ctx, value }
      }).pipe(provideInstanceEffect(directory)),
    )
    const global = yield* config.getGlobal()
    yield* fs.writeJson(file, { shell: "global-new" })
    yield* fs.writeJson(path.join(one, "opencode.json"), { model: "project/one-new" })
    yield* fs.writeJson(path.join(two, "opencode.json"), { provider: { invalid: { env: [42] } } })
    const exit = yield* config.reload(InstanceState.reload(previous.map((item) => item.ctx))).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* config.getGlobal()).toBe(global)
    for (const item of previous) {
      expect(yield* config.get().pipe(Effect.provideService(InstanceRef, item.ctx))).toBe(item.value)
    }
    yield* fs.writeJson(path.join(two, "opencode.json"), { model: "project/two-new" })
    yield* config.reload(InstanceState.reload(previous.map((item) => item.ctx)))
    for (const [index, item] of previous.entries()) {
      expect(yield* config.get().pipe(Effect.provideService(InstanceRef, item.ctx))).toMatchObject({
        shell: "global-new",
        model: index === 0 ? "project/one-new" : "project/two-new",
      })
    }
    expect((yield* config.getGlobal()).shell).toBe("global-new")
  }).pipe(Effect.provide(testInstanceStoreLayer)),
)

it.instance("reload reuses file, directory, inline, project and managed overrides in their existing order", () =>
  Effect.gen(function* () {
    const file = yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const ctx = yield* InstanceState.context
    const custom = yield* tmpdirScoped()
    const directory = yield* tmpdirScoped()
    const managed = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    if (!managed) return yield* Effect.die(new Error("missing managed test directory"))
    const customFile = path.join(custom, "custom.json")
    const localFile = path.join(ctx.directory, ".opencode", "opencode.json")
    const managedFile = path.join(managed, "opencode.json")
    yield* preserveFiles([managedFile, path.join(managed, "opencode.jsonc")])
    yield* fs.remove(path.join(managed, "opencode.jsonc"), { force: true })
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Flag.OPENCODE_CONFIG
        Flag.OPENCODE_CONFIG = customFile
        return previous
      }),
      (previous) => Effect.sync(() => (Flag.OPENCODE_CONFIG = previous)),
    )
    yield* setEnv({
      OPENCODE_CONFIG_DIR: directory,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "inline/old", default_agent: "old" }),
    })
    yield* fs.writeJson(file, { shell: "global-old" })
    yield* fs.writeJson(customFile, { model: "custom/old", small_model: "custom/old-small" })
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), { model: "project/old", share: "manual" })
    yield* fs.writeWithDirs(localFile, JSON.stringify({ model: "local/old", snapshot: false }))
    yield* fs.writeJson(path.join(directory, "opencode.json"), { model: "directory/old", username: "old" })
    yield* fs.writeWithDirs(managedFile, JSON.stringify({ model: "managed/old", autoupdate: false }))
    expect((yield* config.get()).model).toBe("managed/old")
    yield* config.waitForDependencies()
    yield* fs.writeJson(file, { shell: "global-new" })
    yield* fs.writeJson(customFile, { model: "custom/new", small_model: "custom/new-small" })
    yield* fs.writeJson(path.join(ctx.directory, "opencode.json"), { model: "project/new", share: "auto" })
    yield* fs.writeJson(localFile, { model: "local/new", snapshot: true })
    yield* fs.writeJson(path.join(directory, "opencode.json"), { model: "directory/new", username: "new" })
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "inline/new", default_agent: "new" })
    yield* fs.writeJson(managedFile, { model: "managed/new", autoupdate: true })
    yield* config.reload(InstanceState.reload([ctx]))
    expect(yield* config.get()).toMatchObject({
      model: "managed/new",
      shell: "global-new",
      small_model: "custom/new-small",
      share: "auto",
      snapshot: true,
      username: "new",
      default_agent: "new",
      autoupdate: true,
    })
  }),
)

it.instance("reload rereads agent, command and mode markdown", () =>
  Effect.gen(function* () {
    yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const ctx = yield* InstanceState.context
    for (const kind of ["agent", "command", "mode"]) {
      yield* fs.writeWithDirs(path.join(ctx.directory, ".opencode", kind, `${kind}.md`), "Old prompt")
    }
    yield* config.get()
    yield* config.waitForDependencies()
    for (const kind of ["agent", "command", "mode"]) {
      yield* fs.writeFileString(
        path.join(ctx.directory, ".opencode", kind, `${kind}.md`),
        "---\nmodel: test/new\n---\nNew prompt",
      )
    }
    yield* config.reload(InstanceState.reload([ctx]))
    const next = yield* config.get()
    expect(next.agent?.agent).toMatchObject({ prompt: "New prompt", model: "test/new" })
    expect(next.agent?.mode).toMatchObject({ prompt: "New prompt", model: "test/new", mode: "primary" })
    expect(next.command?.command).toMatchObject({ template: "New prompt", model: "test/new" })
  }),
)

it.instance("reload does not start dependency installers or rewrite configuration files", () =>
  Effect.gen(function* () {
    yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const ctx = yield* InstanceState.context
    const directory = path.join(ctx.directory, ".opencode")
    const file = path.join(directory, "opencode.json")
    yield* fs.writeWithDirs(file, "{}")
    yield* config.get()
    yield* config.waitForDependencies()
    const text = '{"model":"project/new"}'
    yield* fs.writeFileString(file, text)
    yield* config.reload(InstanceState.reload([ctx]))
    yield* config.waitForDependencies()
    expect((yield* config.get()).model).toBe("project/new")
    expect(yield* fs.readFileString(file)).toBe(text)
    for (const dir of yield* config.directories()) {
      expect(yield* fs.existsSafe(path.join(dir, "reload-install-started"))).toBe(false)
    }
  }),
)

for (const kind of ["agent", "command", "mode"]) {
  it.instance(`reload rejects malformed ${kind} markdown while ordinary loading stays tolerant`, () =>
    Effect.gen(function* () {
      yield* globalFile
      const fs = yield* FSUtil.Service
      const config = yield* Config.Service
      const ctx = yield* InstanceState.context
      const file = path.join(ctx.directory, ".opencode", kind, "broken.md")
      yield* fs.writeWithDirs(file, "---\ndescription: [reload-secret\n---\nPrompt")
      const previous = yield* config.get()
      yield* config.waitForDependencies()
      expect(previous.username).toBeDefined()
      const logs: unknown[] = []
      const exit = yield* config
        .reload(InstanceState.reload([ctx]))
        .pipe(Effect.exit, Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry))])))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({ data: { path: file } })
      expect(yield* config.get()).toBe(previous)
      expect(JSON.stringify(logs)).not.toContain("reload-secret")
    }),
  )
}

it.instance("reload rejects invalid mode schemas rather than silently dropping the mode", () =>
  Effect.gen(function* () {
    yield* globalFile
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const ctx = yield* InstanceState.context
    const file = path.join(ctx.directory, ".opencode", "mode", "example.md")
    yield* fs.writeWithDirs(file, "---\ntemperature: invalid\n---\nPrompt")
    const previous = yield* config.get()
    yield* config.waitForDependencies()
    expect(previous.agent?.example).toBeUndefined()
    const exit = yield* config.reload(InstanceState.reload([ctx])).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({ data: { path: file } })
    expect(yield* config.get()).toBe(previous)
  }),
)

it.instance("reload validates inline agent and permission overrides without publishing a partial config", () =>
  Effect.gen(function* () {
    yield* globalFile
    const config = yield* Config.Service
    const ctx = yield* InstanceState.context
    yield* setEnv({ OPENCODE_CONFIG_CONTENT: undefined, OPENCODE_PERMISSION: undefined })
    const previous = yield* config.get()
    yield* config.waitForDependencies()
    for (const invalid of [
      { content: JSON.stringify({ agent: { example: { steps: "invalid" } } }), permission: undefined },
      { content: JSON.stringify({ provider: { example: { npm: 42 } } }), permission: undefined },
      { content: undefined, permission: '{"edit":"invalid"}' },
      { content: undefined, permission: '{"edit":' },
    ]) {
      if (invalid.content === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
      else process.env.OPENCODE_CONFIG_CONTENT = invalid.content
      if (invalid.permission === undefined) delete process.env.OPENCODE_PERMISSION
      else process.env.OPENCODE_PERMISSION = invalid.permission
      const exit = yield* config.reload(InstanceState.reload([ctx])).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* config.get()).toBe(previous)
    }
  }),
)

const activeAccount = new Account.Info({
  id: Account.AccountID.make("reload-account"),
  email: "reload@example.com",
  url: "https://account.example.com",
  active_org_id: Account.OrgID.make("reload-org"),
})

for (const failing of ["active", "config", "token"] as const) {
  const accountIt = testEffect(
    configLayer({
      account: Layer.mock(Account.Service)({
        active: () =>
          Effect.gen(function* () {
            if ((yield* InstanceState.reloading) && failing === "active")
              return yield* new Account.AccountServiceError({ message: "reload-secret active failed" })
            return Option.some(activeAccount)
          }),
        config: () =>
          Effect.gen(function* () {
            if ((yield* InstanceState.reloading) && failing === "config")
              return yield* new Account.AccountServiceError({ message: "reload-secret config failed" })
            return Option.some({ model: "remote/old" })
          }),
        token: () =>
          Effect.gen(function* () {
            if ((yield* InstanceState.reloading) && failing === "token")
              return yield* new Account.AccountServiceError({ message: "reload-secret token failed" })
            return Option.none()
          }),
      }),
    }),
  )
  accountIt.instance(`reload fails on account ${failing} errors without logging their messages`, () =>
    Effect.gen(function* () {
      yield* globalFile
      const config = yield* Config.Service
      const ctx = yield* InstanceState.context
      const previous = yield* config.get()
      yield* config.waitForDependencies()
      expect(previous.model).toBe("remote/old")
      const logs: unknown[] = []
      const exit = yield* config
        .reload(InstanceState.reload([ctx]))
        .pipe(Effect.exit, Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry))])))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* config.get()).toBe(previous)
      expect(JSON.stringify(logs)).not.toContain("reload-secret")
    }),
  )
}

const accountInput: { config: Record<string, unknown>; token: string } = { config: {}, token: "old-token" }
const accountIt = testEffect(
  configLayer({
    account: Layer.mock(Account.Service)({
      active: () => Effect.succeed(Option.some(activeAccount)),
      config: () => Effect.sync(() => Option.some(accountInput.config)),
      token: () => Effect.sync(() => Option.some(Account.AccessToken.make(accountInput.token))),
    }),
  }),
)
accountIt.instance("reload stages account token substitutions without changing the live environment", () =>
  Effect.gen(function* () {
    yield* globalFile
    yield* setEnv({ OPENCODE_CONSOLE_TOKEN: undefined })
    const config = yield* Config.Service
    const ctx = yield* InstanceState.context
    accountInput.config = { model: "remote/old" }
    accountInput.token = "old-token"
    const previous = yield* config.get()
    yield* config.waitForDependencies()
    expect(process.env.OPENCODE_CONSOLE_TOKEN).toBe("old-token")
    accountInput.token = "new-token"
    accountInput.config = { provider: { example: { npm: 42 } } }
    const exit = yield* config.reload(InstanceState.reload([ctx])).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(process.env.OPENCODE_CONSOLE_TOKEN).toBe("old-token")
    expect(yield* config.get()).toBe(previous)
    accountInput.config = { provider: { example: { options: { apiKey: "{env:OPENCODE_CONSOLE_TOKEN}" } } } }
    yield* config.reload(InstanceState.reload([ctx]))
    expect((yield* config.get()).provider?.example.options?.apiKey).toBe("new-token")
    expect(process.env.OPENCODE_CONSOLE_TOKEN).toBe("old-token")
  }),
)

const remoteInput: { config: Record<string, unknown> } = { config: {} }
const remoteIt = testEffect(
  configLayer({
    auth: Layer.mock(Auth.Service)({
      all: () =>
        Effect.succeed({
          "https://config.example.com/reload-secret": new Auth.WellKnown({
            type: "wellknown",
            key: "RELOAD_REMOTE_TOKEN",
            token: "reload-token",
          }),
        }),
    }),
    client: HttpClient.make((request) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ config: remoteInput.config }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  }),
)
remoteIt.instance("reload rereads and validates well-known remote configuration without logging URL secrets", () =>
  Effect.gen(function* () {
    yield* globalFile
    const config = yield* Config.Service
    const ctx = yield* InstanceState.context
    remoteInput.config = { model: "remote/old" }
    const previous = yield* config.get()
    yield* config.waitForDependencies()
    expect(previous.model).toBe("remote/old")
    remoteInput.config = { provider: { example: { npm: 42 } } }
    const logs: unknown[] = []
    const exit = yield* config
      .reload(InstanceState.reload([ctx]))
      .pipe(Effect.exit, Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry))])))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* config.get()).toBe(previous)
    expect(JSON.stringify(logs)).not.toContain("reload-secret")
    remoteInput.config = { model: "remote/new" }
    yield* config.reload(InstanceState.reload([ctx]))
    expect((yield* config.get()).model).toBe("remote/new")
  }),
)
