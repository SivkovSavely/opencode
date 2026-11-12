import { expect, spyOn } from "bun:test"
import fs from "node:fs/promises"
import { Context, Deferred, Effect, Fiber, Layer, Result } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { ServerScheduler } from "@/server/scheduler"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionQueue } from "@/session/queue"
import { SessionQueueMigration } from "@/session/queue-migration"
import { SessionSchedule } from "@/session/schedule"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionSchedule.node,
      SessionQueue.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
    ]),
  ),
)

for (const kind of ["valid", "missing", "invalid"] as const) {
  it.instance(
    `prepares ${kind} legacy storage outside scheduled admission`,
    () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const queue = yield* SessionQueue.Service
        const sessions = yield* Session.Service
        const schedules = yield* SessionSchedule.Service
        const instance = yield* InstanceRef
        if (!instance) return yield* Effect.die("Missing instance")
        const session = yield* sessions.create({})
        const file = SessionQueueMigration.storagePath(instance.project.id)
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(file, { force: true })))
        if (kind !== "missing") {
          const value =
            kind === "invalid"
              ? "invalid"
              : JSON.stringify({
                  version: 1,
                  projectID: instance.project.id,
                  sessions: {
                    [session.id]: {
                      stopped: true,
                      hidden: [],
                      items: [
                        {
                          kind: "prompt",
                          info: {
                            agent: "build",
                            model: { providerID: "test", modelID: "test-model" },
                            variant: "high",
                          },
                          body: "legacy",
                          parts: [{ type: "text", text: "legacy" }],
                        },
                      ],
                    },
                  },
                })
          yield* Effect.promise(() => Bun.write(file, value))
        }
        const schedule = yield* schedules.create(session.id, {
          message: "scheduled",
          spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
          sessionState: "always",
          deferUntilIdle: false,
          missed: "all",
          limit: 1,
        })
        const runtime = RuntimeLifecycle.unavailable()
        const active = { value: false }
        const reads: boolean[] = []
        const original = Bun.file
        const spy = spyOn(Bun, "file").mockImplementation((...args) => {
          if (args[0] === file) reads.push(active.value)
          return Reflect.apply(original, Bun, args) as ReturnType<typeof Bun.file>
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
        const wrapped: RuntimeLifecycle.Interface = {
          ...runtime,
          withDurableAdmission: (effect) =>
            runtime.withDurableAdmission(
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  active.value = true
                }),
                () => effect,
                () =>
                  Effect.sync(() => {
                    active.value = false
                  }),
              ),
            ),
        }
        const worker = yield* Layer.build(
          ServerScheduler.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                LayerNode.compile(
                  LayerNode.group([
                    Database.node,
                    InstanceStore.node,
                    Agent.node,
                    Provider.node,
                    SessionStatus.node,
                    EventV2Bridge.node,
                  ]),
                  [
                    [Database.node, Layer.succeed(Database.Service, database)],
                    [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
                  ],
                ),
                Layer.succeed(SessionQueue.Service, queue),
                Layer.succeed(RuntimeLifecycle.Service, wrapped),
                Layer.mock(SessionPrompt.Service, { queueSubmitScheduled: (id) => queue.list(id) }),
              ),
            ),
          ),
        )
        yield* Context.get(worker, ServerScheduler.Service).start
        yield* pollWithTimeout(
          schedules
            .history(session.id, schedule.id)
            .pipe(Effect.map((h) => (h.items[0]?.state === "accepted" ? true : undefined))),
          "scheduled occurrence not accepted",
        )
        expect(reads.length).toBeGreaterThan(0)
        expect(reads).not.toContain(true)
        const snapshot = yield* queue.list(session.id)
        expect(snapshot.items).toHaveLength(kind === "valid" ? 2 : 1)
        if (kind === "valid") expect(snapshot.items[0]?.payload).toMatchObject({ parts: [{ text: "legacy" }] })
        const entry = snapshot.items.find((item) => item.origin)
        if (!entry?.origin) return yield* Effect.die("Missing scheduled entry")
        const origin = entry.origin
        const retries = yield* Effect.all(
          Array.from({ length: 4 }, () =>
            queue.enqueueScheduled(session.id, { id: entry.id, payload: entry.payload }, origin),
          ),
          { concurrency: "unbounded" },
        )
        expect(retries.every((retry) => retry.items.length === snapshot.items.length)).toBe(true)
      }),
    { git: true, config: { ...testProviderConfig("http://127.0.0.1:1"), model: "test/test-model" } },
  )
}

it.instance(
  "prepared migration survives interruption while occurrence and admission roll back together",
  () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const queue = yield* SessionQueue.Service
      const sessions = yield* Session.Service
      const schedules = yield* SessionSchedule.Service
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.die("Missing instance")
      const session = yield* sessions.create({})
      const file = SessionQueueMigration.storagePath(instance.project.id)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(file, { force: true })))
      yield* Effect.promise(() =>
        Bun.write(
          file,
          JSON.stringify({
            version: 1,
            projectID: instance.project.id,
            sessions: { [session.id]: { stopped: true, hidden: [], items: [] } },
          }),
        ),
      )
      const schedule = yield* schedules.create(session.id, {
        message: "scheduled",
        spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
        sessionState: "always",
        deferUntilIdle: false,
        missed: "all",
      })
      const entered = yield* Deferred.make<void>()
      const payload = {
        kind: "prompt" as const,
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text" as const, text: "scheduled" }],
      }
      const preparing = ServerScheduler.engine({
        database,
        startup: 0,
        prepare: () =>
          queue
            .prepareScheduled(session.id)
            .pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never)),
        dispatch: () => Effect.die("Interrupted preparation must not dispatch"),
      })
      const fiber = yield* preparing.step(schedule.anchor).pipe(Effect.forkChild)
      yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
      yield* Fiber.interrupt(fiber)
      expect((yield* schedules.history(session.id, schedule.id)).items).toEqual([])
      expect((yield* schedules.get(session.id, schedule.id)).next).toBe(schedule.next)
      expect((yield* queue.list(session.id)).blocked).toBe(true)
      const failing = ServerScheduler.engine({
        database,
        startup: 0,
        prepare: () => queue.prepareScheduled(session.id).pipe(Effect.as(payload)),
        dispatch: (_, occurrence) =>
          Effect.gen(function* () {
            yield* queue.enqueueScheduled(
              session.id,
              { id: occurrence.id, payload },
              { type: "scheduled", scheduleID: schedule.id, occurrenceID: occurrence.id },
              { prepared: true },
            )
            return yield* new RuntimeLifecycle.RuntimeDrainingError({ message: "draining" })
          }),
      })
      expect(Result.isFailure(yield* failing.step(schedule.anchor).pipe(Effect.result))).toBe(true)
      expect((yield* schedules.history(session.id, schedule.id)).items).toEqual([])
      expect((yield* schedules.get(session.id, schedule.id)).next).toBe(schedule.next)
      expect((yield* queue.list(session.id)).items).toEqual([])
    }),
  { git: true },
)
