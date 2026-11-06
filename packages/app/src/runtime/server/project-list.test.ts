import { expect, test } from "bun:test"
import { createProjectListSync } from "./project-list"
import type { ProjectList } from "@opencode/schema/project-list"
import { createStore, reconcile } from "solid-js/store"

function client(input: {
  projects?: string[]
  migrated?: boolean
  list?: () => Promise<unknown>
  update: (operation: ProjectList.Operation) => Promise<unknown>
}) {
  const state = { projects: input.projects ?? [], migrated: input.migrated ?? false, errors: [] as unknown[] }

  const sync = createProjectListSync({
    remote: { list: input.list ?? (() => Promise.resolve({ projects: [], revision: 0 })), update: input.update },
    cache: () => state.projects,
    replace: (projects) => {
      state.projects = [...projects]
    },
    migrated: () => state.migrated,
    markMigrated: () => {
      state.migrated = true
    },
    onError: (error) => state.errors.push(error),
  })

  return { state, sync }
}

test("renders cache immediately, serializes intent behind server-first migration, and acknowledges migration only after success", async () => {
  const ack = Promise.withResolvers<unknown>()
  const requests: ProjectList.Operation[] = []

  const a = client({
    projects: ["/S2", "/L1", "/L2"],
    update: async (operation) => {
      requests.push(operation)

      if (operation.type === "merge") return ack.promise

      return { projects: ["/X", "/S1", "/S2", "/L1", "/L2"], revision: 2 }
    },
  })

  expect(a.state.projects).toEqual(["/S2", "/L1", "/L2"])
  const added = a.sync.send({ type: "add", directory: "/X" })
  expect(a.state.projects[0]).toBe("/X")
  await Promise.resolve()
  expect(requests.map((op) => op.type)).toEqual(["merge"])
  expect(a.state.migrated).toBe(false)
  ack.resolve({ projects: ["/S1", "/S2", "/L1", "/L2"], revision: 1 })
  await added
  expect(a.state.projects).toEqual(["/X", "/S1", "/S2", "/L1", "/L2"])
  expect(a.state.migrated).toBe(true)
  expect(requests.map((op) => op.type)).toEqual(["merge", "add"])
})

test("newer snapshots beat stale bootstrap and mutation responses while later user intent survives", async () => {
  const ack = Promise.withResolvers<unknown>()
  const a = client({ projects: ["/local"], migrated: true, list: () => ack.promise, update: () => ack.promise })
  a.sync.snapshot({ projects: ["/remote", "/X"], revision: 2 })
  ack.resolve({ projects: ["/old", "/X"], revision: 1 })
  await a.sync.settled()
  expect(a.state.projects).toEqual(["/remote", "/X"])
  const mutation = Promise.withResolvers<unknown>()
  const b = client({
    migrated: true,
    list: async () => ({ projects: ["/A", "/B"], revision: 1 }),
    update: () => mutation.promise,
  })
  await b.sync.settled()
  const moved = b.sync.send({ type: "move", directory: "/B", toIndex: 0 })
  await Promise.resolve()
  b.sync.snapshot({ projects: ["/C", "/B", "/A"], revision: 3 })
  mutation.resolve({ projects: ["/B", "/A"], revision: 2 })
  await moved
  expect(b.state.projects).toEqual(["/C", "/B", "/A"])
})

test("a successful merge acknowledgment retains legacy directories after an earlier snapshot", async () => {
  const requests: ProjectList.Operation[] = []
  const a = client({
    projects: ["/legacy"],
    update: async (operation) => {
      requests.push(operation)
      return { projects: ["/server", "/legacy"], revision: 2 }
    },
  })
  a.sync.snapshot({ projects: ["/server"], revision: 1 })
  await a.sync.settled()
  expect(requests).toEqual([{ type: "merge", projects: ["/legacy"] }])
  expect(a.state.projects).toEqual(["/server", "/legacy"])
  expect(a.state.migrated).toBe(true)
})

for (const response of ["404", "network", "invalid", "unversioned", "negative revision"]) {
  test(`${response} bootstrap preserves cache and pending edits, stays local for this lifecycle and retries next lifecycle`, async () => {
    let calls = 0

    const a = client({
      projects: ["/unresolved"],
      update: async () => {
        calls++

        if (response === "invalid") return { projects: [42] }
        if (response === "unversioned") return { projects: ["/server"] }
        if (response === "negative revision") return { projects: ["/server"], revision: -1 }
        throw new Error(response)
      },
    })

    await a.sync.send({ type: "add", directory: "/X" })
    expect(a.state.migrated).toBe(false)
    expect(a.state.projects).toEqual(["/X", "/unresolved"])
    await a.sync.send({ type: "move", directory: "/unresolved", toIndex: 0 })
    expect(calls).toBe(1)

    const b = client({
      projects: a.state.projects,
      update: async () => ({ projects: ["/server", ...a.state.projects], revision: 1 }),
    })

    await b.sync.settled()
    expect(b.state.migrated).toBe(true)
    expect(b.state.projects).toEqual(["/server", "/unresolved", "/X"])
  })
}

