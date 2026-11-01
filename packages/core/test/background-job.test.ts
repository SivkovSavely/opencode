import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("same-ID restarts join old cleanup and coalesce without making replacement work uninterruptible", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const joined = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const runs: string[] = []
      const id = "job_restart_cleanup"
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const job = yield* jobs.start({
        id,
        type: "test",
        run: Effect.never.pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(cleaning, undefined)
              yield* Deferred.await(release)
              expect((yield* jobs.get(id))?.status).toBe("cancelled")
              yield* Deferred.succeed(joined, undefined)
            }),
          ),
        ),
      })
      const cancelling = yield* jobs.cancel(job.id).pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      const input = {
        id: job.id,
        type: "replacement",
        run: Effect.gen(function* () {
          expect(yield* Deferred.isDone(joined)).toBe(true)
          runs.push("replacement")
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      }
      const first = yield* jobs.start(input).pipe(Effect.forkChild)
      const second = yield* jobs.start(input).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(first.pollUnsafe()).toBeUndefined()
      expect(second.pollUnsafe()).toBeUndefined()
      expect(runs).toEqual([])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(cancelling)
      expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second))
      yield* Deferred.await(started)
      expect((yield* jobs.start(input)).status).toBe("running")
      expect(runs).toEqual(["replacement"])
      expect((yield* jobs.cancel(job.id).pipe(Effect.timeout("2 seconds")))?.status).toBe("cancelled")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("concurrent cancellation joins held finalizers and preserves restart semantics", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const job = yield* jobs.start({
        type: "test",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        ),
      })
      yield* Deferred.await(started)
      const first = yield* jobs.cancel(job.id).pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
      const second = yield* jobs.cancel(job.id).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(first.pollUnsafe()).toBeUndefined()
      expect(second.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(first))?.status).toBe("cancelled")
      expect((yield* Fiber.join(second))?.status).toBe("cancelled")
      expect((yield* jobs.start({ id: job.id, type: "test", run: Effect.succeed("resumed") })).status).toBe("running")
      expect((yield* jobs.wait({ id: job.id })).info?.output).toBe("resumed")
      expect((yield* jobs.cancel(job.id))?.status).toBe("completed")
      yield* jobs.start({ id: job.id, type: "test", run: Effect.succeed("again") })
      expect((yield* jobs.wait({ id: job.id })).info?.output).toBe("again")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
})
