import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Layer } from "effect"
import path from "path"
import { eq } from "drizzle-orm"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("Session.archive", () => {
  testEffect(Layer.empty).live("persists bookmark flags across a complete file database close and reopen", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const filename = path.join(tmp.path, "bookmarks.sqlite")
      const layer = AppNodeBuilder.build(
        LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
        [
          Database.node.replace(Database.configured({ path: filename })),
          Bus.node.replace(Bus.configured({ persist: true })),
          Project.node.replace(globalProjectNode),
          SessionExecution.node.replace(SessionExecution.noopLayer),
        ],
      )
      const ids = yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const marked = yield* sessions.create({ location })
        const cleared = yield* sessions.create({ location })
        const archived = yield* sessions.create({ location })
        yield* sessions.setBookmarked({ sessionID: marked.id, bookmarked: true })
        yield* sessions.setBookmarked({ sessionID: cleared.id, bookmarked: true })
        yield* sessions.setBookmarked({ sessionID: cleared.id, bookmarked: false })
        yield* sessions.setBookmarked({ sessionID: archived.id, bookmarked: true })
        yield* sessions.archive(archived.id)
        return { marked: marked.id, cleared: cleared.id, archived: archived.id }
      }).pipe(Effect.provide(Layer.fresh(layer)), Effect.scoped)

      // The first graph and its database connection are closed before a fresh graph opens the same file.
      expect(yield* Effect.promise(() => Bun.file(filename).exists())).toBe(true)
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        expect((yield* sessions.get(ids.marked)).experimental?.bookmarked).toBe(true)
        expect((yield* sessions.get(ids.cleared)).experimental?.bookmarked).toBe(false)
        const archived = yield* sessions.get(ids.archived)
        expect(archived.experimental?.bookmarked).toBe(true)
        expect(archived.time.archived).toBeDefined()
        expect(
          (yield* sessions.list({ parentID: null, archived: false, experimental: { bookmarked: true } })).data.map(
            (info) => info.id,
          ),
        ).toEqual([ids.marked])
        yield* sessions.unarchive(ids.archived)
        expect(
          (yield* sessions.list({ parentID: null, archived: false, experimental: { bookmarked: true } })).data
            .map((info) => info.id)
            .toSorted(),
        ).toEqual([ids.marked, ids.archived].toSorted())
      }).pipe(Effect.provide(Layer.fresh(layer)), Effect.scoped)
    }),
  )

  it.effect("serializes desired bookmarks, preserves activity, and retains the flag across archive", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const database = yield* Database.Service
      const created = yield* session.create({ location, title: "bookmark keeper", metadata: { fixture: true } })
      expect(created.experimental?.bookmarked).toBe(false)
      yield* Effect.forEach(
        [true, true, true],
        (bookmarked) => session.setBookmarked({ sessionID: created.id, bookmarked }),
        { concurrency: "unbounded" },
      )
      const saved = yield* session.get(created.id)
      expect(saved.experimental?.bookmarked).toBe(true)
      expect(saved.title).toBe(created.title)
      expect(saved.metadata).toEqual(created.metadata)
      expect(DateTime.toEpochMillis(saved.time.updated)).toBe(DateTime.toEpochMillis(created.time.updated))
      const events = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all()
      const bookmarks = events.filter((event) => event.type === Bus.versionedType(SessionEvent.BookmarkChanged.type, 1))
      expect(bookmarks).toHaveLength(1)
      expect(bookmarks[0].data).toEqual({ sessionID: created.id, bookmarked: true })
      yield* session.archive(created.id)
      expect((yield* session.get(created.id)).experimental?.bookmarked).toBe(true)
      expect((yield* session.list({ archived: false, experimental: { bookmarked: true } })).data).toHaveLength(0)
      yield* session.unarchive(created.id)
      expect(
        (yield* session.list({ archived: false, experimental: { bookmarked: true } })).data.map((item) => item.id),
      ).toEqual([created.id])
      yield* session.setBookmarked({ sessionID: created.id, bookmarked: false })
      yield* session.setBookmarked({ sessionID: created.id, bookmarked: false })
      expect((yield* session.get(created.id)).experimental?.bookmarked).toBe(false)
    }),
  )

  it.effect("rejects bookmarking a child but permits clearing it", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const root = yield* session.create({ location })
      const child = yield* session.create({ parentID: root.id })
      expect((yield* Effect.flip(session.setBookmarked({ sessionID: child.id, bookmarked: true })))._tag).toBe(
        "Session.BookmarkChildError",
      )
      yield* session.setBookmarked({ sessionID: child.id, bookmarked: false })
      expect((yield* session.get(child.id)).experimental?.bookmarked).toBe(false)
    }),
  )
  it.effect("archives and unarchives through one durable event each", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      expect(created.time.archived).toBeUndefined()

      yield* session.archive(created.id)
      yield* session.archive(created.id)
      expect((yield* session.get(created.id)).time.archived).toBeDefined()

      yield* session.unarchive(created.id)
      yield* session.unarchive(created.id)
      expect((yield* session.get(created.id)).time.archived).toBeUndefined()

      const types = (yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .all()).map((event) => event.type)
      expect(types.filter((type) => type === Bus.versionedType(SessionEvent.Archived.type, 1))).toHaveLength(1)
      expect(types.filter((type) => type === Bus.versionedType(SessionEvent.Unarchived.type, 1))).toHaveLength(1)
    }),
  )

  it.effect("filters listed sessions by archive state", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const active = yield* session.create({ location })
      const archived = yield* session.create({ location })
      yield* session.archive(archived.id)

      const ids = (input?: Session.ListInput) =>
        session.list(input).pipe(Effect.map((page) => page.data.map((item) => item.id).toSorted()))
      expect(yield* ids()).toEqual([active.id, archived.id].toSorted())
      expect(yield* ids({ archived: false })).toEqual([active.id])
      expect(yield* ids({ archived: true })).toEqual([archived.id])
    }),
  )

  it.effect("rejects an unknown session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_missing_archive")
      expect(yield* Effect.flip(session.archive(sessionID))).toEqual(new Session.NotFoundError({ sessionID }))
      expect(yield* Effect.flip(session.unarchive(sessionID))).toEqual(new Session.NotFoundError({ sessionID }))
    }),
  )
})
