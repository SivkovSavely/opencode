import { describe, expect, test } from "bun:test"
import {
  isManagedPluginAllowed,
  isManagedPtyPlugin,
  MANAGED_PTY_CONFLICT,
  MANAGED_UNTRUSTED_PLUGIN,
} from "@/plugin/managed-profile"
import { PluginLoader } from "@/plugin/loader"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import path from "node:path"
import { pathToFileURL } from "node:url"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

describe("managed pty identification", () => {
  test("matches known identities without matching unrelated plugins", () => {
    for (const spec of [
      "opencode-pty",
      "opencode-pty@^0.1.0",
      "npm:opencode-pty@latest",
      "alias@npm:opencode-pty@latest",
      "github:shekohex/opencode-pty#main",
      "git+https://github.com/shekohex/opencode-pty.git",
      "file:///plugins/opencode-pty/index.ts",
    ])
      expect(isManagedPtyPlugin(spec)).toBe(true)
    for (const spec of ["opencode-pty-extra", "@other/opencode-pty", "github:other/opencode-pty", "compression"])
      expect(isManagedPtyPlugin(spec)).toBe(false)
    expect(isManagedPtyPlugin("file:///plugins/renamed", { name: "opencode-pty" })).toBe(true)
  })

  it.live("blocks server resolution only when opted in", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_MANAGED_PROFILE
      const previousAllowlist = process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST
      yield* Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, "package.json"),
            JSON.stringify({ name: "opencode-pty", main: "index.ts", exports: { "./tui": "./index.ts" } }),
          ),
        )
        yield* Effect.promise(() => Bun.write(path.join(dir, "index.ts"), "export default async () => ({})"))
        const plan = { spec: pathToFileURL(dir).href, options: undefined, deprecated: false }
        delete process.env.OPENCODE_MANAGED_PROFILE
        expect((yield* Effect.promise(() => PluginLoader.resolve(plan, "server"))).ok).toBe(true)
        process.env.OPENCODE_MANAGED_PROFILE = "1"
        delete process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST
        const blocked = yield* Effect.promise(() => PluginLoader.resolve(plan, "server"))
        expect(blocked.ok).toBe(false)
        if (!blocked.ok && blocked.stage !== "missing")
          expect(blocked.error).toEqual(new Error(MANAGED_UNTRUSTED_PLUGIN))
        process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = JSON.stringify([plan.spec, "opencode-pty@latest"])
        const manifest = yield* Effect.promise(() => PluginLoader.resolve(plan, "server"))
        expect(manifest.ok).toBe(false)
        if (!manifest.ok && manifest.stage !== "missing")
          expect(manifest.error).toEqual(new Error(MANAGED_PTY_CONFLICT))
        expect((yield* Effect.promise(() => PluginLoader.resolve(plan, "tui"))).ok).toBe(true)
        const known = yield* Effect.promise(() =>
          PluginLoader.resolve({ ...plan, spec: "opencode-pty@latest" }, "server"),
        )
        expect(known.ok).toBe(false)
        if (!known.ok && known.stage !== "missing") expect(known.error).toEqual(new Error(MANAGED_PTY_CONFLICT))
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

  test("allowlist uses exact entries and fails closed for malformed values", () => {
    const previous = process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST
    try {
      for (const value of ["", "not json", '"compression"', '["compression", 1]']) {
        process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = value
        expect(isManagedPluginAllowed("compression")).toBe(false)
      }
      process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = '["compression@1.0.0"]'
      expect(isManagedPluginAllowed("compression@1.0.0")).toBe(true)
      expect(isManagedPluginAllowed("compression")).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST
      else process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = previous
    }
  })
})
