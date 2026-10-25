import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Ref, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { it } from "../lib/effect"

const waitForState = <A, E>(runner: Runner.Runner<A, E>, tag: Runner.State<A, E>["_tag"]) =>
  Effect.gen(function* () {
    while (runner.state._tag !== tag) yield* Effect.yieldNow
  }).pipe(Effect.timeout("1 second"))

describe("Runner", () => {
  it.live(
    "does not turn an unrequested interruption into successful cancellation",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      let interrupted = false
      const runner = Runner.make<string>(scope, {
        onInterrupt: Effect.sync(() => {
          interrupted = true
          return "cancelled"
        }),
      })

      const exit = yield* runner.ensureRunning(Effect.interrupt).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Interrupted)
      }
      expect(interrupted).toBe(false)
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "does not route scope interruption through user cancellation handling",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      let interrupted = false
      const runner = Runner.make<string>(scope, {
        onInterrupt: Effect.sync(() => {
          interrupted = true
          return "cancelled"
        }),
      })
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("never"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")

      yield* runner.cancelWithReason("scope")
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Runner.Interrupted)
        if (error instanceof Runner.Interrupted) expect(error.reason).toBe("scope")
      }
      expect(interrupted).toBe(false)
    }),
  )

  it.live(
    "classifies scope closure before instance cleanup runs",
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      let interrupted = false
      const runner = Runner.make<string>(scope, {
        onInterrupt: Effect.sync(() => {
          interrupted = true
          return "cancelled"
        }),
      })
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("never"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")

      yield* Scope.close(scope, Exit.void)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Runner.Interrupted)
        if (error instanceof Runner.Interrupted) expect(error.reason).toBe("scope")
      }
      expect(interrupted).toBe(false)
    }),
  )

  for (const outcome of ["failure", "ineligible", "success", "cancel"] as const) {
    it.live(
      `advisory resources are released on ${outcome}`,
      Effect.gen(function* () {
        const runner = Runner.make<string>(yield* Scope.Scope)
        const leases = yield* Ref.make(0)
        const working = yield* Deferred.make<void>()
        const prepare = Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Ref.update(leases, (count) => count + 1),
            () => Ref.update(leases, (count) => count - 1),
          )
          if (outcome === "failure") return yield* Effect.die("claim failed after admission")
          return outcome !== "ineligible"
        })
        yield* runner.startIfIdle(
          Deferred.succeed(working, undefined).pipe(
            Effect.andThen(outcome === "cancel" ? Effect.never : Effect.succeed("done")),
          ),
          prepare,
        )
        if (outcome === "cancel") {
          yield* Deferred.await(working)
          expect(yield* Ref.get(leases)).toBe(1)
          yield* runner.cancel
        }
        yield* waitForState(runner, "Idle")
        expect(yield* Ref.get(leases)).toBe(0)
      }),
    )
  }

  for (const advisory of [false, true]) {
    it.live(
      `cancellation interrupts admission waiting for lifecycle cancellation (${advisory ? "advisory" : "idle"})`,
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const runner = Runner.make<string>(scope)
        const preparing = yield* Deferred.make<void>()
        const cancelled = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const active = advisory
          ? yield* runner.ensureRunning(Deferred.await(release).pipe(Effect.as("first"))).pipe(Effect.forkChild)
          : undefined
        if (active) yield* waitForState(runner, "Running")
        const wake = yield* runner
          .startIfIdle(
            Effect.die("cancelled admission must not run"),
            Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Deferred.await(cancelled)), Effect.as(true)),
          )
          .pipe(Effect.forkChild)
        if (active) yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(preparing)
        yield* runner.cancel.pipe(Effect.timeout("1 second"))
        yield* Deferred.succeed(cancelled, undefined)
        expect(yield* Fiber.join(wake)).toBe(false)
        if (active) expect(yield* Fiber.join(active)).toBe("first")
        expect(runner.busy).toBe(false)
        expect(yield* runner.ensureRunning(Effect.succeed("after cancellation"))).toBe("after cancellation")
      }),
    )
  }

  it.live(
    "an ineligible admission does not discard a newer eligible wake",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const runner = Runner.make<string>(scope)
      const preparing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const first = yield* runner
        .startIfIdle(
          Effect.die("ineligible work must not run"),
          Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(false)),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(preparing)
      yield* runner.startIfIdle(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        Effect.succeed(true),
      )
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(first)).toBe(false)
      yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
      yield* runner.cancel
    }),
  )

  it.live(
    "startIfIdle rechecks an advisory wake before publishing successful completion",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const runner = Runner.make<string>(scope)
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const queued = yield* Deferred.make<void>()
      const running = yield* runner
        .ensureRunning(
          Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("first")),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      expect(
        yield* runner.startIfIdle(
          Deferred.succeed(queued, undefined).pipe(Effect.andThen(Effect.never)),
          Effect.succeed(true),
        ),
      ).toBe(false)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(running)).toBe("first")
      yield* Deferred.await(queued)
      expect(runner.busy).toBe(true)
      yield* runner.cancel
    }),
  )

  it.live(
    "startIfIdle discards advisory work after a failed execution",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const runner = Runner.make<string, string>(scope)
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const preparations = yield* Ref.make(0)
      const running = yield* runner
        .ensureRunning(
          Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.fail("failed")),
          ),
        )
        .pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(ready)
      yield* runner.startIfIdle(
        Effect.die("must not run"),
        Ref.update(preparations, (count) => count + 1).pipe(Effect.as(true)),
      )
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)
      expect(yield* Ref.get(preparations)).toBe(0)
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "startIfIdle serializes preparation and never admits work while busy",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const runner = Runner.make<string>(scope)
      const release = yield* Deferred.make<void>()
      const ready = yield* Deferred.make<void>()
      const preparations = yield* Ref.make(0)
      const prepare = Ref.update(preparations, (count) => count + 1).pipe(Effect.as(true))
      const work = Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("done"))
      const starts = yield* Effect.all([runner.startIfIdle(work, prepare), runner.startIfIdle(work, prepare)], {
        concurrency: "unbounded",
      })
      expect(starts.filter(Boolean)).toHaveLength(1)
      expect(yield* Ref.get(preparations)).toBe(1)
      yield* Deferred.await(ready)
      yield* runner.cancel
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "startIfIdle leaves the runner idle when preparation finds no eligible work",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const runner = Runner.make<string>(scope)
      expect(yield* runner.startIfIdle(Effect.die("must not run"), Effect.succeed(false))).toBe(false)
      expect(runner.busy).toBe(false)
      expect(yield* runner.ensureRunning(Effect.succeed("normal"))).toBe("normal")
    }),
  )

  // --- ensureRunning semantics ---

  it.live(
    "ensureRunning starts work and returns result",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const result = yield* runner.ensureRunning(Effect.succeed("hello"))
      expect(result).toBe("hello")
      expect(runner.state._tag).toBe("Idle")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "ensureRunning propagates work failures",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, string>(s)
      const exit = yield* runner.ensureRunning(Effect.fail("boom")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "concurrent callers share the same run",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const calls = yield* Ref.make(0)
      const work = Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        yield* Effect.sleep("10 millis")
        return "shared"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(work), runner.ensureRunning(work)], {
        concurrency: "unbounded",
      })

      expect(a).toBe("shared")
      expect(b).toBe("shared")
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live(
    "concurrent callers all receive same error",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, string>(s)
      const work = Effect.gen(function* () {
        yield* Effect.sleep("10 millis")
        return yield* Effect.fail("boom")
      })

      const [a, b] = yield* Effect.all(
        [runner.ensureRunning(work).pipe(Effect.exit), runner.ensureRunning(work).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      )

      expect(Exit.isFailure(a)).toBe(true)
      expect(Exit.isFailure(b)).toBe(true)
    }),
  )

  it.live(
    "ensureRunning can be called again after previous run completes",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      expect(yield* runner.ensureRunning(Effect.succeed("first"))).toBe("first")
      expect(yield* runner.ensureRunning(Effect.succeed("second"))).toBe("second")
    }),
  )

  it.live(
    "second ensureRunning ignores new work if already running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const ran = yield* Ref.make<string[]>([])

      const first = Effect.gen(function* () {
        yield* Ref.update(ran, (a) => [...a, "first"])
        yield* Effect.sleep("50 millis")
        return "first-result"
      })
      const second = Effect.gen(function* () {
        yield* Ref.update(ran, (a) => [...a, "second"])
        return "second-result"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(first), runner.ensureRunning(second)], {
        concurrency: "unbounded",
      })

      expect(a).toBe("first-result")
      expect(b).toBe("first-result")
      expect(yield* Ref.get(ran)).toEqual(["first"])
    }),
  )

  it.live(
    "enqueue runs notification work after the active run instead of joining it",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const order = yield* Ref.make<string[]>([])
      const firstStarted = yield* Deferred.make<void>()
      const finishFirst = yield* Deferred.make<void>()
      const first = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Ref.update(order, (items) => [...items, "active"])
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(finishFirst)
            return "active"
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      const queued = yield* runner
        .enqueue(
          Effect.gen(function* () {
            yield* Ref.update(order, (items) => [...items, "notification"])
            return "notification"
          }),
        )
        .pipe(Effect.forkChild)

      yield* Effect.yieldNow
      expect(yield* Ref.get(order)).toEqual(["active"])
      yield* Deferred.succeed(finishFirst, undefined)
      expect(yield* Fiber.join(first)).toBe("active")
      expect(yield* Fiber.join(queued)).toBe("notification")
      expect(yield* Ref.get(order)).toEqual(["active", "notification"])
    }),
  )

  // --- cancel semantics ---

  it.live(
    "cancel interrupts running work",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const started = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, void 0)
            return yield* Effect.never.pipe(Effect.as("never"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(runner.busy).toBe(true)
      expect(runner.state._tag).toBe("Running")

      yield* runner.cancel
      expect(runner.busy).toBe(false)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.live(
    "cancel on idle is a no-op",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      yield* runner.cancel
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "cancel with onInterrupt resolves callers gracefully",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("never"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")

      yield* runner.cancel

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("fallback")
    }),
  )

  it.live(
    "cancel with queued callers resolves all",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })

      const a = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      const b = yield* runner.ensureRunning(Effect.succeed("y")).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      yield* runner.cancel

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA)) expect(exitA.value).toBe("fallback")
      if (Exit.isSuccess(exitB)) expect(exitB.value).toBe("fallback")
    }),
  )

  it.live(
    "work can be started after cancel",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      yield* runner.cancel
      yield* Fiber.await(fiber)

      const result = yield* runner.ensureRunning(Effect.succeed("after-cancel"))
      expect(result).toBe("after-cancel")
    }),
  )

  it.live(
    "cancel does not deadlock when replacement work starts before interrupted run exits",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const hit = yield* Deferred.make<void>()
      const hold = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()

      yield* Effect.gen(function* () {
        const runner = Runner.make<string>(s)
        const first = Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(hit, undefined)),
          Effect.ensuring(Deferred.await(hold)),
          Effect.as("first"),
        )

        const a = yield* runner.ensureRunning(first).pipe(Effect.exit, Effect.forkChild)
        yield* waitForState(runner, "Running")

        const stop = yield* runner.cancel.pipe(Effect.forkChild)
        yield* Deferred.await(hit).pipe(Effect.timeout("250 millis"))

        const b = yield* runner.ensureRunning(Deferred.await(done).pipe(Effect.as("second"))).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(runner.busy).toBe(true)

        yield* Deferred.succeed(hold, undefined)
        const stopExit = yield* Fiber.await(stop).pipe(Effect.timeout("250 millis"))
        expect(Exit.isSuccess(stopExit)).toBe(true)

        expect(runner.busy).toBe(true)
        yield* Deferred.succeed(done, undefined)
        expect(yield* Fiber.join(b).pipe(Effect.timeout("250 millis"))).toBe("second")
        expect(runner.busy).toBe(false)

        const exit = yield* Fiber.join(a)
        expect(Exit.isFailure(exit)).toBe(true)
      }).pipe(
        Effect.ensuring(
          Effect.all([Deferred.succeed(hold, undefined), Deferred.succeed(done, undefined)], { discard: true }).pipe(
            Effect.ignore,
          ),
        ),
      )
    }),
  )

  // --- shell semantics ---

  it.live(
    "shell runs exclusively",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const result = yield* runner.startShell(Effect.succeed("shell-done"))
      expect(result).toBe("shell-done")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "shell rejects when run is active",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const started = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never.pipe(Effect.as("x"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started).pipe(Effect.timeout("250 millis"))
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Running") yield* Effect.yieldNow
      }).pipe(Effect.timeout("250 millis"))

      const exit = yield* runner.startShell(Effect.succeed("nope")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      yield* runner.cancel
      yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))
    }),
  )

  it.live(
    "shell rejects when another shell is running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("first"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const exit = yield* runner.startShell(Effect.succeed("second")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Busy)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)
    }),
  )

  it.live(
    "cancel interrupts shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("ignored"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const stop = yield* runner.cancel.pipe(Effect.forkChild)
      const stopExit = yield* Fiber.await(stop).pipe(Effect.timeout("250 millis"))
      expect(Exit.isSuccess(stopExit)).toBe(true)
      expect(runner.busy).toBe(false)

      const shellExit = yield* Fiber.await(sh)
      expect(Exit.isFailure(shellExit)).toBe(true)

      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
    }),
  )

  it.live(
    "cancel does not mask shell defects",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("interrupted") })
      const ready = yield* Latch.make()

      const sh = yield* runner
        .startShell(
          Effect.gen(function* () {
            yield* ready.open
            return yield* Effect.never.pipe(Effect.as("ignored"))
          }).pipe(Effect.ensuring(Effect.die("boom"))),
          ready,
        )
        .pipe(Effect.forkChild)
      yield* ready.await.pipe(Effect.timeout("250 millis"))

      yield* runner.cancel
      expect(Exit.isFailure(yield* Fiber.await(sh))).toBe(true)
    }),
  )

  // --- shell→run handoff ---

  it.live(
    "ensureRunning queues behind shell then runs after",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("shell-result"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")
      expect(runner.state._tag).toBe("Shell")

      const run = yield* runner.ensureRunning(Effect.succeed("run-result")).pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")
      expect(runner.state._tag).toBe("ShellThenRun")

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("run-result")
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "multiple ensureRunning callers share the queued run behind shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const calls = yield* Ref.make(0)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const work = Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        return "run"
      })
      const a = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
      const b = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live(
    "cancel during shell_then_run cancels both",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)

      const sh = yield* runner.startShell(Effect.never.pipe(Effect.as("aborted"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const run = yield* runner.ensureRunning(Effect.succeed("y")).pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")
      expect(runner.state._tag).toBe("ShellThenRun")

      yield* runner.cancel
      expect(runner.busy).toBe(false)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  // --- lifecycle callbacks ---

  it.live(
    "onIdle fires when returning to idle from running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onIdle: Ref.update(count, (n) => n + 1),
      })
      yield* runner.ensureRunning(Effect.succeed("ok"))
      expect(yield* Ref.get(count)).toBe(1)
    }),
  )

  it.live(
    "onIdle fires on cancel",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onIdle: Ref.update(count, (n) => n + 1),
      })
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      yield* runner.cancel
      yield* Fiber.await(fiber)
      expect(yield* Ref.get(count)).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live(
    "onBusy fires when shell starts",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onBusy: Ref.update(count, (n) => n + 1),
      })
      yield* runner.startShell(Effect.succeed("done"))
      expect(yield* Ref.get(count)).toBe(1)
    }),
  )

  // --- busy flag ---

  it.live(
    "busy is true during run",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const fiber = yield* runner.ensureRunning(Deferred.await(gate).pipe(Effect.as("ok"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      expect(runner.busy).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(fiber)
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "busy is true during shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const fiber = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("ok"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")
      expect(runner.busy).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(fiber)
      expect(runner.busy).toBe(false)
    }),
  )
})
