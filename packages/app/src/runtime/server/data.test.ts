import { expect, test } from "bun:test"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "@opencode/client/promise"
import { createData } from "@opencode/client/solid"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createRoot } from "solid-js"
import { loadHomeBookmarks } from "@/home/sessions/index"
import { createDesktopData, createSessionBookmarks, createSessionMutations } from "./data"

const session: SessionInfo = {
  id: "ses_test",
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory: "/project" },
}

function desktopData(
  update: () => Promise<void> = async () => {},
  get: () => Promise<SessionInfo> = async () => {
    throw new Error("Unexpected API read")
  },
  confirm: () => Promise<SessionInfo> = async () => session,
) {
  return createRoot((dispose) => {
    const event = createGlobalEmitter<{ [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }>()
    const api = OpenCode.make({
      baseUrl: "http://synthetic.local",
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/api/session") return Response.json({ data: [], cursor: {} })
          return Response.json({ data: await get() })
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const native = createData({ api: () => api, directory: "/project", event })
    const data = createDesktopData({
      data: native,
      remove: async () => {},
      bookmark: { update, get: confirm },
    })
    return { dispose, event, native, data }
  })
}

test.each(
  [
    { older: "native", newer: "family", marked: true, archived: undefined },
    { older: "native", newer: "filtered", marked: true, archived: undefined },
    { older: "filtered", newer: "native", marked: false, archived: 20 },
    { older: "native", newer: "absent", marked: false, archived: undefined },
    { older: "absent", newer: "native", marked: true, archived: undefined },
  ].flatMap((pair) => [false, true].map((reverse) => ({ ...pair, reverse }))),
)("overlapping $older/$newer reads retain later-started state (reverse=$reverse)", async (input) => {
  const older = Promise.withResolvers<SessionInfo>()
  const newer = Promise.withResolvers<SessionInfo>()
  const requests = [input.older, input.newer].flatMap((source, index) =>
    source === "native" || source === "family" ? [index === 0 ? older : newer] : [],
  )
  const setup = desktopData(undefined, () => requests.shift()!.promise)
  const load = (source: string, response: typeof older) => {
    if (source === "native") {
      setup.native.session.invalidate(session.id)
      return setup.native.session.sync(session.id)
    }
    if (source === "family") return setup.native.session.sync(session.id, { children: true })
    return setup.data.session.loadBookmarks(async () => {
      const info = await response.promise
      return source === "absent" ? [] : [info]
    })
  }
  try {
    setup.native.session.remember(structuredClone(session))
    if (input.newer !== "family") setup.data.session.bookmark.changed(session.id, !input.marked)
    const first = load(input.older, older)
    const second = load(input.newer, newer)
    const oldInfo = {
      ...structuredClone(session),
      experimental: { bookmarked: !input.marked },
      time: { ...session.time, archived: input.marked && input.older === "native" ? 10 : undefined },
    }
    const newInfo = {
      ...structuredClone(session),
      experimental: { bookmarked: input.marked },
      time: { ...session.time, archived: input.archived },
    }
    if (input.reverse) {
      newer.resolve(newInfo)
      await second
      older.resolve(oldInfo)
      await first
    }
    if (!input.reverse) {
      older.resolve(oldInfo)
      await first
      newer.resolve(newInfo)
      await second
    }
    expect(setup.data.session.get(session.id)?.experimental?.bookmarked).toBe(input.marked)
    expect(setup.data.session.get(session.id)?.time.archived).toBe(input.archived)
  } finally {
    setup.dispose()
  }
})

test.each(
  ["native", "Home"].flatMap((source) =>
    ["refresh", "newer event", "pending write"].map((kind) => ({ source, kind })),
  ),
)(
  "$source authoritative refresh reconciles overlays but protects $kind",
  async ({ source, kind }) => {
    const response = Promise.withResolvers<SessionInfo>()
    const write = Promise.withResolvers<void>()
    const setup = desktopData(() => write.promise, () => response.promise)
    try {
      setup.native.session.remember(structuredClone(session))
      setup.data.session.bookmark.changed(session.id, false)
      setup.event.emit("session.archived", {
        id: "evt_archive",
        created: 10,
        type: "session.archived",
        durable: { aggregateID: session.id, seq: 1, version: 1 },
        data: { sessionID: session.id },
      })
      // Local snapshots are not authoritative refreshes.
      setup.native.session.remember({ ...structuredClone(session), experimental: { bookmarked: true } })
      expect(setup.data.session.get(session.id)?.experimental?.bookmarked).toBe(false)
      const pending = kind === "pending write" ? setup.data.session.bookmark.toggle(session) : undefined
      setup.native.session.invalidate(session.id)
      const loading =
        source === "native"
          ? setup.native.session.sync(session.id)
          : setup.data.session.load(async () => [await response.promise])
      if (kind === "newer event") {
        setup.data.session.bookmark.changed(session.id, false)
        setup.event.emit("session.archived", {
          id: "evt_new_archive",
          created: 20,
          type: "session.archived",
          durable: { aggregateID: session.id, seq: 2, version: 1 },
          data: { sessionID: session.id },
        })
      }
      if (kind === "pending write") {
        write.resolve()
        await pending
      }
      response.resolve({ ...structuredClone(session), experimental: { bookmarked: kind !== "pending write" } })
      await loading
      expect(setup.data.session.get(session.id)?.experimental?.bookmarked).toBe(kind !== "newer event")
      expect(setup.data.session.get(session.id)?.time.archived).toBe(kind === "newer event" ? 20 : undefined)
      write.resolve()
      await pending
    } finally {
      setup.dispose()
    }
  },
)

test.each(["success", "recovery"])("loads starting during a write cannot overwrite its settled %s", async (kind) => {
  const write = Promise.withResolvers<void>()
  const response = Promise.withResolvers<SessionInfo[]>()
  const state = createSessionBookmarks({
    update: () => write.promise,
    get: async () => ({ ...session, experimental: { bookmarked: true } }),
  })
  const pending = state.toggle(session)
  const settled = pending.catch((error: unknown) => error)
  const loading = state.load(() => response.promise, {
    ids: [session.id],
    get: () => session,
    confirm: async () => session,
  })
  if (kind === "success") write.resolve()
  if (kind === "recovery") write.reject(new Error("committed but disconnected"))
  await settled
  expect(state.pending(session.id)).toBe(false)
  expect(state.value(session.id)).toBe(true)
  response.resolve([])
  await loading
  expect(state.value(session.id)).toBe(true)
})

test.each(["archived", "child", "unknown", "eligible"])(
  "filtered bookmark absence reconciles only known eligible roots (%s)",
  async (kind) => {
    const setup = desktopData()
    const info: SessionInfo = {
      ...session,
      experimental: { bookmarked: true },
      ...(kind === "archived" ? { time: { ...session.time, archived: 10 } } : {}),
      ...(kind === "child" ? { parentID: "ses_parent" } : {}),
    }
    try {
      if (kind !== "unknown") setup.native.session.remember(structuredClone(info))
      setup.data.session.bookmark.changed(info.id, true)
      await setup.data.session.loadBookmarks(async () => [])
      expect(setup.data.session.apply([info])[0].experimental?.bookmarked).toBe(kind !== "eligible")
    } finally {
      setup.dispose()
    }
  },
)

test.each(["archived", "unmarked", "failed", "deleted"])(
  "filtered absence confirms a marked root before changing its Info (%s)",
  async (kind) => {
    const info = { ...structuredClone(session), experimental: { bookmarked: true } }
    const setup = desktopData(undefined, undefined, async () => {
      if (kind === "failed") throw new Error("Confirmation unavailable")
      if (kind === "deleted")
        throw { _tag: "SessionNotFoundError", sessionID: session.id, message: "Session not found" }
      return {
        ...structuredClone(info),
        experimental: { bookmarked: kind !== "unmarked" },
        time: { ...info.time, archived: kind === "archived" ? 10 : undefined },
      }
    })
    try {
      setup.native.session.remember(structuredClone(info))
      setup.data.session.bookmark.changed(info.id, true)
      await setup.data.session.loadBookmarks(async () => [])
      if (kind === "deleted") {
        expect(setup.data.session.get(info.id)).toBeUndefined()
        expect(setup.data.session.apply([info])).toEqual([])
        return
      }
      expect(setup.data.session.get(info.id)?.experimental?.bookmarked).toBe(kind !== "unmarked")
      expect(setup.data.session.get(info.id)?.time.archived).toBe(kind === "archived" ? 10 : undefined)
      if (kind !== "archived") return
      setup.event.emit("session.archived", {
        id: "evt_delayed_archive",
        created: 10,
        type: "session.archived",
        durable: { aggregateID: info.id, seq: 1, version: 1 },
        data: { sessionID: info.id },
      })
      await setup.data.session.loadBookmarks(async () => [])
      expect(setup.data.session.get(info.id)?.experimental?.bookmarked).toBe(true)
      expect(setup.data.session.get(info.id)?.time.archived).toBe(10)
    } finally {
      setup.dispose()
    }
  },
)

test.each(["bookmark event", "archive event", "settled write", "newer read"])(
  "absence confirmation cannot overwrite a %s",
  async (kind) => {
    const arrived = Promise.withResolvers<void>()
    const response = Promise.withResolvers<SessionInfo>()
    const info = { ...structuredClone(session), experimental: { bookmarked: true } }
    const setup = desktopData(undefined, undefined, () => {
      arrived.resolve()
      return response.promise
    })
    try {
      setup.native.session.remember(structuredClone(info))
      setup.data.session.bookmark.changed(info.id, true)
      const loading = setup.data.session.loadBookmarks(async () => [])
      await arrived.promise
      if (kind === "bookmark event") setup.data.session.bookmark.changed(info.id, false)
      if (kind === "archive event")
        setup.event.emit("session.archived", {
          id: "evt_newer_archive",
          created: 20,
          type: "session.archived",
          durable: { aggregateID: info.id, seq: 1, version: 1 },
          data: { sessionID: info.id },
        })
      if (kind === "settled write") await setup.data.session.bookmark.toggle(info)
      if (kind === "newer read")
        await setup.data.session.load(async () => [{ ...info, experimental: { bookmarked: false } }])
      response.resolve({ ...info, time: { ...info.time, archived: 10 } })
      await loading
      expect(setup.data.session.get(info.id)?.experimental?.bookmarked).toBe(kind === "archive event")
      expect(setup.data.session.get(info.id)?.time.archived).toBe(
        kind === "newer read" ? undefined : kind === "archive event" ? 20 : 10,
      )
    } finally {
      setup.dispose()
    }
  },
)

test("filtered absence does not GET ordinary unmarked records", async () => {
  let confirmations = 0
  const setup = desktopData(undefined, undefined, async () => {
    confirmations++
    return session
  })
  try {
    setup.native.session.remember(structuredClone(session))
    await setup.data.session.loadBookmarks(async () => [])
    expect(setup.data.session.get(session.id)?.experimental?.bookmarked ?? false).toBe(false)
    expect(confirmations).toBe(0)
  } finally {
    setup.dispose()
  }
})

test.each(["before", "during", "restored", "unknown archive", "deleted", "bookmark", "pending"])(
  "filtered bookmark absence preserves current state across %s events or writes",
  async (kind) => {
    const write = Promise.withResolvers<void>()
    const setup = desktopData(() => write.promise)
    const info = { ...session, experimental: { bookmarked: kind !== "pending" } }
    const response = Promise.withResolvers<SessionInfo[]>()
    const archive = () =>
      setup.event.emit("session.archived", {
        id: "evt_archive",
        created: 10,
        type: "session.archived",
        durable: { aggregateID: info.id, seq: 1, version: 1 },
        data: { sessionID: info.id },
      })
    try {
      if (kind !== "unknown archive") setup.native.session.remember(structuredClone(info))
      if (kind !== "pending") setup.data.session.bookmark.changed(info.id, true)
      if (kind === "before" || kind === "restored" || kind === "unknown archive") archive()
      const loading = setup.data.session.loadBookmarks(() => response.promise)
      if (kind === "during") archive()
      if (kind === "restored")
        setup.event.emit("session.unarchived", {
          id: "evt_restore",
          created: 11,
          type: "session.unarchived",
          durable: { aggregateID: info.id, seq: 2, version: 1 },
          data: { sessionID: info.id },
        })
      if (kind === "deleted")
        setup.event.emit("session.deleted", {
          id: "evt_delete",
          created: 11,
          type: "session.deleted",
          durable: { aggregateID: info.id, seq: 2, version: 2 },
          data: { sessionID: info.id },
        })
      if (kind === "bookmark") setup.data.session.bookmark.changed(info.id, true)
      const pending = kind === "pending" ? setup.data.session.bookmark.toggle(info) : undefined
      response.resolve([])
      await loading
      if (kind === "pending") {
        expect(setup.data.session.get(session.id)?.experimental?.bookmarked).toBe(true)
        expect(setup.data.session.bookmark.pending(session.id)).toBe(true)
      } else if (kind === "deleted") {
        expect(setup.data.session.apply([info])).toEqual([])
      } else {
        expect(setup.data.session.apply([info])[0].experimental?.bookmarked).toBe(true)
        expect(setup.data.session.apply([info])[0].time.archived).toBe(
          kind === "before" || kind === "during" || kind === "unknown archive" ? 10 : undefined,
        )
      }
      write.resolve()
      await pending
    } finally {
      setup.dispose()
    }
  },
)

test("origin data replays bookmark and archive events over stale Home responses without inventing unknown sessions", async () => {
  const setup = desktopData()
  try {
    const stale = { ...session, title: "original", experimental: { bookmarked: true } }
    const snapshot = structuredClone(stale)
    const response = Promise.withResolvers<void>()
    const loading = setup.data.session.loadBookmarks(() =>
      loadHomeBookmarks(async () => {
        await response.promise
        return { data: [snapshot], cursor: {} }
      }),
    )
    setup.native.session.remember(structuredClone(stale))
    setup.event.emit("session.bookmark.changed", {
      id: "evt_bookmark",
      created: 100,
      type: "session.bookmark.changed",
      durable: { aggregateID: session.id, seq: 1, version: 1 },
      data: { sessionID: session.id, bookmarked: false },
    })
    expect(setup.native.session.get(session.id)).toMatchObject({
      title: "original",
      time: { updated: 0 },
      experimental: { bookmarked: false },
    })
    response.resolve()
    expect(setup.data.session.apply(await loading)[0]).toMatchObject({
      title: "original",
      time: { updated: 0 },
      experimental: { bookmarked: false },
    })
    setup.event.emit("session.bookmark.changed", {
      id: "evt_unknown",
      created: 101,
      type: "session.bookmark.changed",
      durable: { aggregateID: "ses_unknown", seq: 1, version: 1 },
      data: { sessionID: "ses_unknown", bookmarked: true },
    })
    expect(setup.data.session.get("ses_unknown")).toBeUndefined()
    expect(setup.data.session.apply([])).toEqual([])
    setup.event.emit("session.archived", {
      id: "evt_archive",
      created: 102,
      type: "session.archived",
      durable: { aggregateID: session.id, seq: 2, version: 1 },
      data: { sessionID: session.id },
    })
    expect(setup.data.session.apply([stale])[0].time.archived).toBe(102)
    setup.event.emit("session.unarchived", {
      id: "evt_restore",
      created: 103,
      type: "session.unarchived",
      durable: { aggregateID: session.id, seq: 3, version: 1 },
      data: { sessionID: session.id },
    })
    expect(
      setup.data.session.apply([{ ...stale, time: { ...stale.time, archived: 102 } }])[0].time.archived,
    ).toBeUndefined()
    await setup.data.session.loadBookmarks(async () => [snapshot])
    expect(setup.data.session.apply([stale])[0].experimental?.bookmarked).toBe(true)
    await setup.data.session.loadBookmarks(async () => [])
    expect(setup.data.session.apply([stale])[0].experimental?.bookmarked).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("bookmark recovery stays in its origin and never overwrites a newer event", async () => {
  const update = Promise.withResolvers<void>()
  const recovery = Promise.withResolvers<SessionInfo>()
  const other = Promise.withResolvers<void>()
  const a = createSessionBookmarks({ update: () => update.promise, get: () => recovery.promise })
  const b = createSessionBookmarks({ update: () => other.promise, get: async () => session })
  const request = a.toggle(session)
  expect(a.value(session.id)).toBe(true)
  expect(a.pending(session.id)).toBe(true)
  expect(b.value(session.id)).toBeUndefined()
  const otherRequest = b.toggle(session)
  update.reject(new Error("offline"))
  a.changed(session.id, true)
  recovery.resolve({ ...session, title: "stale unrelated title", experimental: { bookmarked: false } })
  await expect(request).rejects.toThrow("offline")
  expect(a.value(session.id)).toBe(true)
  expect(a.pending(session.id)).toBe(false)
  expect(b.value(session.id)).toBe(true)
  expect(b.pending(session.id)).toBe(true)
  other.resolve()
  await otherRequest
  expect(b.pending(session.id)).toBe(false)
  expect(session.title).toBeUndefined()
})

test.each([true, false])(
  "bookmark failure reconciles GET or restores prior when GET fails (%s)",
  async (getSucceeds) => {
    const state = createSessionBookmarks({
      update: async () => {
        throw new Error("offline")
      },
      get: async () => {
        if (!getSucceeds) throw new Error("offline")
        return { ...session, experimental: { bookmarked: true } }
      },
    })
    await expect(state.toggle(session)).rejects.toThrow("offline")
    expect(state.value(session.id)).toBe(getSucceeds)
    expect(state.pending(session.id)).toBe(false)
  },
)

test("bookmark pending suppresses duplicate requests and child commands", async () => {
  const release = Promise.withResolvers<void>()
  const writes: boolean[] = []
  const state = createSessionBookmarks({
    update: async (_, value) => {
      writes.push(value)
      await release.promise
    },
    get: async () => session,
  })
  await state.toggle({ ...session, parentID: "ses_parent" })
  const request = state.toggle(session)
  await state.toggle(session)
  expect(writes).toEqual([true])
  release.resolve()
  await request
  expect(state.pending(session.id)).toBe(false)
})

test("different sessions in one origin can remain pending independently", async () => {
  const a = Promise.withResolvers<void>()
  const b = Promise.withResolvers<void>()
  const state = createSessionBookmarks({
    update: (id) => (id === session.id ? a.promise : b.promise),
    get: async () => session,
  })
  const first = state.toggle(session)
  const second = state.toggle({ ...session, id: "ses_other" })
  expect(state.pending("ses_other")).toBe(true)
  a.resolve()
  await first
  expect(state.pending(session.id)).toBe(false)
  expect(state.pending("ses_other")).toBe(true)
  expect(state.value("ses_other")).toBe(true)
  b.resolve()
  await second
})

test("keeps a removed session hidden after its deletion event, for lists cached before it", async () => {
  const release = Promise.withResolvers<void>()
  const mutation = createSessionMutations(async () => release.promise)

  const request = mutation.remove(session.id)
  expect(mutation.apply([session])).toEqual([])
  release.resolve()
  await request
  expect(mutation.apply([session])).toEqual([])

  mutation.deleted(session.id)
  expect(mutation.apply([session])).toEqual([])
})

test("hides a session another client deleted", () => {
  const mutation = createSessionMutations(async () => {})
  mutation.deleted(session.id)
  expect(mutation.apply([session])).toEqual([])
})

test("rolls back a failed removal", async () => {
  const release = Promise.withResolvers<void>()

  const mutation = createSessionMutations(async () => {
    await release.promise
    throw new Error("offline")
  })

  const request = mutation.remove(session.id)
  expect(mutation.apply([session])).toEqual([])
  release.resolve()
  await expect(request).rejects.toThrow("offline")
  expect(mutation.apply([session])).toEqual([session])
})

test("treats SessionNotFoundError on removal as already deleted", async () => {
  const mutation = createSessionMutations(async () => {
    throw JSON.parse('{"_tag":"SessionNotFoundError","sessionID":"ses_test","message":"Session not found: ses_test"}')
  })

  await expect(mutation.remove(session.id)).resolves.toBeUndefined()
  expect(mutation.apply([session])).toEqual([])
})
