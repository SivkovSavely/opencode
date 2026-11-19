import { afterEach, describe, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { isCancelledError, QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ServerEvent, ServerSDK } from "../src/context/server-sdk"
import type { ToastOptions } from "@opencode-ai/ui/toast"

const require = createRequire(import.meta.resolve("vite-plugin-solid"))
const babel = require("@babel/core")
plugin({
  name: "config-reload-solid-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (
        await babel.transformAsync(await Bun.file(path).text(), {
          filename: path,
          presets: [[require.resolve("babel-preset-solid"), { generate: "dom" }]],
          parserOpts: { plugins: ["typescript", "jsx"] },
        })
      ).code.replace(/(["'])@\/(?:context\/server-sdk|utils\/toast)\1/g, (match: string) =>
        path.endsWith("/server-lifecycle-commands.tsx") || path.endsWith("/context/server-sync.tsx")
          ? JSON.stringify(import.meta.path)
          : match,
      ),
      loader: "tsx",
    }))
  },
})

const { PlatformProvider } = await import("../src/context/platform")
const { LanguageProvider } = await import("../src/context/language")
const { SettingsProvider } = await import("../src/context/settings")
const { DialogProvider } = await import("@opencode-ai/ui/context/dialog")
const { CommandProvider, useCommand } = await import("../src/context/command")
const { ServerLifecycleCommands } = await import("../src/components/server-lifecycle-commands")
const { createServerSyncContextInner } = await import("../src/context/server-sync")
const { createSdkForServer } = await import("../src/utils/server")
const { ServerScope } = await import("../src/utils/server-scope")
const { ServerConnection } = await import("../src/context/server")
const { pathKey } = await import("../src/utils/path-key")

let selected: () => Pick<ServerSDK, "client" | "server">
const toasts: ToastOptions[] = []
export const useServerSDK = () => () => selected()
export const showToast = (options: ToastOptions) => toasts.push(options)

const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose())
  toasts.length = 0
})

function mount(run: () => null) {
  const host = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: { platform: "web", openExternal() {}, async restart() {}, async notify() {} },
        get children() {
          return createComponent(LanguageProvider, {
            locale: "en",
            get children() {
              return run()
            },
          })
        },
      }),
    host,
  )
  cleanup.push(dispose)
}

function server(name: string, reload: () => Promise<Response> = async () => Response.json(true)) {
  const requests: Request[] = []
  const connection: ServerConnection.Http = {
    type: "http",
    http: { url: `https://${name}.example`, username: name, password: "private-password" },
  }
  const fetch = Object.assign(
    async (input: string | URL | Request) => {
      const request = new Request(input)
      requests.push(request)
      if (new URL(request.url).pathname === "/global/config/reload") return reload()
      return Response.json({ lineage: "unavailable" })
    },
    { preconnect() {} },
  )
  return { server: connection, client: createSdkForServer({ server: connection.http, fetch }), requests }
}

function commands(initial = server("one")) {
  const servers = [initial]
  const [state, setState] = createStore({ selected: 0 })
  selected = () => servers[state.selected]
  const result: { command?: ReturnType<typeof useCommand> } = {}
  mount(() =>
    createComponent(SettingsProvider, {
      get children() {
        return createComponent(DialogProvider, {
          get children() {
            return createComponent(CommandProvider, {
              get children() {
                result.command = useCommand()
                return createComponent(ServerLifecycleCommands, {})
              },
            })
          },
        })
      },
    }),
  )
  return {
    command: result.command!,
    select: (sdk: ReturnType<typeof server>) => {
      servers.push(sdk)
      setState("selected", servers.length - 1)
    },
    reload: () => result.command!.options.find((option) => option.id === "config.reload"),
  }
}

