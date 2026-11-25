import { afterEach, describe, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { Suspense, type JSX } from "solid-js"
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
      ).code.replace(
        /(["'])@\/(?:context\/(?:server-sdk|sdk|sync|file|layout|comments|permission)|components\/prompt-input\/submit|utils\/toast)\1/g,
        (match: string) =>
          path.endsWith("/server-lifecycle-commands.tsx") || path.endsWith("/context/server-sync.tsx")
            ? JSON.stringify(import.meta.path)
            : /\/components\/prompt-input(?:-v2)?\.tsx$/.test(path)
              ? JSON.stringify(import.meta.path)
              : match,
      ),
      loader: "tsx",
    }))
  },
})

const { PlatformProvider } = await import("../src/context/platform")
const { LanguageProvider } = await import("../src/context/language")
const { SettingsProvider, useSettings } = await import("../src/context/settings")
const { DialogProvider } = await import("@opencode-ai/ui/context/dialog")
const { CommandProvider, useCommand } = await import("../src/context/command")
const { ServerLifecycleCommands } = await import("../src/components/server-lifecycle-commands")
const { createServerSyncContextInner } = await import("../src/context/server-sync")
const { createSdkForServer, createApiForServer } = await import("../src/utils/server")
const { ServerScope } = await import("../src/utils/server-scope")
const { ServerConnection } = await import("../src/context/server")
const { pathKey } = await import("../src/utils/path-key")
const { createPromptState } = await import("../src/context/prompt-state")
const { PromptInputV2Composer, usePromptInputV2Controller } = await import("../src/components/prompt-input-v2")
const { PromptInput } = await import("../src/components/prompt-input")
const { getCursorPosition } = await import("../src/components/prompt-input/editor-dom")

let selected: () => Pick<ServerSDK, "client" | "server">
const toasts: ToastOptions[] = []
export const useServerSDK = () => () => selected()
export const showToast = (options: ToastOptions) => toasts.push(options)
let composerSDK: () => unknown
export const useSDK = () => composerSDK
export const useSync = () => () => ({
  data: {
    reference: [],
    mcp_resource: {},
    command: [],
    agent: [],
    message: {},
    session_diff: {},
    session_message: {},
    part: {},
    session_working: () => false,
  },
  session: { get: () => undefined },
})
export const useFile = () => ({
  pathFromTab: () => undefined,
  tab: (path: string) => path,
  searchFilesAndDirectories: async () => [],
})
export const selectionFromLines = (selection: unknown) => selection
export const useLayout = () => ({})
export const useComments = () => ({ all: () => [] })
export const usePermission = () => ({ isAutoAcceptingDirectory: () => false, isAutoAccepting: () => false })
export const createPromptSubmit = (input: { onSubmit?: () => void }) => ({
  handleSubmit: () => input.onSubmit?.(),
  abort() {},
})

const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose())
  toasts.length = 0
})

function mount(run: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
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
  const unmount = () => {
    dispose()
    host.remove()
  }
  cleanup.push(unmount)
  return { host, dispose: unmount }
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

function skillServer(name: string, protocol: "v1" | "v2" = "v1") {
  const emitter = createGlobalEmitter<{ [key: string]: ServerEvent }>()
  const requests: Request[] = []
  const responses: Promise<Response>[] = []
  const skills = { current: [{ name: "old", description: "old description", location: "/old", content: "old" }] }
  const connection: ServerConnection.Http = {
    type: "http",
    http: { url: `https://${name}.example`, username: name, password: "secret" },
  }
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return responses.shift() ?? Response.json(protocol === "v1" ? skills.current : { data: skills.current })
    },
    { preconnect() {} },
  )
  const client = createSdkForServer({ server: connection.http, fetch, directory: "/project" })
  const api = createApiForServer({ server: connection.http, fetch })
  const server = { server: connection, client, event: { listen: emitter.listen.bind(emitter) } }
  const directory = { client, api, protocol: Promise.resolve(protocol), directory: "/project" }
  return {
    server,
    directory,
    skills,
    requests,
    responses,
    emitter,
    emit: (name = "global", type = "config.reloaded") =>
      emitter.emit(name, { type, properties: {} } as unknown as ServerEvent),
  }
}