test("migration reload lists rather than merges, and disposal and remote updates are isolated from other servers", async () => {
  const ack = Promise.withResolvers<unknown>()
  const a = client({ projects: ["/A"], update: () => ack.promise })

  const b = client({
    projects: ["/old"],
    migrated: true,
    list: async () => ({ projects: ["/B"], revision: 1 }),
    update: async () => {
      throw new Error("must not merge again")
    },
  })

  await b.sync.settled()
  expect(b.state.projects).toEqual(["/B"])
  a.sync.dispose()
  ack.resolve({ projects: ["/late"], revision: 1 })
  await a.sync.settled()
  a.sync.snapshot({ projects: ["/wrong"], revision: 2 })
  b.sync.snapshot({ projects: [], revision: 2 })
  expect(a.state.projects).toEqual(["/A"])
  expect(a.state.migrated).toBe(false)
  expect(b.state.projects).toEqual([])
})

for (const entry of [
  { operation: { type: "add", directory: "/X" }, projects: ["/X", "/C", "/A", "/B"] },
  { operation: { type: "remove", directory: "/A" }, projects: ["/C", "/B"] },
  { operation: { type: "move", directory: "/B", toIndex: 0 }, projects: ["/B", "/C", "/A"] },
] satisfies { operation: ProjectList.Operation; projects: string[] }[]) {
  test(`${entry.operation.type} acknowledgment outranks earlier snapshots even when SSE is delivered later`, async () => {
    const ack = Promise.withResolvers<unknown>()
    const a = client({
      migrated: true,
      list: async () => ({ projects: ["/A", "/B"], revision: 1 }),
      update: () => ack.promise,
    })
    await a.sync.settled()
    const sent = a.sync.send(entry.operation)
    a.sync.snapshot({ projects: ["/C", "/A", "/B"], revision: 2 })
    ack.resolve({ projects: entry.projects, revision: 3 })
    await sent
    expect(a.state.projects).toEqual(entry.projects)
    a.sync.snapshot({ projects: ["/A", "/B"], revision: 1 })
    a.sync.snapshot({ projects: ["/C", "/A", "/B"], revision: 2 })
    expect(a.state.projects).toEqual(entry.projects)
    a.sync.snapshot({ projects: [], revision: 4 })
    expect(a.state.projects).toEqual([])
  })
}

test("queued later intent survives a newer snapshot and an older acknowledgment of the preceding mutation", async () => {
  const ack = Promise.withResolvers<unknown>()
  const a = client({
    migrated: true,
    list: async () => ({ projects: ["/A", "/B"], revision: 1 }),
    update: (operation) =>
      operation.type === "move" ? ack.promise : Promise.resolve({ projects: ["/D", "/C", "/B", "/A"], revision: 4 }),
  })
  await a.sync.settled()
  const moved = a.sync.send({ type: "move", directory: "/B", toIndex: 0 })
  await Promise.resolve()
  const added = a.sync.send({ type: "add", directory: "/D" })
  a.sync.snapshot({ projects: ["/C", "/B", "/A"], revision: 3 })
  expect(a.state.projects).toEqual(["/D", "/B", "/C", "/A"])
  ack.resolve({ projects: ["/B", "/A"], revision: 2 })
  await moved
  expect(a.state.projects).toEqual(["/D", "/C", "/B", "/A"])
  await added
  a.sync.snapshot({ projects: ["/C", "/B", "/A"], revision: 3 })
  expect(a.state.projects).toEqual(["/D", "/C", "/B", "/A"])
})

test("persisted reconcile cannot mutate accepted snapshots or supply another tab's optimistic intent", async () => {
  const [store, setStore] = createStore<{ projects: readonly string[] }>({ projects: ["/A", "/B"] })
  const a = createProjectListSync({
    remote: {
      list: async () => ({ projects: ["/A", "/B"], revision: 1 }),
      update: async () => ({ projects: ["/X", "/A", "/B"], revision: 2 }),
    },
    cache: () => store.projects,
    replace: (projects) => setStore("projects", reconcile(projects)),
    migrated: () => true,
    markMigrated: () => {},
    onError: () => {},
  })
  await a.settled()
  setStore("projects", reconcile(["/B"]))
  a.snapshot({ projects: ["/A", "/B"], revision: 1 })
  expect(store.projects).toEqual(["/A", "/B"])
  setStore("projects", reconcile(["/B"]))
  const added = a.send({ type: "add", directory: "/X" })
  expect(store.projects).toEqual(["/X", "/A", "/B"])
  await added
})

test("refresh queues behind bootstrap, preserves pending intent, and ignores a response older than an event", async () => {
  const bootstrap = Promise.withResolvers<unknown>()
  const refreshed = Promise.withResolvers<unknown>()
  const requests: string[] = []
  const a = client({
    projects: ["/legacy"],
    list: () => {
      requests.push("list")
      return refreshed.promise
    },
    update: (operation) => {
      requests.push(operation.type)
      return operation.type === "merge" ? bootstrap.promise : Promise.resolve({ projects: ["/X", "/new"], revision: 4 })
    },
  })
  const refresh = a.sync.refresh()
  const added = a.sync.send({ type: "add", directory: "/X" })
  await Promise.resolve()
  expect(requests).toEqual(["merge"])
  bootstrap.resolve({ projects: ["/legacy"], revision: 1 })
  await Promise.resolve()
  a.sync.snapshot({ projects: ["/new"], revision: 3 })
  refreshed.resolve({ projects: ["/old"], revision: 2 })
  await refresh
  expect(a.state.projects).toEqual(["/X", "/new"])
  await added
  expect(requests).toEqual(["merge", "list", "add"])
  a.sync.dispose()
  await a.sync.refresh()
  expect(requests).toEqual(["merge", "list", "add"])
})
