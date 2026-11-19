import { expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionWatchStore } from "@opencode-ai/core/session/watch-store"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionWatch } from "@/session/watch"
import { SessionQueue } from "@/session/queue"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { MessageID } from "@/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, LayerNode.compile(CrossSpawnSpawner.node)))

const fixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const directory = yield* tmpdirScoped({
    git: true,
    config: { ...testProviderConfig(llm.url), model: "test/test-model", shell: "/bin/sh" },
  })
  const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope)
  const context = yield* Layer.build(
    AppNodeBuilderV1.build(
      LayerNode.group([
        Session.node,
        SessionPrompt.node,
        SessionQueue.node,
        ToolRegistry.node,
        Agent.node,
        Permission.node,
        InstanceStore.node,
        Database.node,
        SessionProjector.node,
      ]),
    ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime))),
  )
  const database = Context.get(context, Database.Service)
  runtime.bindDatabase(database)
  return {
    llm,
    directory,
    runtime,
    context,
    database,
    store: Context.get(context, InstanceStore.Service),
    agents: Context.get(context, Agent.Service),
  }
})

it.live("one-shot acceptance is atomic and never treats admission-only idle as successful completion", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const source = yield* sessions.create({ title: "source" })
        const destination = yield* sessions.create({ title: "destination" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed"],
          mode: "once",
          delivery: "auto",
          limit: 8,
        })
        const idle = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* f.runtime.release(source.id, idle.fence)
        expect((yield* SessionWatchStore.get(f.database, destination.id, watch.id)).status).toBe("active")
        const active = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* SessionWatchStore.result(f.database, source.id, {
          outcome: "completed",
          summary: "done",
          ownerLineage: f.runtime.identity.lineage,
          ownerInstance: f.runtime.identity.instance,
          fence: active.fence,
        })
        yield* f.runtime.release(source.id, active.fence)
        const saved = yield* SessionWatchStore.get(f.database, destination.id, watch.id)
        expect(saved.status).toBe("resolved")
        expect(saved.accepted).toBe(1)
        yield* f.runtime.release(source.id, active.fence)
        expect((yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).length).toBe(1)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("active watches bind one execution while idle registration only observes future executions", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const source = yield* sessions.create({ title: "source" })
        const destination = yield* sessions.create({ title: "destination" })
        const admission = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        const first = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["failed", "idle"],
          mode: "once",
          delivery: "record",
          limit: 8,
        })
        yield* SessionWatchStore.result(f.database, source.id, {
          outcome: "failed",
          summary: "provider failed",
          ownerLineage: f.runtime.identity.lineage,
          ownerInstance: f.runtime.identity.instance,
          fence: admission.fence,
        })
        yield* f.runtime.release(source.id, admission.fence)
        const second = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed", "cancelled"],
          mode: "persistent",
          delivery: "record",
          limit: 2,
        })
        expect((yield* SessionWatchStore.deliveries(f.database, destination.id, second.id)).length).toBe(0)
        const next = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* SessionWatchStore.result(f.database, source.id, {
          outcome: "completed",
          summary: "ok",
          ownerLineage: f.runtime.identity.lineage,
          ownerInstance: f.runtime.identity.instance,
          fence: next.fence,
        })
        yield* f.runtime.release(source.id, next.fence)
        const cancelled = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* f.runtime.cancel(source.id)
        yield* f.runtime.release(source.id, cancelled.fence)
        yield* f.runtime.finishCancel(source.id)
        const one = yield* SessionWatchStore.deliveries(f.database, destination.id, first.id)
        const many = yield* SessionWatchStore.deliveries(f.database, destination.id, second.id)
        expect(one.map((item) => item.outcome)).toEqual(["failed"])
        expect(many.map((item) => item.outcome)).toEqual(["completed", "cancelled"])
        expect(new Set([...one, ...many].map((item) => item.executionID)).size).toBe(3)
        expect((yield* SessionWatchStore.get(f.database, destination.id, second.id)).status).toBe("exhausted")
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("automatic delivery resumes an idle destination once through the real queue and runner", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.llm.text("source complete")
    yield* f.llm.text("notification processed")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const source = yield* sessions.create({ title: "watched", agent: "build" })
        const destination = yield* sessions.create({ title: "controller", agent: "build" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed"],
          mode: "once",
          delivery: "auto",
          limit: 8,
        })
        yield* prompt.prompt({ sessionID: source.id, parts: [{ type: "text", text: "finish" }] })
        const worker = SessionWatch.engine({ ...f, prompt, queue })
        yield* worker.tick
        yield* pollWithTimeout(
          Effect.gen(function* () {
            yield* worker.tick
            const deliveries = yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)
            return deliveries[0]?.state === "delivered" ? true : undefined
          }),
          "notification was not acknowledged",
        )
        yield* f.runtime.waitForIdle(destination.id)
        yield* worker.tick
        const messages = yield* sessions.messages({ sessionID: destination.id })
        expect(messages.filter((item) => item.info.role === "user")).toHaveLength(1)
        expect(
          messages
            .flatMap((item) => item.parts)
            .some((part) => part.type === "text" && part.text === "notification processed"),
        ).toBe(true)
        expect(yield* f.llm.calls).toBe(2)
        expect(
          yield* f.database.db.all(sql`SELECT id FROM session_watch_delivery WHERE watch_id = ${watch.id}`),
        ).toHaveLength(1)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("direct shell success publishes one completed outcome and automatically resumes its watcher", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.llm.text("shell completion observed")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const source = yield* sessions.create({ title: "direct shell" })
        const destination = yield* sessions.create({ title: "shell observer" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed"],
          mode: "once",
          delivery: "auto",
          limit: 1,
        })
        const result = yield* prompt.shell({ sessionID: source.id, agent: "build", command: "printf SHELL_SUCCESS" })
        expect(Object.keys(result).sort()).toEqual(["aborted", "info", "parts"])
        expect(result.parts).toMatchObject([
          {
            state: {
              status: "completed",
              input: { command: "printf SHELL_SUCCESS" },
              output: "SHELL_SUCCESS",
              metadata: { output: "SHELL_SUCCESS" },
              title: "",
            },
          },
        ])
        expect(
          result.parts.map((part) =>
            part.type === "tool" && part.state.status === "completed" ? part.state.metadata : undefined,
          ),
        ).toEqual([{ output: "SHELL_SUCCESS" }])
        expect(
          yield* f.database.db.get(
            sql`SELECT state, result, message_id FROM session_watch_execution WHERE session_id = ${source.id}`,
          ),
        ).toEqual({ state: "terminal", result: "completed", message_id: result.info.id })
        const worker = SessionWatch.engine({ ...f, prompt, queue })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            yield* worker.tick
            const deliveries = yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)
            return deliveries[0]?.state === "delivered" ? true : undefined
          }),
          "shell completion was not delivered through the durable queue",
        )
        yield* awaitWithTimeout(f.runtime.waitForIdle(destination.id), "shell observer did not finish")
        yield* worker.tick
        yield* worker.tick
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toMatchObject([
          { outcome: "completed", state: "delivered" },
        ])
        expect(
          (yield* sessions.messages({ sessionID: destination.id })).filter((item) => item.info.role === "user"),
        ).toHaveLength(1)
        expect(yield* f.llm.calls).toBe(1)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("direct shell nonzero exit records failure without changing its returned or persisted output", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const source = yield* sessions.create({ title: "nonzero shell" })
        const destination = yield* sessions.create({ title: "exit status observer" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed", "failed"],
          mode: "once",
          delivery: "record",
          limit: 1,
        })
        const result = yield* prompt.shell({
          sessionID: source.id,
          agent: "build",
          command: "printf SHELL_FAILURE; exit 7",
        })
        expect(Object.keys(result).sort()).toEqual(["aborted", "info", "parts"])
        expect(result.parts).toMatchObject([
          {
            state: {
              status: "completed",
              input: { command: "printf SHELL_FAILURE; exit 7" },
              output: "SHELL_FAILURE",
              metadata: { output: "SHELL_FAILURE" },
              title: "",
            },
          },
        ])
        expect(
          result.parts.map((part) =>
            part.type === "tool" && part.state.status === "completed" ? part.state.metadata : undefined,
          ),
        ).toEqual([{ output: "SHELL_FAILURE" }])
        expect(
          (yield* sessions.messages({ sessionID: source.id })).find((item) => item.info.id === result.info.id)?.parts,
        ).toEqual(result.parts)
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toMatchObject([
          { outcome: "failed", state: "recorded" },
        ])
        expect(
          yield* f.database.db.get(
            sql`SELECT result, message_id FROM session_watch_execution WHERE session_id = ${source.id}`,
          ),
        ).toEqual({ result: "failed", message_id: result.info.id })
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

for (const interruption of ["cancelled", "recovered"] as const) {
  it.live(`direct shell late exit cannot publish completion after ${interruption} ownership`, () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const release = `${f.directory}/.watch-shell-release`
      yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "release")))
      yield* f.store.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const source = yield* sessions.create({ title: "held direct shell" })
          const destination = yield* sessions.create({ title: "held shell observer" })
          const watch = yield* SessionWatchStore.create(f.database, {
            id: randomUUID(),
            owner: destination.id,
            source: source.id,
            destination: destination.id,
            events: ["completed", "failed", "cancelled"],
            mode: "persistent",
            delivery: "record",
            limit: 4,
          })
          const running = yield* prompt
            .shell({
              sessionID: source.id,
              agent: "build",
              command:
                "printf READY > .watch-shell-ready; while [ ! -f .watch-shell-release ]; do sleep 0.02; done; printf LATE_SUCCESS",
            })
            .pipe(Effect.exit, Effect.forkScoped)
          yield* pollWithTimeout(
            Effect.promise(async () =>
              (await Bun.file(`${f.directory}/.watch-shell-ready`).exists()) ? true : undefined,
            ),
            "shell process did not start",
          )
          expect(
            yield* f.database.db.get(sql`SELECT result FROM session_watch_execution WHERE session_id = ${source.id}`),
          ).toEqual({ result: null })
          expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toHaveLength(0)
          const started = yield* Deferred.make<number>()
          const finish = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined))
          const current =
            interruption === "recovered"
              ? RuntimeLifecycle.make({ lineage: f.runtime.identity.lineage }, yield* Effect.scope, f.database)
              : undefined
          const oldFence = yield* f.runtime.ownershipFence(source.id)
          if (current) {
            yield* f.runtime.park(source.id)
            yield* current.recover((record) =>
              Deferred.succeed(started, record.fence).pipe(Effect.andThen(Deferred.await(finish))),
            )
            expect(
              yield* awaitWithTimeout(Deferred.await(started), "replacement did not claim shell execution"),
            ).not.toBe(oldFence)
            yield* Effect.promise(() => Bun.write(release, "release"))
          }
          if (interruption === "cancelled") yield* prompt.cancel(source.id)
          const result = yield* awaitWithTimeout(Fiber.join(running), "held shell did not settle")
          expect(result._tag).toBe("Success")
          if (result._tag === "Success")
            expect(result.value.parts).toMatchObject([
              {
                state: {
                  output:
                    interruption === "cancelled" ? expect.stringContaining("User aborted the command") : "LATE_SUCCESS",
                },
              },
            ])
          expect(
            yield* f.database.db.get(sql`SELECT result FROM session_watch_execution WHERE session_id = ${source.id}`),
          ).toEqual({ result: null })
          if (current) {
            expect(yield* current.beforeTurn(source.id)).toBe(true)
            yield* Deferred.succeed(finish, undefined)
            yield* awaitWithTimeout(current.waitForIdle(source.id), "replacement shell recovery did not finish")
          }
          expect(
            (yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).map((item) => item.outcome),
          ).toEqual(interruption === "cancelled" ? ["cancelled"] : [])
          expect(yield* f.llm.calls).toBe(0)
        }).pipe(Effect.provide(f.context)),
      )
    }),
  )
}

