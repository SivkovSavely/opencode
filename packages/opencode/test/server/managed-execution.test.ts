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
        ).toMatchObject({ message: "Managed foreground child requires private Task authorization" })
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

  it.live("foreground child permits retain their original root until every owner joins", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_MANAGED_PROFILE
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.OPENCODE_MANAGED_PROFILE = "1"
        }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
            else process.env.OPENCODE_MANAGED_PROFILE = previous
          }),
      )
      const database = yield* Database.Service
      const root = randomUUID()
      const child = randomUUID()
      yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES (${root}, '/tmp', 0, 0, '[]')`)
      yield* database.db
        .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (${root}, ${root}, ${root}, '/tmp', 'test', '1', 0, 0)`)
      yield* ManagedCommand.coverRoot(database, root)
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const parent = yield* runtime.admit({ sessionID: root, directory: "/tmp" })
      expect(
        yield* ManagedCommand.reserveChild(database, child, root, parent.fence + 1).pipe(Effect.flip),
      ).toBeInstanceOf(ManagedCommand.AdmissionError)
      yield* ManagedCommand.reserveChild(database, child, root, parent.fence)
      yield* database.db
        .run(sql`INSERT INTO session (id, project_id, slug, parent_id, directory, title, version, time_created, time_updated)
        VALUES (${child}, ${root}, ${child}, ${root}, '/tmp', 'child', '1', 0, 0)`)
      expect(
        yield* runtime
          .admit({ sessionID: child, directory: "/tmp", parentSessionID: root, parentMode: "background" })
          .pipe(Effect.flip),
      ).toMatchObject({ message: "Managed child execution must remain foreground" })
      const authorization = yield* runtime.authorizeChild(child, root, parent.fence)
      const owner = yield* runtime.admit({
        sessionID: child,
        directory: "/tmp",
        parentSessionID: root,
        parentMode: "foreground",
        managedChildAuthorization: authorization.prompt,
      })
      for (const input of [
        { sessionID: child, directory: "/tmp" },
        { sessionID: child, directory: "/tmp", parentSessionID: root },
        { sessionID: child, directory: "/tmp", managedChildAuthorization: {} },
        { sessionID: child, directory: "/tmp", managedChildAuthorization: authorization.prompt },
      ])
        expect(yield* runtime.admit(input).pipe(Effect.flip)).toMatchObject({
          message: "Managed foreground child requires private Task authorization",
        })
      const runner = yield* runtime.admit({
        sessionID: child,
        directory: "/tmp",
        parentSessionID: root,
        managedChildAuthorization: authorization.runner,
      })
      const rows = yield* database.db.all<{ session_id: string; root_session_id: string }>(sql`
        SELECT session_id, root_session_id FROM managed_command WHERE root_session_id = ${root}`)
      expect(rows.map((row) => row.session_id).toSorted()).toEqual([root, child].toSorted())
      expect(rows.every((row) => row.root_session_id === root)).toBe(true)
      expect(yield* runtime.setParentMode(child, "background").pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      const retired = yield* runtime.retireRoot(root)
      expect(retired.sessionIDs.toSorted()).toEqual([root, child].toSorted())
      yield* runtime.release(root, parent.fence)
      expect(yield* runtime.commandStatus(root)).toBe("draining")
      yield* runtime.release(child, owner.fence)
      expect(yield* runtime.commandStatus(root)).toBe("draining")
      yield* runtime.release(child, runner.fence)
      expect(yield* runtime.commandStatus(root)).toBe("drained")
      expect(
        yield* ManagedCommand.reserveChild(database, randomUUID(), root, parent.fence).pipe(Effect.flip),
      ).toBeInstanceOf(ManagedCommand.AdmissionError)
      expect(
        yield* runtime.admit({ sessionID: child, directory: "/tmp", parentSessionID: root }).pipe(Effect.flip),
      ).toMatchObject({ reason: "retired" })
      // A late completion cannot resurrect either child or root ownership.
      yield* runtime.complete(child)
      expect(yield* runtime.commandStatus(root)).toBe("drained")
    }),
  )

  it.live("reservation is not historical adoption and retirement wins before child admission", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_MANAGED_PROFILE
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.OPENCODE_MANAGED_PROFILE = "1"
        }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
            else process.env.OPENCODE_MANAGED_PROFILE = previous
          }),
      )
      const database = yield* Database.Service
      const root = randomUUID()
      const other = randomUUID()
      const child = randomUUID()
      yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES (${root}, '/tmp', 0, 0, '[]')`)
      for (const id of [root, other]) {
        yield* database.db
          .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES (${id}, ${root}, ${id}, '/tmp', 'test', '1', 0, 0)`)
        yield* ManagedCommand.coverRoot(database, id)
      }
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
      const parent = yield* runtime.admit({ sessionID: root, directory: "/tmp" })
      const otherParent = yield* runtime.admit({ sessionID: other, directory: "/tmp" })
      expect(yield* ManagedCommand.reserveChild(database, other, root, parent.fence).pipe(Effect.flip)).toBeInstanceOf(
        ManagedCommand.AdmissionError,
      )
      yield* ManagedCommand.reserveChild(database, child, root, parent.fence)
      yield* database.db
        .run(sql`INSERT INTO session (id, project_id, slug, parent_id, directory, title, version, time_created, time_updated)
        VALUES (${child}, ${root}, ${child}, ${root}, '/tmp', 'child', '1', 0, 0)`)
      expect(
        yield* ManagedCommand.reserveChild(database, child, other, otherParent.fence).pipe(Effect.flip),
      ).toBeInstanceOf(ManagedCommand.AdmissionError)
      const unborn = randomUUID()
      yield* ManagedCommand.reserveChild(database, unborn, root, parent.fence)
      yield* runtime.retireRoot(root)
      expect(
        yield* database.db
          .run(
            sql`
        INSERT INTO session (id, project_id, slug, parent_id, directory, title, version, time_created, time_updated)
        VALUES (${unborn}, ${root}, ${unborn}, ${root}, '/tmp', 'too late', '1', 0, 0)`,
          )
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      expect(
        yield* runtime.admit({ sessionID: child, directory: "/tmp", parentSessionID: root }).pipe(Effect.flip),
      ).toMatchObject({ reason: "retired" })
      yield* runtime.release(root, parent.fence)
      expect(yield* runtime.commandStatus(root)).toBe("drained")
      yield* runtime.complete(other)
      yield* runtime.release(other, otherParent.fence)
      expect(yield* runtime.commandStatus(other)).toBe("drained")
    }),
  )
})
