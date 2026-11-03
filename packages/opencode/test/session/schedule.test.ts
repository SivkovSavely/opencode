import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Result } from "effect"
import { NodeServices } from "@effect/platform-node"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionScheduleTable, SessionScheduleOccurrenceTable } from "@opencode-ai/core/session/schedule.sql"
import { SessionQueueTable } from "@opencode-ai/core/session/queue.sql"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RuntimeRetirement } from "@opencode-ai/core/runtime-retirement"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionSchedule } from "@/session/schedule"
import { SessionQueue } from "@/session/queue"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { ServerScheduler } from "@/server/scheduler"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { GlobalBus } from "@/bus/global"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { tmpdirScoped } from "../fixture/fixture"
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
const input: SessionScheduleV1.Input = {
  message: "scheduled input",
  spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
  sessionState: "always",
  deferUntilIdle: false,
  missed: "all",
}
const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const sessions = yield* Session.Service
  const schedules = yield* SessionSchedule.Service
  const queue = yield* SessionQueue.Service
  const session = yield* sessions.create({})
  yield* Effect.addFinalizer(() =>
    database.db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie),
  )
  return { database, db: database.db, sessions, schedules, queue, sessionID: session.id }
})
const payload = {
  kind: "prompt" as const,
  agent: "build",
  model: { providerID: "test", modelID: "test" },
  parts: [{ type: "text" as const, text: "scheduled input" }],
}

function worker(
  database: Database.Interface,
  queue: SessionQueue.Interface,
  runtime: RuntimeLifecycle.Interface,
  wakes: string[],
) {
  return Layer.build(
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
          Layer.succeed(RuntimeLifecycle.Service, runtime),
          // Exercise the real worker through durable admission and wake, without
          // launching an LLM. Already admitted queue inputs are returned unchanged.
          Layer.mock(SessionPrompt.Service, {
            queueSubmitScheduled: (sessionID, input) =>
              queue.list(sessionID).pipe(Effect.tap(() => Effect.sync(() => wakes.push(input.id)))),
          }),
        ),
      ),
    ),
  )
}

