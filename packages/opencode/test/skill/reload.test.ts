import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { Effect, Exit, Layer, Logger } from "effect"
import { rm } from "node:fs/promises"
import path from "node:path"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Skill } from "../../src/skill"
import { Command } from "../../src/command"
import { Discovery } from "../../src/skill/discovery"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { InstanceStore } from "../../src/project/instance-store"
import { reloadConfig } from "../../src/server/global-lifecycle"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { provideTmpdirInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Discovery.node))

it.live("remote index failures reject staged discovery without exposing secrets and recover", () =>
  Effect.gen(function* () {
    let response = new Response('{"skills":')
    const server = Bun.serve({ port: 0, fetch: () => response.clone() })
    yield* Effect.addFinalizer(() => Effect.sync(() => void server.stop(true)))
    const discovery = yield* Discovery.Service
    const url = `http://localhost:${server.port}/?token=private-secret`
    const logs: unknown[] = []
    const logger = Logger.layer([Logger.make((entry) => logs.push(entry))])
    expect(yield* discovery.pull(url).pipe(Effect.provide(logger))).toEqual([])
    expect(logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toContain("private-secret")
    for (const next of [new Response('{"skills":'), new Response("private-secret", { status: 503 })]) {
      response = next
      const result = yield* discovery
        .pull(url)
        .pipe(Effect.provideService(InstanceState.reloading, true), Effect.exit, Effect.provide(logger))
      expect(Exit.isFailure(result)).toBe(true)
      expect(String(result)).not.toContain("private-secret")
      expect(JSON.stringify(logs)).not.toContain("private-secret")
    }
    response = Response.json({ skills: [] })
    expect(yield* discovery.pull(url).pipe(Effect.provideService(InstanceState.reloading, true))).toEqual([])
    server.stop(true)
    const result = yield* discovery.pull(url).pipe(Effect.provideService(InstanceState.reloading, true), Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(String(result)).not.toContain("private-secret")
  }),
)

const integration = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Skill.node,
        Command.node,
        Discovery.node,
        Config.node,
        MCP.node,
        FSUtil.node,
        CrossSpawnSpawner.node,
      ]),
      [[Npm.node, Layer.mock(Npm.Service)({ install: () => Effect.void })]],
    ),
    testInstanceStoreLayer,
  ),
)

function remoteSkill(name = `reload-versioned-${crypto.randomUUID()}`) {
  return Effect.gen(function* () {
    const state = {
      version: "1",
      versioned: true,
      content: "version",
      malformed: false,
      downloads: 0,
      files: ["SKILL.md", "scripts/run.sh"],
    }
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/index.json")) {
          return Response.json({
            skills: [{ name, version: state.versioned ? state.version : undefined, files: state.files }],
          })
        }
        state.downloads++
        if (url.pathname.endsWith("/missing.txt")) return new Response("private-secret", { status: 404 })
        if (url.pathname.endsWith("/SKILL.md")) {
          return new Response(
            state.malformed
              ? "---\nname: [private-secret\n---\ninvalid"
              : `---\nname: ${name}\ndescription: remote\n---\n${state.content} ${state.version}`,
          )
        }
        return new Response(`echo ${state.content} ${state.version}\n`)
      },
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        server.stop(true)
        await Promise.all(
          [path.join(Global.Path.cache, "skills", name), path.join(Global.Path.cache, "skills", ".versions", name)].map(
            (dir) => rm(dir, { recursive: true, force: true }),
          ),
        )
      }),
    )
    return { name, state, url: server.url.toString() }
  })
}