it.live("queued shell execution does not complete its watch before model continuation finishes", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const gate = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
    yield* f.llm.hold("model continuation completed", gate.promise)
    yield* f.llm.text("queued shell completion observed")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const source = yield* sessions.create({ title: "queued shell continuation" })
        const destination = yield* sessions.create({ title: "queued shell observer" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed"],
          mode: "once",
          delivery: "auto",
          limit: 1,
        })
        yield* queue.enqueue(source.id, {
          id: "queued-shell",
          payload: {
            kind: "shell",
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            command: "printf QUEUED_SHELL",
          },
        })
        yield* prompt.queueWake(source.id)
        yield* awaitWithTimeout(f.llm.wait(1), "queued shell did not continue into the model")
        expect(
          yield* f.database.db.get(
            sql`SELECT state, result FROM session_watch_execution WHERE session_id = ${source.id}`,
          ),
        ).toEqual({ state: "running", result: null })
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toHaveLength(0)
        gate.resolve()
        yield* awaitWithTimeout(f.runtime.waitForIdle(source.id), "queued shell continuation did not finish")
        const assistant = (yield* sessions.messages({ sessionID: source.id })).find((item) =>
          item.parts.some((part) => part.type === "text" && part.text === "model continuation completed"),
        )
        expect(assistant).toBeDefined()
        expect(
          yield* f.database.db.get(
            sql`SELECT result, message_id FROM session_watch_execution WHERE session_id = ${source.id}`,
          ),
        ).toEqual({ result: "completed", message_id: assistant?.info.id })
        const worker = SessionWatch.engine({ ...f, prompt, queue })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            yield* worker.tick
            const deliveries = yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)
            return deliveries[0]?.state === "delivered" ? true : undefined
          }),
          "queued shell completion was not delivered",
        )
        yield* awaitWithTimeout(f.runtime.waitForIdle(destination.id), "queued shell observer did not finish")
        yield* worker.tick
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toHaveLength(1)
        expect(yield* f.llm.calls).toBe(2)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("admitted preparation failures deliver one durable failed notification per execution", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.llm.text("first failure observed")
    yield* f.llm.text("second failure observed")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const source = yield* sessions.create({ title: "preparation failure" })
        const destination = yield* sessions.create({ title: "failure observer" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["failed"],
          mode: "persistent",
          delivery: "auto",
          limit: 2,
        })
        const worker = SessionWatch.engine({ ...f, prompt, queue })
        const messageID = MessageID.ascending()
        for (const noReply of [false, true]) {
          const result = yield* prompt
            .prompt({
              sessionID: source.id,
              messageID,
              idempotent: true,
              noReply,
              agent: "missing-selected-agent",
              parts: [{ type: "text", text: "not admitted to history" }],
            })
            .pipe(Effect.exit)
          expect(result._tag).toBe("Failure")
          expect(yield* sessions.messages({ sessionID: source.id })).toHaveLength(0)
          const count = noReply ? 2 : 1
          expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toHaveLength(count)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              yield* worker.tick
              const deliveries = yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)
              return deliveries.filter((item) => item.state === "delivered").length === count ? true : undefined
            }),
            "failed preparation notification was not delivered",
          )
          yield* awaitWithTimeout(f.runtime.waitForIdle(destination.id), "failure observer did not finish")
        }
        const deliveries = yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)
        expect(deliveries.map((item) => item.outcome)).toEqual(["failed", "failed"])
        expect(new Set(deliveries.map((item) => item.executionID)).size).toBe(2)
        expect(
          yield* f.database.db.all(sql`SELECT result FROM session_watch_execution WHERE session_id = ${source.id}`),
        ).toEqual([{ result: "failed" }, { result: "failed" }])
        yield* worker.tick
        yield* worker.tick
        expect(yield* f.llm.calls).toBe(2)
        expect(
          (yield* sessions.messages({ sessionID: destination.id })).filter((item) => item.info.role === "user"),
        ).toHaveLength(2)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("queued preparation failures retain one failed outcome without replaying uncertain input", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.llm.text("queued failure observed")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const source = yield* sessions.create({ title: "queued preparation failure" })
        const destination = yield* sessions.create({ title: "queue failure observer" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["failed"],
          mode: "once",
          delivery: "auto",
          limit: 1,
        })
        yield* queue.enqueue(source.id, {
          id: "missing-agent",
          payload: {
            kind: "prompt",
            agent: "missing-selected-agent",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "cannot prepare" }],
          },
        })
        yield* prompt.queueWake(source.id)
        yield* awaitWithTimeout(f.runtime.waitForIdle(source.id), "failed queued execution was not released")
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toMatchObject([
          { outcome: "failed", state: "pending" },
        ])
        const worker = SessionWatch.engine({ ...f, prompt, queue })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            yield* worker.tick
            const deliveries = yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)
            return deliveries[0]?.state === "delivered" ? true : undefined
          }),
          "queued failure notification was not delivered",
        )
        yield* awaitWithTimeout(f.runtime.waitForIdle(destination.id), "queued failure observer did not finish")
        yield* prompt.queueWake(source.id)
        yield* worker.tick
        expect((yield* queue.list(source.id)).items).toMatchObject([{ state: "uncertain" }])
        expect(yield* sessions.messages({ sessionID: source.id })).toHaveLength(0)
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toHaveLength(1)
        expect(yield* f.llm.calls).toBe(1)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("multiple failed inputs sharing an execution accept only one terminal event", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const source = yield* sessions.create({ title: "shared preparation failures" })
        const destination = yield* sessions.create({ title: "shared failure observer" })
        const lease = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["failed"],
          mode: "persistent",
          delivery: "record",
          limit: 4,
        })
        const input = {
          sessionID: source.id,
          agent: "missing-selected-agent",
          parts: [{ type: "text" as const, text: "fail" }],
        }
        const exits = yield* Effect.all(
          [prompt.prompt(input).pipe(Effect.exit), prompt.prompt(input).pipe(Effect.exit)],
          { concurrency: "unbounded" },
        )
        expect(exits.map((exit) => exit._tag)).toEqual(["Failure", "Failure"])
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toHaveLength(0)
        yield* f.runtime.release(source.id, lease.fence)
        yield* f.runtime.release(source.id, lease.fence)
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toMatchObject([
          { outcome: "failed", state: "recorded" },
        ])
        expect(
          yield* f.database.db.all(sql`SELECT id FROM session_watch_event WHERE source_id = ${source.id}
          AND outcome = 'failed'`),
        ).toHaveLength(1)
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

