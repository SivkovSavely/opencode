import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import type { PersistenceSyncCallback } from "@solid-primitives/storage"
import { createServerProjects, ServerConnection } from "@/runtime/server/registry"
import { ServerScope } from "@/runtime/server/scope"
import { ServerState } from "@/runtime/server/persistence"
import { Persistence } from "@/runtime/persistence/schema"
import { ModelSelectionSchema } from "@/providers/models/selection"
import { flushPersisted, persistStore } from "@/runtime/persistence/persist"
import { persisted } from "@/runtime/persistence/storage"

test("acknowledged migration survives dirty held cache replication, disposal and fresh registry hydration", () => {
  const documents = new Map<string, string>()
  const subscribers: PersistenceSyncCallback[] = []
  const scope = ServerScope.fromServerKey(ServerConnection.Key.make("https://marker-boundary.example"))
  const platform = { platform: "web" as const, openExternal() {}, async restart() {}, async notify() {} }
  const schema = Persistence.withInitial(ServerState, {
    list: [],
    hidden: {},
    lastProjectID: {},
    usedProjectIDs: {},
    hostnames: {},
    projects: {},
  })
  const make = (scope: ServerScope) =>
    createRoot((dispose) => {
      const [store, setStore] = createStore(
        Schema.decodeUnknownSync(schema)({
          projects: { [scope]: [{ worktree: "/Alpha" }, { worktree: "/Beta" }] },
        }),
      )
      const persist = persistStore({
        store,
        setStore,
        name: "server",
        storage: {
          getItem: (key) => documents.get(key) ?? null,
          setItem: (key, value) => {
            documents.set(key, value)
          },
          removeItem: (key) => {
            documents.delete(key)
          },
        },
        serialize: JSON.stringify,
        deserialize: Schema.decodeUnknownSync(Schema.fromJsonString(schema)),
        sync: [
          (subscriber) => {
            subscribers.push(subscriber)
          },
          (key, newValue) =>
            subscribers
              .filter((subscriber) => subscriber !== subscribers[index])
              .forEach((subscriber) => subscriber({ key, newValue: String(newValue), timeStamp: 0 })),
        ],
      })
      const index = subscribers.length - 1
      return {
        projects: createServerProjects({ scope: () => scope, store, setStore: persist.setStore, platform }),
        persist,
        dispose,
      }
    })
  const a = make(scope)
  const b = make(scope)
  try {
    expect(a.projects.migrated(1)).toBe(false)
    a.projects.replace(["/Alpha", "/Beta", "/fallback"])
    b.projects.markMigrated(2)
    b.projects.replace(["/Beta"])
    b.persist.flush()
    a.persist.flush()
    expect(b.projects.directories()).toEqual(["/Alpha", "/Beta", "/fallback"])
    expect(b.projects.migrated(2)).toBe(true)
    b.projects.markMigrated(1)
    expect(b.projects.migrated(2)).toBe(true)
    flushPersisted()
    b.dispose()
    const reload = make(scope)
    const other = make(ServerScope.fromServerKey(ServerConnection.Key.make("https://other-marker.example")))
    try {
      expect(reload.projects.migrated(1)).toBe(true)
      expect(reload.projects.migrated(2)).toBe(true)
      expect(other.projects.migrated(1)).toBe(false)
    } finally {
      reload.dispose()
      other.dispose()
    }
    const legacyScope = ServerScope.fromServerKey(ServerConnection.Key.make("https://legacy-marker.example"))
    documents.set("server", JSON.stringify({ projectListVersion: { [legacyScope]: 3 } }))
    const legacy = make(legacyScope)
    expect(legacy.projects.migrated(3)).toBe(true)
    legacy.dispose()
    documents.set("server", "{}")
    const legacyReload = make(legacyScope)
    try {
      expect(legacyReload.projects.migrated(3)).toBe(true)
    } finally {
      legacyReload.dispose()
    }
  } finally {
    a.dispose()
    b.dispose()
  }
})

test("persisted model selection hydrates, updates and serializes the schema shape", () => {
  const key = `consumer-model-selection-${crypto.randomUUID()}`
  localStorage.setItem(
    key,
    JSON.stringify({ pick: { session1: { agent: "plan" }, __workspace__: { agent: "build" } } }),
  )
  createRoot((dispose) => {
    try {
      const [state, setState] = persisted(
        key,
        ModelSelectionSchema,
        { session: {} },
        {
          platform: "web",
          openExternal: () => {},
          restart: async () => {},
          notify: async () => {},
        },
      )

      expect(state.session.session1?.agent).toBe("plan")
      setState("session", "session1", { agent: "build", variant: null })
      expect(state.session.session1?.agent).toBe("build")
      flushPersisted()
      expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual({
        session: { session1: { agent: "build", variant: null } },
      })
    } finally {
      dispose()
      localStorage.removeItem(key)
    }
  })
})