integration.live("a later project reload failure preserves published remote skill files until recovery", () =>
  Effect.gen(function* () {
    const remote = yield* remoteSkill()
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const store = yield* InstanceStore.Service
    const skill = yield* Skill.Service
    const command = yield* Command.Service
    const first = yield* store.load({
      directory: yield* tmpdirScoped({ config: { skills: { urls: [remote.url] } } }),
    })
    yield* Effect.addFinalizer(() => store.dispose(first))
    const second = yield* store.load({ directory: yield* tmpdirScoped({ config: {} }) })
    yield* Effect.addFinalizer(() => store.dispose(second))
    yield* config.get().pipe(Effect.provideService(InstanceRef, second))
    const previous = yield* skill.require(remote.name).pipe(Effect.provideService(InstanceRef, first))
    const previousCommand = (yield* command.list().pipe(Effect.provideService(InstanceRef, first))).find(
      (item) => item.name === remote.name,
    )
    expect(previous.content).toBe("version 1")
    expect(previousCommand?.template).toContain("version 1")
    const markdown = yield* fs.readFileString(previous.location)
    const script = path.join(path.dirname(previous.location), "scripts/run.sh")
    expect(yield* fs.readFileString(script)).toBe("echo version 1\n")

    remote.state.version = "2"
    remote.state.files.push("new.txt")
    yield* fs.writeFileString(path.join(second.directory, "opencode.json"), "{invalid")
    expect(Exit.isFailure(yield* reloadConfig(RuntimeLifecycle.unavailable()).pipe(Effect.exit))).toBe(true)
    expect(remote.state.downloads).toBe(5)
    expect(yield* fs.readFileString(script)).toBe("echo version 1\n")
    expect(yield* fs.readFileString(previous.location)).toBe(markdown)
    expect(yield* fs.exists(path.join(path.dirname(previous.location), "new.txt"))).toBe(false)
    expect(yield* skill.require(remote.name).pipe(Effect.provideService(InstanceRef, first))).toBe(previous)
    expect(
      (yield* command.list().pipe(Effect.provideService(InstanceRef, first))).find((item) => item.name === remote.name),
    ).toBe(previousCommand)

    yield* fs.writeJson(path.join(second.directory, "opencode.json"), {})
    yield* reloadConfig(RuntimeLifecycle.unavailable())
    const next = yield* skill.require(remote.name).pipe(Effect.provideService(InstanceRef, first))
    expect(next.content).toBe("version 2")
    expect(next.location).not.toBe(previous.location)
    expect(yield* fs.readFileString(path.join(path.dirname(next.location), "scripts/run.sh"))).toBe("echo version 2\n")
    expect(yield* fs.exists(path.join(path.dirname(next.location), "new.txt"))).toBe(true)
    expect(yield* fs.readFileString(script)).toBe("echo version 1\n")
    expect(yield* fs.readFileString(previous.location)).toBe(markdown)
    const nextCommand = (yield* command.list().pipe(Effect.provideService(InstanceRef, first))).find(
      (item) => item.name === remote.name,
    )
    expect(nextCommand?.template).toContain("version 2")
    expect(nextCommand?.template).toContain(path.dirname(next.location))
    expect(remote.state.downloads).toBe(5)
  }),
)