const composerControls = {
  agents: { available: [], options: [], current: "", loading: false, visible: false, select() {} },
  model: {
    loading: true,
    paid: false,
    selection: {
      current: () => undefined,
      list: () => [],
      variant: { current: () => undefined, list: () => [], set() {} },
    },
  },
  session: {
    tabs: { active: () => undefined, all: () => [], open() {}, setActive() {} },
    reviewPanel: { opened: () => false, open() {} },
  },
}

function composer(layout: "v1" | "v2", initial: ReturnType<typeof skillServer>, suspense = false) {
  const servers = [initial]
  const [selection, setSelection] = createStore({ index: 0 })
  selected = () => servers[selection.index]!.server
  composerSDK = () => servers[selection.index]!.directory
  const state = createPromptState()
  const result: {
    controller?: ReturnType<typeof usePromptInputV2Controller>
    editor?: HTMLDivElement
    settings?: ReturnType<typeof useSettings>
    command?: ReturnType<typeof useCommand>
  } = {}
  const submissions: string[] = []
  const draft = () =>
    state
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
  const submit = () => submissions.push(draft())
  const props = {
    state,
    controls: composerControls,
    history: { entries: () => [], add() {} },
    submission: { handleSubmit: submit, abort() {} },
    onSubmit: submit,
    ref: (element: HTMLDivElement) => {
      result.editor = element
    },
  } as Parameters<typeof PromptInput>[0]
  const content = () => {
    result.settings = useSettings()
    result.command = useCommand()
    if (layout === "v1") return createComponent(PromptInput, props)
    result.controller = usePromptInputV2Controller(props)
    return suspense ? createComponent(PromptInputV2Composer, { controller: result.controller }) : null
  }
  const mounted = mount(() =>
    createComponent(SettingsProvider, {
      get children() {
        return createComponent(DialogProvider, {
          get children() {
            return createComponent(CommandProvider, {
              get children() {
                if (!suspense) return createComponent(content, {})
                const fallback = document.createElement("div")
                fallback.dataset.testid = "composer-fallback"
                return createComponent(Suspense, {
                  fallback,
                  get children() {
                    return createComponent(content, {})
                  },
                })
              },
            })
          },
        })
      },
    }),
  )
  return {
    ...mounted,
    state,
    result,
    draft,
    submissions,
    select: (next: ReturnType<typeof skillServer>) => {
      servers.push(next)
      setSelection("index", servers.length - 1)
    },
  }
}

test.each(["v1", "v2"] as const)(
  "%s composer sends on the configured chord and keeps Enter as newline",
  async (layout) => {
    const mounted = composer(layout, skillServer("keybind"), layout === "v2")
    await waitFor(() => !!mounted.host.querySelector('[data-component="prompt-input"][contenteditable="true"]'))
    const editor = mounted.host.querySelector<HTMLDivElement>(
      '[data-component="prompt-input"][contenteditable="true"]',
    )!
    const settings = mounted.result.settings!
    settings.general.setEnterNewline(true)
    settings.keybinds.set("prompt.send", "ctrl+shift+enter")
    try {
      editor.focus()
      editor.textContent = "draft"
      const selection = window.getSelection()!
      selection.collapse(editor.firstChild!, 5)
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }))
      const press = (key: string, options: KeyboardEventInit = {}) =>
        editor.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }))

      press("Enter", { shiftKey: true })
      expect(mounted.submissions).toEqual([])
      press("Enter")
      expect(mounted.draft()).toBe("draft\n")
      press("Enter", { ctrlKey: true, shiftKey: true, isComposing: true })
      press("Enter", { ctrlKey: true, shiftKey: true, repeat: true })
      expect(mounted.submissions).toEqual([])
      press("Enter", { ctrlKey: true, shiftKey: true })
      expect(mounted.submissions).toEqual(["draft\n"])

      settings.keybinds.set("prompt.newline", "alt+;")
      expect(press("Enter")).toBe(false)
      expect(mounted.draft()).toBe("draft\n")
      press(";", { altKey: true })
      expect(mounted.draft()).toBe("draft\n\n")

      settings.keybinds.set("prompt.send", "alt+s")
      press("Enter", { ctrlKey: true, shiftKey: true })
      expect(mounted.submissions).toEqual(["draft\n"])
      press("s", { altKey: true })
      expect(mounted.submissions).toEqual(["draft\n", "draft\n\n"])
    } finally {
      settings.keybinds.resetAll()
      settings.general.setEnterNewline(false)
    }
  },
)

