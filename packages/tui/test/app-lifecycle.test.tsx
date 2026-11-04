/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import { rm } from "node:fs/promises"
import { onMount } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import { useLocal } from "../src/context/local"
import { useSync } from "../src/context/sync"
import { useRoute } from "../src/context/route"
import { usePromptRef } from "../src/context/prompt"
import { useToast } from "../src/ui/toast"

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

const base = { providerID: "provider", modelID: "base" }
const override = { providerID: "provider", modelID: "override" }
const session = (id: string) => ({
  id,
  title: id,
  slug: id,
  projectID: "project",
  directory,
  version: "test",
  time: { created: 1, updated: 1 },
})

async function waitFor(predicate: () => unknown) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for app state")
    await Bun.sleep(5)
  }
}

async function mount(
  options: {
    args?: { continue?: boolean; fork?: boolean; sessionID?: string; model?: string }
    sessions?: ReturnType<typeof session>[]
    lsp?: Promise<Response>
    create?: Promise<Response>
    fork?: Promise<Response>
    saved?: Record<string, unknown>
  } = {},
) {
  const state = `/tmp/opencode/lifecycle-${crypto.randomUUID()}`
  await Bun.write(`${state}/model.json`, JSON.stringify(options.saved ?? {}))
  await Bun.write(`${state}/kv.json`, "{}")
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const ready = Promise.withResolvers<{
    local: ReturnType<typeof useLocal>
    sync: ReturnType<typeof useSync>
    route: ReturnType<typeof useRoute>
    prompt: ReturnType<typeof usePromptRef>
    toast: ReturnType<typeof useToast>
  }>()
  const created = Promise.withResolvers<void>()
  const forked = Promise.withResolvers<void>()
  function Probe() {
    const local = useLocal()
    const sync = useSync()
    const route = useRoute()
    const prompt = usePromptRef()
    const toast = useToast()
    onMount(() => ready.resolve({ local, sync, route, prompt, toast }))
    return null
  }
  const model = {
    providerID: "provider",
    api: { id: "model", url: "http://test", npm: "test" },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1000, output: 100 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/lsp" && options.lsp) return options.lsp
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", hidden: false }])
    if (url.pathname === "/session") return json(options.sessions ?? [])
    if (url.pathname === "/config/providers")
      return json({
        providers: [
          {
            id: "provider",
            name: "Provider",
            source: "custom",
            env: [],
            options: {},
            models: {
              base: { ...model, id: "base", name: "Base", variants: { low: {} } },
              override: { ...model, id: "override", name: "Override", variants: { high: {} } },
            },
          },
        ],
        default: { provider: "base" },
      })
    if (url.pathname === "/session/dummy") return json({ message: "not found" }, { status: 404 })
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(session(url.pathname.split("/")[2]))
    if (/^\/session\/[^/]+\/(message|todo|diff)$/.test(url.pathname)) return json([])
    if (/^\/session\/[^/]+\/queue$/.test(url.pathname))
      return json({ revision: 0, paused: false, blocked: false, items: [] })
  })
  const transport = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/session" && request.method === "POST" && options.create) {
      created.resolve()
      return options.create
    }
    if (url.pathname.endsWith("/fork") && options.fork) {
      forked.resolve()
      return options.fork
    }
    return calls.fetch(input, init)
  }) as typeof fetch
  const events = createEventSource()
  let api!: TuiPluginApi
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: transport,
      events: events.source,
      args: options.args ?? {},
      pluginHost: {
        async start(input) {
          api = input.api
          input.runtime.setupSlots(input.api).register({ id: "probe", slots: { app: () => <Probe /> } })
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(Global.layerWith({ state }))),
  )
  const ctx = await ready.promise
  await waitFor(() => ctx.local.model.ready && ctx.prompt.current)
  return {
    ...ctx,
    state,
    task,
    created: created.promise,
    forked: forked.promise,
    renderer: setup.renderer,
    exit: () => api.keymap.dispatchCommand("app.exit"),
    async cleanup() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task
      mock.restore()
      await rm(state, { recursive: true, force: true })
    },
  }
}

test("continue waits for complete empty snapshot and selects the CLI model only once", async () => {
  const gate = Promise.withResolvers<Response>()
  const app = await mount({ args: { continue: true, model: "provider/override" }, lsp: gate.promise })
  try {
    await waitFor(() => app.sync.status === "partial")
    app.local.model.set(base)
    expect(app.local.model.current()).toEqual(base)
    gate.resolve(json([]))
    await waitFor(() => app.sync.status === "complete")
    expect(app.local.model.current()).toEqual(override)
    expect(app.route.data.type).toBe("home")
    app.local.model.set(base)
    app.sync.set("session", [])
    await Bun.sleep(0)
    expect(app.local.model.current()).toEqual(base)
  } finally {
    gate.resolve(json([]))
    await app.cleanup()
  }
})

for (const model of [undefined, "provider/override"] as const) {
  test(`continue with ${model ?? "no model"} preserves destination precedence and other sessions`, async () => {
    const app = await mount({
      args: { continue: true, model },
      sessions: [session("target")],
      saved: { session: { target: base, unrelated: base } },
    })
    try {
      await waitFor(() => app.route.data.type === "session" && app.route.data.sessionID === "target")
      expect(app.local.model.current()).toEqual(model ? override : base)
      app.exit()
      await app.task
      const saved = await Bun.file(`${app.state}/model.json`).json()
      expect(saved.session.target).toEqual(model ? override : base)
      expect(saved.session.unrelated).toEqual(base)
    } finally {
      await app.cleanup()
    }
  })
}