for (const replacement of ["cancelled", "recovered"] as const) {
  it.live(`late preparation failures cannot overwrite ${replacement} execution ownership`, () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* Effect.promise(() =>
        Bun.write(
          `${f.directory}/.opencode/skills/preparation-gate/SKILL.md`,
          "---\nname: preparation-gate\ndescription: Hold preparation for a real permission decision.\n---\nPreparation gate.\n",
        ),
      )
      yield* f.store.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const permission = yield* Permission.Service
          const source = yield* sessions.create({
            title: "delayed preparation",
            permission: [{ permission: "skill", pattern: "preparation-gate", action: "ask" }],
          })
          const destination = yield* sessions.create({ title: "late failure observer" })
          const watch = yield* SessionWatchStore.create(f.database, {
            id: randomUUID(),
            owner: destination.id,
            source: source.id,
            destination: destination.id,
            events: ["failed", "cancelled"],
            mode: "persistent",
            delivery: "record",
            limit: 4,
          })
          const pending = yield* prompt
            .prompt({
              sessionID: source.id,
              noReply: true,
              parts: [{ type: "file", mime: "application/x-opencode-skill", url: "skill:preparation-gate" }],
            })
            .pipe(Effect.exit, Effect.forkScoped)
          const request = yield* pollWithTimeout(
            permission.list().pipe(Effect.map((items) => items[0])),
            "preparation did not reach the real permission barrier",
          )
          const oldFence = yield* f.runtime.ownershipFence(source.id)
          expect(oldFence).toBeDefined()
          const started = yield* Deferred.make<number>()
          const finish = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined))
          const current =
            replacement === "recovered"
              ? RuntimeLifecycle.make({ lineage: f.runtime.identity.lineage }, yield* Effect.scope, f.database)
              : undefined
          if (current) {
            yield* f.runtime.park(source.id)
            yield* current.recover((record) =>
              Deferred.succeed(started, record.fence).pipe(Effect.andThen(Deferred.await(finish))),
            )
          }
          if (replacement === "cancelled") yield* prompt.cancel(source.id)
          const resumedFence = current
            ? yield* awaitWithTimeout(Deferred.await(started), "replacement runtime did not claim parked execution")
            : undefined
          yield* permission.reply({ requestID: request.id, reply: "reject" })
          expect((yield* awaitWithTimeout(Fiber.join(pending), "late preparation did not settle"))._tag).toBe("Failure")
          expect(yield* sessions.messages({ sessionID: source.id })).toHaveLength(0)
          expect(
            yield* f.database.db.get(sql`SELECT result FROM session_watch_execution WHERE session_id = ${source.id}`),
          ).toEqual({ result: null })
          if (current) {
            expect(resumedFence).not.toBe(oldFence)
            expect(yield* current.beforeTurn(source.id)).toBe(true)
            yield* Deferred.succeed(finish, undefined)
            yield* awaitWithTimeout(current.waitForIdle(source.id), "replacement recovery did not finish")
          }
          expect(
            (yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).map((item) => item.outcome),
          ).toEqual(replacement === "cancelled" ? ["cancelled"] : [])
          expect(yield* f.llm.calls).toBe(0)
        }).pipe(Effect.provide(f.context)),
      )
    }),
  )
}

