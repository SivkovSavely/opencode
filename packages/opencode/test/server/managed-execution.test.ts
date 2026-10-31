import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ManagedCommand } from "@opencode-ai/core/managed-command"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node])))

describe("managed execution accounting", () => {
  for (const retire of [false, true]) {
    it.live(`settles only after every admitted owner releases (${retire ? "retirement" : "cancellation"})`, () =>
      Effect.gen(function* () {
        const previous = process.env.OPENCODE_MANAGED_PROFILE
        const allowlist = process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.OPENCODE_MANAGED_PROFILE = "1"
            process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = "[]"
          }),
          () =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
              else process.env.OPENCODE_MANAGED_PROFILE = previous
              if (allowlist === undefined) delete process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST
              else process.env.OPENCODE_MANAGED_PLUGIN_ALLOWLIST = allowlist
            }),
        )
        const database = yield* Database.Service
        expect(
          yield* RuntimeLifecycle.unavailable().admit({ sessionID: "untracked", directory: "/tmp" }).pipe(Effect.flip),
        ).toMatchObject({ message: "Managed execution requires a tracked runtime" })
        const id = randomUUID()
        yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
          VALUES (${id}, '/tmp', 0, 0, '[]')`)
        yield* database.db
          .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES (${id}, ${id}, ${id}, '/tmp', 'test', '1', 0, 0)`)
        yield* ManagedCommand.enrollCreatedRoot(database, id)
        const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
        const replacement = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
        const first = yield* runtime.admit({ sessionID: id, directory: "/tmp" })
        const second = yield* runtime.admit({ sessionID: id, directory: "/tmp" })
        expect(
          yield* runtime.admit({ sessionID: "child", directory: "/tmp", parentSessionID: id }).pipe(Effect.flip),
        ).toMatchObject({ message: "Child execution is unavailable in the managed profile" })
        yield* database.db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (${randomUUID()}, ${id}, 0, 0, '{}')`)
        expect(yield* runtime.commandStatus(id)).toBe("draining")
        // The replacement cannot infer that the original process has joined its work.
        expect(yield* replacement.commandStatus(id)).toBe("unknown")
        if (retire) yield* runtime.retireRoot(id)
        expect(yield* runtime.cancel(id)).toBe(true)
        yield* runtime.finishCancel(id)
        yield* runtime.release(id, first.fence)
        expect(yield* runtime.commandStatus(id)).toBe("draining")
        expect(yield* replacement.commandStatus(id)).toBe("unknown")
        yield* runtime.release(id, second.fence)
        expect(yield* runtime.commandStatus(id)).toBe("drained")
        expect(yield* replacement.commandStatus(id)).toBe("drained")
        if (retire) {
          expect(yield* runtime.admit({ sessionID: id, directory: "/tmp" }).pipe(Effect.flip)).toMatchObject({
            reason: "retired",
          })
          expect(yield* runtime.resumeRetry(id)).toBe(false)
          const notification = { delivered: false }
          yield* runtime.scheduleNotification(
            id,
            Effect.sync(() => {
              notification.delivered = true
            }),
          )
          expect(notification.delivered).toBe(false)
          return
        }
        const resumed = yield* runtime.admit({ sessionID: id, directory: "/tmp" })
        yield* runtime.complete(id)
        yield* runtime.release(id, resumed.fence)
        expect(yield* runtime.commandStatus(id)).toBe("drained")
      }),
    )
  }
})