integration.live("malformed downloaded skill markdown cannot replace published supporting files", () =>
  Effect.gen(function* () {
    const remote = yield* remoteSkill()
    const fs = yield* FSUtil.Service
    const store = yield* InstanceStore.Service
    const skill = yield* Skill.Service
    const command = yield* Command.Service
    const ctx = yield* store.load({ directory: yield* tmpdirScoped({ config: { skills: { urls: [remote.url] } } }) })
    yield* Effect.addFinalizer(() => store.dispose(ctx))
    const previous = yield* skill.require(remote.name).pipe(Effect.provideService(InstanceRef, ctx))
    const previousCommand = (yield* command.list().pipe(Effect.provideService(InstanceRef, ctx))).find(
      (item) => item.name === remote.name,
    )
    const markdown = yield* fs.readFileString(previous.location)
    const script = path.join(path.dirname(previous.location), "scripts/run.sh")
    remote.state.version = "2"
    remote.state.malformed = true
    expect(Exit.isFailure(yield* reloadConfig(RuntimeLifecycle.unavailable()).pipe(Effect.exit))).toBe(true)
    expect(remote.state.downloads).toBe(4)
    expect(yield* fs.readFileString(script)).toBe("echo version 1\n")
    expect(yield* fs.readFileString(previous.location)).toBe(markdown)
    expect(yield* skill.require(remote.name).pipe(Effect.provideService(InstanceRef, ctx))).toBe(previous)
    expect(
      (yield* command.list().pipe(Effect.provideService(InstanceRef, ctx))).find((item) => item.name === remote.name),
    ).toBe(previousCommand)

    remote.state.version = "3"
    remote.state.malformed = false
    yield* reloadConfig(RuntimeLifecycle.unavailable())
    const next = yield* skill.require(remote.name).pipe(Effect.provideService(InstanceRef, ctx))
    expect(next.content).toBe("version 3")
    expect(next.location).not.toBe(previous.location)
    expect(yield* fs.readFileString(path.join(path.dirname(next.location), "scripts/run.sh"))).toBe("echo version 3\n")
    expect(yield* fs.readFileString(script)).toBe("echo version 1\n")
    expect(yield* fs.readFileString(previous.location)).toBe(markdown)
    expect(
      (yield* command.list().pipe(Effect.provideService(InstanceRef, ctx))).find((item) => item.name === remote.name)
        ?.template,
    ).toContain(path.dirname(next.location))
  }),
)

integration.live("remote versions and index identities use separate cached resources", () =>
  Effect.gen(function* () {
    const remote = yield* remoteSkill()
    const discovery = yield* Discovery.Service
    const fs = yield* FSUtil.Service
    const first = yield* discovery.pull(remote.url)
    remote.state.version = "2"
    remote.state.files.push("new.txt")
    const second = yield* discovery.pull(remote.url)
    expect(second).not.toEqual(first)
    expect(yield* fs.readFileString(path.join(first[0], "scripts/run.sh"))).toBe("echo version 1\n")
    expect(yield* fs.exists(path.join(first[0], "new.txt"))).toBe(false)
    expect(yield* fs.readFileString(path.join(second[0], "scripts/run.sh"))).toBe("echo version 2\n")

    remote.state.content = "other-index"
    const otherIndex = yield* discovery.pull(`${remote.url}other/`)
    expect(otherIndex).not.toEqual(second)
    expect(yield* fs.readFileString(path.join(otherIndex[0], "scripts/run.sh"))).toBe("echo other-index 2\n")
    const other = yield* remoteSkill(remote.name)
    other.state.version = "2"
    other.state.content = "other-origin"
    const otherOrigin = yield* discovery.pull(other.url)
    expect(otherOrigin).not.toEqual(second)
    expect(yield* fs.readFileString(path.join(otherOrigin[0], "scripts/run.sh"))).toBe("echo other-origin 2\n")
    expect(yield* fs.readFileString(path.join(first[0], "scripts/run.sh"))).toBe("echo version 1\n")
    expect(yield* fs.readFileString(path.join(second[0], "scripts/run.sh"))).toBe("echo version 2\n")
  }),
)

integration.live("incomplete version downloads retain prior resources without exposing URL or version secrets", () =>
  Effect.gen(function* () {
    const remote = yield* remoteSkill()
    const discovery = yield* Discovery.Service
    const fs = yield* FSUtil.Service
    const url = `${remote.url}url-private-secret/`
    const first = yield* discovery.pull(url)
    expect(first).toHaveLength(1)
    expect(first[0]).not.toContain("url-private-secret")
    remote.state.version = "version-private-secret"
    remote.state.files.push("missing.txt")
    const logs: unknown[] = []
    const logger = Logger.layer([Logger.make((entry) => logs.push(entry))])
    const result = yield* discovery
      .pull(url)
      .pipe(Effect.provideService(InstanceState.reloading, true), Effect.exit, Effect.provide(logger))
    expect(Exit.isFailure(result)).toBe(true)
    expect(String(result)).not.toContain("private-secret")
    expect(yield* discovery.pull(url).pipe(Effect.provide(logger))).toEqual(first)
    expect(Bun.inspect(logs, { depth: 20 })).not.toContain("private-secret")
    expect(yield* fs.readFileString(path.join(first[0], "scripts/run.sh"))).toBe("echo version 1\n")
    remote.state.files = ["SKILL.md", "scripts/run.sh"]
    const next = yield* discovery.pull(url)
    expect(next).not.toEqual(first)
    expect(next[0]).not.toContain("private-secret")
    expect(yield* fs.readFileString(path.join(next[0], "scripts/run.sh"))).toBe("echo version version-private-secret\n")
    expect(yield* fs.readFileString(path.join(first[0], "scripts/run.sh"))).toBe("echo version 1\n")
  }),
)

