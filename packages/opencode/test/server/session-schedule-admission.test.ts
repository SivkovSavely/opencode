import { expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Layer, Result, Scope } from "effect"
import { NodeServices } from "@effect/platform-node"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { SessionScheduleOccurrenceTable, SessionScheduleTable } from "@opencode-ai/core/session/schedule.sql"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { ServerScheduler } from "@/server/scheduler"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionQueue } from "@/session/queue"
import { SessionSchedule } from "@/session/schedule"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { SessionStatus } from "@/session/status"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const root = LayerNode.group([
  SessionPrompt.node,
  SessionSchedule.node,
  InstanceStore.node,
  Session.node,
  SessionProjector.node,
  SessionQueue.node,
  SessionStatus.node,
  Agent.node,
  Provider.node,
  EventV2Bridge.node,
  Database.node,
])
const it = testEffect(Layer.mergeAll(LayerNode.compile(Database.node), TestLLMServer.layer, NodeServices.layer))

it.live(
  "scheduled wake cannot claim an input after a competing runtime wins admission",
  () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({
        git: true,
        config: { ...testProviderConfig(llm.url), model: "test/test-model" },
      })
      const scope = yield* Effect.scope
      const runtime = RuntimeLifecycle.make({ lineage: "scheduled-wake" }, scope, database)
      const competitor = RuntimeLifecycle.make({ lineage: "scheduled-competitor" }, scope, database)
      const entered = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const rejected = yield* Deferred.make<void>()
      const wakeFinished = yield* Deferred.make<void>()
      const owner: { fence?: number } = {}
      const wrapped = {
        ...runtime,
        admit: (input: Parameters<RuntimeLifecycle.Interface["admit"]>[0]) =>
          Effect.gen(function* () {
            if (owner.fence === undefined) {
              owner.fence = (yield* competitor.admit(input)).fence
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(resume)
              return yield* runtime.admit(input).pipe(Effect.tapError(() => Deferred.succeed(rejected, undefined)))
            }
            return yield* runtime.admit(input)
          }),
      }
      const services = yield* Layer.build(
        LayerNode.compile(root, [
          [Database.node, Layer.succeed(Database.Service, database)],
          [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
        ]).pipe(Layer.provideMerge(Layer.succeed(RuntimeLifecycle.Service, wrapped))),
      )
      const store = Context.get(services, InstanceStore.Service)
      yield* store.provide(
        { directory },
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const schedules = yield* SessionSchedule.Service
          const queue = yield* SessionQueue.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({})
          yield* llm.text("scheduled response")
          const schedule = yield* schedules.create(session.id, {
            message: "scheduled input",
            spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
            sessionState: "always",
            deferUntilIdle: false,
            missed: "all",
            limit: 1,
          })
          const workerScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void))
          const worker = yield* Layer.build(
            ServerScheduler.layer.pipe(
              Layer.provide(
                Layer.succeedContext(
                  Context.add(services, SessionPrompt.Service, {
                    ...prompt,
                    queueSubmitScheduled: (...args) =>
                      prompt
                        .queueSubmitScheduled(...args)
                        .pipe(Effect.ensuring(Deferred.succeed(wakeFinished, undefined))),
                  }),
                ),
              ),
            ),
          ).pipe(Effect.provideService(Scope.Scope, workerScope))
          yield* Context.get(worker, ServerScheduler.Service).start
          yield* awaitWithTimeout(
            Deferred.await(entered),
            "scheduled wake did not reach runtime admission",
            "15 seconds",
          )
          yield* Deferred.succeed(resume, undefined)
          yield* awaitWithTimeout(Deferred.await(rejected), "foreign admission did not fence scheduled wake")
          yield* awaitWithTimeout(Deferred.await(wakeFinished), "rejected wake did not finish")
          expect((yield* queue.list(session.id)).blocked).toBe(false)
          const occurrence = yield* database.db
            .select()
            .from(SessionScheduleOccurrenceTable)
            .where(eq(SessionScheduleOccurrenceTable.schedule_id, schedule.id))
            .get()
            .pipe(Effect.orDie)
          expect(occurrence?.state).toBe("accepted")
          if (!occurrence) return yield* Effect.die("missing occurrence")
          const item = yield* queue.get(session.id, occurrence.id)
          expect(item.state).toBe("pending")
          expect(item.messageID).toBeUndefined()
          expect(item.origin).toEqual({ type: "scheduled", scheduleID: schedule.id, occurrenceID: occurrence.id })
          expect(
            yield* database.db
              .select()
              .from(MessageTable)
              .where(eq(MessageTable.session_id, session.id))
              .all()
              .pipe(Effect.orDie),
          ).toHaveLength(0)
          expect(yield* llm.calls).toBe(0)
          const execution = yield* database.db
            .get<{
              owner_lineage: string
              owner_instance: string
              fence: number
              state: string
            }>(
              sql`SELECT owner_lineage, owner_instance, fence, state FROM runtime_execution WHERE session_id = ${session.id}`,
            )
            .pipe(Effect.orDie)
          expect(execution).toMatchObject({
            owner_lineage: competitor.identity.lineage,
            owner_instance: competitor.identity.instance,
            fence: owner.fence,
            state: "active",
          })
          yield* competitor.release(session.id, owner.fence)
          yield* pollWithTimeout(
            database.db
              .select()
              .from(SessionScheduleOccurrenceTable)
              .where(eq(SessionScheduleOccurrenceTable.id, occurrence.id))
              .get()
              .pipe(
                Effect.orDie,
                Effect.map((row) => (row?.state === "delivered" ? row : undefined)),
              ),
            "scheduled input did not recover after competing owner completed",
            "15 seconds",
          )
          yield* awaitWithTimeout(llm.wait(1), "recovered scheduled input did not start a provider turn")
          expect(yield* llm.calls).toBe(1)
          yield* pollWithTimeout(
            database.db
              .get<{ state: string }>(sql`SELECT state FROM runtime_execution WHERE session_id = ${session.id}`)
              .pipe(
                Effect.orDie,
                Effect.map((row) => (row?.state === "completed" ? row : undefined)),
              ),
            "scheduled runtime did not release its execution",
          )
          const messages = yield* database.db
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.session_id, session.id))
            .all()
            .pipe(Effect.orDie)
          expect(messages.filter((row) => row.data.role === "user")).toHaveLength(1)
          yield* Scope.close(workerScope, Exit.void)
        }).pipe(Effect.provide(services)),
      )
    }),
  30_000,
)

