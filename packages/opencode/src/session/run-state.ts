import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context, Option, Cause } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"

export interface Interface {
  readonly admit: <E>(
    sessionID: SessionID,
    prepare: (active?: SessionV1.User["model"]) => Effect.Effect<SessionV1.User, E>,
  ) => Effect.Effect<void, E>
  readonly observe: (sessionID: SessionID, parent: SessionV1.User, visible: ReadonlySet<string>) => Effect.Effect<void>
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly enqueue: <E = never>(
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    prepare?: (active?: SessionV1.User["model"]) => Effect.Effect<SessionV1.User, E>,
  ) => Effect.Effect<SessionV1.WithParts, E>
  readonly startIfIdle: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts, never, Scope.Scope>,
    prepare: Effect.Effect<boolean, never, Scope.Scope>,
  ) => Effect.Effect<boolean>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const runtime = Option.getOrElse(
      yield* Effect.serviceOption(RuntimeLifecycle.Service),
      () => RuntimeLifecycle.current() ?? RuntimeLifecycle.unavailable(),
    )

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        const selections = new Map<SessionID, SessionV1.User>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancelWithReason("scope"), {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, selections, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          if (next.busy) return
          data.runners.delete(sessionID)
          data.selections.delete(sessionID)
          if (yield* runtime.isParked(sessionID)) {
            yield* status.set(sessionID, { type: "busy" })
            return
          }
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
      })
      data.runners.set(sessionID, next)
      return next
    })

    // Cancellation belongs to each waiter, not to the shared session runner.
    const onCancellation = <E>(
      work: Effect.Effect<SessionV1.WithParts, E>,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) =>
      work.pipe(
        Effect.catchCause((cause) =>
          Cause.squash(cause) instanceof Runner.Cancelled ? onInterrupt : Effect.failCause(cause),
        ),
      )

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const pending = [sessionID]
      const cancelled = new Set<SessionID>()
      while (pending.length > 0) {
        const current = pending.pop()!
        if (cancelled.has(current)) continue
        cancelled.add(current)
        yield* cancelBackgroundJobs(background, current)
        const data = yield* InstanceState.get(state)
        const existing = data.runners.get(current)
        if (existing) yield* existing.cancel
        else yield* status.set(current, { type: "idle" })
        const children = yield* sessions.children(current)
        pending.push(...children.map((child) => child.id))
      }
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* onCancellation((yield* runner(sessionID)).ensureRunning(work), onInterrupt)
    })

    const activeModel = Effect.fn("SessionRunState.activeModel")(function* (sessionID: SessionID, active: boolean) {
      if (!active) return
      const data = yield* InstanceState.get(state)
      const parent = data.selections.get(sessionID)
      if (!parent) return
      const response = yield* sessions
        .findMessage(sessionID, (message) => message.info.role === "assistant" && message.info.parentID === parent.id)
        .pipe(Effect.orDie)
      if (Option.isSome(response) && response.value.info.role === "assistant") {
        const assistant = response.value.info
        // Runner cleanup can lag the durable terminal response. Tool steps still own the turn.
        if (
          assistant.time.completed &&
          (assistant.error ||
            (assistant.finish &&
              !["tool-calls", "unknown"].includes(assistant.finish) &&
              !response.value.parts.some(
                (part) =>
                  part.type === "tool" &&
                  !part.metadata?.providerExecuted &&
                  !(
                    part.state.status === "error" &&
                    part.state.metadata?.interrupted === true &&
                    part.state.metadata?.crashInterrupted !== true
                  ) &&
                  !(part.tool === "StructuredOutput" && assistant.structured !== undefined),
              )))
        )
          return
      }
      return parent.model
    })

    const enqueue = Effect.fn("SessionRunState.enqueue")(function* <E = never>(
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      prepare?: (active?: SessionV1.User["model"]) => Effect.Effect<SessionV1.User, E>,
    ) {
      const data = yield* InstanceState.get(state)
      return yield* onCancellation(
        (yield* runner(sessionID)).enqueue(
          work,
          prepare
            ? (active) =>
                activeModel(sessionID, active).pipe(
                  Effect.flatMap(prepare),
                  Effect.tap((parent) => Effect.sync(() => data.selections.set(sessionID, parent))),
                  Effect.asVoid,
                )
            : undefined,
        ),
        onInterrupt,
      )
    })

    const admit = Effect.fn("SessionRunState.admit")(function* <E>(
      sessionID: SessionID,
      prepare: (active?: SessionV1.User["model"]) => Effect.Effect<SessionV1.User, E>,
    ) {
      const data = yield* InstanceState.get(state)
      const current = yield* runner(sessionID)
      yield* current.admit((active) =>
        activeModel(sessionID, active).pipe(
          Effect.flatMap(prepare),
          Effect.tap((parent) => Effect.sync(() => data.selections.set(sessionID, parent))),
        ),
      )
    })

    const observe = Effect.fn("SessionRunState.observe")(function* (
      sessionID: SessionID,
      parent: SessionV1.User,
      visible: ReadonlySet<string>,
    ) {
      const data = yield* InstanceState.get(state)
      const current = yield* runner(sessionID)
      yield* current.admit(() =>
        Effect.sync(() => {
          const admitted = data.selections.get(sessionID)
          // Never replace a steer admitted after this history snapshot was read.
          if (!admitted || visible.has(admitted.id)) data.selections.set(sessionID, parent)
        }),
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* onCancellation((yield* runner(sessionID)).startShell(work, ready), onInterrupt).pipe(
        Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))),
      )
    })

    const startIfIdle = Effect.fn("SessionRunState.startIfIdle")(function* (
      sessionID: SessionID,
      _onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts, never, Scope.Scope>,
      prepare: Effect.Effect<boolean, never, Scope.Scope>,
    ) {
      return yield* (yield* runner(sessionID)).startIfIdle(work, prepare)
    })

    return Service.of({ admit, observe, assertNotBusy, cancel, ensureRunning, enqueue, startShell, startIfIdle })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, Session.node, SessionStatus.node],
})

export * as SessionRunState from "./run-state"