describe("durable schedules", () => {
  it.instance("validates input and enforces active instance scope", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const invalid = yield* s.schedules.create(s.sessionID, { ...input, message: " " }).pipe(Effect.result)
      expect(Result.isFailure(invalid) && invalid.failure.reason).toBe("invalid")
      const schedule = yield* s.schedules.create(s.sessionID, input)
      const foreign = yield* s.schedules
        .get(s.sessionID, schedule.id)
        .pipe(Effect.provideService(InstanceRef, undefined), Effect.result)
      expect(Result.isFailure(foreign) && foreign.failure.reason).toBe("scope")
      const workspace = yield* s.schedules
        .list(s.sessionID)
        .pipe(Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make("wrk_other")), Effect.result)
      expect(Result.isFailure(workspace) && workspace.failure.reason).toBe("scope")
      expect((yield* s.schedules.list(s.sessionID)).map((row) => row.id)).toEqual([schedule.id])
    }),
  )

  it.instance("preserves interval anchors on message edits and resumes on the original grid", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, input)
      const edited = yield* s.schedules.update(s.sessionID, schedule.id, { ...input, message: "changed" })
      expect(edited.anchor).toBe(schedule.anchor)
      expect(edited.next).toBe(schedule.next)
      yield* s.schedules.pause(s.sessionID, schedule.id, true)
      const resumed = yield* s.schedules.pause(s.sessionID, schedule.id, false)
      expect(resumed.anchor).toBe(schedule.anchor)
      expect(resumed.next).toBeGreaterThan(Date.now())
      expect(((resumed.next ?? 0) - schedule.anchor) % 60_000).toBe(0)
    }),
  )

  it.instance("rejects overflowing immediate schedules before creation or editing", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const invalid: SessionScheduleV1.Input = {
        ...input,
        spec: { mode: "interval", amount: Number.MAX_SAFE_INTEGER, unit: "weeks", immediate: true },
      }
      const created = yield* s.schedules.create(s.sessionID, invalid).pipe(Effect.result)
      expect(Result.isFailure(created) && created.failure.reason).toBe("invalid")
      expect(yield* s.schedules.list(s.sessionID)).toHaveLength(0)
      const schedule = yield* s.schedules.create(s.sessionID, input)
      const edited = yield* s.schedules.update(s.sessionID, schedule.id, invalid).pipe(Effect.result)
      expect(Result.isFailure(edited) && edited.failure.reason).toBe("invalid")
      expect(yield* s.schedules.get(s.sessionID, schedule.id)).toEqual(schedule)
      const preview = yield* s.schedules
        .preview(s.sessionID, {
          spec: { mode: "interval", amount: 2_000_000_000, unit: "hours", immediate: true },
        })
        .pipe(Effect.result)
      expect(Result.isFailure(preview) && preview.failure.reason).toBe("invalid")
    }),
  )

  it.instance("reserves finite delivery allowance but counts only a persisted user message", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, { ...input, limit: 1 })
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: (_, occurrence) =>
          s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
      })
      yield* scheduler.step(schedule.anchor)
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).completed).toBe(0)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items[0]?.state).toBe("accepted")
      expect((yield* scheduler.step(schedule.anchor + 60_000))?.blocked).toBe(true)
      const queued = yield* s.queue.claimNext(s.sessionID)
      expect(queued).toBeDefined()
      const messageID = MessageID.ascending()
      const data = {
        role: "user" as const,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      }
      yield* s.db.insert(MessageTable).values({ id: messageID, session_id: s.sessionID, data }).run()
      if (!queued) return yield* Effect.die("Missing queue claim")
      yield* s.queue.delivered(s.sessionID, queued.id, messageID)
      yield* scheduler.reconcile
      yield* scheduler.reconcile
      const completed = yield* s.schedules.get(s.sessionID, schedule.id)
      expect(completed.completed).toBe(1)
      expect(completed.status).toBe("completed")
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items[0]?.messageID).toBe(messageID)
    }),
  )

  it.instance("serializes concurrent dispatches with deterministic occurrence identities", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, input)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: (_, occurrence) =>
          s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
      })
      yield* Effect.all(
        Array.from({ length: 8 }, () => scheduler.step(schedule.anchor)),
        { concurrency: "unbounded" },
      )
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items.map((item) => item.id)).toEqual([
        `occ_${schedule.id}_${schedule.anchor}`,
      ])
      expect((yield* s.queue.list(s.sessionID)).items).toHaveLength(1)
    }),
  )

  for (const missed of ["all", "latest", "none"] as const) {
    it.instance(`incrementally recovers ${missed} missed occurrences without a replay cap`, () =>
      Effect.gen(function* () {
        const s = yield* setup
        const schedule = yield* s.schedules.create(s.sessionID, { ...input, missed })
        const startup = schedule.anchor + 180_001
        const scheduler = ServerScheduler.engine({
          database: s.database,
          startup,
          dispatch: (_, occurrence) =>
            s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
        })
        for (let i = 0; i < 4; i++) yield* scheduler.step(startup)
        const history = yield* s.schedules.history(s.sessionID, schedule.id)
        expect(history.items).toHaveLength(4)
        expect(history.items.filter((item) => item.state === "accepted")).toHaveLength(
          missed === "all" ? 4 : missed === "latest" ? 1 : 0,
        )
        expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.anchor + 240_000)
      }),
    )
  }

  it.instance("rechecks deferred busy state without blocking another schedule", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const deferred = yield* s.schedules.create(s.sessionID, { ...input, sessionState: "idle", deferUntilIdle: true })
      const other = yield* s.schedules.create(s.sessionID, input)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: () => Effect.succeed("busy" as const),
      })
      expect((yield* scheduler.step(deferred.anchor))?.blocked).toBe(true)
      expect((yield* scheduler.step(other.anchor, [], [`occ_${deferred.id}_${deferred.anchor}`]))?.id).toBe(other.id)
      const resumed = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: (_, occurrence) =>
          s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
      })
      yield* resumed.step(other.anchor)
      expect((yield* s.schedules.history(s.sessionID, deferred.id)).items[0]?.state).toBe("accepted")
    }),
  )

  it.instance("ignores defer-until-idle for Send always and preserves immediate-only interval edits", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, { ...input, deferUntilIdle: true })
      expect(schedule.deferUntilIdle).toBe(false)
      const edited = yield* s.schedules.update(s.sessionID, schedule.id, {
        ...input,
        spec: { immediate: false, unit: "minutes", amount: 1, mode: "interval" },
      })
      expect(edited.anchor).toBe(schedule.anchor)
      expect(edited.next).toBe(schedule.next)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: (_, occurrence) =>
          s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("busy" as const)),
      })
      yield* scheduler.drain(() => schedule.anchor)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items[0]?.state).toBe("accepted")
    }),
  )

  it.instance(
    "persists every busy idle-only occurrence, survives restart, and tolerates repeated dispatcher races",
    () =>
      Effect.gen(function* () {
        const s = yield* setup
        const schedule = yield* s.schedules.create(s.sessionID, {
          ...input,
          sessionState: "idle",
          deferUntilIdle: true,
        })
        const other = yield* s.schedules.create(s.sessionID, input)
        const busy = () =>
          ServerScheduler.engine({
            database: s.database,
            startup: 0,
            dispatch: (row, occurrence) =>
              row.id === schedule.id
                ? Effect.succeed("busy" as const)
                : s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("busy" as const)),
          })
        const first = busy()
        const second = busy()
        const now = schedule.anchor + 240_000
        yield* Effect.all(
          Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).drain(() => now)),
          { concurrency: "unbounded" },
        )
        expect((yield* s.schedules.history(s.sessionID, schedule.id)).items.map((row) => row.state)).toEqual(
          Array(5).fill("deferred"),
        )
        expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.anchor + 300_000)
        expect((yield* s.schedules.history(s.sessionID, other.id)).items.every((row) => row.state === "accepted")).toBe(
          true,
        )
        expect((yield* s.schedules.history(s.sessionID, other.id)).items.length).toBeGreaterThan(0)
        const restarted = ServerScheduler.engine({
          database: s.database,
          startup: now + 1,
          dispatch: (_, occurrence) =>
            s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
        })
        yield* restarted.drain(() => now)
        expect((yield* s.schedules.history(s.sessionID, schedule.id)).items.map((row) => row.state)).toEqual(
          Array(5).fill("accepted"),
        )
        expect(
          (yield* s.queue.list(s.sessionID)).items.filter((row) => row.id.startsWith(`occ_${schedule.id}_`)),
        ).toHaveLength(5)
      }),
  )

  it.instance("keeps the last missed tick when the next tick is exactly at startup", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, { ...input, missed: "latest" })
      const startup = schedule.anchor + 120_000
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup,
        dispatch: (_, occurrence) =>
          s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
      })
      yield* scheduler.drain(() => startup)
      expect(
        (yield* s.schedules.history(s.sessionID, schedule.id)).items.map((row) => [row.scheduled, row.state]),
      ).toEqual([
        [startup, "accepted"],
        [startup - 60_000, "accepted"],
        [startup - 120_000, "discarded"],
      ])
    }),
  )

  it.instance("bounds reconciliation pages without starving delivered rows behind unresolved evidence", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, input)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: (_, occurrence) =>
          s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
      })
      yield* scheduler.step(schedule.anchor)
      const queued = yield* s.queue.claimNext(s.sessionID)
      if (!queued) return yield* Effect.die("Missing claim")
      const messageID = MessageID.ascending()
      const data = {
        role: "user" as const,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      }
      yield* s.db.insert(MessageTable).values({ id: messageID, session_id: s.sessionID, data }).run()
      yield* s.queue.delivered(s.sessionID, queued.id, messageID)
      yield* s.db
        .insert(SessionScheduleOccurrenceTable)
        .values(
          Array.from({ length: 70 }, (_, i) => ({
            id: `a_${schedule.id}_${String(i).padStart(3, "0")}`,
            schedule_id: schedule.id,
            scheduled: schedule.anchor - i - 1,
            state: "uncertain" as const,
          })),
        )
        .run()
      yield* scheduler.reconcile
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).completed).toBe(0)
      yield* scheduler.reconcile
      yield* scheduler.reconcile
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).completed).toBe(1)
    }),
  )

  it.instance("rejects limits below reservations and clears deferred history on finite completion", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, { ...input, limit: 2 })
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: (_, occurrence) =>
          s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
      })
      yield* scheduler.step(schedule.anchor)
      yield* scheduler.step(schedule.anchor + 60_000)
      const lowered = yield* s.schedules.update(s.sessionID, schedule.id, { ...input, limit: 1 }).pipe(Effect.result)
      expect(Result.isFailure(lowered) && lowered.failure.reason).toBe("conflict")
      yield* s.db
        .insert(SessionScheduleOccurrenceTable)
        .values({
          id: `deferred_${schedule.id}`,
          schedule_id: schedule.id,
          scheduled: schedule.anchor - 1,
          state: "deferred",
        })
        .run()
      for (let i = 0; i < 2; i++) {
        const queued = yield* s.queue.claimNext(s.sessionID)
        if (!queued) return yield* Effect.die("Missing claim")
        const messageID = MessageID.ascending()
        const data = {
          role: "user" as const,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
          time: { created: Date.now() },
        }
        yield* s.db.insert(MessageTable).values({ id: messageID, session_id: s.sessionID, data }).run()
        yield* s.queue.delivered(s.sessionID, queued.id, messageID)
      }
      yield* scheduler.reconcile
      yield* scheduler.reconcile
      const completed = yield* s.schedules.get(s.sessionID, schedule.id)
      expect(completed.completed).toBe(2)
      expect(completed.status).toBe("completed")
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items.some((row) => row.state === "deferred")).toBe(
        false,
      )
    }),
  )

  it.instance("rejects mutations after runtime draining begins", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const runtime = RuntimeLifecycle.make({ lineage: "scheduler-drain-test" }, yield* Effect.scope)
      const context = yield* Layer.build(
        SessionSchedule.layer.pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime)), Layer.fresh),
      )
      const service = Context.get(context, SessionSchedule.Service)
      yield* runtime.request("shutdown")
      const result = yield* service.create(s.sessionID, input).pipe(Effect.result)
      expect(Result.isFailure(result) && result.failure.reason).toBe("conflict")
      expect(yield* s.schedules.list(s.sessionID)).toEqual([])
    }),
  )

  it.instance("parks recovery-needed work without consuming its durable cursor", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, input)
      yield* s.db.run(
        sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated) VALUES (${`run_${schedule.id}`}, ${s.sessionID}, '/test', 'other', 'other', 1, 'recovery_needed', 0, 0, 0)`,
      )
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: () => Effect.die("Recovery bypass"),
      })
      yield* scheduler.drain(() => schedule.anchor)
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.next)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toEqual([])
    }),
  )

  for (const untracked of [true, false]) {
    it.instance(`fences foreign execution admission with ${untracked ? "an unavailable" : "no"} runtime`, () =>
      Effect.gen(function* () {
        const s = yield* setup
        const schedule = yield* s.schedules.create(s.sessionID, input)
        const scheduler = ServerScheduler.engine({
          database: s.database,
          runtime: untracked ? RuntimeLifecycle.unavailable() : undefined,
          startup: 0,
          dispatch: (_, occurrence) =>
            s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
        })
        for (const state of ["active", "waiting_child", "retry_wait"]) {
          yield* s.db.run(sql`INSERT INTO runtime_execution
            (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated)
            VALUES (${`run_${schedule.id}`}, ${s.sessionID}, '/test', 'foreign', 'foreign', 1, ${state}, 1, 0, 0)
            ON CONFLICT(session_id) DO UPDATE SET state = excluded.state`)
          yield* scheduler.drain(() => schedule.anchor)
          expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.next)
          expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toEqual([])
          expect((yield* s.queue.list(s.sessionID)).items).toEqual([])
        }
        // A finished execution is not ownership of the next run. Untracked/default
        // sessions also have no record at all, so neither case may strand work.
        yield* s.db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = ${s.sessionID}`)
        yield* scheduler.drain(() => schedule.anchor)
        expect((yield* s.queue.list(s.sessionID)).items).toHaveLength(1)
        yield* s.db.run(sql`DELETE FROM runtime_execution WHERE session_id = ${s.sessionID}`)
        yield* scheduler.drain(() => schedule.anchor + 60_000)
        expect((yield* s.queue.list(s.sessionID)).items).toHaveLength(2)
      }),
    )
  }

  it.instance("admits and wakes accepted inputs after a completed execution survives startup recovery", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.die("Missing instance")
      const scope = yield* Effect.scope
      const previous = RuntimeLifecycle.make({ lineage: "completed-scheduler-restart" }, scope, s.database)
      const admission = yield* previous.admit({ sessionID: s.sessionID, directory: instance.directory })
      yield* previous.release(s.sessionID, admission.fence)
      expect(
        yield* s.db.get(
          sql`SELECT state, desired_active, owner_instance FROM runtime_execution WHERE session_id = ${s.sessionID}`,
        ),
      ).toMatchObject({ state: "completed", desired_active: 1, owner_instance: previous.identity.instance })
      const replacement = RuntimeLifecycle.make({ lineage: previous.identity.lineage }, scope, s.database)
      expect(replacement.identity.instance).not.toBe(previous.identity.instance)
      yield* replacement.recover(() => Effect.die("Completed execution must not be recovered"))
      yield* replacement.finishStartupRecovery()
      const schedule = yield* s.schedules.create(s.sessionID, { ...input, limit: 1 })
      const admit = ServerScheduler.engine({
        database: s.database,
        runtime: replacement,
        startup: 0,
        dispatch: (_, occurrence) =>
          s.queue
            .enqueueScheduled(
              s.sessionID,
              { id: occurrence.id, payload },
              { type: "scheduled", scheduleID: schedule.id, occurrenceID: occurrence.id },
            )
            .pipe(Effect.as("idle" as const)),
      })
      yield* admit.drain(() => schedule.anchor)
      const accepted = (yield* s.schedules.history(s.sessionID, schedule.id)).items[0]
      expect(accepted?.state).toBe("accepted")
      const wakes: string[] = []
      const context = yield* worker(s.database, s.queue, replacement, wakes)
      yield* Context.get(context, ServerScheduler.Service).start
      yield* pollWithTimeout(
        Effect.sync(() => (wakes.includes(`occ_${schedule.id}_${schedule.anchor}`) ? true : undefined)),
        "Completed foreign owner blocked the accepted input's restart wake",
      )
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toEqual([accepted])
      expect((yield* s.queue.list(s.sessionID)).items).toHaveLength(1)
      expect(
        yield* s.db.get(
          sql`SELECT state, desired_active, owner_instance FROM runtime_execution WHERE session_id = ${s.sessionID}`,
        ),
      ).toMatchObject({ state: "completed", desired_active: 1, owner_instance: previous.identity.instance })
    }),
  )

  for (const rule of [
    { sessionState: "idle", deferUntilIdle: true, busy: true, expected: "deferred" },
    { sessionState: "idle", deferUntilIdle: false, busy: true, expected: "skipped_busy" },
    { sessionState: "busy", deferUntilIdle: false, busy: false, expected: "skipped_idle" },
  ] as const) {
    it.instance(
      `preserves ${rule.expected} eligibility when model preparation fails`,
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          const wakes: string[] = []
          const context = yield* worker(s.database, s.queue, RuntimeLifecycle.unavailable(), wakes)
          const status = Context.get(context, SessionStatus.Service)
          yield* status.set(s.sessionID, { type: rule.busy ? "busy" : "idle" })
          yield* s.db
            .update(SessionTable)
            .set({ model: { providerID: "test", id: "missing-model" } })
            .where(eq(SessionTable.id, s.sessionID))
            .run()
          const schedule = yield* s.schedules.create(s.sessionID, {
            ...input,
            sessionState: rule.sessionState,
            deferUntilIdle: rule.deferUntilIdle,
            limit: 1,
          })
          yield* Context.get(context, ServerScheduler.Service).start
          const first = yield* pollWithTimeout(
            s.schedules
              .history(s.sessionID, schedule.id)
              .pipe(
                Effect.map((history) => (history.items[0]?.state === rule.expected ? history.items[0] : undefined)),
              ),
            `Broken model incorrectly failed a ${rule.expected} occurrence`,
          )
          expect(first).toMatchObject({ id: `occ_${schedule.id}_${schedule.anchor}`, scheduled: schedule.anchor })
          expect(first.error).toBeUndefined()
          expect((yield* s.queue.list(s.sessionID)).items).toEqual([])
          if (!rule.deferUntilIdle) return
          // Keep the model broken through another real worker poll: rechecking an
          // already deferred occurrence while still busy must leave it untouched.
          yield* Effect.sleep("1200 millis")
          expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toEqual([first])
          // Configuration repair and the idle event must admit this same deferred
          // occurrence, not reanchor it or create an occurrence at the repair time.
          yield* s.db
            .update(SessionTable)
            .set({ model: { providerID: "test", id: "test-model" } })
            .where(eq(SessionTable.id, s.sessionID))
            .run()
          yield* status.set(s.sessionID, { type: "idle" })
          const accepted = yield* pollWithTimeout(
            s.schedules
              .history(s.sessionID, schedule.id)
              .pipe(Effect.map((history) => (history.items[0]?.state === "accepted" ? history.items[0] : undefined))),
            "Deferred occurrence was not accepted after the model was repaired and session became idle",
          )
          expect(accepted.id).toBe(first.id)
          expect(accepted.scheduled).toBe(first.scheduled)
          const current = yield* s.schedules.get(s.sessionID, schedule.id)
          expect(current.anchor).toBe(schedule.anchor)
          expect(current.next).toBe(schedule.anchor + 60_000)
          expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toHaveLength(1)
          const queued = (yield* s.queue.list(s.sessionID)).items
          expect(queued).toHaveLength(1)
          expect(queued[0]?.id).toBe(first.id)
          expect(queued[0]?.payload.kind === "prompt" && queued[0].payload.parts).toEqual([
            { type: "text", text: input.message },
          ])
        }),
      { config: testProviderConfig("http://127.0.0.1:1") },
    )
  }

  it.instance("preserves bootstrap failures without invoking dispatch or reloading under the writer lock", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const boots = { count: 0 }
      const context = yield* Layer.build(
        LayerNode.compile(InstanceStore.node, [
          [Database.node, Layer.succeed(Database.Service, s.database)],
          [
            InstanceStore.bootstrapNode,
            Layer.succeed(InstanceBootstrap.Service, {
              run: Effect.sync(() => {
                boots.count++
                throw new Error("Scheduled instance bootstrap failed")
              }),
            }),
          ],
        ]).pipe(Layer.fresh),
      )
      const schedule = yield* s.schedules.create(s.sessionID, input)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        store: Context.get(context, InstanceStore.Service),
        startup: 0,
        prepare: () => Effect.die("Bootstrap failure must not resolve a payload"),
        dispatch: () => Effect.die("Bootstrap failure must not dispatch without an instance"),
      })
      yield* scheduler.drain(() => schedule.anchor)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items[0]).toMatchObject({
        id: `occ_${schedule.id}_${schedule.anchor}`,
        state: "failed",
        error: "Error: Scheduled instance bootstrap failed",
      })
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.anchor + 60_000)
      expect((yield* s.queue.list(s.sessionID)).items).toEqual([])
      expect(boots.count).toBe(1)
    }),
  )

  it.instance("records a real missing-default-agent defect and continues into another project", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const context = yield* Layer.build(
        LayerNode.compile(LayerNode.group([Agent.node, InstanceStore.node]), [
          [Database.node, Layer.succeed(Database.Service, s.database)],
          [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
        ]).pipe(Layer.fresh),
      )
      const store = Context.get(context, InstanceStore.Service)
      const agents = Context.get(context, Agent.Service)
      const bad = yield* tmpdirScoped({ git: true, config: { default_agent: "missing-scheduled-agent" } })
      const good = yield* tmpdirScoped({ git: true })
      const create = Effect.gen(function* () {
        const session = yield* s.sessions.create({})
        yield* Effect.addFinalizer(() =>
          s.db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie),
        )
        return yield* s.schedules.create(session.id, input)
      })
      const poison = yield* store.provide({ directory: bad }, create)
      const healthy = yield* store.provide({ directory: good }, create)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        store,
        startup: 0,
        prepare: () => agents.defaultInfo().pipe(Effect.as(payload)),
        dispatch: (schedule, occurrence, session, prepared) =>
          prepared && Result.isFailure(prepared)
            ? Effect.fail(prepared.failure)
            : s.queue
                .enqueueScheduled(
                  session.id,
                  { id: occurrence.id, payload },
                  { type: "scheduled", scheduleID: schedule.id, occurrenceID: occurrence.id },
                )
                .pipe(Effect.as("idle" as const)),
      })
      yield* scheduler.drain(() => healthy.anchor).pipe(Effect.timeout("10 seconds"))
      const failed = yield* s.db
        .select()
        .from(SessionScheduleOccurrenceTable)
        .where(eq(SessionScheduleOccurrenceTable.schedule_id, poison.id))
        .all()
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({
        state: "failed",
        error: 'Error: default agent "missing-scheduled-agent" not found',
      })
      expect(
        (yield* s.db.select().from(SessionScheduleTable).where(eq(SessionScheduleTable.id, poison.id)).get())?.next,
      ).toBe(poison.anchor + 60_000)
      expect(
        (yield* s.db
          .select()
          .from(SessionScheduleOccurrenceTable)
          .where(eq(SessionScheduleOccurrenceTable.schedule_id, healthy.id))
          .get())?.state,
      ).toBe("accepted")
      // Retrying the same tick must not repeat the failed occurrence or its error.
      yield* scheduler.drain(() => healthy.anchor)
      expect(
        yield* s.db
          .select()
          .from(SessionScheduleOccurrenceTable)
          .where(eq(SessionScheduleOccurrenceTable.schedule_id, poison.id))
          .all(),
      ).toHaveLength(1)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.instance("bounds synchronous preparation defects and continues draining healthy schedules", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const bad = yield* s.schedules.create(s.sessionID, input)
      const good = yield* s.schedules.create(s.sessionID, input)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        prepare: (schedule) => {
          if (schedule.id === bad.id) throw new Error("broken preparation " + "x".repeat(3000))
          return Effect.succeed(payload)
        },
        dispatch: (_, occurrence, _session, prepared) =>
          prepared && Result.isFailure(prepared)
            ? Effect.fail(prepared.failure)
            : s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
      })
      yield* scheduler.drain(() => good.anchor)
      const history = yield* s.schedules.history(s.sessionID, bad.id)
      expect(history.items[0]?.state).toBe("failed")
      expect(history.items[0]?.error).toStartWith("Error: broken preparation")
      expect(history.items[0]?.error).toHaveLength(2000)
      expect((yield* s.schedules.history(s.sessionID, good.id)).items[0]?.state).toBe("accepted")
    }),
  )

  it.instance("prepares outside writer/admission locks and retries a concurrently edited snapshot", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const runtime = RuntimeLifecycle.make({ lineage: "schedule-preparation-test" }, yield* Effect.scope, s.database)
      const context = yield* Layer.build(
        SessionSchedule.layer.pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime)), Layer.fresh),
      )
      const service = Context.get(context, SessionSchedule.Service)
      const schedule = yield* service.create(s.sessionID, input)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scheduler = ServerScheduler.engine({
        database: s.database,
        runtime,
        startup: 0,
        prepare: (row) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return { ...payload, parts: [{ type: "text" as const, text: row.input.message }] }
          }),
        dispatch: (_, occurrence, session, prepared) =>
          prepared?._tag === "Success"
            ? s.queue
                .enqueue(session.id, { id: occurrence.id, payload: prepared.success })
                .pipe(Effect.as("idle" as const))
            : Effect.die("Missing prepared input"),
      })
      const preparing = yield* scheduler.step(schedule.anchor).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* service.update(s.sessionID, schedule.id, { ...input, message: "edited while preparing" })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(preparing)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toEqual([])
      yield* scheduler.drain(() => schedule.anchor)
      const queued = (yield* s.queue.list(s.sessionID)).items[0]
      expect(queued?.payload.kind === "prompt" && queued.payload.parts[0]).toEqual({
        type: "text",
        text: "edited while preparing",
      })
    }),
  )

  it.instance("closes scheduler admission during slow preparation without advancing the cursor", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const runtime = RuntimeLifecycle.make(
        { lineage: "schedule-preparation-drain-test" },
        yield* Effect.scope,
        s.database,
      )
      const schedule = yield* s.schedules.create(s.sessionID, input)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scheduler = ServerScheduler.engine({
        database: s.database,
        runtime,
        startup: 0,
        prepare: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(payload)),
        dispatch: () => Effect.die("Admission after draining"),
      })
      const preparing = yield* scheduler.step(schedule.anchor).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(entered)
      expect((yield* runtime.request("shutdown")).state).not.toBe("running")
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(preparing))).toBe(true)
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.next)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toEqual([])
      expect((yield* s.queue.list(s.sessionID)).items).toEqual([])
    }),
  )

  it.instance("does not await a disposed instance's database-dependent replacement during commit", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const original = yield* InstanceRef
      if (!original) return yield* Effect.die("Missing instance")
      const loading = yield* Deferred.make<void>()
      const read = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const state = { reload: false, prepared: original, loading }
      const context = yield* Layer.build(
        LayerNode.compile(InstanceStore.node, [
          [
            InstanceStore.bootstrapNode,
            Layer.succeed(InstanceBootstrap.Service, {
              run: Effect.gen(function* () {
                if (!state.reload) return
                yield* Deferred.succeed(state.loading, undefined)
                yield* Deferred.await(read)
                yield* s.db.get(sql`SELECT 1`).pipe(Effect.orDie)
              }),
            }),
          ],
        ]).pipe(Layer.fresh),
      )
      const store = Context.get(context, InstanceStore.Service)
      const instance = yield* store.load(original)
      const runtime = RuntimeLifecycle.make({ lineage: "schedule-instance-reload" }, yield* Effect.scope, s.database)
      const schedule = yield* s.schedules.create(s.sessionID, input)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        runtime,
        store,
        startup: 0,
        prepare: () =>
          Effect.gen(function* () {
            const prepared = yield* InstanceRef
            if (!prepared) return yield* Effect.die("Missing prepared instance")
            state.prepared = prepared
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return payload
          }),
        dispatch: (_, occurrence) =>
          Effect.gen(function* () {
            expect(yield* InstanceRef).toBe(state.prepared)
            yield* s.queue.enqueueScheduled(
              s.sessionID,
              { id: occurrence.id, payload },
              { type: "scheduled", scheduleID: schedule.id, occurrenceID: occurrence.id },
            )
            return "idle" as const
          }),
      })
      const preparing = yield* scheduler.step(schedule.anchor).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* store.dispose(instance)
      state.reload = true
      const reloading = yield* store.load(original).pipe(Effect.forkChild)
      yield* Deferred.await(loading)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(preparing).pipe(Effect.timeout("2 seconds"))).toMatchObject({ blocked: true })
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.next)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toEqual([])
      expect((yield* s.queue.list(s.sessionID)).items).toEqual([])
      yield* Deferred.succeed(read, undefined)
      const replacement = yield* Fiber.join(reloading).pipe(Effect.timeout("2 seconds"))
      yield* scheduler.drain(() => schedule.anchor).pipe(Effect.timeout("2 seconds"))
      expect(state.prepared).toBe(replacement)
      expect((yield* s.queue.list(s.sessionID)).items).toHaveLength(1)
      // Also dispose after entering the writer transaction. The replacement now
      // actually waits on that transaction's DB lock, not on the preparation gate.
      state.loading = yield* Deferred.make<void>()
      const scope = yield* Effect.scope
      const replacementLoaded = yield* Deferred.make<void>()
      const racing = ServerScheduler.engine({
        database: s.database,
        runtime,
        store,
        startup: 0,
        prepare: () => Effect.succeed(payload),
        dispatch: (_, occurrence) =>
          Effect.gen(function* () {
            expect(yield* InstanceRef).toBe(replacement)
            yield* store.dispose(replacement)
            yield* store
              .load(original)
              .pipe(Effect.andThen(Deferred.succeed(replacementLoaded, undefined)), Effect.forkIn(scope))
            yield* Deferred.await(state.loading)
            yield* Effect.yieldNow
            yield* s.queue.enqueueScheduled(
              s.sessionID,
              { id: occurrence.id, payload },
              { type: "scheduled", scheduleID: schedule.id, occurrenceID: occurrence.id },
            )
            return "idle" as const
          }),
      })
      expect(yield* racing.step(schedule.anchor + 60_000).pipe(Effect.timeout("2 seconds"))).toMatchObject({
        blocked: true,
      })
      yield* Deferred.await(replacementLoaded).pipe(Effect.timeout("2 seconds"))
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.anchor + 60_000)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toHaveLength(1)
      expect((yield* s.queue.list(s.sessionID)).items).toHaveLength(1)
      expect((yield* runtime.request("shutdown")).state).not.toBe("running")
    }),
  )

  for (const phase of ["prepare", "dispatch"] as const) {
    it.instance(`releases the instance subscription and admission on interruption during ${phase}`, () =>
      Effect.gen(function* () {
        const s = yield* setup
        const original = yield* InstanceRef
        if (!original) return yield* Effect.die("Missing instance")
        const context = yield* Layer.build(
          LayerNode.compile(InstanceStore.node, [
            [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
          ]).pipe(Layer.fresh),
        )
        const store = Context.get(context, InstanceStore.Service)
        const instance = yield* store.load(original)
        const runtime = RuntimeLifecycle.make(
          { lineage: `schedule-interrupt-${phase}` },
          yield* Effect.scope,
          s.database,
        )
        const schedule = yield* s.schedules.create(s.sessionID, input)
        const entered = yield* Deferred.make<void>()
        const listeners = GlobalBus.listenerCount("event")
        const scheduler = ServerScheduler.engine({
          database: s.database,
          runtime,
          store,
          startup: 0,
          prepare: () =>
            Effect.gen(function* () {
              expect(yield* InstanceRef).toBe(instance)
              if (phase === "prepare") {
                yield* Deferred.succeed(entered, undefined)
                yield* Effect.never
              }
              return payload
            }),
          dispatch: (_, occurrence) =>
            Effect.gen(function* () {
              expect(yield* InstanceRef).toBe(instance)
              yield* s.queue.enqueueScheduled(
                s.sessionID,
                { id: occurrence.id, payload },
                { type: "scheduled", scheduleID: schedule.id, occurrenceID: occurrence.id },
              )
              yield* Deferred.succeed(entered, undefined)
              yield* Effect.never
              return "idle" as const
            }),
        })
        const running = yield* scheduler.step(schedule.anchor).pipe(Effect.forkChild)
        yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
        expect(GlobalBus.listenerCount("event")).toBe(listeners + 1)
        yield* Fiber.interrupt(running).pipe(Effect.timeout("2 seconds"))
        expect(GlobalBus.listenerCount("event")).toBe(listeners)
        expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.next)
        expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toEqual([])
        expect((yield* s.queue.list(s.sessionID)).items).toEqual([])
        expect(yield* store.load(original)).toBe(instance)
        expect((yield* runtime.request("shutdown").pipe(Effect.timeout("2 seconds"))).state).not.toBe("running")
      }),
    )
  }

  for (const spec of [
    { mode: "cron", expression: "invalid", timeZone: "UTC" },
    { mode: "interval", amount: Number.MAX_SAFE_INTEGER, unit: "weeks", immediate: true },
  ] satisfies SessionScheduleV1.Spec[]) {
    it.instance(`isolates persisted ${spec.mode} calculation failures without advancing or replaying the cursor`, () =>
      Effect.gen(function* () {
        const s = yield* setup
        const poison = yield* s.schedules.create(s.sessionID, input)
        const valid = yield* s.schedules.create(s.sessionID, input)
        yield* s.db
          .update(SessionScheduleTable)
          .set({ input: { ...input, spec }, time_created: 0 })
          .where(eq(SessionScheduleTable.id, poison.id))
          .run()
        const scheduler = ServerScheduler.engine({
          database: s.database,
          startup: 0,
          dispatch: (_, occurrence) =>
            s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
        })
        yield* scheduler.drain(() => valid.anchor)
        yield* scheduler.drain(() => valid.anchor)
        const row = yield* s.db.select().from(SessionScheduleTable).where(eq(SessionScheduleTable.id, poison.id)).get()
        expect(row?.status).toBe("paused")
        expect(row?.next).toBe(poison.next)
        const history = yield* s.schedules.history(s.sessionID, poison.id)
        expect(history.items).toHaveLength(1)
        expect(history.items[0]?.state).toBe("failed")
        expect(history.items[0]?.error?.length).toBeGreaterThan(0)
        expect((yield* s.schedules.history(s.sessionID, valid.id)).items[0]?.state).toBe("accepted")
        expect((yield* s.queue.list(s.sessionID)).items).toHaveLength(1)
      }),
    )
  }

  it.instance("does not blindly replay missing accepted queue evidence", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, { ...input, limit: 1 })
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: (_, occurrence) =>
          s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
      })
      yield* scheduler.step(schedule.anchor)
      yield* s.db.delete(SessionQueueTable).where(eq(SessionQueueTable.session_id, s.sessionID)).run()
      yield* scheduler.reconcile
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items[0]?.state).toBe("uncertain")
      expect((yield* scheduler.step(schedule.anchor + 60_000))?.blocked).toBe(true)
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).completed).toBe(0)
    }),
  )

  it.instance("rolls back both admission and cursor when runtime draining interrupts dispatch", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, input)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: (_, occurrence) =>
          Effect.gen(function* () {
            yield* s.queue.enqueue(s.sessionID, { id: occurrence.id, payload })
            return yield* new RuntimeLifecycle.RuntimeDrainingError({ message: "Runtime is draining" })
          }),
      })
      expect(Result.isFailure(yield* scheduler.step(schedule.anchor).pipe(Effect.result))).toBe(true)
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).next).toBe(schedule.next)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items).toEqual([])
      expect((yield* s.queue.list(s.sessionID)).items).toEqual([])
    }),
  )

  it.instance("keeps live claims reserved and quarantines proven-dead claims without replay", () =>
    Effect.gen(function* () {
      const identity = RuntimeLifecycle.processIdentity()
      if (!identity) return
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, { ...input, limit: 1 })
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: (_, occurrence) =>
          s.queue.enqueue(s.sessionID, { id: occurrence.id, payload }).pipe(Effect.as("idle" as const)),
      })
      yield* scheduler.step(schedule.anchor)
      const entry = yield* s.queue.claimNext(s.sessionID)
      if (!entry) return yield* Effect.die("Missing claim")
      yield* scheduler.reconcile
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items[0]?.state).toBe("accepted")
      yield* s.db
        .update(SessionQueueTable)
        .set({ owner: JSON.stringify({ id: "abandoned", process: { ...identity, pid: 2147483647 } }) })
        .where(eq(SessionQueueTable.id, entry.id))
        .run()
      yield* scheduler.reconcile
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items[0]?.state).toBe("uncertain")
      expect((yield* scheduler.step(schedule.anchor + 60_000))?.blocked).toBe(true)
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).completed).toBe(0)
    }),
  )

  it.instance("records bounded failures without spending successful delivery allowance", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, { ...input, limit: 1 })
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: () => Effect.fail("x".repeat(4000)),
      })
      yield* scheduler.step(schedule.anchor)
      yield* scheduler.step(schedule.anchor + 60_000)
      const history = yield* s.schedules.history(s.sessionID, schedule.id)
      expect(history.items.map((row) => row.state)).toEqual(["failed", "failed"])
      expect(history.items.every((row) => row.error?.length === 2000)).toBe(true)
      expect((yield* s.schedules.get(s.sessionID, schedule.id)).completed).toBe(0)
    }),
  )

  it.instance("does not resurrect archived sessions and discards old deferred work on pause", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, { ...input, sessionState: "idle", deferUntilIdle: true })
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: () => Effect.succeed("busy" as const),
      })
      yield* scheduler.step(schedule.anchor)
      yield* s.schedules.pause(s.sessionID, schedule.id, true)
      expect((yield* s.schedules.history(s.sessionID, schedule.id)).items[0]?.state).toBe("discarded")
      yield* s.schedules.pause(s.sessionID, schedule.id, false)
      yield* s.db.update(SessionTable).set({ time_archived: Date.now() }).where(eq(SessionTable.id, s.sessionID)).run()
      yield* scheduler.step(schedule.anchor + 60_000)
      expect(Result.isFailure(yield* s.schedules.list(s.sessionID).pipe(Effect.result))).toBe(true)
      expect(
        (yield* s.db.select().from(SessionScheduleTable).where(eq(SessionScheduleTable.id, schedule.id)).get())?.status,
      ).toBe("paused")
      expect(
        (yield* s.db
          .select()
          .from(SessionScheduleOccurrenceTable)
          .where(eq(SessionScheduleOccurrenceTable.schedule_id, schedule.id))
          .all()).some((row) => row.state === "failed" && row.error?.includes("archived")),
      ).toBe(true)
      expect((yield* s.queue.list(s.sessionID).pipe(Effect.result))._tag).toBe("Failure")
    }),
  )

  it.instance("dispatches equal timestamps by schedule creation then ID across sessions", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const other = yield* s.sessions.create({})
      yield* Effect.addFinalizer(() =>
        s.db.delete(SessionTable).where(eq(SessionTable.id, other.id)).run().pipe(Effect.orDie),
      )
      const first = yield* s.schedules.create(s.sessionID, input)
      const second = yield* s.schedules.create(other.id, input)
      yield* s.db
        .update(SessionScheduleTable)
        .set({ next: first.anchor, time_created: 1 })
        .where(eq(SessionScheduleTable.id, second.id))
        .run()
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: () => Effect.succeed("idle" as const),
      })
      expect((yield* scheduler.step(first.anchor))?.id).toBe(second.id)
      expect((yield* scheduler.step(first.anchor))?.id).toBe(first.id)
    }),
  )

  it.instance("permanently fences retired sessions without admitting another occurrence", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, input)
      yield* RuntimeRetirement.retireRoot(s.database, s.sessionID)
      const scheduler = ServerScheduler.engine({
        database: s.database,
        startup: 0,
        dispatch: () => Effect.die("Retired dispatch"),
      })
      yield* scheduler.step(schedule.anchor)
      expect(
        (yield* s.db.select().from(SessionScheduleTable).where(eq(SessionScheduleTable.id, schedule.id)).get())?.status,
      ).toBe("paused")
      const result = yield* s.schedules.pause(s.sessionID, schedule.id, false).pipe(Effect.result)
      expect(Result.isFailure(result) && result.failure.reason).toBe("conflict")
    }),
  )

  it.instance("paginates bounded history and cascades schedule deletion", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const schedule = yield* s.schedules.create(s.sessionID, input)
      yield* s.db
        .insert(SessionScheduleOccurrenceTable)
        .values(
          Array.from({ length: 65 }, (_, i) => ({
            id: `${schedule.id}_${i}`,
            schedule_id: schedule.id,
            scheduled: i,
            state: "discarded" as const,
          })),
        )
        .run()
      const first = yield* s.schedules.history(s.sessionID, schedule.id)
      const second = yield* s.schedules.history(s.sessionID, schedule.id, first.cursor)
      expect(first.items).toHaveLength(50)
      expect(second.items).toHaveLength(15)
      expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(65)
      yield* s.schedules.remove(s.sessionID, schedule.id)
      expect(
        yield* s.db
          .select()
          .from(SessionScheduleOccurrenceTable)
          .where(eq(SessionScheduleOccurrenceTable.schedule_id, schedule.id))
          .all(),
      ).toEqual([])
      expect(
        yield* s.db.select().from(SessionScheduleTable).where(eq(SessionScheduleTable.id, schedule.id)).all(),
      ).toEqual([])
    }),
  )
})
