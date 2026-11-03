import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, NodeServices.layer))

it.live(
  "the embedded scheduler does not wake pending scheduled work owned by another live listener",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({
        git: true,
        config: { ...testProviderConfig(llm.url), model: "test/test-model" },
      })
      const hold = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => hold.resolve()))
      yield* llm.hold("first response", hold.promise)
      yield* llm.text("scheduled response")
      const spawn = (role: string) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn([process.execPath, "run", "./test/server/fixtures/session-schedule-owner.ts", role], {
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
              stdin: "pipe",
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
      const ready = (role: string) =>
        pollWithTimeout(
          Effect.promise(async () => {
            const file = Bun.file(`${directory}/${role}-ready.json`)
            if (!(await file.exists())) return undefined
            return (await file.json()) as { url?: string }
          }),
          `${role} scheduler process did not start`,
          "20 seconds",
        )
      const owner = yield* spawn("owner")
      const address = yield* ready("owner")
      expect(address.url).toBeDefined()
      const sdk = createOpencodeClient({ baseUrl: address.url, directory, throwOnError: true })
      const session = (yield* Effect.promise(() => sdk.session.create({ title: "cross-process scheduled ownership" })))
        .data
      if (!session) return yield* Effect.die("Missing test session")
      yield* Effect.promise(() =>
        sdk.session.promptAsync({
          sessionID: session.id,
          parts: [{ type: "text", text: "Keep this turn active" }],
        }),
      )
      yield* llm.wait(1)
      const url = new URL(`/session/${session.id}/schedule`, address.url)
      url.searchParams.set("directory", directory)
      const schedule = yield* Effect.promise(async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "Only after the owner finishes its active provider turn",
            spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
            sessionState: "always",
            deferUntilIdle: false,
            missed: "all",
            limit: 1,
          }),
        })
        expect(response.status).toBe(200)
        return (await response.json()) as SessionScheduleV1.Info
      })
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => new Database(`${directory}/schedule.sqlite`, { readonly: true })),
        (database) => Effect.sync(() => database.close()),
      )
      const occurrence = database.query<{ state: string; queue_state: string }, [string]>(
        "SELECT o.state, q.state AS queue_state FROM session_schedule_occurrence o JOIN session_queue q ON q.id = o.id WHERE o.schedule_id = ?",
      )
      yield* pollWithTimeout(
        Effect.sync(() => (occurrence.get(schedule.id)?.state === "accepted" ? true : undefined)),
        "owning listener did not admit the scheduled input",
      )
      expect(occurrence.get(schedule.id)).toEqual({ state: "accepted", queue_state: "pending" })
      const embedded = yield* spawn("embedded")
      yield* ready("embedded")
      // Negative assertion over multiple one-second scheduler polls, with the foreign
      // stream intentionally held open. This used to launch a second provider request.
      yield* Effect.sleep("2500 millis")
      expect(yield* llm.calls).toBe(1)
      expect(occurrence.get(schedule.id)).toEqual({ state: "accepted", queue_state: "pending" })
      hold.resolve()
      yield* awaitWithTimeout(llm.wait(2), "owning listener stranded its scheduled input", "15 seconds")
      yield* pollWithTimeout(
        Effect.promise(async () => {
          const messages = (await sdk.session.messages({ sessionID: session.id })).data
          const users = messages?.filter((message) => message.info.role === "user")
          const assistants = messages?.filter(
            (message) => message.info.role === "assistant" && message.info.time.completed,
          )
          return users?.length === 2 && assistants?.length === 2 && occurrence.get(schedule.id)?.state === "delivered"
            ? messages
            : undefined
        }),
        "owned provider turns did not finish",
      )
      expect(yield* llm.calls).toBe(2)
      for (const child of [embedded, owner]) {
        child.stdin.end()
        const result = yield* awaitWithTimeout(
          Effect.promise(async () => ({
            code: await child.exited,
            stderr: await new Response(child.stderr).text(),
          })),
          "scheduler process did not shut down",
          "15 seconds",
        )
        expect(result).toMatchObject({ code: 0 })
      }
    }),
  60_000,
)
