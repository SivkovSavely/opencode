import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createServerProjects } from "./server"
import { createServerProjectSync, PROJECT_LIST_MIGRATION } from "./project-list-sync"
import { ServerScope } from "@/utils/server-scope"
import type { ServerSDK } from "./server-sdk"

type Operation =
  | { type: "merge"; projects: string[] }
  | { type: "add"; directory: string }
  | { type: "remove"; directory: string }
  | { type: "move"; directory: string; toIndex: number }

type Stored = { worktree: string; expanded: boolean }
type SnapshotEvent = { type: string; properties: { projects: string[] } }

// Minimal stand-in for the server-side ordered set, enough to observe what the client sends.
function remoteApply(current: string[], operation: Operation) {
  if (operation.type === "merge") {
    const seen = new Set(current)
    const added = operation.projects.filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
    return [...current, ...added]
  }
  if (operation.type === "add") return current.includes(operation.directory) ? current : [operation.directory, ...current]
  if (operation.type === "remove") return current.filter((item) => item !== operation.directory)
  const from = current.indexOf(operation.directory)
  if (from === -1) return current
  const next = [...current]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(operation.toIndex, next.length)), 0, item)
  return next
}

const settle = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function harness(input: { local?: Stored[]; server?: string[]; unsupported?: boolean; delay?: number }) {
  const listeners: Array<(event: SnapshotEvent) => void> = []
  const requests: Operation[] = []
  let server = [...(input.server ?? [])]
  let calls = 0
  let dispose: (() => void) | undefined

  const respond = (operation: Operation) => {
    calls++
    requests.push(operation)
    if (input.unsupported) return Promise.reject(new Error("404"))
    const apply = () => {
      server = remoteApply(server, operation)
      return { data: { projects: [...server] } }
    }
    if (!input.delay) return Promise.resolve(apply())
    return new Promise((resolve) => setTimeout(() => resolve(apply()), input.delay))
  }

  const sdk = {
    client: {
      global: {
        projects: {
          list: () => {
            calls++
            if (input.unsupported) return Promise.reject(new Error("404"))
            return Promise.resolve({ data: { projects: [...server] } })
          },
          update: (params: { body: Operation }) => respond(params.body),
        },
      },
    },
    event: {
      on: (_directory: string, handler: (event: SnapshotEvent) => void) => {
        listeners.push(handler)
        return () => {
          const index = listeners.indexOf(handler)
          if (index !== -1) listeners.splice(index, 1)
        }
      },
    },
  } as unknown as ServerSDK

  const [store, setStore] = createStore({
    projects: { local: [...(input.local ?? [])] } as Record<string, Stored[]>,
    lastProject: {} as Record<string, string>,
    recentlyClosed: {} as Record<string, string[]>,
    syncedProjects: {} as Record<string, number>,
  })
  const projects = createServerProjects({ scope: () => ServerScope.local, store, setStore })

  return {
    projects,
    requests,
    server: () => server,
    calls: () => calls,
    setServer(next: string[]) {
      server = [...next]
    },
    emit(projects: string[]) {
      listeners.forEach((listener) => listener({ type: "server.projects.updated", properties: { projects } }))
    },
    // Recreates the per-server context, mirroring a page reload over the same browser state.
    start() {
      dispose?.()
      let sync: { send: (operation: Operation) => void } | undefined
      dispose = createRoot((release) => {
        sync = createServerProjectSync({ sdk, projects })
        return release
      })
      return {
        send: (operation: Operation) => sync?.send(operation),
        stop: () => {
          dispose?.()
          dispose = undefined
        },
      }
    },
  }
}

const worktrees = (projects: { list: () => Stored[] }) => projects.list().map((project) => project.worktree)