test("the shortcut catalog shows composer defaults and the current overrides", () => {
  const mounted = composer("v2", skillServer("keybind-catalog"))
  const command = mounted.result.command!
  const settings = mounted.result.settings!
  try {
    settings.general.setEnterNewline(true)
    expect(command.catalog.filter((item) => item.id === "prompt.send" || item.id === "prompt.newline")).toEqual([
      { id: "prompt.send", title: "Send", keybind: "shift+enter" },
      { id: "prompt.newline", title: "New line", keybind: "enter" },
    ])
    const initial = command.keybind("prompt.send")
    settings.keybinds.set("prompt.send", "enter")
    expect(command.keybind("prompt.send")).toBe("Enter")
    settings.keybinds.resetAll()
    expect(command.keybind("prompt.send")).toBe(initial)
  } finally {
    settings.keybinds.resetAll()
    settings.general.setEnterNewline(false)
  }
})

test.each(["v1", "v2"] as const)("V1 composer reloads actual skill suggestions using %s protocol", async (protocol) => {
  const server = skillServer("legacy", protocol)
  server.skills.current = [{ name: "skill-old", description: "old", location: "/old", content: "old" }]
  const mounted = composer("v1", server)
  await waitFor(() => server.requests.length === 1)
  const editor = mounted.result.editor!
  editor.textContent = "$s"
  const range = document.createRange()
  range.setStart(editor.firstChild!, 2)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(getCursorPosition(editor)).toBe(2)
  await waitFor(() => mounted.host.textContent!.includes("skill-old"))
  server.skills.current = [{ name: "skill-new", description: "changed", location: "/new", content: "new" }]
  server.emit()
  await waitFor(() => mounted.host.textContent!.includes("skill-new"))
  expect(mounted.host.textContent).not.toContain("skill-old")
  expect(mounted.result.editor).toBe(editor)
  expect(server.requests).toHaveLength(2)
  expect(server.requests[0]!.headers.get("authorization")).toBe(`Basic ${btoa("legacy:secret")}`)
  expect(new URL(server.requests[0]!.url).pathname).toBe(protocol === "v1" ? "/skill" : "/api/skill")
  if (protocol === "v2") expect(server.requests[0]!.url).toContain("%2Fproject")
})

test.each(["v1", "v2"] as const)("V2 controller uses %s protocol and follows the selected server", async (protocol) => {
  const first = skillServer("first", protocol)
  const second = skillServer("second", protocol)
  second.skills.current = [
    { name: "second", description: "second description", location: "/second", content: "second" },
  ]
  const mounted = composer("v2", first)
  const controller = mounted.result.controller!
  controller.onInput("$")
  await waitFor(() => controller.suggestions().some((item) => item.id === "skill:old"))
  expect(first.requests).toHaveLength(1)
  expect(first.requests[0]!.headers.get("authorization")).toBe(`Basic ${btoa("first:secret")}`)
  expect(new URL(first.requests[0]!.url).pathname).toBe(protocol === "v1" ? "/skill" : "/api/skill")
  if (protocol === "v2") expect(first.requests[0]!.url).toContain("%2Fproject")
  second.emit()
  first.emit("/project")
  first.emit("global", "server.connected")
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(first.requests).toHaveLength(1)
  expect(second.requests).toHaveLength(0)
  mounted.select(second)
  await waitFor(() => controller.suggestions().some((item) => item.id === "skill:second"))
  first.emit()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(first.requests).toHaveLength(1)
  expect(second.requests).toHaveLength(1)
  second.skills.current = [{ name: "second", description: "updated", location: "/second", content: "updated" }]
  second.emit()
  await waitFor(() =>
    controller.suggestions().some((item) => item.id === "skill:second" && item.description === "updated"),
  )
  expect(mounted.result.controller).toBe(controller)
  mounted.dispose()
  second.emit()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(second.requests).toHaveLength(2)
})

