import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PluginLoader } from "@/plugin/loader"
import { isLegacyQueuePlugin, QUEUE_PLUGIN_CONFLICT } from "@/plugin/queue-conflict"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

describe("native queue plugin conflict protection", () => {
  test("recognizes exact npm, github, manifest and named local identities conservatively", () => {
    for (const spec of [
      "opencode-queue",
      "opencode-queue@latest",
      "opencode-queue@^0.12.0",
      "npm:opencode-queue@0.12.2",
      "github:mirsella/opencode-queue#main",
      "mirsella/opencode-queue",
      "git+https://github.com/mirsella/opencode-queue.git#main",
      "git@github.com:mirsella/opencode-queue.git",
      "file:///plugins/opencode-queue/index.ts",
      "/plugins/opencode-queue.ts",
    ])
      expect(isLegacyQueuePlugin(spec)).toBe(true)
    for (const spec of [
      "my-opencode-queue",
      "opencode-queue-extra",
      "@someone/opencode-queue",
      "github:someone/opencode-queue",
      "file:///plugins/queue.ts",
      "/plugins/opencode-queue-extra/index.ts",
      "https://evil.example/mirsella/opencode-queue.git",
    ])
      expect(isLegacyQueuePlugin(spec)).toBe(false)
    expect(isLegacyQueuePlugin("file:///plugins/custom/index.ts", { name: "opencode-queue" })).toBe(true)
  })

  it.live("rejects known npm/github specs before installation", () =>
    Effect.gen(function* () {
      for (const spec of ["opencode-queue@0.12.2", "github:mirsella/opencode-queue#main"]) {
        const result = yield* Effect.promise(() =>
          PluginLoader.resolve({ spec, options: undefined, deprecated: false }, "server"),
        )
        expect(result.ok).toBe(false)
        if (result.ok) return yield* Effect.die("Unexpectedly resolved plugin")
        expect(result.stage).toBe("compatibility")
        if (result.stage !== "missing") expect(result.error).toEqual(new Error(QUEUE_PLUGIN_CONFLICT))
      }
    }),
  )

  it.live("recognizes a renamed checkout by manifest before module evaluation", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const mark = path.join(dir, "executed")
      yield* Effect.promise(() =>
        Bun.write(path.join(dir, "package.json"), JSON.stringify({ name: "opencode-queue", main: "./index.ts" })),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "index.ts"),
          `await Bun.write(${JSON.stringify(mark)}, "unsafe"); export default async () => ({})`,
        ),
      )
      const result = yield* Effect.promise(() =>
        PluginLoader.resolve({ spec: pathToFileURL(dir).href, options: undefined, deprecated: false }, "server"),
      )
      expect(result.ok).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(mark).exists())).toBe(false)
      const load = yield* Effect.promise(() =>
        PluginLoader.load({
          spec: pathToFileURL(dir).href,
          options: undefined,
          deprecated: false,
          source: "file",
          target: dir,
          entry: pathToFileURL(path.join(dir, "index.ts")).href,
          pkg: { dir, pkg: path.join(dir, "package.json"), json: { name: "opencode-queue" } },
        }),
      )
      expect(load.ok).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(mark).exists())).toBe(false)
    }),
  )
})
