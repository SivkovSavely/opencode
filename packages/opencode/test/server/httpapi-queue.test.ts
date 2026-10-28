import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Deferred, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { HttpServer } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ManagedCommand } from "@opencode-ai/core/managed-command"
import {
  createOpencodeClient,
  type EventSessionQueueChanged,
  type SessionQueueV1Mutation,
  type SessionQueueV1Payload,
} from "@opencode-ai/sdk/v2"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Session } from "../../src/session/session"
import { SessionQueue } from "../../src/session/queue"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayerWithRuntime } from "./httpapi-layer"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"

const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    FSUtil.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
    Database.node,
    Session.node,
    SessionQueue.node,
  ]),
  [
    [
      InstanceStore.bootstrapNode,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ],
)
const authorization = `Basic ${Buffer.from("queue-user:queue-secret").toString("base64")}`
const runtime = RuntimeLifecycle.make({ lineage: randomUUID(), instance: randomUUID() }, Scope.makeUnsafe())
const it = testEffect(
  Layer.mergeAll(
    appLayer,
    Layer.unwrap(
      Effect.gen(function* () {
        const previous = RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable()
        yield* Effect.addFinalizer(() => Effect.sync(() => RuntimeLifecycle.setCurrent(previous)))
        return httpApiLayerWithRuntime(runtime)
      }),
    ).pipe(
      Layer.provide(appLayer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: "queue-secret",
            OPENCODE_SERVER_USERNAME: "queue-user",
          }),
        ),
      ),
    ),
    TestLLMServer.layer,
  ).pipe(
    Layer.provide(
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await disposeAllInstances()
            await resetDatabase()
          }),
        ),
      ),
    ),
  ),
)
const model = { providerID: "test", modelID: "test-model" }
type Sdk = ReturnType<typeof createOpencodeClient>

function client(directory: string, headers: Record<string, string> = { authorization }) {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => createOpencodeClient({ baseUrl: HttpServer.formatAddress(server.address), directory, headers })),
  )
}

function ok<T>(request: () => Promise<{ response: Response; data?: T; error?: unknown }>) {
  return Effect.promise(request).pipe(
    Effect.map((result) => {
      expect({ status: result.response.status, error: result.error }).toEqual({ status: 200, error: undefined })
      if (result.data === undefined) throw new Error("Missing SDK response body")
      return result.data
    }),
  )
}

function update(sdk: Sdk, sessionID: string, mutation: SessionQueueV1Mutation) {
  return Effect.gen(function* () {
    const current = yield* ok(() => sdk.session.queueList({ sessionID }))
    return yield* ok(() => sdk.session.queueUpdate({ sessionID, revision: current.revision, mutation }))
  })
}

function prompt(text: string): SessionQueueV1Payload {
  return { kind: "prompt", agent: "build", model, parts: [{ type: "text", text }] }
}

const fixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
  const sdk = yield* client(directory)
  const session = yield* ok(() => sdk.session.create({ title: "Native queue integration" }))
  return { sdk, directory, llm, sessionID: session.id }
})

function idle(sdk: Sdk, sessionID: string) {
  return pollWithTimeout(
    ok(() => sdk.session.status()).pipe(
      Effect.map((statuses) => (!statuses[sessionID] || statuses[sessionID].type === "idle" ? true : undefined)),
    ),
    "queued execution did not become idle",
  )
}