it.live(
  "pauses cancelled schedules durably and requires explicit session and queue recovery",
  () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({
        git: true,
        config: { ...testProviderConfig(llm.url), model: "test/test-model" },
      })
      const scope = yield* Effect.scope
      const runtime = RuntimeLifecycle.make({ lineage: "cancelled-schedule" }, scope, database)
      const services = yield* Layer.build(
        LayerNode.compile(root, [
          [Database.node, Layer.succeed(Database.Service, database)],
          [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
        ]).pipe(Layer.provideMerge(Layer.succeed(RuntimeLifecycle.Service, runtime))),
      )
      const store = Context.get(services, InstanceStore.Service)
      yield* store.provide(
        { directory },
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const schedules = yield* SessionSchedule.Service
          const queue = yield* SessionQueue.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({ title: "Cancelled schedule regression" })
          const created = yield* schedules.create(session.id, {
            message: "scheduled input",
            spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
            sessionState: "always",
            deferUntilIdle: false,
            missed: "all",
          })
          // Put both ticks in the past without waiting for a real interval.
          const anchor = Date.now() - 120_000
          yield* database.db
            .update(SessionScheduleTable)
            .set({ anchor, next: anchor })
            .where(eq(SessionScheduleTable.id, created.id))
            .run()
          const payload = {
            kind: "prompt" as const,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            variant: "default",
            selection: {},
            parts: [{ type: "text" as const, text: "scheduled input" }],
          }
          const engine = (owner: RuntimeLifecycle.Interface) =>
            ServerScheduler.engine({
              database,
              runtime: owner,
              startup: 0,
              dispatch: (schedule, occurrence) =>
                queue
                  .enqueueScheduled(
                    session.id,
                    { id: occurrence.id, payload },
                    { type: "scheduled", scheduleID: schedule.id, occurrenceID: occurrence.id },
                  )
                  .pipe(Effect.as("idle" as const)),
            })
          const scheduler = engine(runtime)
          yield* scheduler.step(anchor)
          const first = (yield* schedules.history(session.id, created.id)).items[0]
          yield* llm.hang
          yield* prompt.queueSubmitScheduled(
            session.id,
            { id: first.id, payload },
            { type: "scheduled", scheduleID: created.id, occurrenceID: first.id },
          )
          yield* awaitWithTimeout(llm.wait(1), "scheduled session did not start")
          yield* queue.enqueue(session.id, {
            id: "explicit-recovery-input",
            payload: { ...payload, parts: [{ type: "text", text: "explicit recovery" }] },
          })
          yield* prompt.cancel(session.id)
          expect(
            yield* database.db.get(
              sql`SELECT state, desired_active FROM runtime_execution WHERE session_id = ${session.id}`,
            ),
          ).toMatchObject({ state: "cancelled", desired_active: 0 })
          expect((yield* queue.list(session.id)).blocked).toBe(true)
          yield* scheduler.step(anchor + 60_000)
          expect(yield* schedules.get(session.id, created.id)).toMatchObject({ status: "paused", completed: 1 })
          expect((yield* schedules.get(session.id, created.id)).next).toBeUndefined()
          const history = yield* schedules.history(session.id, created.id)
          expect(history.items).toHaveLength(2)
          expect(history.items[0]).toMatchObject({ scheduled: anchor + 60_000, state: "failed" })
          expect(history.items[0].error).toContain("cancelled")

          const replacement = RuntimeLifecycle.make({ lineage: runtime.identity.lineage }, scope, database)
          yield* replacement.recover(() => Effect.die("Cancelled execution must not recover automatically"))
          yield* replacement.finishStartupRecovery()
          yield* engine(replacement).drain(() => Date.now() + 86_400_000)
          expect(yield* schedules.history(session.id, created.id)).toEqual(history)
          expect((yield* schedules.get(session.id, created.id)).status).toBe("paused")
          expect((yield* queue.list(session.id)).blocked).toBe(true)
          expect(yield* llm.calls).toBe(1)
          const rejected = yield* schedules.pause(session.id, created.id, false).pipe(Effect.result)
          expect(Result.isFailure(rejected) && rejected.failure.reason).toBe("conflict")

          yield* llm.text("explicit recovery response")
          yield* prompt.queueResume(session.id)
          yield* awaitWithTimeout(llm.wait(2), "explicit queue resume did not deliver recovery input")
          yield* pollWithTimeout(
            database.db
              .get<{ state: string }>(sql`SELECT state FROM runtime_execution WHERE session_id = ${session.id}`)
              .pipe(Effect.map((row) => (row?.state === "completed" ? row : undefined))),
            "explicit recovery did not finish",
          )
          expect((yield* queue.list(session.id)).blocked).toBe(false)
          // A completed session alone is insufficient if its queue is still blocked.
          yield* queue.block(session.id)
          const blocked = yield* schedules.pause(session.id, created.id, false).pipe(Effect.result)
          expect(Result.isFailure(blocked) && blocked.failure.reason).toBe("conflict")
          yield* prompt.queueResume(session.id)
          const resumed = yield* schedules.pause(session.id, created.id, false)
          expect(resumed.status).toBe("active")
          expect(resumed.next).toBeGreaterThan(Date.now())
          expect(resumed.next).toBeGreaterThan(anchor + 60_000)
          if (resumed.next === undefined) return yield* Effect.die("Missing resumed tick")
          yield* engine(replacement).step(resumed.next)
          yield* engine(replacement).step(resumed.next)
          const pending = (yield* queue.list(session.id)).items
          expect(pending).toHaveLength(1)
          expect(pending[0].origin?.occurrenceID).toBe(`occ_${created.id}_${resumed.next}`)
          expect((yield* schedules.history(session.id, created.id)).items).toHaveLength(3)
          expect(yield* llm.calls).toBe(2)
          yield* llm.text("resumed schedule response")
          yield* prompt.queueSubmitScheduled(
            session.id,
            { id: pending[0].id, payload: pending[0].payload },
            { type: "scheduled", scheduleID: created.id, occurrenceID: pending[0].id },
          )
          yield* pollWithTimeout(
            queue
              .get(session.id, pending[0].id)
              .pipe(Effect.map((row) => (row.state === "delivered" ? row : undefined))),
            "resumed schedule did not deliver",
          )
          yield* scheduler.reconcile
          yield* scheduler.reconcile
          expect((yield* schedules.get(session.id, created.id)).completed).toBe(2)
          yield* awaitWithTimeout(llm.wait(3), "resumed schedule did not start its provider turn")
          yield* pollWithTimeout(
            database.db
              .get<{ state: string }>(sql`SELECT state FROM runtime_execution WHERE session_id = ${session.id}`)
              .pipe(Effect.map((row) => (row?.state === "completed" ? row : undefined))),
            "resumed schedule did not finish",
          )
          expect(yield* llm.calls).toBe(3)
        }).pipe(Effect.provide(services)),
      )
    }),
  30_000,
)