describe("createServerProjectSync", () => {
  test("unions legacy browser projects into the authoritative server list", async () => {
    const h = harness({ local: [{ worktree: "/b", expanded: true }], server: ["/a", "/b"] })
    h.start()
    await settle()

    expect(h.requests).toEqual([{ type: "merge", projects: ["/b"] }])
    expect(h.server()).toEqual(["/a", "/b"])
    expect(worktrees(h.projects)).toEqual(["/a", "/b"])
    expect(h.projects.migrated(PROJECT_LIST_MIGRATION)).toBe(true)
  })

  test("appends only the missing legacy projects in their local order", async () => {
    const h = harness({
      local: [
        { worktree: "/b", expanded: true },
        { worktree: "/c", expanded: true },
        { worktree: "/d", expanded: true },
      ],
      server: ["/a", "/b"],
    })
    h.start()
    await settle()

    expect(h.server()).toEqual(["/a", "/b", "/c", "/d"])
    expect(worktrees(h.projects)).toEqual(["/a", "/b", "/c", "/d"])
  })

  test("marks the scope migrated only after the merge succeeds", async () => {
    const h = harness({ local: [{ worktree: "/b", expanded: true }], unsupported: true })
    h.start()
    await settle()

    expect(h.projects.migrated(PROJECT_LIST_MIGRATION)).toBe(false)
    expect(worktrees(h.projects)).toEqual(["/b"])
  })

  test("treats the server list as authoritative after migration", async () => {
    const h = harness({ local: [{ worktree: "/b", expanded: true }], server: ["/a", "/b"] })
    h.start()
    await settle()

    // Another device removed "/a" from the server list; a reload must not re-merge local state.
    h.setServer(["/b"])
    h.start()
    await settle()

    expect(h.requests).toEqual([{ type: "merge", projects: ["/b"] }])
    expect(worktrees(h.projects)).toEqual(["/b"])
  })

  test("applies remote snapshots in order while preserving local expansion", async () => {
    const h = harness({ local: [{ worktree: "/a", expanded: false }], server: ["/a"] })
    h.start()
    await settle()

    h.emit(["/b", "/a"])

    expect(h.projects.list()).toEqual([
      { worktree: "/b", expanded: true },
      { worktree: "/a", expanded: false },
    ])
  })

  test("does not record a remote removal as a local close", async () => {
    const h = harness({ local: [{ worktree: "/a", expanded: true }], server: ["/a"] })
    h.start()
    await settle()

    h.emit([])

    expect(h.projects.list()).toEqual([])
    expect(h.projects.recentlyClosed()).toEqual([])
  })

  test("keeps a stale mutation response from reverting a newer remote snapshot", async () => {
    const h = harness({ local: [{ worktree: "/a", expanded: true }], server: ["/a"], delay: 5 })
    const sync = h.start()
    await settle(30)

    sync.send({ type: "add", directory: "/b" })
    h.emit(["/a", "/b", "/c"])
    await settle(30)

    expect(h.server()).toEqual(["/b", "/a"])
    expect(worktrees(h.projects)).toEqual(["/a", "/b", "/c"])
  })

  test("queues a local mutation behind the initial migration", async () => {
    const h = harness({ local: [{ worktree: "/b", expanded: true }], server: ["/a", "/b"], delay: 5 })
    const sync = h.start()

    sync.send({ type: "add", directory: "/c" })
    await settle(30)

    expect(h.server()).toEqual(["/c", "/a", "/b"])
    expect(worktrees(h.projects)).toEqual(["/c", "/a", "/b"])
  })

  test("propagates a local reorder to the server", async () => {
    const h = harness({
      local: [
        { worktree: "/a", expanded: true },
        { worktree: "/b", expanded: true },
      ],
      server: ["/a", "/b"],
    })
    const sync = h.start()
    await settle()

    sync.send({ type: "move", directory: "/a", toIndex: 1 })
    await settle()

    expect(h.requests.at(-1)).toEqual({ type: "move", directory: "/a", toIndex: 1 })
    expect(h.server()).toEqual(["/b", "/a"])
    expect(worktrees(h.projects)).toEqual(["/b", "/a"])
  })

  test("stays local-only when the endpoint is unsupported", async () => {
    const h = harness({ local: [{ worktree: "/a", expanded: true }], unsupported: true })
    const sync = h.start()

    sync.send({ type: "add", directory: "/b" })
    await settle()

    expect(h.calls()).toBe(1)
    expect(h.requests).toEqual([{ type: "merge", projects: ["/a"] }])
    expect(worktrees(h.projects)).toEqual(["/a"])
    expect(h.projects.migrated(PROJECT_LIST_MIGRATION)).toBe(false)
  })
})