describe("native queue HttpApi SDK", () => {
  for (const profile of ["managed", "plugins", "unmanaged"] as const) {
    it.live(`enrolls only fresh managed roots without untracked plugin authority (${profile})`, () =>
      Effect.gen(function* () {
        const previous = {
          profile: process.env.OPENCODE_MANAGED_PROFILE,
          plugins: process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST,
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous.profile === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
            else process.env.OPENCODE_MANAGED_PROFILE = previous.profile
            if (previous.plugins === undefined) delete process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST
            else process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = previous.plugins
          }),
        )
        process.env.OPENCODE_MANAGED_PROFILE = profile === "unmanaged" ? "0" : "1"
        process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = profile === "plugins" ? '["trusted-plugin"]' : "[]"
        const { sessionID } = yield* fixture
        expect(yield* runtime.commandStatus(sessionID)).toBe(profile === "managed" ? "drained" : "unknown")
        // Neither another server profile nor a later configuration change can upgrade this root.
        process.env.OPENCODE_MANAGED_PROFILE = "1"
        process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = "[]"
        const database = yield* Database.Service
        yield* ManagedCommand.enrollCreatedRoot(database, sessionID)
        expect(yield* runtime.commandStatus(sessionID)).toBe(profile === "managed" ? "drained" : "unknown")
      }),
    )
  }

  it.live(
    "round-trips all payload contracts and deduplicates concurrent admissions without transcript or busy state",
    () =>
      Effect.gen(function* () {
        const { sdk, sessionID, llm } = yield* fixture
        const initial = yield* ok(() => sdk.session.queueList({ sessionID }))
        expect(initial).toEqual({ sessionID, revision: 0, paused: false, blocked: false, items: [] })
        const paused = yield* update(sdk, sessionID, { action: "pause", paused: true })
        const attachment = {
          type: "file" as const,
          mime: "text/plain",
          filename: "context.txt",
          url: "data:text/plain;base64,Y29udGV4dA==",
        }
        const payloads: SessionQueueV1Payload[] = [
          {
            kind: "prompt",
            agent: "build",
            model,
            variant: "careful",
            system: "Preserve the complete queued request",
            tools: { bash: false, read: true },
            format: {
              type: "json_schema",
              retryCount: 2,
              schema: { type: "object", properties: { answer: { type: "string" } } },
            },
            parts: [
              {
                type: "text",
                text: "queued request",
                metadata: { origin: "sdk", nested: { count: 2 } },
                ignored: false,
              },
              attachment,
              { type: "agent", name: "general", source: { value: "@general", start: 0, end: 8 } },
              { type: "subtask", agent: "general", prompt: "inspect context", description: "inspection", model },
            ],
          },
          {
            kind: "command",
            agent: "build",
            model,
            variant: "careful",
            command: "inspect",
            arguments: "a b",
            parts: [attachment],
          },
          // Admission only: pause prevents this shell payload from ever executing.
          { kind: "shell", agent: "build", model, variant: "careful", command: "printf queue-contract" },
          { kind: "compact", agent: "build", model, variant: "careful" },
        ]
        const submissions = payloads.map((payload, index) => ({ id: `contract-${index}`, payload }))
        const responses = yield* Effect.promise(() =>
          Promise.all(
            [...submissions, submissions[0]].map((submission) => sdk.session.queueSubmit({ sessionID, ...submission })),
          ),
        )
        expect(responses.map((result) => result.response.status)).toEqual([200, 200, 200, 200, 200])
        const listed = yield* ok(() => sdk.session.queueList({ sessionID }))
        expect(listed.paused).toBe(true)
        expect(listed.blocked).toBe(false)
        expect(listed.revision).toBe(paused.revision + submissions.length)
        expect(listed.items.filter((item) => item.delivery === "queue")).toHaveLength(4)
        for (const submission of submissions) {
          expect(listed.items.find((item) => item.id === submission.id)).toEqual({
            ...submission,
            sessionID,
            delivery: "queue",
            state: "pending",
            position: expect.any(Number),
            created: expect.any(Number),
          })
        }
        const retried = yield* ok(() => sdk.session.queueSubmit({ sessionID, ...submissions[0] }))
        expect(retried).toEqual(listed)
        const conflict = yield* Effect.promise(() =>
          sdk.session.queueSubmit({
            sessionID,
            ...submissions[0],
            payload: prompt("different request"),
          }),
        )
        expect(conflict.response.status).toBe(409)
        expect(conflict.error).toMatchObject({ _tag: "ConflictError", resource: sessionID })
        const changedPlacement = yield* Effect.promise(() =>
          sdk.session.queueSubmit({
            sessionID,
            ...submissions[0],
            front: true,
          }),
        )
        expect(changedPlacement.response.status).toBe(409)
        expect(yield* ok(() => sdk.session.queueList({ sessionID }))).toEqual(listed)
        expect(yield* ok(() => sdk.session.messages({ sessionID }))).toEqual([])
        expect((yield* ok(() => sdk.session.status()))[sessionID]?.type ?? "idle").toBe("idle")
        expect(yield* llm.calls).toBe(0)
      }),
  )

  it.live("treats async prompts as ordinary prompts after cancellation", () =>
    Effect.gen(function* () {
      const { sdk, sessionID, llm } = yield* fixture
      yield* llm.text("initial result")
      yield* ok(() =>
        sdk.session.prompt({
          sessionID,
          agent: "build",
          model,
          parts: [{ type: "text", text: "start session" }],
        }),
      )
      yield* awaitWithTimeout(llm.wait(1), "initial session prompt did not run")
      yield* idle(sdk, sessionID)

      yield* llm.text("PTY completion result")
      yield* Effect.promise(() =>
        sdk.session.promptAsync({
          sessionID,
          agent: "build",
          model,
          parts: [{ type: "text", text: "<pty_exited>\nID: pty_test\n</pty_exited>" }],
        }),
      )
      yield* awaitWithTimeout(llm.wait(2), "PTY notification did not resume the completed session")
      yield* idle(sdk, sessionID)
      expect(yield* llm.calls).toBe(2)

      const cancelledSession = yield* ok(() => sdk.session.create({ title: "Cancelled PTY notification" }))
      const release = Promise.withResolvers<void>()
      yield* llm.hold("active result", release.promise)
      yield* llm.text("must not run")
      yield* Effect.promise(() =>
        sdk.session.promptAsync({
          sessionID: cancelledSession.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "start cancellable session" }],
        }),
      )
      yield* awaitWithTimeout(llm.wait(3), "cancellable session prompt did not start")
      yield* ok(() => sdk.session.abort({ sessionID: cancelledSession.id }))
      const cancelledRuntime = yield* Database.Service.use(({ db }) =>
        db.get<{ state: string; fence: number }>(sql`
          SELECT state, fence FROM runtime_execution WHERE session_id = ${cancelledSession.id}
        `),
      )
      expect(cancelledRuntime?.state).toBe("cancelled")
      release.resolve()
      yield* idle(sdk, cancelledSession.id)

      yield* llm.text("must not run")
      yield* Effect.promise(() =>
        sdk.session.promptAsync({
          sessionID: cancelledSession.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "late PTY completion" }],
        }),
      )
      yield* awaitWithTimeout(llm.wait(4), "ordinary async prompt did not resume after cancellation")
      expect(yield* llm.calls).toBe(4)
      yield* idle(sdk, cancelledSession.id)
    }),
  )

  it.live("retires roots and rejects subsequent prompt and queue admissions", () =>
    Effect.gen(function* () {
      const { sdk, sessionID, directory, llm } = yield* fixture
      const server = yield* HttpServer.HttpServer
      const response = yield* Effect.promise(() =>
        fetch(
          `${HttpServer.formatAddress(server.address)}/session/${sessionID}/retire?directory=${encodeURIComponent(directory)}`,
          { method: "POST", headers: { authorization } },
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        rootSessionID: sessionID,
        sessionIDs: [sessionID],
        commandStatus: "unknown",
      })
      const payload = { sessionID, agent: "build", model, parts: [{ type: "text" as const, text: "after retirement" }] }
      expect((yield* Effect.promise(() => sdk.session.prompt(payload))).response.status).toBe(409)
      expect((yield* Effect.promise(() => sdk.session.promptAsync(payload))).response.status).toBe(409)
      expect((yield* Effect.promise(() => sdk.session.summarize({ sessionID, ...model }))).response.status).toBe(409)
      expect(
        (yield* Effect.promise(() => sdk.session.shell({ sessionID, agent: "build", command: "echo forbidden" })))
          .response.status,
      ).toBe(409)
      expect(
        (yield* Effect.promise(() => sdk.session.command({ sessionID, command: "missing", arguments: "" }))).response
          .status,
      ).toBe(409)
      expect(
        (yield* Effect.promise(() =>
          sdk.session.queueSubmit({ sessionID, id: randomUUID(), payload: prompt("queued") }),
        )).response.status,
      ).toBe(409)
      expect(yield* llm.calls).toBe(0)
    }),
  )

  it.live("returns bounded retirement status while an admitted local lease is held", () =>
    Effect.gen(function* () {
      const { sessionID, directory } = yield* fixture
      const admission = yield* runtime.admit({ sessionID, directory, manualRecovery: true })
      yield* Effect.addFinalizer(() => runtime.release(sessionID, admission.fence))
      const done = yield* Deferred.make<number>()
      const server = yield* HttpServer.HttpServer
      yield* Effect.promise(() =>
        fetch(
          `${HttpServer.formatAddress(server.address)}/session/${sessionID}/retire?directory=${encodeURIComponent(directory)}`,
          {
            method: "POST",
            headers: { authorization },
          },
        ),
      ).pipe(
        Effect.flatMap((response) => Deferred.succeed(done, response.status)),
        Effect.forkScoped,
      )
      yield* pollWithTimeout(
        Database.Service.use(({ db }) =>
          db.get<{ session_id: string }>(
            sql`SELECT session_id FROM runtime_retirement WHERE session_id = ${sessionID}`,
          ),
        ),
        "retirement barrier was not committed",
      )
      expect(yield* awaitWithTimeout(Deferred.await(done), "retirement waited for a held lease")).toBe(200)
      yield* runtime.release(sessionID, admission.fence)
    }),
  )

  it.live("interrupts descendants during retirement even when the root already has a cancellation owner", () =>
    Effect.gen(function* () {
      const { sdk, sessionID, directory, llm } = yield* fixture
      const child = yield* ok(() => sdk.session.create({ parentID: sessionID }))
      const release = Promise.withResolvers<void>()
      yield* llm.hold("child", release.promise)
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* Effect.promise(() =>
        sdk.session.promptAsync({
          sessionID: child.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "start child" }],
        }),
      )
      yield* awaitWithTimeout(llm.wait(1), "child prompt did not start")
      expect(yield* runtime.cancel(sessionID)).toBe(true)
      yield* Effect.addFinalizer(() => runtime.finishCancel(sessionID))
      const server = yield* HttpServer.HttpServer
      const response = yield* Effect.promise(() =>
        fetch(
          `${HttpServer.formatAddress(server.address)}/session/${sessionID}/retire?directory=${encodeURIComponent(directory)}`,
          { method: "POST", headers: { authorization } },
        ),
      )
      expect(response.status).toBe(200)
      yield* awaitWithTimeout(runtime.waitForIdle(child.id), "retirement skipped the descendant interruption")
      // The retire handler must not acknowledge the owner's cancellation marker.
      expect(yield* runtime.cancel(sessionID)).toBe(false)
    }),
  )

  it.live("keeps retirement durable when the caller abandons the request", () =>
    Effect.gen(function* () {
      const { sessionID, directory, sdk } = yield* fixture
      const admission = yield* runtime.admit({ sessionID, directory, manualRecovery: true })
      yield* Effect.addFinalizer(() => runtime.release(sessionID, admission.fence))
      const controller = new AbortController()
      const server = yield* HttpServer.HttpServer
      const url = `${HttpServer.formatAddress(server.address)}/session/${sessionID}/retire?directory=${encodeURIComponent(directory)}`
      const pending = fetch(url, { method: "POST", headers: { authorization }, signal: controller.signal }).catch(
        () => undefined,
      )
      yield* pollWithTimeout(
        Database.Service.use(({ db }) =>
          db.get<{ session_id: string }>(
            sql`SELECT session_id FROM runtime_retirement WHERE session_id = ${sessionID}`,
          ),
        ),
        "retirement barrier was not committed",
      )
      controller.abort()
      // A bounded retirement may already have returned before abort reaches the transport.
      yield* Effect.promise(() => pending)
      expect(
        (yield* Effect.promise(() =>
          sdk.session.promptAsync({ sessionID, agent: "build", model, parts: [{ type: "text", text: "after" }] }),
        )).response.status,
      ).toBe(409)
      yield* runtime.release(sessionID, admission.fence)
      const retry = yield* Effect.promise(() => fetch(url, { method: "POST", headers: { authorization } }))
      expect(retry.status).toBe(200)
      expect((yield* Effect.promise(() => retry.json())).commandStatus).toBe("unknown")
    }),
  )

  it.live("joins concurrent abort and retirement of an active session", () =>
    Effect.gen(function* () {
      const { sdk, sessionID, directory, llm } = yield* fixture
      const release = Promise.withResolvers<void>()
      yield* llm.hold("active", release.promise)
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* Effect.promise(() =>
        sdk.session.promptAsync({
          sessionID,
          agent: "build",
          model,
          parts: [{ type: "text", text: "start" }],
        }),
      )
      yield* awaitWithTimeout(llm.wait(1), "prompt did not start")
      const server = yield* HttpServer.HttpServer
      const [abort, retired] = yield* Effect.all(
        [
          Effect.promise(() => sdk.session.abort({ sessionID })),
          Effect.promise(() =>
            fetch(
              `${HttpServer.formatAddress(server.address)}/session/${sessionID}/retire?directory=${encodeURIComponent(directory)}`,
              {
                method: "POST",
                headers: { authorization },
              },
            ),
          ),
        ],
        { concurrency: "unbounded" },
      )
      expect(abort.response.status).toBe(200)
      expect(retired.status).toBe(200)
      expect(["draining", "unknown"]).toContain((yield* Effect.promise(() => retired.json())).commandStatus)
      expect(
        (yield* Effect.promise(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            model,
            parts: [{ type: "text", text: "after" }],
          }),
        )).response.status,
      ).toBe(409)
    }),
  )

  it.live("uses revisions and stable IDs for reorder, delete, conversion, and queue-only clear", () =>
    Effect.gen(function* () {
      const { sdk, sessionID, llm } = yield* fixture
      yield* update(sdk, sessionID, { action: "pause", paused: true })
      for (const id of ["one", "two", "front"]) {
        yield* ok(() =>
          sdk.session.queueSubmit({
            sessionID,
            id,
            payload: prompt(id),
            front: id === "front",
          }),
        )
      }
      const before = yield* ok(() => sdk.session.queueList({ sessionID }))
      expect(before.items.map((item) => item.id)).toEqual(["front", "one", "two"])
      const reordered = yield* update(sdk, sessionID, {
        action: "reorder",
        delivery: "queue",
        ids: ["two", "front", "one"],
      })
      expect(reordered.items.map((item) => item.id)).toEqual(["two", "front", "one"])
      expect(reordered.items.map((item) => item.payload)).toEqual([
        before.items[2].payload,
        before.items[0].payload,
        before.items[1].payload,
      ])
      const stale = yield* Effect.promise(() =>
        sdk.session.queueUpdate({
          sessionID,
          revision: before.revision,
          mutation: { action: "clear" },
        }),
      )
      expect(stale.response.status).toBe(409)
      expect(stale.error).toMatchObject({ _tag: "ConflictError" })
      expect(yield* ok(() => sdk.session.queueList({ sessionID }))).toEqual(reordered)
      const deleted = yield* update(sdk, sessionID, { action: "delete", id: "front" })
      expect(deleted.items.map((item) => item.id)).toEqual(["two", "one"])

      const steer = yield* ok(() =>
        sdk.session.prompt({
          sessionID,
          agent: "build",
          model,
          noReply: true,
          parts: [{ type: "text", text: "convert me" }],
        }),
      )
      const converted = yield* update(sdk, sessionID, { action: "convert", id: steer.info.id, delivery: "queue" })
      expect(converted.items.find((item) => item.id === steer.info.id)).toMatchObject({
        delivery: "queue",
        state: "pending",
      })
      expect(converted.items.find((item) => item.id === steer.info.id)?.messageID).toBeUndefined()
      expect(yield* ok(() => sdk.session.messages({ sessionID }))).toEqual([])
      const preserved = yield* ok(() =>
        sdk.session.prompt({
          sessionID,
          agent: "build",
          model,
          noReply: true,
          parts: [{ type: "text", text: "keep this steer" }],
        }),
      )
      const cleared = yield* update(sdk, sessionID, { action: "clear" })
      expect(cleared.items).toHaveLength(1)
      expect(cleared.items[0]).toMatchObject({
        id: preserved.info.id,
        messageID: preserved.info.id,
        delivery: "steer",
        state: "pending",
      })
      expect((yield* ok(() => sdk.session.messages({ sessionID }))).map((message) => message.info.id)).toEqual([
        preserved.info.id,
      ])
      expect(yield* llm.calls).toBe(0)
    }),
  )

  for (const scope of ["directory", "project"]) {
    it.live(`rejects an out-of-${scope} session on every queue route`, () =>
      Effect.gen(function* () {
        const { sdk, sessionID, directory, llm } = yield* fixture
        yield* update(sdk, sessionID, { action: "pause", paused: true })
        const sameProject = `${directory}/nested`
        yield* FSUtil.Service.use((fs) => fs.ensureDir(sameProject))
        const target =
          scope === "directory" ? sameProject : yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const local = yield* ok(() => sdk.project.current())
        const foreign = yield* client(target)
        const project = yield* ok(() => foreign.project.current())
        expect(project.id === local.id).toBe(scope === "directory")
        const results = yield* Effect.promise(() =>
          Promise.all([
            foreign.session.queueList({ sessionID, directory: target }),
            foreign.session.queueSubmit({
              sessionID,
              directory: target,
              id: "foreign",
              payload: prompt("foreign"),
            }),
            foreign.session.queueUpdate({
              sessionID,
              directory: target,
              revision: 1,
              mutation: { action: "clear" },
            }),
            foreign.session.queueFlush({ sessionID, directory: target }),
          ]),
        )
        expect(results.map((result) => result.response.status)).toEqual([403, 403, 403, 403])
        expect(results.every((result) => result.error?._tag === "ForbiddenError")).toBe(true)
        expect((yield* ok(() => sdk.session.queueList({ sessionID }))).items).toEqual([])
        expect(yield* llm.calls).toBe(0)
      }),
    )
  }

  it.live("rejects missing and archived sessions on every queue route", () =>
    Effect.gen(function* () {
      const { sdk, sessionID, llm } = yield* fixture
      const missing = yield* Effect.promise(() =>
        Promise.all([
          sdk.session.queueList({ sessionID: "ses_missing" }),
          sdk.session.queueSubmit({
            sessionID: "ses_missing",
            id: "missing",
            payload: prompt("missing"),
          }),
          sdk.session.queueUpdate({
            sessionID: "ses_missing",
            revision: 0,
            mutation: { action: "clear" },
          }),
          sdk.session.queueFlush({ sessionID: "ses_missing" }),
        ]),
      )
      expect(missing.map((result) => result.response.status)).toEqual([404, 404, 404, 404])
      yield* ok(() => sdk.session.update({ sessionID, time: { archived: Date.now() } }))
      const archived = yield* Effect.promise(() =>
        Promise.all([
          sdk.session.queueList({ sessionID }),
          sdk.session.queueSubmit({ sessionID, id: "archived", payload: prompt("archived") }),
          sdk.session.queueUpdate({ sessionID, revision: 0, mutation: { action: "clear" } }),
          sdk.session.queueFlush({ sessionID }),
        ]),
      )
      expect(archived.map((result) => result.response.status)).toEqual([409, 409, 409, 409])
      expect(archived.every((result) => result.error?._tag === "ConflictError")).toBe(true)
      expect(yield* llm.calls).toBe(0)
    }),
  )

  it.live("applies existing basic authentication middleware to all queue operations", () =>
    Effect.gen(function* () {
      const { sdk, sessionID, directory, llm } = yield* fixture
      yield* update(sdk, sessionID, { action: "pause", paused: true })
      for (const password of [undefined, "wrong", "queue-secret"]) {
        const authenticated = yield* client(
          directory,
          password
            ? {
                authorization: `Basic ${Buffer.from(`queue-user:${password}`).toString("base64")}`,
              }
            : {},
        )
        const results = yield* Effect.forEach(
          [
            () => authenticated.session.queueList({ sessionID }),
            () =>
              authenticated.session.queueUpdate({
                sessionID,
                revision: 1,
                mutation: { action: "pause", paused: true },
              }),
            () =>
              authenticated.session.queueSubmit({
                sessionID,
                id: "auth",
                payload: prompt("authorized"),
              }),
            () => authenticated.session.queueFlush({ sessionID: "ses_missing" }),
          ],
          (request) => Effect.promise(request),
        )
        if (password !== "queue-secret") {
          expect(results.map((result) => result.response.status)).toEqual([401, 401, 401, 401])
          continue
        }
        // The missing-session response proves an authenticated flush reached its handler without executing work.
        expect(results.map((result) => result.response.status)).toEqual([200, 200, 200, 404])
      }
      expect(yield* llm.calls).toBe(0)
    }),
  )

  it.live("delivers typed queue revision invalidations through the native SDK event stream", () =>
    Effect.gen(function* () {
      const { sdk, sessionID } = yield* fixture
      const controller = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      const events = yield* Effect.promise(() => sdk.event.subscribe(undefined, { signal: controller.signal }))
      const ready = yield* Deferred.make<void>()
      const received = yield* Deferred.make<EventSessionQueueChanged>()
      yield* Effect.promise(async () => {
        for await (const event of events.stream) {
          if (event.type === "server.connected") Deferred.doneUnsafe(ready, Effect.void)
          if (event.type !== "session.queue.changed" || event.properties.sessionID !== sessionID) continue
          Deferred.doneUnsafe(received, Effect.succeed(event))
          return
        }
      }).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(Deferred.await(ready), "SDK event stream did not connect")
      const paused = yield* update(sdk, sessionID, { action: "pause", paused: true })
      const changed = yield* awaitWithTimeout(Deferred.await(received), "queue revision event was not delivered")
      expect(changed).toEqual({
        id: expect.any(String),
        type: "session.queue.changed",
        properties: { sessionID, revision: paused.revision },
      })
      expect(yield* ok(() => sdk.session.queueList({ sessionID }))).toEqual(paused)
    }),
  )

  it.live("converts a paused queued prompt into a visible steer at the next successful provider boundary", () =>
    Effect.gen(function* () {
      const { sdk, sessionID, llm } = yield* fixture
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* llm.hold("initial result", release.promise)
      yield* llm.text("steer result")
      yield* Effect.promise(() =>
        sdk.session.promptAsync({ sessionID, agent: "build", model, parts: [{ type: "text", text: "initial input" }] }),
      )
      yield* awaitWithTimeout(llm.wait(1), "initial provider call did not start")
      yield* update(sdk, sessionID, { action: "pause", paused: true })
      yield* ok(() => sdk.session.queueSubmit({ sessionID, id: "convert", payload: prompt("steer input") }))
      expect(
        (yield* ok(() => sdk.session.messages({ sessionID }))).filter((message) => message.info.role === "user"),
      ).toHaveLength(1)
      const converted = yield* update(sdk, sessionID, { action: "convert", id: "convert", delivery: "steer" })
      expect(converted.paused).toBe(true)
      expect(converted.items).toMatchObject([
        { id: "convert", messageID: "msg_queue_convert", delivery: "steer", state: "pending" },
      ])
      const bubble = (yield* ok(() => sdk.session.messages({ sessionID }))).find(
        (message) => message.info.id === "msg_queue_convert",
      )
      expect(bubble?.info.role).toBe("user")
      expect(bubble?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "steer input" }))
      expect(yield* llm.calls).toBe(1)
      release.resolve()
      yield* awaitWithTimeout(llm.wait(2), "converted steer did not execute")
      yield* idle(sdk, sessionID)
      expect(JSON.stringify((yield* llm.inputs)[1])).toContain("steer input")
      expect((yield* ok(() => sdk.session.queueList({ sessionID }))).items).toEqual([])
      const messages = yield* ok(() => sdk.session.messages({ sessionID }))
      expect(
        messages
          .filter((message) => message.info.role === "assistant")
          .map((message) => message.info.role === "assistant" && message.info.error),
      ).toEqual([undefined, undefined])
      expect(JSON.stringify(messages)).toContain("steer result")
      expect(yield* llm.calls).toBe(2)
    }),
  )

  it.live("coalesces concurrent flushes and runs immediate queued submissions serially through the real provider", () =>
    Effect.gen(function* () {
      const { sdk, sessionID, llm } = yield* fixture
      yield* update(sdk, sessionID, { action: "pause", paused: true })
      yield* ok(() => sdk.session.queueSubmit({ sessionID, id: "first", payload: prompt("first input") }))
      yield* ok(() => sdk.session.queueSubmit({ sessionID, id: "second", payload: prompt("second input") }))
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* llm.hold("first result", release.promise)
      yield* llm.text("second result")
      const flushed = yield* Effect.promise(() =>
        Promise.all([sdk.session.queueFlush({ sessionID }), sdk.session.queueFlush({ sessionID })]),
      )
      expect(flushed.map((result) => result.response.status)).toEqual([200, 200])
      yield* awaitWithTimeout(llm.wait(1), "flushed provider call did not start")
      expect(yield* llm.calls).toBe(1)
      expect(JSON.stringify((yield* llm.inputs)[0])).toContain("first input")
      expect(JSON.stringify((yield* llm.inputs)[0])).not.toContain("second input")
      release.resolve()
      yield* idle(sdk, sessionID)
      expect(yield* llm.calls).toBe(2)
      const pending = yield* ok(() => sdk.session.queueList({ sessionID }))
      expect(pending.paused).toBe(true)
      expect(pending.items).toEqual([])
      yield* update(sdk, sessionID, { action: "pause", paused: false })
      yield* awaitWithTimeout(llm.wait(2), "unpaused provider call did not start")
      yield* idle(sdk, sessionID)
      yield* llm.text("immediate result")
      yield* ok(() =>
        sdk.session.queueSubmit({
          sessionID,
          id: "immediate",
          payload: prompt("immediate input"),
        }),
      )
      yield* awaitWithTimeout(llm.wait(3), "idle submission did not execute immediately")
      yield* idle(sdk, sessionID)
      const messages = yield* ok(() => sdk.session.messages({ sessionID }))
      expect(messages.filter((message) => message.info.role === "user").map((message) => message.info.id)).toEqual([
        "msg_queue_first",
        "msg_queue_second",
        "msg_queue_immediate",
      ])
      const assistants = messages.filter((message) => message.info.role === "assistant")
      expect(assistants).toHaveLength(3)
      expect(
        assistants.every(
          (message) => message.info.role === "assistant" && !message.info.error && message.info.finish === "stop",
        ),
      ).toBe(true)
      expect(
        assistants.flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text)),
      ).toEqual(["first result", "second result", "immediate result"])
      expect(JSON.stringify((yield* llm.inputs)[1])).toContain("second input")
      expect((yield* ok(() => sdk.session.queueList({ sessionID }))).items).toEqual([])
      expect(yield* llm.calls).toBe(3)
    }),
  )
})
