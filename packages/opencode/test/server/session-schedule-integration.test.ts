import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "../../src/server/server"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  Layer.mergeAll(TestLLMServer.layer, NodeServices.layer).pipe(
    Layer.provide(
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await disposeAllInstances()
            await resetDatabase()
            RuntimeLifecycle.setCurrent(RuntimeLifecycle.unavailable())
          }),
        ),
      ),
    ),
  ),
)
const authorization = `Basic ${Buffer.from("schedule-user:schedule-secret").toString("base64")}`
const input: SessionScheduleV1.Input = {
  message: "scheduled message exactly",
  spec: { mode: "interval", amount: 1, unit: "minutes", immediate: false },
  sessionState: "always",
  deferUntilIdle: false,
  missed: "all",
}

const fixture = Effect.gen(function* () {
  const previous = {
    password: process.env.OPENCODE_SERVER_PASSWORD,
    username: process.env.OPENCODE_SERVER_USERNAME,
    flagPassword: Flag.OPENCODE_SERVER_PASSWORD,
    flagUsername: Flag.OPENCODE_SERVER_USERNAME,
  }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previous.password === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = previous.password
      if (previous.username === undefined) delete process.env.OPENCODE_SERVER_USERNAME
      else process.env.OPENCODE_SERVER_USERNAME = previous.username
      Flag.OPENCODE_SERVER_PASSWORD = previous.flagPassword
      Flag.OPENCODE_SERVER_USERNAME = previous.flagUsername
    }),
  )
  process.env.OPENCODE_SERVER_PASSWORD = Flag.OPENCODE_SERVER_PASSWORD = "schedule-secret"
  process.env.OPENCODE_SERVER_USERNAME = Flag.OPENCODE_SERVER_USERNAME = "schedule-user"
  const llm = yield* TestLLMServer
  const directory = yield* tmpdirScoped({
    git: true,
    config: { ...testProviderConfig(llm.url), model: "test/test-model" },
  })
  const listener = yield* Effect.acquireRelease(
    Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
    (server) => Effect.promise(() => server.stop(true)),
  )
  const sdk = createOpencodeClient({ baseUrl: listener.url.toString(), directory, headers: { authorization } })
  const created = yield* Effect.promise(() => sdk.session.create({ title: "schedule integration" }))
  expect(created.response.status).toBe(200)
  if (!created.data) return yield* Effect.die("Missing session")
  return { llm, directory, listener, sdk, sessionID: created.data.id }
})