describe("reload configuration command", () => {
  test("registers one discoverable System command", () => {
    const state = commands()
    expect(state.command.options.filter((option) => option.id === "config.reload")).toHaveLength(1)
    expect(state.reload()).toMatchObject({ title: "Reload configuration", category: "System", slash: "reload-config" })
  })

  test("posts through the currently selected server's authenticated SDK", async () => {
    const first = server("one")
    const second = server("two")
    const state = commands(first)
    const reload = state.reload()
    state.select(second)
    await reload?.onSelect?.()
    const requests = second.requests.filter((request) => request.method === "POST")
    expect(first.requests.filter((request) => request.method === "POST")).toHaveLength(0)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://two.example/global/config/reload")
    expect(requests[0]?.headers.get("Authorization")).toBe(`Basic ${btoa("two:private-password")}`)
  })

  test("prevents duplicate requests until completion and allows a later reload", async () => {
    const pending = Promise.withResolvers<Response>()
    const target = server("one", () => pending.promise)
    const state = commands(target)
    const first = state.reload()?.onSelect?.()
    await state.reload()?.onSelect?.()
    expect(state.reload()?.disabled).toBe(true)
    await waitFor(() => target.requests.some((request) => request.method === "POST"))
    expect(target.requests.filter((request) => request.method === "POST")).toHaveLength(1)
    pending.resolve(Response.json(true))
    await first
    expect(state.reload()?.disabled).toBe(false)
    await state.reload()?.onSelect?.()
    expect(target.requests.filter((request) => request.method === "POST")).toHaveLength(2)
  })

  test("shows localized success only after a successful response", async () => {
    const pending = Promise.withResolvers<Response>()
    const state = commands(server("one", () => pending.promise))
    const request = state.reload()?.onSelect?.()
    expect(toasts).toEqual([])
    pending.resolve(Response.json(true))
    await request
    expect(toasts).toEqual([{ variant: "success", title: "Configuration reloaded" }])
  })

  test.each(["invalid", "busy", "internal"])("shows the secret-free %s error and allows retry", async (kind) => {
    let failed = false
    const state = commands(
      server("one", async () => {
        if (failed) return Response.json(true)
        failed = true
        return Response.json(
          { _tag: "ConfigReloadError", kind, message: "The configuration could not be reloaded." },
          { status: 409 },
        )
      }),
    )
    await state.reload()?.onSelect?.()
    expect(toasts).toEqual([
      {
        variant: "error",
        title: "Failed to reload configuration",
        description: "The configuration could not be reloaded.",
      },
    ])
    expect(state.reload()?.disabled).toBe(false)
    await state.reload()?.onSelect?.()
    expect(toasts.at(-1)?.variant).toBe("success")
  })

  test.each([false, { unexpected: "private-server-detail" }])(
    "rejects an unsuccessful acknowledgement: %j",
    async (body) => {
      const state = commands(server("one", async () => Response.json(body)))
      await state.reload()?.onSelect?.()
      expect(toasts).toEqual([
        {
          variant: "error",
          title: "Failed to reload configuration",
          description: "The configuration could not be reloaded. Please try again.",
        },
      ])
    },
  )

  test("does not expose unstructured transport errors", async () => {
    const state = commands(
      server("one", async () => {
        throw new Error("private-server-detail")
      }),
    )
    await state.reload()?.onSelect?.()
    expect(toasts).toEqual([
      {
        variant: "error",
        title: "Failed to reload configuration",
        description: "The configuration could not be reloaded. Please try again.",
      },
    ])
  })
})

function sync(name: string, emitter = createGlobalEmitter<{ [key: string]: ServerEvent }>()) {
  const requests: Request[] = []
  const pending = new Map<string, Promise<Response>>()
  const revision = { current: "old" }
  const connection: ServerConnection.Http = { type: "http", http: { url: `https://${name}.example` } }
  const scope = ServerScope.fromServerKey(ServerConnection.Key.make(name))
  const fetch = Object.assign(
    async (input: string | URL | Request) => {
      const request = new Request(input)
      requests.push(request)
      const pathname = new URL(request.url).pathname
      const response = pending.get(pathname)
      if (response) return response
      const body = (() => {
        if (pathname === "/global/config" || pathname === "/config")
          return revision.current === "old"
            ? { model: "kept/old", instructions: ["removed.md"], agent: { removed: {} } }
            : { model: "kept/new" }
        if (pathname === "/provider")
          return {
            all: [
              {
                id: "kept",
                models:
                  revision.current === "old"
                    ? { removed: {}, new: { variants: { removed: {} } } }
                    : { new: { variants: { current: {} } } },
              },
              ...(revision.current === "old" ? [{ id: "removed", models: {} }] : []),
            ],
            connected: revision.current === "old" ? ["kept", "removed"] : ["kept"],
            default: { kept: "new" },
          }
        if (pathname === "/agent") return [{ name: revision.current, mode: "primary" }]
        if (pathname === "/command") return [{ name: revision.current, template: revision.current, source: "skill" }]
        if (pathname === "/mcp") return { [revision.current]: { status: "connected" } }
        if (pathname === "/experimental/resource")
          return {
            [revision.current]: { client: revision.current, uri: `docs://${revision.current}`, name: revision.current },
          }
        if (pathname === "/path") return { state: "", config: "", worktree: "", directory: "", home: "" }
        if (pathname === "/session/status") return {}
        if (pathname === "/session" || pathname === "/permission" || pathname === "/question") return []
        if (pathname === "/vcs") return {}
        if (pathname === "/find/file") return []
        throw new Error(`Unexpected request: ${request.url}`)
      })()
      return Response.json(body)
    },
    { preconnect() {} },
  )
  const client = createSdkForServer({ server: connection.http, fetch, throwOnError: true })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  const sdk = {
    server: connection,
    scope,
    client,
    protocol: Promise.resolve("v1"),
    getProtocol: () => Promise.resolve("v1"),
    protocolKind: () => "v1",
    api: { project: { list: async () => [], current: async () => ({ id: "project" }) }, session: {}, message: {} },
    createClient: (options: { directory?: string }) =>
      createSdkForServer({ server: connection.http, fetch, ...options }),
    event: { on: emitter.on.bind(emitter), listen: emitter.listen.bind(emitter), start() {} },
  } as unknown as ServerSDK
  const result: { sync?: ReturnType<typeof createServerSyncContextInner> } = {}
  mount(() =>
    createComponent(QueryClientProvider, {
      client: queryClient,
      get children() {
        return createComponent(() => {
          result.sync = createServerSyncContextInner(sdk)
          return null
        }, {})
      },
    }),
  )
  cleanup.push(() => queryClient.clear())
  return {
    sync: result.sync!,
    queryClient,
    scope,
    revision,
    requests,
    emitter,
    pending,
    emit: (directory = "global") =>
      emitter.emit(directory, { type: "config.reloaded", properties: {} } as unknown as ServerEvent),
  }
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(check()).toBe(true)
}