test("V2 controller ignores stale initial, reload, and previous server skill responses", async () => {
  const first = skillServer("first")
  const initial = Promise.withResolvers<Response>()
  const reload = Promise.withResolvers<Response>()
  first.responses.push(initial.promise, reload.promise)
  const mounted = composer("v2", first)
  const controller = mounted.result.controller!
  controller.onInput("$")
  await waitFor(() => first.requests.length === 1)
  first.emit()
  await waitFor(() => first.requests.length === 2)
  first.skills.current = [{ name: "latest", description: "latest", location: "/latest", content: "latest" }]
  first.emit()
  await waitFor(() => controller.suggestions().some((item) => item.id === "skill:latest"))
  initial.resolve(
    Response.json([{ name: "stale-initial", description: "stale", location: "/stale", content: "stale" }]),
  )
  reload.resolve(Response.json([{ name: "stale-reload", description: "stale", location: "/stale", content: "stale" }]))
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(
    controller
      .suggestions()
      .filter((item) => item.kind === "skill")
      .map((item) => item.id),
  ).toEqual(["skill:latest"])
  const pending = Promise.withResolvers<Response>()
  first.responses.push(pending.promise)
  first.emit()
  await waitFor(() => first.requests.length === 4)
  const second = skillServer("second")
  second.skills.current = [{ name: "new-server", description: "new", location: "/new", content: "new" }]
  mounted.select(second)
  await waitFor(() => controller.suggestions().some((item) => item.id === "skill:new-server"))
  pending.resolve(Response.json([{ name: "stale-server", description: "stale", location: "/stale", content: "stale" }]))
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(
    controller
      .suggestions()
      .filter((item) => item.kind === "skill")
      .map((item) => item.id),
  ).toEqual(["skill:new-server"])
})

test("two same-batch reloads start distinct skill requests", async () => {
  const server = skillServer("batch")
  const mounted = composer("v2", server)
  const controller = mounted.result.controller!
  controller.onInput("$")
  await waitFor(() => controller.suggestions().some((item) => item.id === "skill:old"))
  const stale = Promise.withResolvers<Response>()
  server.responses.push(stale.promise)
  server.skills.current = [{ name: "latest", description: "latest", location: "/latest", content: "latest" }]
  server.emit()
  server.emit()
  await waitFor(() => controller.suggestions().some((item) => item.id === "skill:latest"))
  expect(server.requests).toHaveLength(3)
  stale.resolve(Response.json([{ name: "stale", description: "stale", location: "/stale", content: "stale" }]))
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(
    controller
      .suggestions()
      .filter((item) => item.kind === "skill")
      .map((item) => item.id),
  ).toEqual(["skill:latest"])
})