function request(base: URL, directory: string, path: string, method = "GET", body?: unknown, auth = true) {
  const url = new URL(path, base)
  url.searchParams.set("directory", directory)
  return Effect.promise(() =>
    fetch(url, {
      method,
      headers: {
        ...(auth ? { authorization } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

function json<T>(response: Response) {
  expect(response.status).toBe(200)
  return Effect.promise(() => response.json() as Promise<T>)
}

describe("scheduled messages over a live listener", () => {
  it.live(
    "recovers a file-backed accepted occurrence across process restarts exactly once",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({
          git: true,
          config: { ...testProviderConfig(llm.url), model: "test/test-model" },
        })
        yield* llm.text("persisted scheduled response")
        // Run, not test: the normal test preload intentionally forces an in-memory DB.
        for (const phase of ["accept", "deliver", "verify"]) {
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.spawn([process.execPath, "run", "./test/server/fixtures/session-schedule-restart.ts", phase], {
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
              return { phase, code, stdout, stderr }
            }),
            `schedule restart ${phase} child timed out`,
            "30 seconds",
          )
          expect(result).toMatchObject({ code: 0 })
          expect(result.stdout).toContain(`schedule restart ${phase} verified`)
          expect(yield* llm.calls).toBe(phase === "accept" ? 0 : 1)
        }
        expect(yield* Effect.promise(() => Bun.file(`${directory}/schedule.sqlite`).exists())).toBe(true)
      }),
    100_000,
  )

  it.live("enforces authorization and scope while managing schedules", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const root = `/session/${f.sessionID}/schedule`
      expect((yield* request(f.listener.url, f.directory, root, "GET", undefined, false)).status).toBe(401)
      expect(yield* json<SessionScheduleV1.Info[]>(yield* request(f.listener.url, f.directory, root))).toEqual([])
      const preview = yield* json<SessionScheduleV1.Preview>(
        yield* request(f.listener.url, f.directory, `${root}/preview`, "POST", { spec: input.spec }),
      )
      expect(preview.times).toHaveLength(5)
      expect(preview.times[1] - preview.times[0]).toBe(60_000)
      const created = yield* json<SessionScheduleV1.Info>(
        yield* request(f.listener.url, f.directory, root, "POST", input),
      )
      expect(created).toMatchObject({ message: input.message, sessionID: f.sessionID, status: "active", completed: 0 })
      const item = `${root}/${created.id}`
      expect(yield* json<SessionScheduleV1.Info>(yield* request(f.listener.url, f.directory, item))).toEqual(created)
      expect(
        yield* json<SessionScheduleV1.History>(yield* request(f.listener.url, f.directory, `${item}/history`)),
      ).toEqual({ items: [] })
      const edited = yield* json<SessionScheduleV1.Info>(
        yield* request(f.listener.url, f.directory, item, "PUT", { ...input, message: "edited" }),
      )
      expect(edited).toMatchObject({ message: "edited", anchor: created.anchor, next: created.next })
      const paused = yield* json<SessionScheduleV1.Info>(
        yield* request(f.listener.url, f.directory, `${item}/pause`, "POST", { paused: true }),
      )
      expect(paused.status).toBe("paused")
      expect(paused.next).toBeUndefined()
      const resumed = yield* json<SessionScheduleV1.Info>(
        yield* request(f.listener.url, f.directory, `${item}/pause`, "POST", { paused: false }),
      )
      expect(resumed.status).toBe("active")
      expect(resumed.anchor).toBe(created.anchor)
      expect(resumed.next).toBeGreaterThan(Date.now())
      for (const [path, method, body] of [
        [root, "GET", undefined],
        [root, "POST", input],
        [`${root}/preview`, "POST", { spec: input.spec }],
        [item, "GET", undefined],
        [item, "PUT", input],
        [item, "DELETE", undefined],
        [`${item}/pause`, "POST", { paused: true }],
        [`${item}/history`, "GET", undefined],
      ] as const) {
        expect((yield* request(f.listener.url, f.directory, path, method, body, false)).status).toBe(401)
        expect((yield* request(f.listener.url, `${f.directory}/nested`, path, method, body)).status).toBe(403)
      }
      const foreign = yield* tmpdirScoped({ git: true })
      expect((yield* request(f.listener.url, foreign, item)).status).toBe(403)
      const other = yield* Effect.promise(() => f.sdk.session.create({ title: "another session" }))
      expect(other.response.status).toBe(200)
      expect(
        (yield* request(f.listener.url, f.directory, `/session/${other.data?.id}/schedule/${created.id}`)).status,
      ).toBe(404)
      expect((yield* request(f.listener.url, f.directory, root, "POST", { ...input, message: " " })).status).toBe(400)
      expect(
        (yield* request(f.listener.url, f.directory, `${root}/preview`, "POST", {
          spec: { mode: "cron", expression: "invalid", timeZone: "UTC" },
        })).status,
      ).toBe(400)
      expect((yield* request(f.listener.url, f.directory, root, "POST", { ...input, limit: 0 })).status).toBe(400)
      expect(yield* json<boolean>(yield* request(f.listener.url, f.directory, item, "DELETE"))).toBe(true)
      expect((yield* request(f.listener.url, f.directory, item)).status).toBe(404)
      expect(yield* f.llm.calls).toBe(0)
    }),
  )

  it.live("materializes one scheduled user message without a connected client", () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.llm.text("fake provider response")
      const root = `/session/${f.sessionID}/schedule`
      const created = yield* json<SessionScheduleV1.Info>(
        yield* request(f.listener.url, f.directory, root, "POST", {
          ...input,
          limit: 1,
          spec: { ...input.spec, immediate: true },
        }),
      )
      yield* awaitWithTimeout(f.llm.wait(1), "scheduler did not invoke the fake provider")
      const history = yield* pollWithTimeout(
        Effect.gen(function* () {
          const result = yield* json<SessionScheduleV1.History>(
            yield* request(f.listener.url, f.directory, `${root}/${created.id}/history`),
          )
          return result.items[0]?.state === "delivered" ? result : undefined
        }),
        "scheduled occurrence was not delivered",
      )
      expect(history.items).toHaveLength(1)
      const messages = yield* Effect.promise(() => f.sdk.session.messages({ sessionID: f.sessionID }))
      expect(messages.response.status).toBe(200)
      const users = messages.data?.filter((message) => message.info.role === "user") ?? []
      expect(users).toHaveLength(1)
      expect(users[0].info).toMatchObject({
        id: history.items[0].messageID,
        origin: { type: "scheduled", scheduleID: created.id, occurrenceID: history.items[0].id },
      })
      expect(users[0].parts).toEqual([expect.objectContaining({ type: "text", text: input.message })])
      expect(
        yield* json<SessionScheduleV1.Info>(yield* request(f.listener.url, f.directory, `${root}/${created.id}`)),
      ).toMatchObject({ status: "completed", completed: 1 })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const status = yield* Effect.promise(() => f.sdk.session.status())
          return !status.data?.[f.sessionID] || status.data[f.sessionID].type === "idle" ? true : undefined
        }),
        "scheduled session did not become idle",
      )
      expect(
        yield* json<SessionScheduleV1.History>(
          yield* request(f.listener.url, f.directory, `${root}/${created.id}/history`),
        ),
      ).toEqual(history)
      expect(yield* f.llm.calls).toBe(1)
    }),
  )
})
