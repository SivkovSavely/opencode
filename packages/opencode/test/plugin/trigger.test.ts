import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.instance("managed profile skips project pty plugin before evaluation while preserving other hooks", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_MANAGED_PROFILE
      const previousAllowlist = process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST
      process.env.OPENCODE_MANAGED_PROFILE = "1"
      yield* Effect.gen(function* () {
        const test = yield* TestInstance
        const pty = path.join(test.directory, "renamed")
        const mark = path.join(test.directory, "pty-executed")
        const other = path.join(test.directory, "compression.ts")
        const wrapper = path.join(test.directory, "wrapper.ts")
        const wrapperMark = path.join(test.directory, "wrapper-executed")
        process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = JSON.stringify([
          pathToFileURL(other).href,
          pathToFileURL(pty).href,
        ])
        yield* Effect.promise(() =>
          Bun.write(path.join(pty, "package.json"), JSON.stringify({ name: "opencode-pty", main: "index.ts" })),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(pty, "index.ts"),
            `await Bun.write(${JSON.stringify(mark)}, "executed"); export default async () => ({})`,
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            other,
            `export default async () => ({ ${JSON.stringify(systemHook)}: (_input, output) => { output.system.push("compression") } })`,
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            wrapper,
            `await Bun.write(${JSON.stringify(wrapperMark)}, "executed"); export { default } from ${JSON.stringify(pathToFileURL(path.join(pty, "index.ts")).href)}`,
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify({
              plugin: [pathToFileURL(pty).href, pathToFileURL(wrapper).href, pathToFileURL(other).href],
            }),
          ),
        )
        expect(yield* triggerSystemTransform()).toEqual(["compression"])
        expect(yield* Effect.promise(() => Bun.file(mark).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(wrapperMark).exists())).toBe(false)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
            else process.env.OPENCODE_MANAGED_PROFILE = previous
            if (previousAllowlist === undefined) delete process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST
            else process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = previousAllowlist
          }),
        ),
      )
    }),
  )

  it.instance("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
      }),
    ),
  )

  it.instance("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )
})
