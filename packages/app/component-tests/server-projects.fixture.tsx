import { createComponent, createRoot } from "solid-js"
import { ServersProvider, ServerConnection, useServers } from "../src/runtime/server/registry"
import { LanguageProvider } from "../src/runtime/i18n/language"
import { flushPersisted } from "../src/runtime/persistence/persist"

export function exerciseProjectOwner(initialized: boolean) {
  const key = ServerConnection.Key.make(`https://owner-${initialized}.example`)
  const app = createRoot((dispose) => {
    const context: { servers?: ReturnType<typeof useServers> } = {}
    createComponent(LanguageProvider, {
      locale: "en",
      get children() {
        return createComponent(ServersProvider, {
          servers: [],
          get children() {
            context.servers = useServers()
            return undefined
          },
        })
      },
    })
    if (!context.servers) throw new Error("Server provider did not initialize")
    return { servers: context.servers, dispose }
  })
  const first = createRoot((dispose) => ({ projects: app.servers.projects.forServer(key), dispose }))
  if (initialized) first.projects.migrated(1)
  first.dispose()
  const second = createRoot((dispose) => ({ projects: app.servers.projects.forServer(key), dispose }))
  try {
    const same = first.projects === second.projects
    second.projects.markMigrated(1)
    flushPersisted()
    const acknowledged = second.projects.migrated(1)
    second.projects.markMigrated(2)
    second.dispose()
    flushPersisted()
    return { same, acknowledged, later: app.servers.projects.forServer(key).migrated(2) }
  } finally {
    second.dispose()
    flushPersisted()
    app.dispose()
  }
}
