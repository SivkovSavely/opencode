import { expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, LayerNode.compile(CrossSpawnSpawner.node)))

it.live(
  "pending watch events and accepted control input survive real process restarts without duplicate execution",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const home = yield* tmpdirScoped()
      const directory = yield* tmpdirScoped({
        git: true,
        config: { ...testProviderConfig(llm.url), model: "test/test-model", snapshot: false },
      })
      yield* llm.text("control recovered")
      yield* llm.text("watch recovered")
      for (const phase of ["seed", "replay", "replay"]) {
        const result = yield* child(directory, home, phase)
        expect(result).toMatchObject({ code: 0 })
      }
      expect(yield* llm.calls).toBe(2)
    }),
  30_000,
)

it.live(
  "managed profiles hide orchestration tools and reject direct execution before any session mutation",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const home = yield* tmpdirScoped()
      expect(yield* child(directory, home, "managed")).toMatchObject({ code: 0 })
    }),
  30_000,
)

const child = (directory: string, home: string, phase: string) =>
  Effect.promise(async () => {
    const child = Bun.spawn(["bun", "run", "./test/session/fixtures/session-orchestration.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        OPENCODE_TEST_HOME: home,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_STATE_HOME: path.join(home, "state"),
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_DB: path.join(home, "restart.db"),
        TEST_DIRECTORY: directory,
        TEST_PHASE: phase,
        OPENCODE_MANAGED_PROFILE: phase === "managed" ? "1" : undefined,
        OPENCODE_MANAGED_WORKSPACE: phase === "managed" ? directory : undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr }
  })