describe("configuration reload synchronization", () => {
  test("does not expose configuration values when refreshing after a reload fails", async () => {
    const state = sync("one")
    await waitFor(() => state.sync.data.config.model === "kept/old")
    state.pending.set(
      "/global/config",
      Promise.resolve(Response.json({ message: "reload-private-secret" }, { status: 500 })),
    )
    state.emit()
    await waitFor(() => toasts.length > 0)
    expect(toasts).toContainEqual({
      variant: "error",
      title: "Failed to reload configuration",
      description: "The configuration could not be reloaded. Please try again.",
    })
    expect(JSON.stringify(toasts)).not.toContain("reload-private-secret")
  })

  test("refreshes config-backed state in every existing directory without loading sessions or other servers", async () => {
    const first = sync("one")
    const second = sync("two")
    const one = first.sync.child("/one", { bootstrap: false })
    const two = first.sync.child("/two", { bootstrap: false })
    const other = second.sync.child("/other", { bootstrap: false })
    for (const [store, setStore] of [one, two]) {
      setStore("config", { instructions: ["removed.md"], agent: { removed: {} } })
      setStore("agent", [{ name: "removed", mode: "primary", options: {}, permission: [] }])
      setStore("command", [{ name: "removed", template: "old" }])
      setStore("status", "complete")
      expect(store.session).toEqual([])
    }
    await waitFor(() => first.sync.data.config.model === "kept/old")
    await waitFor(() => second.sync.data.config.model === "kept/old")
    for (const directory of ["/one", "/two"]) {
      const key = pathKey(directory)
      await Promise.all([
        first.queryClient.fetchQuery(first.sync.queryOptions.providers(key)),
        first.queryClient.fetchQuery(first.sync.queryOptions.agents(key)),
        first.queryClient.fetchQuery(first.sync.queryOptions.mcp(key)),
        first.queryClient.fetchQuery(first.sync.queryOptions.mcpResources(key)),
      ])
    }
    await waitFor(() => one[0].provider.all.has("removed") && "old" in one[0].mcp)
    const secondCount = second.requests.length
    const before = first.requests.length
    first.queryClient.setQueryData([first.scope, "/one", "message", "ses"], ["existing transcript"])
    first.queryClient.setQueryData([first.scope, "activeSessions"], {})
    first.revision.current = "new"
    first.emit()
    await waitFor(() => one[0].config.model === "kept/new" && two[0].command[0]?.name === "new")
    await waitFor(() => first.sync.data.config.model === "kept/new")
    expect(first.sync.data.config).toEqual({ model: "kept/new" })
    expect([...first.sync.data.provider.all.keys()]).toEqual(["kept"])
    for (const [store] of [one, two]) {
      expect(store.config).toEqual({ model: "kept/new" })
      expect(store.agent.map((agent) => agent.name)).toEqual(["new"])
      expect(store.command.map((command) => [command.name, command.source])).toEqual([["new", "skill"]])
      expect([...store.provider.all.keys()]).toEqual(["kept"])
      expect(Object.keys(store.provider.all.get("kept")!.models)).toEqual(["new"])
      expect(store.provider.all.get("kept")!.models.new.variants).toEqual({ current: {} })
      expect(Object.keys(store.mcp)).toEqual(["new"])
      expect(Object.keys(store.mcp_resource)).toEqual(["new"])
      expect(store.status).toBe("complete")
      expect(store.session).toEqual([])
    }
    expect(first.queryClient.getQueryData([first.scope, "/one", "message", "ses"])).toEqual(["existing transcript"])
    expect(first.queryClient.getQueryState([first.scope, "/one", "message", "ses"])?.isInvalidated).toBe(false)
    expect(first.queryClient.getQueryState([first.scope, "activeSessions"])?.isInvalidated).toBe(false)
    expect(new Set(first.requests.slice(before).map((request) => new URL(request.url).pathname))).toEqual(
      new Set(["/global/config", "/provider", "/config", "/agent", "/command", "/mcp", "/experimental/resource"]),
    )
    expect(second.requests).toHaveLength(secondCount)
    expect(second.sync.data.config.model).toBe("kept/old")
    expect(other[0].command).toEqual([])
  })

  test("discards an in-flight pre-reload provider response", async () => {
    const state = sync("one")
    const child = state.sync.child("/one", { bootstrap: false })
    await waitFor(() => state.sync.data.config.model === "kept/old")
    const pending = Promise.withResolvers<Response>()
    state.pending.set("/provider", pending.promise)
    const load = state.queryClient.fetchQuery(state.sync.queryOptions.providers(pathKey("/one"))).then(
      () => false,
      (error) => isCancelledError(error),
    )
    await waitFor(() =>
      state.requests.some((request) => {
        const url = new URL(request.url)
        return url.pathname === "/provider" && url.searchParams.get("directory") === "/one"
      }),
    )
    state.pending.delete("/provider")
    state.revision.current = "new"
    state.emit()
    await waitFor(() => child[0].provider.all.has("kept"))
    pending.resolve(Response.json({ all: [{ id: "stale", models: {} }], connected: ["stale"], default: {} }))
    expect(await load).toBe(true)
    expect([...child[0].provider.all.keys()]).toEqual(["kept"])
    expect(child[0].provider.all.has("stale")).toBe(false)
  })

  test("keeps the latest directory config and commands when reload responses arrive out of order", async () => {
    const state = sync("one")
    const child = state.sync.child("/one", { bootstrap: false })
    await waitFor(() => state.sync.data.config.model === "kept/old")
    const config = Promise.withResolvers<Response>()
    const command = Promise.withResolvers<Response>()
    state.pending.set("/config", config.promise)
    state.pending.set("/command", command.promise)
    state.emit()
    await waitFor(() => state.requests.some((request) => new URL(request.url).pathname === "/config"))
    await waitFor(() => state.requests.some((request) => new URL(request.url).pathname === "/command"))
    state.pending.delete("/config")
    state.pending.delete("/command")
    state.revision.current = "new"
    state.emit()
    await waitFor(() => child[0].config.model === "kept/new" && child[0].command[0]?.name === "new")
    config.resolve(Response.json({ model: "kept/stale" }))
    command.resolve(Response.json([{ name: "stale", template: "stale" }]))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(child[0].config.model).toBe("kept/new")
    expect(child[0].command[0]?.name).toBe("new")
  })

  test("discards directory bootstrap config and commands started before reload", async () => {
    const state = sync("one")
    await waitFor(() => state.sync.data.config.model === "kept/old")
    const config = Promise.withResolvers<Response>()
    const command = Promise.withResolvers<Response>()
    state.pending.set("/config", config.promise)
    state.pending.set("/command", command.promise)
    const child = state.sync.child("/one", { mcp: true })
    await waitFor(() => state.requests.some((request) => new URL(request.url).pathname === "/config"))
    await waitFor(() => state.requests.some((request) => new URL(request.url).pathname === "/command"))
    state.pending.delete("/config")
    state.pending.delete("/command")
    state.revision.current = "new"
    state.emit()
    await waitFor(() => child[0].config.model === "kept/new" && child[0].command[0]?.name === "new")
    config.resolve(Response.json({ model: "kept/stale" }))
    command.resolve(Response.json([{ name: "stale", template: "stale" }]))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(child[0].config.model).toBe("kept/new")
    expect(child[0].command[0]?.name).toBe("new")
  })

  test("refreshes independent clients listening to the same server", async () => {
    const first = sync("shared")
    const second = sync("shared", first.emitter)
    const one = first.sync.child("/one", { bootstrap: false })
    const two = second.sync.child("/two", { bootstrap: false })
    await waitFor(() => first.sync.data.config.model === "kept/old" && second.sync.data.config.model === "kept/old")
    first.revision.current = "new"
    second.revision.current = "new"
    first.emit()
    await waitFor(() => one[0].config.model === "kept/new" && two[0].config.model === "kept/new")
    expect(first.sync.data.config.model).toBe("kept/new")
    expect(second.sync.data.config.model).toBe("kept/new")
  })

  test("ignores a reload event outside the global directory", async () => {
    const state = sync("one")
    const child = state.sync.child("/one", { bootstrap: false })
    await waitFor(() => state.sync.data.config.model === "kept/old")
    const before = state.requests.length
    state.revision.current = "new"
    state.emit("/one")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.requests).toHaveLength(before)
    expect(child[0].config).toEqual({})
  })
})
