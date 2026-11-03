import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import path from "node:path"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer))

it.live(
  "the default in-process handler delivers schedules without an external listener",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({
        git: true,
        config: { ...testProviderConfig(llm.url), model: "test/test-model" },
      })
      yield* llm.text("embedded scheduled response")
      // Isolate the process-wide Default handler and its scope from listener tests.
      // Run, not test: the test preload forces an in-memory DB.
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn([process.execPath, "run", "./test/server/fixtures/session-schedule-default.ts"], {
            cwd: path.resolve(import.meta.dir, "../.."),
            env: {
              ...process.env,
              HOME: directory,
              OPENCODE_TEST_HOME: directory,
              XDG_CONFIG_HOME: `${directory}/config`,
              XDG_DATA_HOME: `${directory}/data`,
              XDG_CACHE_HOME: `${directory}/cache`,
              XDG_STATE_HOME: `${directory}/state`,
              OPENCODE_TEST_MANAGED_CONFIG_DIR: `${directory}/managed`,
              OPENCODE_DB: `${directory}/schedule.sqlite`,
              OPENCODE_CONFIG_CONTENT: "{}",
              OPENCODE_PURE: "1",
              OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
              OPENCODE_MANAGED_PROFILE: "0",
              OPENCODE_MANAGED_WORKSPACE: "",
              OPENCODE_SERVER_PASSWORD: "",
              OPENCODE_AUTH_CONTENT: "{}",
              SCHEDULE_DIRECTORY: directory,
            },
            stdout: "pipe",
            stderr: "pipe",
          }),
        ),
        (child) =>
          Effect.promise(async () => {
            if (child.exitCode === null) child.kill()
            await child.exited
          }),
      )
      const result = yield* awaitWithTimeout(
        Effect.promise(async () => {
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          return { code, stdout, stderr }
        }),
        "default handler schedule child timed out",
        "30 seconds",
      )
      expect(result).toMatchObject({ code: 0 })
      expect(result.stdout).toContain("default handler schedule verified")
      expect(yield* llm.calls).toBe(1)
    }),
  40_000,
)
