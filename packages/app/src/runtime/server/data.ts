import type { Data } from "@opencode/client/solid"
import { isSessionNotFoundError, type OpenCodeEvent, type SessionInfo } from "@opencode/client/promise"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { uuid } from "@opencode/util/uuid"

type SessionMutation = { readonly id: string; readonly type: "remove"; readonly sessionID: string }

const REMOVED_SESSION_LIMIT = 512

// The events on which the server advances a session's `time.updated` to the event's time.
const SESSION_ACTIVITY = [
  "session.inbox.enqueued",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.renamed",
  "session.agent.selected",
  "session.model.selected",
  "session.metadata.updated",
  "session.permissions",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.revert.staged",
  "session.revert.cleared",
  "session.revert.committed",
] satisfies OpenCodeEvent["type"][]

export function createDesktopData(input: {
  data: Data
  remove: (sessionID: string) => Promise<void>
  bookmark: Parameters<typeof createSessionBookmarks>[0]
}) {
  const mutation = createSessionMutations(input.remove)
  const [activity, setActivity] = createStore<Record<string, number | undefined>>({})
  const bookmarks = createSessionBookmarks(input.bookmark)
  const [archives, setArchives] = createStore<
    Record<string, { value: number | undefined; revision: number } | undefined>
  >({})
  let archiveRead = 0
  const archiveReads = new Map<string, number>()
  const archiveChanged = (id: string, value: number | undefined) =>
    setArchives(id, { value, revision: (archives[id]?.revision ?? 0) + 1 })
  onCleanup(
    input.data.on("session.bookmark.changed", (event) => {
      bookmarks.changed(event.data.sessionID, event.data.bookmarked)
    }),
  )
  onCleanup(input.data.on("session.archived", (event) => archiveChanged(event.data.sessionID, event.created)))
  onCleanup(input.data.on("session.unarchived", (event) => archiveChanged(event.data.sessionID, undefined)))
  onCleanup(
    input.data.on("session.deleted", (event) => {
      setActivity(event.data.sessionID, undefined)
      mutation.deleted(event.data.sessionID)
    }),
  )

  // Lists loaded earlier (the Home index, the live store, search results) learn each session's newer
  // `time.updated` from its events, so they rank sessions in the server's order without reloading.
  SESSION_ACTIVITY.forEach((type) =>
    onCleanup(
      input.data.on(type, (event) => {
        if (event.created > (activity[event.data.sessionID] ?? 0)) setActivity(event.data.sessionID, event.created)
      }),
    ),
  )

  const apply = (sessions: readonly SessionInfo[]) =>
    mutation.apply(sessions).map((session) => {
      const updated = activity[session.id]

      const bookmark = bookmarks.value(session.id)
      const archive = archives[session.id]
      return {
        ...session,
        ...(bookmark !== undefined ? { experimental: { ...session.experimental, bookmarked: bookmark } } : {}),
        time: {
          ...session.time,
          ...(updated && updated > session.time.updated ? { updated } : {}),
          ...(archive ? { archived: archive.value } : {}),
        },
      }
    })

  const read = (filtered = false) => {
    const bookmark = filtered ? undefined : bookmarks.read()
    const order = ++archiveRead
    const before = Object.fromEntries(Object.entries(archives).map(([id, archive]) => [id, archive?.revision]))
    return (sessions: readonly SessionInfo[]) => {
      bookmark?.(sessions)
      sessions.forEach((session) => {
        if (
          (archives[session.id]?.revision ?? 0) !== (before[session.id] ?? 0) ||
          (archiveReads.get(session.id) ?? 0) > order
        )
          return
        archiveReads.set(session.id, order)
        setArchives(session.id, { value: session.time.archived, revision: before[session.id] ?? 0 })
      })
    }
  }
  onCleanup(input.data.session.onRead(read))

  return {
    ...input.data,
    session: {
      ...input.data.session,
      get: (sessionID: string) => {
        const session = input.data.session.get(sessionID)
        return session ? apply([session])[0] : session
      },
      bookmark: bookmarks,
      async load(load: () => Promise<SessionInfo[]>) {
        const complete = read()
        const sessions = await load()
        complete(sessions)
        return sessions
      },
      async loadBookmarks(load: () => Promise<SessionInfo[]>) {
        const complete = read(true)
        const before = Object.fromEntries(Object.entries(archives).map(([id, archive]) => [id, archive?.revision]))
        const sessions = await bookmarks.load(load, {
          ids: input.data.session.list().map((session) => session.id),
          get: (id) => {
            if ((archives[id]?.revision ?? 0) !== (before[id] ?? 0)) return
            const session = input.data.session.get(id)
            return session ? apply([session])[0] : undefined
          },
          confirm: async (id) => {
            const session = await input.bookmark.get(id).catch((error) => {
              if (!isSessionNotFoundError(error)) throw error
              mutation.deleted(id)
              input.data.session.forget(id)
              return undefined
            })
            if (session) complete([session])
            return session
          },
        })
        complete(sessions)
        return sessions
      },
      list: () => apply(input.data.session.list()),
      apply,
      remove: (sessionID: string) =>
        mutation.remove(sessionID).then(() => {
          setActivity(sessionID, undefined)
          input.data.session.forget(sessionID)
        }),
    },
  }
}