for (const mode of ["continue", "session"] as const) {
  for (const outcome of ["success", "failure", "reject"] as const) {
    test(`${mode} fork ${outcome} selects the CLI model after navigation`, async () => {
      const gate = Promise.withResolvers<Response>()
      const app = await mount({
        args: {
          ...(mode === "continue" ? { continue: true } : { sessionID: "source" }),
          fork: true,
          model: "provider/override",
        },
        sessions: [session("source")],
        saved: { session: { source: base, destination: base, unrelated: base } },
        fork: gate.promise,
      })
      try {
        await app.forked
        if (outcome === "success") gate.resolve(json(session("destination")))
        if (outcome === "failure") gate.resolve(json({ message: "failed" }, { status: 500 }))
        if (outcome === "reject") gate.reject(new Error("network failed"))
        await waitFor(() =>
          outcome === "success"
            ? app.route.data.type === "session" && app.route.data.sessionID === "destination"
            : app.route.data.type === "home" && app.toast.currentToast?.message === "Failed to fork session",
        )
        expect(app.local.model.current()).toEqual(override)
        if (outcome !== "success") expect(app.toast.currentToast?.message).toBe("Failed to fork session")
        app.exit()
        await app.task
        const saved = await Bun.file(`${app.state}/model.json`).json()
        expect(saved.session.source).toEqual(base)
        expect(saved.session.unrelated).toEqual(base)
        expect(saved.session.destination).toEqual(outcome === "success" ? override : base)
      } finally {
        gate.resolve(json(session("destination")))
        await app.cleanup()
      }
    })
  }
}

test("partial empty continue snapshot can still adopt a later session", async () => {
  const gate = Promise.withResolvers<Response>()
  const app = await mount({ args: { continue: true, model: "provider/override" }, lsp: gate.promise })
  try {
    await waitFor(() => app.sync.status === "partial")
    app.sync.set("session", [session("later")])
    await waitFor(() => app.route.data.type === "session" && app.route.data.sessionID === "later")
    expect(app.local.model.current()).toEqual(override)
    app.local.model.set(base)
    gate.resolve(json([]))
    await waitFor(() => app.sync.status === "complete")
    expect(app.local.model.current()).toEqual(base)
  } finally {
    gate.resolve(json([]))
    await app.cleanup()
  }
})

for (const model of [undefined, "invalid"] as const) {
  test(`empty continue with ${model ?? "no model"} preserves selection and warnings`, async () => {
    const gate = Promise.withResolvers<Response>()
    const app = await mount({ args: { continue: true, model }, lsp: gate.promise, saved: { model: { build: base } } })
    try {
      await waitFor(() => app.sync.status === "partial")
      gate.resolve(json([]))
      await waitFor(() => app.sync.status === "complete" && app.route.data.type === "home")
      expect(app.local.model.current()).toEqual(base)
      if (model) expect(app.toast.currentToast?.message).toBe("Invalid model format: invalid")
      if (!model) expect(app.toast.currentToast?.message).not.toContain("Invalid model")
    } finally {
      gate.resolve(json([]))
      await app.cleanup()
    }
  })
}

test("shutdown persists the original prompt selection when creation completes within the grace period", async () => {
  const gate = Promise.withResolvers<Response>()
  const app = await mount({ create: gate.promise })
  try {
    await waitFor(() => app.sync.status === "complete")
    app.local.model.set(base)
    app.local.model.variant.set("low")
    app.prompt.current!.set({ input: "hello", parts: [] })
    app.prompt.current!.submit()
    await app.created
    app.local.model.set(override)
    app.exit()
    await waitFor(() => app.renderer.isDestroyed)
    await Bun.sleep(0)
    gate.resolve(json(session("created")))
    await app.task
    const saved = await Bun.file(`${app.state}/model.json`).json()
    expect(saved.session.created).toEqual({ ...base, variant: "low" })
  } finally {
    gate.resolve(json(session("created")))
    await app.cleanup()
  }
})

for (const outcome of ["success", "reject"] as const) {
  test(`shutdown cuts off pending prompt creation and ignores late ${outcome}`, async () => {
    const gate = Promise.withResolvers<Response>()
    const app = await mount({ create: gate.promise })
    try {
      await waitFor(() => app.sync.status === "complete")
      app.local.model.set(base)
      app.local.model.variant.set("low")
      app.prompt.current!.set({ input: "hello", parts: [] })
      app.prompt.current!.submit()
      await app.created
      app.local.model.set(override)
      const start = performance.now()
      app.exit()
      await app.task
      expect(performance.now() - start).toBeGreaterThanOrEqual(200)
      expect(performance.now() - start).toBeLessThan(1000)
      const before = await Bun.file(`${app.state}/model.json`).text()
      expect(JSON.parse(before).model.build).toEqual(override)
      if (outcome === "success") gate.resolve(json(session("late")))
      if (outcome === "reject") gate.reject(new Error("late failure"))
      await Bun.sleep(0)
      await app.local.model.flush()
      expect(await Bun.file(`${app.state}/model.json`).text()).toBe(before)
      expect(JSON.parse(before).session?.late).toBeUndefined()
    } finally {
      gate.resolve(json(session("late")))
      await app.cleanup()
    }
  })
}
