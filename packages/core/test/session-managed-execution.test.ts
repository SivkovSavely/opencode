import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(SessionExecutionLocal.node))

describe("managed V2 execution", () => {
  it.effect("rejects direct wake and resume before looking up a session", () =>
    Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      const previous = process.env.OPENCODE_MANAGED_PROFILE
      yield* Effect.gen(function* () {
        process.env.OPENCODE_MANAGED_PROFILE = "1"
        const id = SessionSchema.ID.make("ses_managed_missing")
        expect((yield* execution.wake(id).pipe(Effect.flip))._tag).toBe("SessionInput.ManagedProfile")
        expect((yield* execution.resume(id).pipe(Effect.flip))._tag).toBe("SessionInput.ManagedProfile")
        expect((yield* execution.active).size).toBe(0)
        yield* execution.interrupt(id)
      }).pipe(Effect.ensuring(Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
        else process.env.OPENCODE_MANAGED_PROFILE = previous
      })))
    }),
  )
})
