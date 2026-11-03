/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir, rename, rm } from "node:fs/promises"
import { onCleanup, onMount } from "solid-js"
import { Flock } from "@opencode-ai/core/util/flock"
import type { AssistantMessage, Model, UserMessage } from "@opencode-ai/sdk/v2"
import { Prompt, type PromptRef } from "../../src/component/prompt"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { DataProvider } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider, useLocal } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { materializePrompt } from "../../src/prompt/materialize"
import { PromptStashProvider } from "../../src/prompt/stash"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

test("prompt controls remain one-shot across navigation and persistent model restart", async () => {
  const state = `/tmp/opencode/prompt-controls-${crypto.randomUUID()}`
  await Bun.write(`${state}/kv.json`, "{}")
  const events = createEventSource()
  const submissions: Record<string, unknown>[] = []
  const queueSubmissions: Record<string, unknown>[] = []
  const creations: Record<string, unknown>[] = []
  const flushes: (() => Promise<void>)[] = []
  const creationRelease = Promise.withResolvers<void>()
  const shutdownCreationRelease = Promise.withResolvers<void>()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/fs/find")
      return json({ location: { directory }, data: [{ path: "src/components", type: "directory" }] })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", hidden: false }])
    if (url.pathname === "/skill")
      return json([
        { name: "review", description: "Review a change" },
        { name: "my-skill", description: "Test" },
        { name: "foo", description: "Test" },
        { name: "foo.bar", description: "Test" },
        { name: "日本.語", description: "Test" },
      ])
    if (url.pathname === "/command")
      return json([{ name: "review", description: "Review a change", template: "$ARGUMENTS", source: "command" }])
  })
  const transport = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname === "/session" && request.method === "POST") {
      const count = creations.push(await request.json())
      if (count === 4) await shutdownCreationRelease.promise
      if (count > 1) await creationRelease.promise
      return json({ id: ["created", "delayed", "default-created", "shutdown-created"][count - 1], directory })
    }
    if (new URL(request.url).pathname === "/session/one") return json({ id: "one", directory })
    if (new URL(request.url).pathname === "/session/one/queue") {
      const snapshot = { sessionID: "one", revision: 1, paused: false, blocked: false, items: [] }
      if (request.method === "GET") return json(snapshot)
      queueSubmissions.push(await request.json())
      return queueSubmissions.length === 1 ? json({ message: "lost acknowledgement" }, { status: 503 }) : json(snapshot)
    }
    if (/\/session\/[^/]+\/(message|command)$/.test(new URL(request.url).pathname)) {
      submissions.push(await request.json())
      return json({})
    }
    return calls.fetch(input, init)
  }) as typeof fetch
  let ready = Promise.withResolvers<{
    local: ReturnType<typeof useLocal>
    sync: ReturnType<typeof useSync>
    prompt: () => PromptRef
    navigate: (id?: string) => void
  }>()
  function Probe(props: { init?: (local: ReturnType<typeof useLocal>, sync: ReturnType<typeof useSync>) => void }) {
    const local = useLocal()
    const sync = useSync()
    const route = useRoute()
    props.init?.(local, sync)
    let prompt: PromptRef | undefined
    onMount(() =>
      ready.resolve({
        local,
        sync,
        prompt: () => prompt!,
        navigate: (sessionID) => route.navigate(sessionID ? { type: "session", sessionID } : { type: "home" }),
      }),
    )
    return (
      <Prompt
        sessionID={route.data.type === "session" ? route.data.sessionID : undefined}
        ref={(ref) => {
          prompt = ref
        }}
      />
    )
  }
  function Harness(props: Parameters<typeof Probe>[0] & { model?: string }) {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <ArgsProvider model={props.model}>
              <KVProvider>
                <ToastProvider>
                  <RouteProvider initialRoute={{ type: "session", sessionID: "one" }}>
                    <ExitProvider exit={() => {}}>
                      <SDKProvider url="http://test" directory={directory} fetch={transport} events={events.source}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <SyncProvider>
                              <DataProvider>
                                <ThemeProvider mode="dark">
                                  <LocalProvider onFlush={(flush) => flushes.push(flush)}>
                                    <PromptStashProvider>
                                      <DialogProvider>
                                        <FrecencyProvider>
                                          <PromptHistoryProvider>
                                            <EditorContextProvider>
                                              <LocationProvider>
                                                <Probe init={props.init} />
                                              </LocationProvider>
                                            </EditorContextProvider>
                                          </PromptHistoryProvider>
                                        </FrecencyProvider>
                                      </DialogProvider>
                                    </PromptStashProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </DataProvider>
                            </SyncProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </ExitProvider>
                  </RouteProvider>
                </ToastProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 30, kittyKeyboard: true })
  try {
    const ctx = await ready.promise
    while (!ctx.local.model.ready || ctx.sync.status === "loading") await Bun.sleep(10)
    const model: Omit<Model, "id" | "name"> = {
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
    ctx.sync.set("provider", [
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
    ])
    const base = { providerID: "provider", modelID: "base" }
    ctx.local.model.set(base)
    expect(ctx.local.model.variant.selected(), "unused model still offers the variant chooser").toBeUndefined()
    ctx.local.model.variant.set("low")
    const user: UserMessage = {
      id: "user",
      sessionID: "one",
      role: "user",
      agent: "build",
      time: { created: 1 },
      model: { providerID: "provider", modelID: "override", variant: "high" },
    }
    ctx.sync.set("message", "one", [user])
    ctx.sync.set("message", "two", [{ ...user, id: "other", sessionID: "two" }])
    ctx.navigate("two")
    await app.renderOnce()
    ctx.local.model.set({ providerID: "provider", modelID: "override" })
    ctx.local.model.variant.set("high")
    ctx.navigate("one")
    await app.renderOnce()
    expect(ctx.local.model.current()).toEqual(base)
    expect(ctx.local.model.variant.current()).toBe("low")
    const input = "@model:provider/override text"
    const draft = {
      input,
      parts: [
        {
          type: "control" as const,
          kind: "model" as const,
          model: { providerID: "provider", modelID: "override" },
          source: { start: 0, end: 24, value: "@model:provider/override" },
        },
      ],
    }
    ctx.prompt().set(draft)
    await app.renderOnce()
    expect(ctx.prompt().current.parts).toEqual(draft.parts)
    expect(ctx.local.model.current()).toEqual(base)
    ctx.prompt().reset()
    await app.mockInput.typeText("@mod")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(ctx.prompt().current.input).toBe("@model:")
    await app.mockInput.typeText("override")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(ctx.prompt().current.input).toBe("@model:Override")
    expect(ctx.prompt().current.parts).toHaveLength(1)
    await app.mockInput.typeText(" @model:base")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(ctx.prompt().current.parts).toHaveLength(1)
    expect(ctx.prompt().current.input).toBe(" @model:Base")
    expect(ctx.local.model.current()).toEqual(base)
    await app.mockInput.typeText(" $review")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(ctx.prompt().current.parts.map((part) => part.type)).toEqual(["control", "skill"])
    expect(ctx.prompt().current.input.endsWith("$review")).toBe(true)
    ctx.prompt().submit()
    for (let count = 0; count < 100 && !submissions.length; count++) await Bun.sleep(10)
    expect(submissions[0]).toMatchObject({
      model: base,
      selection: { inheritActive: true, model: base },
      parts: [
        { type: "text", text: "  $review" },
        { type: "file", mime: "application/x-opencode-skill", filename: "review", url: "skill:review" },
      ],
    })
    expect(JSON.stringify(submissions[0])).not.toContain('"type":"control"')
    expect(JSON.stringify(submissions[0])).not.toContain('"type":"skill"')
    ctx.prompt().set({ input: "@model:provider/override", parts: [draft.parts[0]] })
    ctx.prompt().submit()
    await Bun.sleep(10)
    expect(submissions).toHaveLength(1)
    ctx.prompt().set({ input: "plain steer", parts: [] })
    ctx.prompt().submit()
    for (let count = 0; count < 100 && submissions.length < 2; count++) await Bun.sleep(10)
    expect(submissions[1]).toMatchObject({ selection: { inheritActive: true }, model: base })
    const chip = draft.parts[0].source.value
    ctx.prompt().set({
      input: "$my" + chip + "-skill",
      parts: [{ ...draft.parts[0], source: { start: 3, end: 3 + chip.length, value: chip } }],
    })
    ctx.prompt().submit()
    for (let count = 0; count < 100 && submissions.length < 3; count++) await Bun.sleep(10)
    expect(submissions[2]).toMatchObject({
      selection: { inheritActive: true, model: draft.parts[0].model },
      parts: [
        { type: "text", text: "$my-skill" },
        { type: "file", mime: "application/x-opencode-skill", filename: "my-skill", url: "skill:my-skill" },
      ],
    })
    ctx.prompt().set({ input: "/queue $my-skill", parts: [] })
    ctx.prompt().submit()
    for (let count = 0; count < 100 && (queueSubmissions.length < 1 || ctx.sync.queue.data.busy.one); count++)
      await Bun.sleep(10)
    expect(queueSubmissions).toHaveLength(1)
    ctx.local.model.set({ providerID: "provider", modelID: "override" })
    await app.renderOnce()
    app.mockInput.pressEscape()
    await app.renderOnce()
    ctx.prompt().submit()
    for (let count = 0; count < 100 && queueSubmissions.length < 2; count++) await Bun.sleep(10)
    expect(queueSubmissions[1]).toEqual(queueSubmissions[0])
    expect(queueSubmissions[0]).toMatchObject({
      payload: {
        selection: { model: { providerID: "provider", modelID: "base" } },
        parts: [
          { type: "text", text: "$my-skill" },
          { type: "file", filename: "my-skill" },
        ],
      },
    })
    ctx.local.model.set({ providerID: "provider", modelID: "base" })
    ctx.prompt().set({ input: chip + " /review args", parts: [draft.parts[0]] })
    ctx.prompt().submit()
    for (let count = 0; count < 100 && submissions.length < 4; count++) await Bun.sleep(10)
    expect(submissions[3]).toMatchObject({
      command: "review",
      arguments: "args",
      selection: { inheritActive: true, model: draft.parts[0].model },
    })
    for (const prefix of ["/", "$"]) {
      ctx.prompt().set({
        input: prefix + "rev" + chip + "ie",
        parts: [{ ...draft.parts[0], source: { start: 4, end: 4 + chip.length, value: chip } }],
      })
      await app.mockInput.typeText("w")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await app.renderOnce()
      expect(materializePrompt(ctx.prompt().current).input).toBe(prefix + "review")
      expect(materializePrompt(ctx.prompt().current).selection.model).toEqual(draft.parts[0].model)
      if (prefix === "/") {
        ctx.prompt().submit()
        for (let count = 0; count < 100 && submissions.length < 5; count++) await Bun.sleep(10)
        expect(submissions[4]).toMatchObject({
          command: "review",
          arguments: "",
          selection: { inheritActive: true, model: draft.parts[0].model },
        })
      }
      if (prefix === "$")
        expect(
          ctx
            .prompt()
            .current.parts.map((part) => part.type)
            .sort(),
        ).toEqual(["control", "skill"])
    }
    ctx.prompt().set({
      input: "@file:src/" + chip + "co",
      parts: [{ ...draft.parts[0], source: { start: 10, end: 10 + chip.length, value: chip } }],
    })
    await app.mockInput.typeText("m")
    await Bun.sleep(20)
    await app.renderOnce()
    app.mockInput.pressKey("TAB")
    await app.renderOnce()
    expect(materializePrompt(ctx.prompt().current).input).toBe("@file:src/components/")
    expect(materializePrompt(ctx.prompt().current).selection.model).toEqual(draft.parts[0].model)
    const running: AssistantMessage = {
      id: "running",
      role: "assistant",
      sessionID: "one",
      agent: "build",
      mode: "build",
      parentID: user.id,
      modelID: "override",
      providerID: "provider",
      finish: "stop",
      time: { created: 2, completed: 3 },
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    ctx.sync.set("message", "one", [user, running])
    ctx.sync.set("part", running.id, [
      {
        id: "running-tool",
        messageID: running.id,
        sessionID: "one",
        type: "tool",
        callID: "call",
        tool: "read",
        state: { status: "running", input: {}, time: { start: 2 } },
      },
    ])
    ctx.sync.set("session_status", "one", { type: "busy" })
    ctx.prompt().reset()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("active: provider/override (high)")
    for (const [text, variant] of [
      ["/queue ", "low"],
      ["", "high"],
      ["/queue /review ", "high"],
    ]) {
      ctx.sync.set("command", 0, "model", "provider/override")
      ctx.prompt().set({ input: text + "@variant:", parts: [] })
      await app.mockInput.typeText(variant)
      await app.renderOnce()
      app.mockInput.pressEnter()
      await app.renderOnce()
      expect(materializePrompt(ctx.prompt().current).selection.variant).toBe(variant)
    }
    ctx.prompt().set({ input: "/queue @variant:", parts: [] })
    await app.mockInput.typeText("high")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(materializePrompt(ctx.prompt().current).selection.variant).toBeUndefined()
    app.mockInput.pressEscape()
    await app.renderOnce()
    ctx.prompt().set({
      input: "@variant:high steer",
      parts: [
        { type: "control", kind: "variant", variant: "high", source: { start: 0, end: 13, value: "@variant:high" } },
      ],
    })
    const steered = submissions.length
    ctx.prompt().submit()
    for (let count = 0; count < 100 && submissions.length === steered; count++) await Bun.sleep(10)
    expect(submissions[steered], "steer submission").toMatchObject({
      model: base,
      variant: "low",
      selection: { inheritActive: true, variant: "high" },
    })
    expect(ctx.local.model.current()).toEqual(base)
    expect(ctx.local.model.variant.current()).toBe("low")
    ctx.sync.set("message", "one", [user, running, { ...running, id: "done" }])
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("active:")
    ctx.sync.set("session_status", "one", { type: "idle" })
    app.mockInput.pressEscape()
    await app.renderOnce()
    for (const [name, suffix] of [
      ["foo.bar", ""],
      ["日本.語", ""],
      ["foo", "."],
    ]) {
      ctx.prompt().set({ input: "$" + name + suffix, parts: [] })
      const before = submissions.length
      ctx.prompt().submit()
      for (let count = 0; count < 100 && submissions.length === before; count++) await Bun.sleep(10)
      expect(submissions[before]).toMatchObject({
        parts: [
          { type: "text", text: "$" + name + suffix },
          { type: "file", filename: name, url: "skill:" + encodeURIComponent(name) },
        ],
      })
      expect((submissions[before].parts as unknown[]).length).toBe(2)
    }
    ctx.prompt().set({
      input: "$foo" + chip + ".bar",
      parts: [{ ...draft.parts[0], source: { start: 4, end: 4 + chip.length, value: chip } }],
    })
    const interleaved = submissions.length
    ctx.prompt().submit()
    for (let count = 0; count < 100 && submissions.length === interleaved; count++) await Bun.sleep(10)
    expect(submissions[interleaved]).toMatchObject({
      parts: [
        { type: "text", text: "$foo.bar" },
        { type: "file", filename: "foo.bar" },
      ],
    })
    expect((submissions[interleaved].parts as unknown[]).length).toBe(2)
    ctx.prompt().reset()
    await app.mockInput.typeText("$foo.bar")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(ctx.prompt().current.parts.some((part) => part.type === "skill" && part.name === "foo.bar")).toBe(true)
    const selected = submissions.length
    ctx.prompt().submit()
    for (let count = 0; count < 100 && submissions.length === selected; count++) await Bun.sleep(10)
    expect(submissions[selected]).toMatchObject({
      parts: [
        { type: "text", text: "$foo.bar" },
        { type: "file", filename: "foo.bar" },
      ],
    })
    expect((submissions[selected].parts as unknown[]).length).toBe(2)
    for (const text of ["\\$foo.bar", "me@example.com $100 $ARGUMENTS", "$foo.barista"]) {
      ctx.prompt().set({ input: text, parts: [] })
      const before = submissions.length
      ctx.prompt().submit()
      for (let count = 0; count < 100 && submissions.length === before; count++) await Bun.sleep(10)
      expect(submissions[before]).toMatchObject({ parts: [{ type: "text", text }] })
      expect((submissions[before].parts as unknown[]).length).toBe(1)
    }
    for (const [suffix, args] of [
      ["\targ", "arg"],
      ["\narg\n  next", "arg\n  next"],
      [" \t  arg\n", "\t  arg\n"],
    ]) {
      ctx.prompt().set({
        input: chip + " /rev" + chip + "iew" + suffix,
        parts: [
          { ...draft.parts[0] },
          { ...draft.parts[0], source: { start: chip.length + 5, end: chip.length + 5 + chip.length, value: chip } },
        ],
      })
      const before = submissions.length
      ctx.prompt().submit()
      for (let count = 0; count < 100 && submissions.length === before; count++) await Bun.sleep(10)
      expect(submissions[before]).toMatchObject({ command: "review", arguments: args })
    }
    for (let count = 0; count < 100 && !(await Bun.file(`${state}/model.json`).exists()); count++) await Bun.sleep(10)
    expect((await Bun.file(`${state}/model.json`).json()).model.build).toEqual(base)
    ctx.local.model.set({ providerID: "provider", modelID: "override" }, { recent: true })
    ctx.local.model.set({ providerID: "provider", modelID: "base" }, { recent: true })
    ctx.local.model.cycle(1)
    expect(ctx.local.model.current(), "recent cycle").toEqual(draft.parts[0].model)
    for (
      let count = 0;
      count < 100 && (await Bun.file(`${state}/model.json`).json()).model.build.modelID !== "override";
      count++
    )
      await Bun.sleep(10)
    expect((await Bun.file(`${state}/model.json`).json()).model.build).toEqual(draft.parts[0].model)
    ctx.local.model.set(base)
    ctx.local.model.variant.set("low")
    ctx.prompt().set({
      input: chip + " @variant:high one-shot",
      parts: [
        { ...draft.parts[0], source: { start: 0, end: chip.length, value: chip } },
        {
          type: "control",
          kind: "variant",
          variant: "high",
          source: { start: chip.length + 1, end: chip.length + 14, value: "@variant:high" },
        },
      ],
    })
    const overridden = submissions.length
    ctx.prompt().submit()
    for (let count = 0; count < 100 && submissions.length === overridden; count++) await Bun.sleep(10)
    expect(submissions[overridden], "override submission").toMatchObject({
      model: base,
      variant: "low",
      selection: { model: draft.parts[0].model, variant: "high" },
    })
    ctx.sync.set("message", "one", [user, { ...running, id: "last-executed" }])
    ctx.navigate("two")
    await app.renderOnce()
    expect(ctx.local.model.current(), "session two").toEqual(draft.parts[0].model)
    expect(ctx.local.model.variant.current()).toBe("high")
    ctx.local.model.variant.set(undefined)
    ctx.navigate("one")
    await app.renderOnce()
    expect(ctx.local.model.current()).toEqual(base)
    expect(ctx.local.model.variant.current()).toBe("low")
    ctx.navigate("unsaved")
    await app.renderOnce()
    expect(ctx.local.model.current(), "unsaved fallback").toEqual(draft.parts[0].model)
    ctx.local.model.set(base)
    ctx.local.model.variant.set(undefined)
    ctx.navigate("one")
    await app.renderOnce()
    expect(ctx.local.model.variant.current()).toBe("low")
    ctx.local.model.set(base)
    expect(ctx.local.model.variant.current()).toBe("low")
    ctx.navigate()
    await app.renderOnce()
    ctx.local.model.set(base)
    ctx.local.model.variant.set("low")
    ctx.prompt().set({
      input: chip + " first message",
      parts: [{ ...draft.parts[0], source: { start: 0, end: chip.length, value: chip } }],
    })
    const first = submissions.length
    ctx.prompt().submit()
    for (let count = 0; count < 100 && submissions.length === first; count++) await Bun.sleep(10)
    expect(creations).toHaveLength(1)
    expect(creations[0]).toMatchObject({ model: { providerID: base.providerID, id: base.modelID, variant: "low" } })
    expect(submissions[first]).toMatchObject({
      model: base,
      variant: "low",
      selection: { model: draft.parts[0].model },
    })
    for (let count = 0; count < 100 && !(await Bun.file(`${state}/model.json`).json()).session?.created; count++)
      await Bun.sleep(10)
    ctx.navigate("created")
    await app.renderOnce()
    expect(ctx.local.model.current()).toEqual(base)
    expect(ctx.local.model.variant.current()).toBe("low")
    ctx.navigate()
    await app.renderOnce()
    ctx.prompt().set({ input: "delayed first message", parts: [] })
    const delayed = submissions.length
    ctx.prompt().submit()
    for (let count = 0; count < 100 && creations.length < 2; count++) await Bun.sleep(10)
    expect(creations).toHaveLength(2)
    ctx.navigate("delayed")
    await app.renderOnce()
    ctx.local.model.set(draft.parts[0].model)
    ctx.local.model.variant.set("high")
    creationRelease.resolve()
    for (let count = 0; count < 100 && submissions.length === delayed; count++) await Bun.sleep(10)
    expect(submissions).toHaveLength(delayed + 1)
    ctx.navigate("delayed")
    await app.renderOnce()
    expect(ctx.local.model.current(), "creation must not overwrite a newer explicit selection").toEqual(
      draft.parts[0].model,
    )
    expect(ctx.local.model.variant.current()).toBe("high")
    ctx.navigate()
    await app.renderOnce()
    ctx.local.model.set(base)
    ctx.local.model.variant.set(undefined)
    ctx.prompt().set({ input: "explicit default first message", parts: [] })
    const defaulted = submissions.length
    ctx.prompt().submit()
    for (let count = 0; count < 100 && submissions.length === defaulted; count++) await Bun.sleep(10)
    expect(creations).toHaveLength(3)
    expect(creations[2].model).toEqual({ providerID: base.providerID, id: base.modelID })
    expect(submissions[defaulted].variant).toBeUndefined()
    ctx.navigate("default-created")
    await app.renderOnce()
    expect(ctx.local.model.variant.selected()).toBe("default")
    ctx.local.model.set(base)
    expect(ctx.local.model.variant.selected(), "new session retains explicit Default on model reselection").toBe(
      "default",
    )
    ctx.navigate("one")
    await app.renderOnce()
    const saved = {
      one: { ...base, variant: "low" },
      two: { ...draft.parts[0].model, variant: "default" },
      unsaved: { ...base, variant: "default" },
      created: { ...base, variant: "low" },
      delayed: { ...draft.parts[0].model, variant: "high" },
      "default-created": { ...base, variant: "default" },
    }
    for (
      let count = 0;
      count < 100 && JSON.stringify((await Bun.file(`${state}/model.json`).json()).session) !== JSON.stringify(saved);
      count++
    )
      await Bun.sleep(10)
    expect((await Bun.file(`${state}/model.json`).json()).session).toEqual(saved)
    ctx.prompt().reset()
    app.renderer.destroy()
    ready = Promise.withResolvers()
    const restarted = await testRender(
      () => (
        <Harness
          init={(local, sync) => {
            sync.set("agent", ctx.sync.data.agent)
            sync.set("provider", ctx.sync.data.provider)
            expect(local.model.ready).toBe(false)
            local.model.set(base)
          }}
        />
      ),
      { width: 120, height: 30, kittyKeyboard: true },
    )
    try {
      const next = await ready.promise
      while (!next.local.model.ready || next.sync.status === "loading") await Bun.sleep(10)
      next.sync.set("provider", ctx.sync.data.provider)
      expect(next.local.model.current()).toEqual(base)
      expect(next.local.model.variant.current()).toBe("low")
      next.navigate("two")
      await restarted.renderOnce()
      expect(next.local.model.current()).toEqual(draft.parts[0].model)
      expect(next.local.model.variant.selected()).toBe("default")
      next.navigate("one")
      await restarted.renderOnce()
      expect(next.local.model.current()).toEqual(base)
      expect(next.local.model.variant.current()).toBe("low")
      ready = Promise.withResolvers()
      const concurrent = await testRender(() => <Harness />, { width: 120, height: 30, kittyKeyboard: true })
      try {
        const other = await ready.promise
        while (!other.local.model.ready || other.sync.status === "loading") await Bun.sleep(10)
        other.sync.set("provider", ctx.sync.data.provider)
        next.navigate("parallel-one")
        other.navigate("parallel-two")
        await restarted.renderOnce()
        await concurrent.renderOnce()
        next.local.model.set(base)
        next.local.model.variant.set("low")
        other.local.model.set(draft.parts[0].model)
        other.local.model.variant.set("high")
        for (let count = 0; count < 200; count++) {
          const session = (await Bun.file(`${state}/model.json`).json()).session
          if (session["parallel-one"]?.variant === "low" && session["parallel-two"]?.variant === "high") break
          await Bun.sleep(10)
        }
        expect((await Bun.file(`${state}/model.json`).json()).session).toMatchObject({
          ...saved,
          "parallel-one": { ...base, variant: "low" },
          "parallel-two": { ...draft.parts[0].model, variant: "high" },
        })
        next.local.model.toggleFavorite(base)
        for (let count = 0; count < 100 && !(await Bun.file(`${state}/model.json`).json()).favorite.length; count++)
          await Bun.sleep(10)
        expect((await Bun.file(`${state}/model.json`).json()).session["parallel-two"]).toEqual({
          ...draft.parts[0].model,
          variant: "high",
        })
        await next.local.model.flush()
        await other.local.model.flush()
        // A directory at the destination forces real atomic-rename failures without mocking persistence.
        await rename(`${state}/model.json`, `${state}/model.saved.json`)
        await mkdir(`${state}/model.json`)
        try {
          other.navigate("retry-one")
          await concurrent.renderOnce()
          other.local.model.set(base)
          await concurrent.renderOnce()
          other.local.model.variant.set("low")
          await other.local.model.flush()
        } finally {
          await rm(`${state}/model.json`, { recursive: true })
          await rename(`${state}/model.saved.json`, `${state}/model.json`)
        }
        other.navigate("retry-two")
        await concurrent.renderOnce()
        other.local.model.set(draft.parts[0].model)
        await concurrent.renderOnce()
        other.local.model.variant.set("high")
        await other.local.model.flush()
        expect((await Bun.file(`${state}/model.json`).json()).session).toMatchObject({
          "retry-one": { ...base, variant: "low" },
          "retry-two": { ...draft.parts[0].model, variant: "high" },
        })
        const lock = await Flock.acquire(`tui-model:${state}/model.json`, { dir: `${state}/locks` })
        try {
          other.navigate("shutdown")
          await concurrent.renderOnce()
          other.local.model.set(base)
          await concurrent.renderOnce()
          other.local.model.variant.set("low")
          other.navigate()
          await concurrent.renderOnce()
          other.prompt().set({ input: "create while exiting", parts: [] })
          const sent = submissions.length
          other.prompt().submit()
          for (let count = 0; count < 100 && creations.length < 4; count++) await Bun.sleep(10)
          expect(creations).toHaveLength(4)
          other.local.model.set(draft.parts[0].model)
          await concurrent.renderOnce()
          other.local.model.variant.set("high")
          const flush = flushes.find((flush) => flush === other.local.model.flush)
          expect(flush).toBeDefined()
          concurrent.renderer.destroy()
          const finished = { value: false }
          const shutdown = flush!().then(() => (finished.value = true))
          await Bun.sleep(20)
          expect(finished.value, "shutdown must wait for session initialization").toBe(false)
          shutdownCreationRelease.resolve()
          await Bun.sleep(20)
          expect(finished.value, "shutdown must then wait for the locked model save").toBe(false)
          await lock.release()
          await shutdown
          expect((await Bun.file(`${state}/model.json`).json()).session.shutdown).toEqual({ ...base, variant: "low" })
          expect((await Bun.file(`${state}/model.json`).json()).session["shutdown-created"]).toEqual({
            ...base,
            variant: "low",
          })
          expect(submissions, "a disposed composer must not send after late creation").toHaveLength(sent)
        } finally {
          await lock.release().catch(() => {})
        }
      } finally {
        concurrent.renderer.destroy()
      }
    } finally {
      restarted.renderer.destroy()
    }
    ready = Promise.withResolvers()
    const startup = await testRender(
      () => (
        <Harness
          model="provider/override"
          init={(local, sync) => {
            sync.set("agent", ctx.sync.data.agent)
            sync.set("provider", ctx.sync.data.provider)
            local.model.selectInitial()
          }}
        />
      ),
      { width: 120, height: 30, kittyKeyboard: true },
    )
    try {
      const started = await ready.promise
      while (!started.local.model.ready || started.sync.status === "loading") await Bun.sleep(10)
      started.sync.set("provider", ctx.sync.data.provider)
      expect(started.local.model.current(), "--model overrides the reopened session's saved model").toEqual(
        draft.parts[0].model,
      )
      await started.local.model.flush()
      expect((await Bun.file(`${state}/model.json`).json()).session.one).toEqual({
        ...draft.parts[0].model,
        variant: "high",
      })
      started.navigate("two")
      await startup.renderOnce()
      expect(started.local.model.variant.selected(), "--model does not overwrite other sessions").toBe("default")
      started.navigate("shutdown-created")
      await startup.renderOnce()
      expect(started.local.model.current()).toEqual(base)
      expect(started.local.model.variant.current()).toBe("low")
    } finally {
      startup.renderer.destroy()
    }
  } finally {
    app.renderer.destroy()
  }
})
