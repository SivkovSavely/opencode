import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly enqueue: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly startIfIdle: (
    work: Effect.Effect<A, E, Scope.Scope>,
    prepare: Effect.Effect<boolean, never, Scope.Scope>,
  ) => Effect.Effect<boolean>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
  readonly cancelWithReason: (reason: CancelReason) => Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Interrupted extends Schema.TaggedErrorClass<Interrupted>()("RunnerInterrupted", {
  reason: Schema.Literals(["internal", "scope"]),
}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

export type CancelReason = "user" | "scope"

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled | Interrupted>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<CancelReason>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled | Interrupted>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "RunningQueued"; readonly run: RunHandle<A, E>; readonly queue: PendingHandle<A, E>[] }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | {
      readonly _tag: "ShellThenRun"
      readonly shell: ShellHandle<A, E>
      readonly run: PendingHandle<A, E>
      readonly queue: PendingHandle<A, E>[]
    }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  const cancellations = new Map<number, CancelReason>()
  let ids = 0
  let advisory:
    | { work: Effect.Effect<A, E, Scope.Scope>; prepare: Effect.Effect<boolean, never, Scope.Scope> }
    | undefined

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const cancellationError = (reason: CancelReason) =>
    reason === "user" ? new Cancelled() : new Interrupted({ reason: "scope" })

  const complete = (
    done: Deferred.Deferred<A, E | Cancelled | Interrupted>,
    exit: Exit.Exit<A, E>,
    reason?: CancelReason,
  ) => {
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
      if (reason === "user") return Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      return Deferred.fail(
        done,
        new Interrupted({ reason: reason === "scope" || scope.state._tag === "Closed" ? "scope" : "internal" }),
      ).pipe(Effect.asVoid)
    }
    return Deferred.done(done, exit).pipe(Effect.asVoid)
  }

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled | Interrupted>) =>
    Deferred.await(done).pipe(
      Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)),
      Effect.catchTag("RunnerInterrupted", (error) => Effect.die(error)),
    )

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  const finishRun: (
    id: number,
    done: Deferred.Deferred<A, E | Cancelled | Interrupted>,
    exit: Exit.Exit<A, E>,
    skipped?: boolean,
  ) => Effect.Effect<void> = (id, done, exit, skipped = false) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        const reason = cancellations.get(id)
        cancellations.delete(id)
        if (
          !skipped &&
          (st._tag === "Running" || st._tag === "RunningQueued") &&
          st.run.id === id &&
          Exit.isFailure(exit)
        )
          advisory = undefined
        if (st._tag === "Running" && st.run.id === id) {
          const run = yield* takeAdvisory()
          if (run) return [complete(done, exit, reason), { _tag: "Running", run }] as const
          return [idle.pipe(Effect.andThen(complete(done, exit, reason))), { _tag: "Idle" }] as const
        }
        if (st._tag !== "RunningQueued" || st.run.id !== id) return [complete(done, exit, reason), st] as const
        const [pending, ...queue] = st.queue
        if (!pending) return [complete(done, exit, reason), { _tag: "Idle" }] as const
        const run = yield* startRun(pending.work, pending.done)
        return [
          complete(done, exit, reason),
          queue.length > 0 ? ({ _tag: "RunningQueued", run, queue } as const) : ({ _tag: "Running", run } as const),
        ] as const
      }),
    ).pipe(Effect.flatten)

  const startRun: (
    work: Effect.Effect<A, E, Scope.Scope>,
    done: Deferred.Deferred<A, E | Cancelled | Interrupted>,
    admission?: { prepare: Effect.Effect<boolean, never, Scope.Scope>; ready?: Deferred.Deferred<boolean> },
  ) => Effect.Effect<RunHandle<A, E>> = (work, done, admission) =>
    Effect.gen(function* () {
      const id = next()
      let skipped = false
      const runScope = Scope.forkUnsafe(scope)
      // Admission can wait for cancellation. Run it in the owned fiber, never
      // under the state lock that cancellation needs in order to interrupt it.
      const run = admission
        ? Effect.gen(function* () {
            const admitted = yield* admission.prepare
            if (admission.ready) yield* Deferred.succeed(admission.ready, admitted)
            if (!admitted) {
              skipped = true
              return yield* Effect.interrupt
            }
            return yield* work
          }).pipe(
            Effect.ensuring(
              admission.ready ? Deferred.succeed(admission.ready, false).pipe(Effect.asVoid) : Effect.void,
            ),
          )
        : work
      const fiber = yield* run.pipe(
        Effect.scoped,
        Effect.onExit((exit) => finishRun(id, done, exit, skipped)),
        Effect.forkIn(runScope),
      )
      yield* Scope.addFinalizer(
        runScope,
        Effect.gen(function* () {
          const current = state()
          if ((current._tag === "Running" || current._tag === "RunningQueued") && current.run.id === id)
            yield* cancelWithReason("scope")
        }),
      )
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap((exit) => Scope.close(runScope, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber } satisfies RunHandle<A, E>
    })

  const takeAdvisory = Effect.fnUntraced(function* () {
    const next = advisory
    advisory = undefined
    if (!next) return
    return yield* startRun(next.work, yield* Deferred.make<A, E | Cancelled | Interrupted>(), {
      prepare: next.prepare,
    })
  })

  const finishShell = (id: number, success: boolean) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if ((st._tag === "Shell" || st._tag === "ShellThenRun") && st.shell.id === id && !success) advisory = undefined
        if (st._tag === "Shell" && st.shell.id === id) {
          const run = yield* takeAdvisory()
          if (run) return [Effect.void, { _tag: "Running", run }] as const
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const run = yield* startRun(st.run.work, st.run.done)
          return [
            Effect.void,
            st.queue.length > 0
              ? ({ _tag: "RunningQueued", run, queue: st.queue } as const)
              : ({ _tag: "Running", run } as const),
          ] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>, reason: CancelReason) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, reason).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const ensureRunning = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Running":
          case "RunningQueued":
          case "ShellThenRun":
            return [awaitDone(st.run.done), st] as const
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Interrupted>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run, queue: [] }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled | Interrupted>()
            const run = yield* startRun(work, done)
            return [awaitDone(done), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const enqueue = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        const pending = {
          id: next(),
          done: yield* Deferred.make<A, E | Cancelled | Interrupted>(),
          work,
        } satisfies PendingHandle<A, E>
        if (st._tag === "Idle") {
          const run = yield* startRun(pending.work, pending.done)
          return [awaitDone(pending.done), { _tag: "Running", run }] as const
        }
        if (st._tag === "Running")
          return [awaitDone(pending.done), { _tag: "RunningQueued", run: st.run, queue: [pending] }] as const
        if (st._tag === "RunningQueued")
          return [awaitDone(pending.done), { ...st, queue: [...st.queue, pending] }] as const
        if (st._tag === "Shell")
          return [awaitDone(pending.done), { _tag: "ShellThenRun", shell: st.shell, run: pending, queue: [] }] as const
        return [awaitDone(pending.done), { ...st, queue: [...st.queue, pending] }] as const
      }),
    ).pipe(Effect.flatten)

  const startIfIdle = (work: Effect.Effect<A, E, Scope.Scope>, prepare: Effect.Effect<boolean, never, Scope.Scope>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          // Recheck inside the final successful completion transition. Otherwise
          // an enqueue between a drain's last check and Idle could be stranded.
          advisory = { work, prepare }
          return [Effect.succeed(false), st] as const
        }
        const ready = yield* Deferred.make<boolean>()
        const done = yield* Deferred.make<A, E | Cancelled | Interrupted>()
        const run = yield* startRun(work, done, { prepare, ready })
        return [
          Deferred.await(ready).pipe(
            Effect.flatMap((admitted) =>
              admitted ? Effect.succeed(true) : Deferred.await(done).pipe(Effect.exit, Effect.as(false)),
            ),
          ),
          { _tag: "Running", run },
        ] as const
      }),
    ).pipe(Effect.flatten)

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<CancelReason>()
        const fiber = yield* work.pipe(
          Effect.onExit((exit) => finishShell(id, Exit.isSuccess(exit))),
          Effect.forkChild,
        )
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            const reason = (yield* Deferred.isDone(cancelled)) ? yield* Deferred.await(cancelled) : undefined
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              (reason !== undefined && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (reason === "user") {
                if (onInterrupt) return yield* onInterrupt
                return yield* Effect.die(new Cancelled())
              }
              return yield* Effect.die(
                new Interrupted({ reason: reason ?? (scope.state._tag === "Closed" ? "scope" : "internal") }),
              )
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)

  const cancelWithReason = (reason: CancelReason) =>
    SynchronizedRef.modify(ref, (st) => {
      advisory = undefined
      switch (st._tag) {
        case "Idle":
          return [Effect.void, st] as const
        case "Running":
          return [
            Effect.gen(function* () {
              cancellations.set(st.run.id, reason)
              yield* Fiber.interrupt(st.run.fiber)
              yield* Deferred.fail(st.run.done, cancellationError(reason)).pipe(Effect.asVoid)
              yield* idleIfCurrent()
            }),
            { _tag: "Idle" } as const,
          ] as const
        case "RunningQueued":
          return [
            Effect.gen(function* () {
              cancellations.set(st.run.id, reason)
              yield* Fiber.interrupt(st.run.fiber)
              yield* Deferred.fail(st.run.done, cancellationError(reason)).pipe(Effect.asVoid)
              yield* Effect.forEach(
                st.queue,
                (pending) => Deferred.fail(pending.done, cancellationError(reason)).pipe(Effect.asVoid),
                { concurrency: "unbounded", discard: true },
              )
              yield* idleIfCurrent()
            }),
            { _tag: "Idle" } as const,
          ] as const
        case "Shell":
          return [
            Effect.gen(function* () {
              yield* stopShell(st.shell, reason)
              yield* idleIfCurrent()
            }),
            { _tag: "Idle" } as const,
          ] as const
        case "ShellThenRun":
          return [
            Effect.gen(function* () {
              yield* stopShell(st.shell, reason)
              yield* Deferred.fail(st.run.done, cancellationError(reason)).pipe(Effect.asVoid)
              yield* Effect.forEach(
                st.queue,
                (pending) => Deferred.fail(pending.done, cancellationError(reason)).pipe(Effect.asVoid),
                { concurrency: "unbounded", discard: true },
              )
              yield* idleIfCurrent()
            }),
            { _tag: "Idle" } as const,
          ] as const
      }
    }).pipe(Effect.flatten)

  const cancel = cancelWithReason("user")

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    enqueue,
    startIfIdle,
    startShell,
    cancel,
    cancelWithReason,
  }
}

export * as Runner from "./runner"
