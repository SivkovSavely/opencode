/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { newSchedule } from "../../src/schedule/form"
import type { ScheduleAPI } from "../../src/schedule/api"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

async function mountSchedules(root: string, spec = newSchedule().spec) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { DialogProvider, useDialog },
    { SchedulesView },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/component/dialog-schedules"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
  ])
  let item: SessionScheduleV1.Info = {
    ...newSchedule(),
    spec,
    id: "schedule",
    sessionID: SessionID.make("ses_ui_schedule"),
    message: "Original message",
    created: 1,
    anchor: 1,
    status: "active",
    completed: 2,
    limit: 5,
    next: 100,
    summary: "Every 15 minutes",
  }
  const calls: { name: string; input?: unknown }[] = []
  let failPreview = false
  const api: ScheduleAPI = {
    list: async () => [item],
    get: async () => item,
    save: async (_, input) => {
      calls.push({ name: "save", input })
      item = { ...item, ...input }
      return item
    },
    preview: async (_, spec, scheduleID) => {
      calls.push({ name: "preview", input: { spec, scheduleID } })
      if (failPreview) {
        failPreview = false
        throw new Error("Invalid schedule from server")
      }
      return {
        summary: "Server preview",
        times: [Date.parse("2026-03-08T06:30:00Z"), Date.parse("2026-03-08T07:30:00Z")],
      }
    },
    pause: async (_, __, paused) => {
      calls.push({ name: "pause", input: paused })
      item = { ...item, status: paused ? "paused" : "active" }
      return item
    },
    remove: async () => {
      calls.push({ name: "remove" })
      return true
    },
    history: async (_, __, cursor) => {
      calls.push({ name: "history", input: cursor })
      return {
        items: [{ id: "occ", scheduleID: item.id, scheduled: 100, state: "failed", error: "Provider unavailable" }],
        cursor: cursor === undefined ? 10 : undefined,
      }
    },
  }
  function Open() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <SchedulesView sessionID={item.sessionID} api={api} />))
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
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
  const app = await testRender(() => <Harness />, { width: 110, height: 50, kittyKeyboard: true })
  async function frame() {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  async function wait(check: (screen: string) => boolean) {
    const deadline = Date.now() + 3000
    while (true) {
      const screen = await frame()
      if (check(screen)) return screen
      if (Date.now() > deadline) throw new Error(`Timed out waiting for schedule dialog:\n${screen}`)
      await Bun.sleep(5)
    }
  }
  await wait(
    (screen) => screen.includes("2/5 successes") && app.renderer.currentFocusedEditor instanceof InputRenderable,
  )
  return {
    app,
    calls,
    frame,
    wait,
    failPreview: () => {
      failPreview = true
    },
    async choose(text: string) {
      await wait(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
      const previous = app.renderer.currentFocusedEditor
      await app.mockInput.typeText(text)
      await wait((screen) => screen.includes(text))
      app.mockInput.pressEnter()
      return wait(
        (screen) =>
          (app.renderer.currentFocusedEditor !== previous &&
            (app.renderer.currentFocusedEditor instanceof InputRenderable ||
              app.renderer.currentFocusedEditor instanceof TextareaRenderable)) ||
          screen.includes("Invalid schedule from server"),
      )
    },
  }
}

test("schedule dialogs edit, preview, save, pause/resume, paginate errors and confirm deletion", async () => {
  await using tmp = await tmpdir()
  const ui = await mountSchedules(tmp.path)
  try {
    expect(await ui.frame()).toContain("2/5 successes")
    await ui.choose("Original message")
    expect(await ui.choose("Edit")).toContain("Send always")
    await ui.choose("State:")
    expect(await ui.choose("Send when idle")).toContain("[ ] If busy")
    expect(await ui.choose("If busy")).toContain("[x] If busy")
    const preview = await ui.choose("Preview next")
    expect(preview).toContain("Server preview")
    expect(preview).toContain(new Date("2026-03-08T06:30:00Z").toLocaleString())
    expect(preview).not.toContain("Times in ")
    expect(await ui.choose("Confirm and save")).toContain("History and errors")
    expect(ui.calls.filter((call) => call.name === "save")).toHaveLength(1)
    expect(ui.calls.find((call) => call.name === "save")?.input).toMatchObject({
      message: "Original message",
      sessionState: "idle",
      deferUntilIdle: true,
    })
    expect(await ui.choose("Pause")).toContain("Resume")
    expect(await ui.choose("Resume")).toContain("Pause")
    expect(await ui.choose("History and errors")).toContain("Provider unavailable")
    expect(await ui.choose("Next page")).toContain("Previous page")
    await ui.choose("Previous page")
    expect(ui.calls.filter((call) => call.name === "history").map((call) => call.input)).toEqual([
      undefined,
      10,
      undefined,
    ])
    await ui.choose("Back to schedule")
    expect(await ui.choose("Delete")).toContain("Confirm delete")
    expect(ui.calls.filter((call) => call.name === "remove")).toHaveLength(0)
    await ui.choose("Confirm delete")
    expect(ui.calls.filter((call) => call.name === "remove")).toHaveLength(1)
  } finally {
    ui.app.renderer.destroy()
  }
})

test("schedule wizard exposes interval, calendar weekday presets, last-day and advanced cron", async () => {
  await using tmp = await tmpdir()
  const ui = await mountSchedules(tmp.path)
  try {
    expect(await ui.choose("Create schedule")).toContain("Forever")
    await ui.choose("Timing:")
    expect(await ui.choose("Interval")).toContain("Amount: 15")
    expect(await ui.choose("Send immediately")).toContain("[x]")
    await ui.choose("Done")
    await ui.choose("Timing:")
    await ui.choose("Calendar")
    await ui.choose("Rule:")
    await ui.choose("Selected weekdays")
    expect(await ui.choose("Select weekdays")).toContain("Weekends")
    expect(await ui.choose("Weekends")).toContain("[x] Sunday")
    await ui.choose("Done")
    await ui.choose("Rule:")
    expect(await ui.choose("Last day of month")).toContain("last-day")
    await ui.choose("Done")
    await ui.choose("Timing:")
    expect(await ui.choose("Advanced:")).toContain("Every 15 minutes")
    expect(await ui.choose("Weekdays at 09:00")).toContain("0 9 * * 1-5")
  } finally {
    ui.app.renderer.destroy()
  }
})

test("creating a schedule preserves exact text and recovers from server preview errors", async () => {
  await using tmp = await tmpdir()
  const ui = await mountSchedules(tmp.path)
  try {
    await ui.choose("Create schedule")
    await ui.choose("Message:")
    await ui.app.mockInput.typeText("  exact message  ")
    ui.app.mockInput.pressEnter()
    await ui.wait(() => ui.app.renderer.currentFocusedEditor instanceof InputRenderable)
    ui.failPreview()
    expect(await ui.choose("Preview next")).toContain("Invalid schedule from server")
    expect(ui.calls.some((call) => call.name === "save")).toBe(false)
    ui.app.mockInput.pressEnter()
    expect(await ui.wait((screen) => screen.includes("Server preview"))).toContain("Server preview")
    await ui.choose("Confirm and save")
    expect(ui.calls.find((call) => call.name === "save")?.input).toMatchObject({ message: "  exact message  " })
    expect(ui.calls.find((call) => call.name === "preview")?.input).toMatchObject({ scheduleID: undefined })
  } finally {
    ui.app.renderer.destroy()
  }
})

for (const spec of [
  { mode: "calendar", rule: "daily", time: "01:30", timeZone: "America/New_York" },
  { mode: "cron", expression: "30 * * * *", timeZone: "America/New_York" },
] as const) {
  test(`${spec.mode} preview uses the schedule zone across DST`, async () => {
    await using tmp = await tmpdir()
    const ui = await mountSchedules(tmp.path, spec)
    try {
      await ui.choose("Original message")
      await ui.choose("Edit")
      const screen = await ui.choose("Preview next")
      expect(ui.calls.find((call) => call.name === "preview")?.input).toMatchObject({ spec })
      expect(screen).toContain("Times in America/New_York")
      expect(screen).toContain("3/8/2026, 1:30:00 AM")
      expect(screen).toContain("3/8/2026, 3:30:00 AM")
    } finally {
      ui.app.renderer.destroy()
    }
  })
}