integration.live("unversioned legacy cache paths remain usable and versioned pulls never replace them", () =>
  Effect.gen(function* () {
    const remote = yield* remoteSkill()
    const discovery = yield* Discovery.Service
    const fs = yield* FSUtil.Service
    const legacy = path.join(Global.Path.cache, "skills", remote.name)
    yield* fs.writeWithDirs(path.join(legacy, "SKILL.md"), "legacy markdown")
    yield* fs.writeWithDirs(path.join(legacy, "scripts/run.sh"), "echo legacy\n")
    yield* fs.writeFileString(path.join(legacy, ".opencode-version"), "1")
    remote.state.versioned = false
    expect(yield* discovery.pull(remote.url)).toEqual([legacy])
    expect(remote.state.downloads).toBe(0)
    remote.state.versioned = true
    const versioned = yield* discovery.pull(remote.url)
    expect(versioned).toHaveLength(1)
    expect(versioned).not.toEqual([legacy])
    expect(remote.state.downloads).toBe(2)
    expect(yield* fs.readFileString(path.join(versioned[0], "scripts/run.sh"))).toBe("echo version 1\n")
    expect(yield* fs.readFileString(path.join(legacy, "scripts/run.sh"))).toBe("echo legacy\n")
    expect(yield* fs.readFileString(path.join(legacy, "SKILL.md"))).toBe("legacy markdown")
  }),
)

integration.live("failed remote discovery preserves cached skills and commands until recovery", () =>
  Effect.gen(function* () {
    const id = crypto.randomUUID()
    const old = `reload-old-${id}`
    const next = `reload-new-${id}`
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        Promise.all(
          [old, next].map((name) => rm(path.join(Global.Path.cache, "skills", name), { recursive: true, force: true })),
        ),
      ),
    )
    let names = [old]
    let broken = false
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/index.json") {
          if (broken) return new Response('{"skills":')
          return Response.json({ skills: names.map((name) => ({ name, files: ["SKILL.md"] })) })
        }
        const name = url.pathname.split("/")[1]
        return new Response(`---\nname: ${name}\ndescription: remote\n---\n${name}`)
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => void server.stop(true)))
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          if (!ctx) return yield* Effect.die("missing instance")
          const skill = yield* Skill.Service
          const command = yield* Command.Service
          const previous = yield* skill.get(old)
          expect(previous?.name).toBe(old)
          expect((yield* command.list()).some((item) => item.name === old)).toBe(true)
          broken = true
          expect(Exit.isFailure(yield* InstanceState.reload([ctx]).pipe(Effect.exit))).toBe(true)
          expect(yield* skill.get(old)).toBe(previous)
          expect((yield* command.list()).some((item) => item.name === old)).toBe(true)
          broken = false
          names = [next]
          yield* InstanceState.reload([ctx])
          expect(yield* skill.get(old)).toBeUndefined()
          expect((yield* skill.get(next))?.name).toBe(next)
          const commands = yield* command.list()
          expect(commands.some((item) => item.name === old)).toBe(false)
          expect(commands.some((item) => item.name === next)).toBe(true)
        }),
      { config: { skills: { urls: [`http://localhost:${server.port}/`] } } },
    )
  }),
)