test("all mounted composers refresh without replacing their drafts, caret, attachment, or editor", async () => {
  const server = skillServer("shared")
  server.skills.current = [{ name: "skill-old", description: "old", location: "/old", content: "old" }]
  const legacy = composer("v1", server)
  const modern = composer("v2", server)
  const controller = modern.result.controller!
  const editor = legacy.result.editor!
  const modernEditor = document.createElement("div")
  controller.setEditor(modernEditor)
  editor.textContent = "$s"
  const range = document.createRange()
  range.setStart(editor.firstChild!, 2)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }))
  controller.onInput("$s")
  await waitFor(
    () =>
      legacy.host.textContent!.includes("skill-old") &&
      controller.suggestions().some((item) => item.id === "skill:skill-old"),
  )
  const image = {
    type: "image" as const,
    id: "image",
    filename: "image.png",
    mime: "image/png",
    blob: { id: "blob", url: "data:image/png;base64,AA==" },
  }
  legacy.state.set([...legacy.state.current(), image], 2)
  modern.state.set([...modern.state.current(), image], 2)
  const snapshot = (state: ReturnType<typeof createPromptState>) => ({
    parts: Array.from(state.current(), (part) =>
      part.type === "image" ? { ...part, blob: { ...part.blob } } : { ...part },
    ),
    cursor: state.cursor(),
  })
  const beforeLegacy = snapshot(legacy.state)
  const beforeModern = snapshot(modern.state)
  expect(beforeLegacy.parts.some((part) => part.type === "image")).toBe(true)
  expect(beforeModern.parts.some((part) => part.type === "image")).toBe(true)
  expect(getCursorPosition(editor)).toBe(2)
  server.skills.current = [{ name: "skill-new", description: "new description", location: "/new", content: "new" }]
  server.emit()
  await waitFor(
    () =>
      legacy.host.textContent!.includes("skill-new") &&
      controller.suggestions().some((item) => item.id === "skill:skill-new"),
  )
  expect(server.requests).toHaveLength(4)
  expect(legacy.host.textContent).not.toContain("skill-old")
  expect(
    controller
      .suggestions()
      .filter((item) => item.kind === "skill")
      .map((item) => [item.id, item.description]),
  ).toEqual([["skill:skill-new", "new description"]])
  expect(snapshot(legacy.state)).toEqual(beforeLegacy)
  expect(snapshot(modern.state)).toEqual(beforeModern)
  expect(legacy.result.editor).toBe(editor)
  expect(modern.result.controller).toBe(controller)
  expect(modern.result.editor).toBe(modernEditor)
  expect(getCursorPosition(editor)).toBe(2)
})

test("V1 composer switches servers and unsubscribes on disposal", async () => {
  const first = skillServer("first")
  const second = skillServer("second")
  const mounted = composer("v1", first)
  await waitFor(() => first.requests.length === 1)
  first.emit("/project")
  first.emit("global", "server.connected")
  second.emit()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(first.requests).toHaveLength(1)
  mounted.select(second)
  await waitFor(() => second.requests.length === 1)
  first.emit()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(first.requests).toHaveLength(1)
  second.emit()
  await waitFor(() => second.requests.length === 2)
  mounted.dispose()
  second.emit()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(second.requests).toHaveLength(2)
})

test("V1 composer rejects stale initial, batched reload, and prior server responses", async () => {
  const first = skillServer("first")
  const initial = Promise.withResolvers<Response>()
  const reload = Promise.withResolvers<Response>()
  first.responses.push(initial.promise, reload.promise)
  const mounted = composer("v1", first)
  const editor = mounted.result.editor!
  editor.textContent = "$s"
  const range = document.createRange()
  range.setStart(editor.firstChild!, 2)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }))
  await waitFor(() => first.requests.length === 1)
  first.skills.current = [{ name: "skill-latest", description: "latest", location: "/latest", content: "latest" }]
  first.emit()
  first.emit()
  await waitFor(() => mounted.host.textContent!.includes("skill-latest"))
  expect(first.requests).toHaveLength(3)
  initial.resolve(
    Response.json([{ name: "skill-stale-initial", description: "stale", location: "/stale", content: "stale" }]),
  )
  reload.resolve(
    Response.json([{ name: "skill-stale-reload", description: "stale", location: "/stale", content: "stale" }]),
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(mounted.host.textContent).not.toContain("skill-stale")
  const pending = Promise.withResolvers<Response>()
  first.responses.push(pending.promise)
  first.emit()
  await waitFor(() => first.requests.length === 4)
  const second = skillServer("second")
  second.skills.current = [{ name: "skill-second", description: "new", location: "/new", content: "new" }]
  mounted.select(second)
  await waitFor(() => mounted.host.textContent!.includes("skill-second"))
  pending.resolve(
    Response.json([{ name: "skill-stale-server", description: "stale", location: "/stale", content: "stale" }]),
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(mounted.host.textContent).not.toContain("skill-stale")
  expect(mounted.host.textContent).toContain("skill-second")
})