export function createSessionBookmarks(api: {
  update: (sessionID: string, bookmarked: boolean) => Promise<unknown>
  get: (sessionID: string) => Promise<SessionInfo>
}) {
  const [store, setStore] = createStore<
    Record<string, { value: boolean; revision: number; pending: boolean } | undefined>
  >({})
  let sequence = 0
  const reads = new Map<string, number>()
  const read = () => {
    const order = ++sequence
    const before = Object.fromEntries(Object.entries(store).map(([id, state]) => [id, { ...state }]))
    return (sessions: readonly SessionInfo[]) =>
      sessions.forEach((session) => {
        const state = store[session.id]
        if (
          before[session.id]?.pending ||
          state?.pending ||
          (state?.revision ?? 0) !== (before[session.id]?.revision ?? 0)
        )
          return
        // Mutations fence all older reads; accepted reads only fence earlier-started reads.
        if ((reads.get(session.id) ?? 0) > order) return
        reads.set(session.id, order)
        setStore(session.id, {
          value: session.experimental?.bookmarked ?? false,
          revision: state?.revision ?? 0,
          pending: false,
        })
      })
  }
  return {
    value: (id: string) => store[id]?.value,
    pending: (id: string) => store[id]?.pending ?? false,
    changed(id: string, value: boolean) {
      setStore(id, { value, revision: (store[id]?.revision ?? 0) + 1, pending: store[id]?.pending ?? false })
    },
    read,
    async load(
      load: () => Promise<SessionInfo[]>,
      known: {
        ids: string[]
        get: (id: string) => SessionInfo | undefined
        confirm: (id: string) => Promise<SessionInfo | undefined>
      },
    ) {
      const complete = read()
      const ids = new Set([...Object.keys(store), ...known.ids])
      const eligible = new Set(
        [...ids].filter((id) => {
          const session = known.get(id)
          return session && !session.parentID && session.time.archived === undefined
        }),
      )
      const sessions = await load()
      const marked = new Set(sessions.map((session) => session.id))
      // A missing marked root may have been archived before its event reaches this client.
      const absent = await Promise.all(
        [...ids].map(async (id) => {
          if (marked.has(id) || !eligible.has(id)) return []
          const session = known.get(id)
          if (!session || session.parentID || session.time.archived !== undefined) return []
          if (!session.experimental?.bookmarked) return [session]
          return known
            .confirm(id)
            .then((session) => (session ? [session] : []))
            .catch(() => [])
        }),
      )
      complete([
        ...sessions.map((session) => ({ ...session, experimental: { ...session.experimental, bookmarked: true } })),
        ...absent.flat(),
      ])
      return sessions
    },
    async toggle(info: SessionInfo) {
      if (info.parentID || store[info.id]?.pending) return
      const previous = store[info.id]?.value ?? info.experimental?.bookmarked ?? false
      const revision = (store[info.id]?.revision ?? 0) + 1
      setStore(info.id, { value: !previous, revision, pending: true })
      try {
        await api.update(info.id, !previous)
      } catch (error) {
        const persisted = await api
          .get(info.id)
          .then((info) => info.experimental?.bookmarked ?? false)
          .catch(() => previous)
        if (store[info.id]?.revision === revision) setStore(info.id, "value", persisted)
        throw error
      } finally {
        setStore(info.id, { pending: false, revision: (store[info.id]?.revision ?? 0) + 1 })
      }
    },
  }
}

export function createSessionMutations(remove: (sessionID: string) => Promise<void>) {
  const [store, setStore] = createStore<{ session: SessionMutation[] }>({ session: [] })

  const clear = (id: string) => {
    setStore("session", (current) => current.filter((mutation) => mutation.id !== id))
  }

  const append = (current: readonly SessionMutation[], next: SessionMutation) =>
    [...current.filter((mutation) => mutation.sessionID !== next.sessionID), next].slice(-REMOVED_SESSION_LIMIT)

  return {
    apply(sessions: readonly SessionInfo[]) {
      const removed = new Set(
        store.session.flatMap((mutation) => (mutation.type === "remove" ? [mutation.sessionID] : [])),
      )

      return removed.size === 0 ? [...sessions] : sessions.filter((session) => !removed.has(session.id))
    },
    remove(sessionID: string) {
      const mutation = { id: uuid(), type: "remove" as const, sessionID }
      setStore("session", (current) => append(current, mutation))

      return Promise.resolve()
        .then(() => remove(sessionID))
        .catch((error) => {
          if (isSessionNotFoundError(error)) return

          clear(mutation.id)
          throw error
        })
    },
    // Keep the deleted session hidden: cached lists such as the Home index still hold it until they refetch.
    deleted(sessionID: string) {
      setStore("session", (current) => append(current, { id: uuid(), type: "remove", sessionID }))
    },
  }
}
