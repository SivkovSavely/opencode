import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { LSP } from "../../src/lsp/lsp"
import { Format } from "../../src/format"
import { Snapshot } from "../../src/snapshot"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Config.node, MCP.node, InstanceBootstrap.node, LSP.node, Format.node, Snapshot.node]),
  ),
)
const command = [
  process.execPath,
  "-e",
  "Bun.write(process.env.OPENCODE_TEST_MCP_MARKER, 'started'); setInterval(() => {}, 1000)",
]

const managed = (config?: unknown) =>
  Effect.gen(function* () {
    const previous = process.env.OPENCODE_MANAGED_PROFILE
    const marker = process.env.OPENCODE_TEST_MCP_MARKER
    const configContent = process.env.OPENCODE_CONFIG_CONTENT
    const instance = yield* TestInstance
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.OPENCODE_MANAGED_PROFILE = "1"
        process.env.OPENCODE_TEST_MCP_MARKER = path.join(instance.directory, "mcp-started")
        if (config !== undefined) process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
          else process.env.OPENCODE_MANAGED_PROFILE = previous
          if (marker === undefined) delete process.env.OPENCODE_TEST_MCP_MARKER
          else process.env.OPENCODE_TEST_MCP_MARKER = marker
          if (configContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
          else process.env.OPENCODE_CONFIG_CONTENT = configContent
        }),
    )
    return path.join(instance.directory, "mcp-started")
  })

it.instance("managed config rejects local MCP before bootstrap or MCP initialization can launch it", () =>
  Effect.gen(function* () {
    const marker = yield* managed({ mcp: { marker: { type: "local", command, timeout: 500 } } })
    const mcp = yield* MCP.Service
    const bootstrap = yield* InstanceBootstrap.Service
    for (const effect of [mcp.status(), bootstrap.run]) {
      const exit = yield* Effect.exit(effect)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("MCP configuration is unavailable")
    }
    expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
  }),
)

it.instance("managed config rejects remote MCP before initialization", () =>
  Effect.gen(function* () {
    yield* managed({ mcp: { remote: { type: "remote", url: "https://127.0.0.1:1/mcp" } } })
    const config = yield* Config.Service
    const exit = yield* Effect.exit(config.get())
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("MCP configuration is unavailable")
  }),
)

it.instance("managed MCP rejects dynamic local servers without launching them", () =>
  Effect.gen(function* () {
    const marker = yield* managed()
    const mcp = yield* MCP.Service
    expect(yield* mcp.status()).toEqual({})
    const exit = yield* Effect.exit(mcp.add("marker", { type: "local", command, timeout: 500 }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("MCP connections are unavailable")
    expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
  }),
)

it.instance(
  "managed file services cannot launch LSP, formatter or snapshot processes",
  () =>
    Effect.gen(function* () {
      const marker = yield* managed()
      const instance = yield* TestInstance
      const config = yield* Config.Service
      const lsp = yield* LSP.Service
      const format = yield* Format.Service
      const snapshot = yield* Snapshot.Service
      const effective = yield* config.get()
      expect(effective.lsp).toBe(false)
      expect(effective.formatter).toBe(false)
      expect(effective.snapshot).toBe(false)
      const file = path.join(instance.directory, "example.ts")
      yield* Effect.promise(() => Bun.write(file, "export const example = true\n"))
      yield* lsp.touchFile(file)
      expect(yield* format.file(file)).toBe(false)
      expect(yield* snapshot.track()).toBeUndefined()
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  {
    git: true,
    config: {
      lsp: { marker: { command, extensions: [".ts"] } },
      formatter: { marker: { command, extensions: [".ts"] } },
      snapshot: true,
    },
  },
)