it.live("successful admission-only input and cancellation never become failed execution results", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const gate = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
    yield* f.llm.hold("cancelled response", gate.promise)
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const source = yield* sessions.create({ title: "admission and cancellation" })
        const destination = yield* sessions.create({ title: "terminal observer" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["failed", "completed", "cancelled"],
          mode: "persistent",
          delivery: "record",
          limit: 4,
        })
        yield* prompt.prompt({ sessionID: source.id, noReply: true, parts: [{ type: "text", text: "admit only" }] })
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toHaveLength(0)
        const running = yield* prompt
          .prompt({ sessionID: source.id, parts: [{ type: "text", text: "cancel this" }] })
          .pipe(Effect.exit, Effect.forkScoped)
        yield* awaitWithTimeout(f.llm.wait(1), "cancellation target did not start")
        yield* prompt.cancel(source.id)
        yield* awaitWithTimeout(Fiber.join(running), "cancellation did not settle the caller")
        expect(
          (yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).map((item) => item.outcome),
        ).toEqual(["cancelled"])
        expect(
          yield* f.database.db.all(sql`SELECT result FROM session_watch_execution WHERE session_id = ${source.id}`),
        ).toEqual([{ result: null }, { result: null }])
        const held = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* f.runtime.park(source.id)
        const payload = yield* prompt.textPayload(source.id, "cannot bypass recovery")
        expect((yield* prompt.controlSteer(source.id, payload, "guarded-recovery").pipe(Effect.exit))._tag).toBe(
          "Failure",
        )
        yield* f.runtime.release(source.id, held.fence)
        expect(
          yield* f.database.db.get(sql`SELECT result FROM session_watch_execution WHERE session_id = ${source.id}
          ORDER BY sequence DESC LIMIT 1`),
        ).toEqual({ result: null })
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toHaveLength(1)
        expect(yield* f.llm.calls).toBe(1)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("stale result evidence cannot classify a later execution", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const source = yield* sessions.create({ title: "source" })
        const destination = yield* sessions.create({ title: "destination" })
        const old = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* f.runtime.release(source.id, old.fence)
        const next = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed"],
          mode: "once",
          delivery: "record",
          limit: 8,
        })
        yield* SessionWatchStore.result(f.database, source.id, {
          outcome: "completed",
          summary: "stale",
          ownerLineage: f.runtime.identity.lineage,
          ownerInstance: f.runtime.identity.instance,
          fence: old.fence,
        })
        yield* f.runtime.release(source.id, next.fence)
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toHaveLength(0)
        expect((yield* SessionWatchStore.get(f.database, destination.id, watch.id)).status).toBe("invalidated")
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("watch graph, exact retries and retained delivery bounds reject unsafe subscriptions", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const source = yield* sessions.create({ title: "source" })
        const destination = yield* sessions.create({ title: "destination" })
        const input = {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed" as const],
          mode: "persistent" as const,
          delivery: "auto" as const,
          limit: 128,
        }
        yield* SessionWatchStore.create(f.database, input)
        expect((yield* SessionWatchStore.create(f.database, input)).id).toBe(input.id)
        expect(yield* Effect.flip(SessionWatchStore.create(f.database, { ...input, events: ["idle"] }))).toMatchObject({
          code: "conflict",
        })
        expect(
          yield* Effect.flip(
            SessionWatchStore.create(f.database, {
              ...input,
              id: randomUUID(),
              source: destination.id,
              destination: source.id,
            }),
          ),
        ).toMatchObject({ code: "invalid" })
        expect(
          yield* Effect.flip(
            SessionWatchStore.create(f.database, {
              ...input,
              id: randomUUID(),
              source: destination.id,
            }),
          ),
        ).toMatchObject({ code: "invalid" })
        for (let index = 0; index < 66; index++) {
          const active = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
          yield* SessionWatchStore.result(f.database, source.id, {
            outcome: "completed",
            summary: "x".repeat(4000),
            ownerLineage: f.runtime.identity.lineage,
            ownerInstance: f.runtime.identity.instance,
            fence: active.fence,
          })
          yield* f.runtime.release(source.id, active.fence)
        }
        const rows = yield* SessionWatchStore.deliveries(f.database, destination.id, input.id)
        expect(rows).toHaveLength(64)
        expect(rows.every((row) => row.summary.length <= 2000)).toBe(true)
        expect((yield* SessionWatchStore.get(f.database, destination.id, input.id)).status).toBe("exhausted")
        yield* SessionWatchStore.cancel(f.database, destination.id, input.id)
        expect(
          (yield* SessionWatchStore.deliveries(f.database, destination.id, input.id)).every(
            (row) => row.state === "cancelled",
          ),
        ).toBe(true)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("native watches require explicit source and cross-directory delivery authorization", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const other = yield* tmpdirScoped({ git: true, config: testProviderConfig(f.llm.url) })
    const source = yield* f.store.provide(
      { directory: other },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        return yield* sessions.create({ title: "external source" })
      }).pipe(Effect.provide(f.context)),
    )
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const registry = yield* ToolRegistry.Service
        const destination = yield* sessions.create({ title: "controller" })
        const watch = (yield* registry.all()).find((tool) => tool.id === "session_watch")
        expect(watch).toBeDefined()
        if (!watch) throw new Error("session_watch is not registered")
        const permissions: string[] = []
        const ctx: Tool.Context = {
          sessionID: destination.id,
          messageID: MessageID.ascending(),
          agent: "build",
          callID: randomUUID(),
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: (request) =>
            Effect.sync(() => {
              permissions.push(request.permission)
            }),
        }
        const created = yield* watch.execute({ sessionID: source.id, events: ["completed"], delivery: "record" }, ctx)
        expect(permissions).toContain("external_directory")
        expect(permissions.filter((permission) => permission === "session_watch")).toHaveLength(2)
        expect(JSON.parse(created.output)).toMatchObject({
          source_id: source.id,
          destination_id: destination.id,
          status: "active",
        })
        const denied = yield* Effect.exit(
          watch.execute(
            { sessionID: source.id },
            {
              ...ctx,
              callID: randomUUID(),
              ask: () => Effect.die(new Error("denied")),
            },
          ),
        )
        expect(denied._tag).toBe("Failure")
        expect(yield* SessionWatchStore.list(f.database, destination.id)).toHaveLength(1)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("paused pending deliveries survive worker reconstruction and acknowledge exactly one queue admission", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.llm.text("notification processed")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const source = yield* sessions.create({ title: "source" })
        const destination = yield* sessions.create({ title: "paused" })
        yield* queue.update(destination.id, {
          revision: (yield* queue.list(destination.id)).revision,
          mutation: { action: "pause", paused: true },
        })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed"],
          mode: "once",
          delivery: "auto",
          limit: 8,
        })
        const active = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* SessionWatchStore.result(f.database, source.id, {
          outcome: "completed",
          summary: "done",
          ownerLineage: f.runtime.identity.lineage,
          ownerInstance: f.runtime.identity.instance,
          fence: active.fence,
        })
        yield* f.runtime.release(source.id, active.fence)
        yield* SessionWatch.engine({ ...f, prompt, queue }).tick
        expect(yield* f.llm.calls).toBe(0)
        expect((yield* queue.list(destination.id)).items).toHaveLength(1)
        const delivery = (yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id))[0]
        expect(delivery?.state).toBe("accepted")
        if (!delivery) throw new Error("Missing delivery")
        // Simulate failure before the acknowledgement; the immutable queue identity
        // reconciles a second outbox attempt rather than creating another input.
        yield* f.database.db.run(sql`UPDATE session_watch_delivery SET state = 'pending' WHERE id = ${delivery.id}`)
        yield* queue.update(destination.id, {
          revision: (yield* queue.list(destination.id)).revision,
          mutation: { action: "pause", paused: false },
        })
        const restarted = SessionWatch.engine({ ...f, prompt, queue })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            yield* restarted.tick
            return (yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id))[0]?.state === "delivered"
              ? true
              : undefined
          }),
          "pending replay did not deliver",
        )
        yield* f.runtime.waitForIdle(destination.id)
        expect(yield* f.llm.calls).toBe(1)
        expect(
          (yield* sessions.messages({ sessionID: destination.id })).filter((item) => item.info.role === "user"),
        ).toHaveLength(1)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("busy delivery defers to a provider boundary without interrupting its active stream", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const gate = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
    yield* f.llm.hold("active response", gate.promise)
    yield* f.llm.text("notification response")
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const source = yield* sessions.create({ title: "source" })
        const destination = yield* sessions.create({ title: "busy" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed"],
          mode: "once",
          delivery: "auto",
          limit: 8,
        })
        yield* prompt
          .prompt({ sessionID: destination.id, parts: [{ type: "text", text: "work" }] })
          .pipe(Effect.forkScoped)
        yield* awaitWithTimeout(f.llm.wait(1), "destination did not start")
        const active = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* SessionWatchStore.result(f.database, source.id, {
          outcome: "completed",
          summary: "done",
          ownerLineage: f.runtime.identity.lineage,
          ownerInstance: f.runtime.identity.instance,
          fence: active.fence,
        })
        yield* f.runtime.release(source.id, active.fence)
        const worker = SessionWatch.engine({ ...f, prompt, queue })
        yield* awaitWithTimeout(worker.tick, "busy notification waited for execution")
        expect(yield* f.llm.calls).toBe(1)
        expect((yield* queue.list(destination.id)).items).toHaveLength(1)
        gate.resolve()
        yield* pollWithTimeout(
          Effect.gen(function* () {
            yield* worker.tick
            return (yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id))[0]?.state === "delivered"
              ? true
              : undefined
          }),
          "busy delivery did not resume",
        )
        yield* f.runtime.waitForIdle(destination.id)
        expect(yield* f.llm.calls).toBe(2)
        expect(
          (yield* sessions.messages({ sessionID: destination.id })).filter((item) => item.info.role === "user"),
        ).toHaveLength(2)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("cancelled and recovery-parked destinations keep accepted notifications without execution", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const source = yield* sessions.create({ title: "source" })
        const cancelled = yield* sessions.create({ title: "cancelled" })
        const parked = yield* sessions.create({ title: "parked" })
        const cancel = yield* f.runtime.admit({ sessionID: cancelled.id, directory: f.directory })
        yield* f.runtime.release(cancelled.id, cancel.fence)
        yield* prompt.cancel(cancelled.id)
        const park = yield* f.runtime.admit({ sessionID: parked.id, directory: f.directory })
        yield* f.runtime.park(parked.id)
        yield* f.runtime.release(parked.id, park.fence)
        for (const destination of [cancelled, parked])
          yield* SessionWatchStore.create(f.database, {
            id: randomUUID(),
            owner: destination.id,
            source: source.id,
            destination: destination.id,
            events: ["completed"],
            mode: "once",
            delivery: "auto",
            limit: 8,
          })
        const active = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* SessionWatchStore.result(f.database, source.id, {
          outcome: "completed",
          summary: "done",
          ownerLineage: f.runtime.identity.lineage,
          ownerInstance: f.runtime.identity.instance,
          fence: active.fence,
        })
        yield* f.runtime.release(source.id, active.fence)
        const worker = SessionWatch.engine({ ...f, prompt, queue })
        yield* worker.tick
        yield* worker.tick
        expect(yield* f.llm.calls).toBe(0)
        expect((yield* queue.list(cancelled.id)).items).toHaveLength(1)
        expect((yield* queue.list(cancelled.id)).blocked).toBe(true)
        expect((yield* queue.list(parked.id)).items).toHaveLength(1)
        expect(yield* f.runtime.isParked(parked.id)).toBe(true)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("durable watches cannot deliver after their owner's explicit permission is revoked", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const source = yield* sessions.create({ title: "source" })
        const destination = yield* sessions.create({ title: "destination" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed"],
          mode: "once",
          delivery: "auto",
          limit: 8,
          agent: "build",
        })
        const active = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* SessionWatchStore.result(f.database, source.id, {
          outcome: "completed",
          summary: "done",
          ownerLineage: f.runtime.identity.lineage,
          ownerInstance: f.runtime.identity.instance,
          fence: active.fence,
        })
        yield* f.runtime.release(source.id, active.fence)
        yield* sessions.setPermission({
          sessionID: destination.id,
          permission: [{ permission: "session_watch", pattern: "*", action: "deny" }],
        })
        yield* SessionWatch.engine({ ...f, prompt, queue }).tick
        expect((yield* queue.list(destination.id)).items).toHaveLength(0)
        expect((yield* SessionWatchStore.get(f.database, destination.id, watch.id)).status).toBe("invalidated")
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("terminal event classification uses execution identity rather than a shared millisecond", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const source = yield* sessions.create({ title: "source" })
        const first = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* f.runtime.release(source.id, first.fence)
        const second = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
        yield* f.database.db.transaction(
          () =>
            Effect.gen(function* () {
              yield* f.database.db.run(
                sql`UPDATE session_watch_execution SET time_completed = 12345 WHERE session_id = ${source.id} AND state = 'terminal'`,
              )
              yield* f.database.db.run(
                sql`UPDATE runtime_execution SET state = 'cancelled', desired_active = 0, time_updated = 12345 WHERE session_id = ${source.id}`,
              )
            }),
          { behavior: "immediate" },
        )
        const events = yield* f.database.db.all(
          sql`SELECT outcome FROM session_watch_event WHERE source_id = ${source.id} AND outcome = 'cancelled'`,
        )
        expect(events).toHaveLength(1)
        yield* f.runtime.release(source.id, second.fence)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("journal retention keeps accepted pending references and session deletion cleans watch resources", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const source = yield* sessions.create({ title: "retained source" })
        const destination = yield* sessions.create({ title: "pending destination" })
        const watch = yield* SessionWatchStore.create(f.database, {
          id: randomUUID(),
          owner: destination.id,
          source: source.id,
          destination: destination.id,
          events: ["completed"],
          mode: "once",
          delivery: "auto",
          limit: 8,
        })
        for (const index of Array.from({ length: 140 }, (_, index) => index)) {
          const run = yield* f.runtime.admit({ sessionID: source.id, directory: f.directory })
          if (index === 0)
            yield* SessionWatchStore.result(f.database, source.id, {
              outcome: "completed",
              summary: "retained notification",
              ownerLineage: f.runtime.identity.lineage,
              ownerInstance: f.runtime.identity.instance,
              fence: run.fence,
            })
          yield* f.runtime.release(source.id, run.fence)
        }
        const journal = yield* f.database.db.all(
          sql`SELECT id FROM session_watch_execution WHERE session_id = ${source.id}`,
        )
        expect(journal.length).toBeLessThanOrEqual(128)
        expect(yield* SessionWatchStore.deliveries(f.database, destination.id, watch.id)).toMatchObject([
          { state: "pending", summary: "retained notification" },
        ])
        yield* sessions.remove(source.id)
        expect(yield* SessionWatchStore.list(f.database, destination.id)).toHaveLength(0)
        expect(
          yield* f.database.db.all(sql`SELECT id FROM session_watch_delivery WHERE watch_id = ${watch.id}`),
        ).toHaveLength(0)
        expect(
          yield* f.database.db.all(sql`SELECT id FROM session_watch_execution WHERE session_id = ${source.id}`),
        ).toHaveLength(0)
      }).pipe(Effect.provide(f.context)),
    )
  }),
)

it.live("watch registration rejects a scope changed after permission approval", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const registry = yield* ToolRegistry.Service
        const source = yield* sessions.create({ title: "moving source" })
        const destination = yield* sessions.create({ title: "controller" })
        const tool = (yield* registry.all()).find((tool) => tool.id === "session_watch")
        if (!tool) throw new Error("session_watch is not registered")
        const result = yield* Effect.exit(
          tool.execute(
            { sessionID: source.id },
            {
              sessionID: destination.id,
              messageID: MessageID.ascending(),
              agent: "build",
              callID: randomUUID(),
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: (request) =>
                request.patterns.some((pattern) => pattern.startsWith("deliver:"))
                  ? f.database.db
                      .run(sql`UPDATE session SET directory = ${`${f.directory}/changed`} WHERE id = ${source.id}`)
                      .pipe(Effect.orDie, Effect.asVoid)
                  : Effect.void,
            },
          ),
        )
        expect(result._tag).toBe("Failure")
        expect(yield* SessionWatchStore.list(f.database, destination.id)).toHaveLength(0)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)
