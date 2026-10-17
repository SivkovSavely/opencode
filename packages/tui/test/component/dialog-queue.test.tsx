/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { createQueueController } from "../../src/queue/controller"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

async function mountQueue(root: string, info = false) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { DialogProvider, useDialog },
    { QueueView },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/component/dialog-queue"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
  ])
  const sessionID = SessionID.make("ses_ui_queue")
  const payload = {
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
    variant: "high",
    kind: "prompt" as const,
    parts: [
      { type: "text" as const, text: "original preview" },
      { type: "file" as const, mime: "image/png", filename: "image.png", url: "file:///image.png" },
    ],
  }
  let server: SessionQueueV1.Snapshot = {
    sessionID,
    revision: 1,
    paused: true,
    blocked: false,
    items: [
      { id: "steer", sessionID, delivery: "steer", state: "pending", position: 0, created: 0, payload },
      {
        id: "queue",
        sessionID,
        delivery: "queue",
        state: "pending",
        position: 0,
        created: 0,
        payload: { ...payload, kind: "shell", command: "echo queued" },
      },
      {
        id: "claim",
        sessionID,
        delivery: "queue",
        state: "claimed",
        position: 1,
        created: 0,
        payload: { ...payload, kind: "compact" },
      },
    ],
  }
  const mutations: SessionQueueV1.Mutation[] = []
  const queue = createQueueController({
    list: async () => server,
    submit: async () => server,
    update: async (_, input) => {
      mutations.push(input.mutation)
      if (input.mutation.action === "pause")
        server = { ...server, revision: server.revision + 1, paused: input.mutation.paused }
      return server
    },
    flush: async () => server,
  })
  let closed = 0
  function Open() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(
        () => <QueueView sessionID={sessionID} queue={queue} info={info} />,
        () => {
          closed++
        },
      ),
    )
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Open />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 110, height: 40, kittyKeyboard: true })
  const started = Date.now()
  while (!queue.data.snapshots[sessionID] || queue.data.loading[sessionID]) {
    if (Date.now() - started > 2000) {
      app.renderer.destroy()
      throw new Error("queue dialog did not load")
    }
    await Bun.sleep(5)
  }
  await app.renderOnce()
  return {
    app,
    queue,
    mutations,
    closed: () => closed,
    sessionID,
    async frame() {
      await app.renderOnce()
      return app.captureCharFrame()
    },
  }
}

test("queue dialog renders pending-only count, groups, attachments, captured mode, and immutable claims", async () => {
  await using tmp = await tmpdir()
  const ui = await mountQueue(tmp.path)
  try {
    const frame = await ui.frame()
    expect(frame).toContain("Queue (1) PAUSED")
    expect(frame).toContain("Automatic queued delivery is paused. Steering remains active.")
    expect(frame.indexOf("Steering")).toBeLessThan(frame.indexOf("Queued"))
    expect(frame).toContain("original preview [image.png]")
    expect(frame).toContain("provider/model (high)")
    expect(frame).toContain("!echo queued")
    expect(frame).toContain("claimed (read-only)")
    ui.app.mockInput.pressKey("p")
    await ui.frame()
    expect(ui.mutations).toEqual([{ action: "pause", paused: false }])
    expect(await ui.frame()).toContain("Queue (1) RUNNING")
    expect(await ui.frame()).toContain("Automatic queued delivery is enabled.")
  } finally {
    ui.app.renderer.destroy()
  }
})

test("delete shows original preview; Escape cancels without closing, and other action keys do not execute", async () => {
  await using tmp = await tmpdir()
  const ui = await mountQueue(tmp.path)
  try {
    ui.app.mockInput.pressKey("DELETE")
    const deleting = await ui.frame()
    expect(deleting).toContain("Delete? [Y/any key cancels] original preview [image.png]")
    ui.app.mockInput.pressEscape()
    expect(await ui.frame()).not.toContain("Delete?")
    expect(ui.closed()).toBe(0)
    ui.app.mockInput.pressKey("DELETE")
    ui.app.mockInput.pressKey("p")
    await ui.frame()
    expect(ui.mutations).toEqual([])
    ui.app.mockInput.pressKey("DELETE")
    ui.app.mockInput.pressKey("y")
    await ui.frame()
    expect(ui.mutations).toEqual([{ action: "delete", id: "steer" }])
  } finally {
    ui.app.renderer.destroy()
  }
})

test("queue list is informational rather than management", async () => {
  await using tmp = await tmpdir()
  const ui = await mountQueue(tmp.path, true)
  try {
    expect(await ui.frame()).toContain("Use /queues to manage")
    ui.app.mockInput.pressKey("p")
    ui.app.mockInput.pressKey("DELETE")
    await ui.frame()
    expect(ui.mutations).toEqual([])
    expect(await ui.frame()).not.toContain("Delete?")
  } finally {
    ui.app.renderer.destroy()
  }
})