test.each(["v1", "v2"] as const)(
  "%s composer receives reloads while its initial skills are pending under Suspense",
  async (layout) => {
    const server = skillServer(`initial-${layout}`)
    const initial = Promise.withResolvers<Response>()
    server.responses.push(initial.promise)
    const mounted = composer(layout, server, true)
    server.skills.current = [{ name: "skill-new", description: "new description", location: "/new", content: "new" }]
    // Publish before the initial render's suspended effects can run.
    server.emit()
    await waitFor(() => server.requests.length === 2)
    await waitFor(() => !!mounted.result.editor?.isConnected)
    const editor = mounted.result.editor!
    editor.focus()
    editor.textContent = "$s"
    const range = document.createRange()
    range.setStart(editor.firstChild!, 2)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }))
    await waitFor(() => mounted.host.textContent!.includes("skill-new"))
    initial.resolve(
      Response.json([{ name: "skill-stale", description: "stale", location: "/stale", content: "stale" }]),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(mounted.host.textContent).toContain("skill-new")
    expect(mounted.host.textContent).not.toContain("skill-stale")
    expect(server.requests).toHaveLength(2)
  },
)

test.each(["v1", "v2"] as const)(
  "%s composer keeps its focused editor and draft mounted during a pending reload under Suspense",
  async (layout) => {
    const server = skillServer(`focused-${layout}`)
    server.skills.current = [{ name: "skill-old", description: "old description", location: "/old", content: "old" }]
    const mounted = composer(layout, server, true)
    await waitFor(() => !!mounted.result.editor?.isConnected && server.requests.length === 1)
    const editor = mounted.result.editor!
    const controller = mounted.result.controller
    const image = {
      type: "image" as const,
      id: "image",
      filename: "image.png",
      mime: "image/png",
      blob: { id: "blob", url: "data:image/png;base64,AA==" },
    }
    mounted.state.set([{ type: "text", content: "", start: 0, end: 0 }, image], 0)
    editor.focus()
    editor.textContent = "$s tail"
    const range = document.createRange()
    range.setStart(editor.firstChild!, 2)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }))
    await waitFor(() => mounted.host.textContent!.includes("skill-old"))
    const snapshot = () => ({
      parts: Array.from(mounted.state.current(), (part) =>
        part.type === "image" ? { ...part, blob: { ...part.blob } } : { ...part },
      ),
      cursor: mounted.state.cursor(),
    })
    const before = snapshot()
    const session = mounted.state.capture()
    expect(document.activeElement).toBe(editor)
    expect(getCursorPosition(editor)).toBe(2)
    expect(before.parts).toHaveLength(2)
    expect(before.parts[1]).toEqual(image)
    const pending = Promise.withResolvers<Response>()
    server.responses.push(pending.promise)
    server.emit()
    await waitFor(() => server.requests.length === 2)
    expect(editor.isConnected).toBe(true)
    expect(mounted.host.querySelector('[data-testid="composer-fallback"]')).toBeNull()
    expect(document.activeElement).toBe(editor)
    expect(getCursorPosition(editor)).toBe(2)
    expect(snapshot()).toEqual(before)
    pending.resolve(
      Response.json([{ name: "skill-new", description: "new description", location: "/new", content: "new" }]),
    )
    await waitFor(() => mounted.host.textContent!.includes("skill-new"))
    expect(mounted.host.textContent).not.toContain("skill-old")
    expect(mounted.result.editor).toBe(editor)
    expect(mounted.result.controller).toBe(controller)
    expect(mounted.state.capture()).toBe(session)
    expect(document.activeElement).toBe(editor)
    expect(getCursorPosition(editor)).toBe(2)
    expect(snapshot()).toEqual(before)
  },
)

test.each(["v1", "v2"] as const)(
  "%s composer switches server subscriptions and disposes them under Suspense",
  async (layout) => {
    const first = skillServer(`previous-${layout}`)
    const second = skillServer(`current-${layout}`)
    const mounted = composer(layout, first, true)
    await waitFor(() => !!mounted.result.editor?.isConnected && first.requests.length === 1)
    first.emit("/project")
    first.emit("global", "server.connected")
    second.emit()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
    mounted.select(second)
    await waitFor(() => second.requests.length === 1)
    first.emit()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(first.requests).toHaveLength(1)
    second.emit()
    await waitFor(() => second.requests.length === 2)
    mounted.dispose()
    second.emit()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(second.requests).toHaveLength(2)
  },
)
