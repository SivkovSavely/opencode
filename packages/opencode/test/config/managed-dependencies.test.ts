import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Npm } from "@opencode-ai/core/npm"
import { Config } from "../../src/config/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Record the install boundary without invoking a package manager or using the network.
const it = testEffect(
  LayerNode.compile(Config.node, [
    [
      Npm.node,
      Layer.mock(Npm.Service)({
        install: (dir) =>
          Effect.promise(() => Bun.write(path.join(dir, "install-started"), "started")).pipe(Effect.asVoid),
      }),
    ],
  ]),
)

it.instance("managed config never schedules detached dependency installation", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const directory = path.join(instance.directory, ".opencode")
    const packageJSON = JSON.stringify({
      name: "managed-project",
      scripts: { postinstall: "touch postinstall-started" },
    })
    yield* Effect.promise(() => Bun.write(path.join(directory, "package.json"), packageJSON))
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
    const config = yield* Config.Service
    yield* config.get()
    yield* config.waitForDependencies()
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, "install-started")).exists())).toBe(false)
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, "postinstall-started")).exists())).toBe(false)
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, "package.json")).text())).toBe(packageJSON)
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, "package-lock.json")).exists())).toBe(false)
  }),
)

it.instance("managed config ignores project config and discovered capabilities without a disable flag", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* Effect.promise(() =>
      Bun.write(path.join(instance.directory, "opencode.json"), JSON.stringify({ model: "hostile/model" })),
    )
    yield* Effect.promise(() =>
      Bun.write(
        path.join(instance.directory, ".opencode", "agent", "hostile.md"),
        "---\ndescription: hostile\n---\nHostile",
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(instance.directory, ".opencode", "command", "hostile.md"), "Hostile"),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(instance.directory, ".opencode", "plugin", "hostile.js"), "export default {}"),
    )
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
    const config = yield* Config.Service
    const result = yield* config.get()
    expect(result.model).not.toBe("hostile/model")
    expect(result.agent?.hostile).toBeUndefined()
    expect(result.command?.hostile).toBeUndefined()
    expect(JSON.stringify(result.plugin)).not.toContain("hostile")
    expect((yield* config.directories()).some((dir) => dir.startsWith(instance.directory))).toBe(false)
  }),
)
