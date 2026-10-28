import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, LayerMap } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { RuntimeRetirement } from "@opencode-ai/core/runtime-retirement"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const started = Deferred.makeUnsafe<void>()
const interrupted = Deferred.makeUnsafe<void>()
let calls = 0
const runner = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({
  run: () => Effect.gen(function* () {
    calls++
    yield* Deferred.succeed(started, undefined)
    yield* Effect.never
  }).pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid))),
}))
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(() => runner as unknown as Layer.Layer<LocationServices>),
)
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, SessionStore.node, SessionExecutionLocal.node]),
  [[LocationServiceMap.node, locations]],
))

describe("SessionExecution retirement", () => {
  it.live("interrupts an active drain and ignores later resumes and wakes", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const execution = yield* SessionExecution.Service
      const sessionID = SessionSchema.ID.make("ses_execution_retired")
      yield* database.db.insert(ProjectTable).values({
        id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({
        id: sessionID, project_id: Project.ID.global, slug: "test", directory: "/project", title: "test", version: "test",
      }).run().pipe(Effect.orDie)
      const run = yield* execution.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* RuntimeRetirement.retireRoot(database, sessionID)
      yield* Deferred.await(interrupted).pipe(Effect.timeout("3 seconds"))
      yield* Fiber.await(run)
      yield* execution.resume(sessionID)
      yield* execution.wake(sessionID)
      yield* Effect.sleep("200 millis")
      expect(calls).toBe(1)
      expect((yield* execution.active).size).toBe(0)
    }),
  )
})
