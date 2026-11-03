import { afterEach, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import type { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"

// Bun's JSX transform is not Solid's DOM compiler. Compile the actual components
// with the same preset used by vite-plugin-solid, without replacing their logic.
const require = createRequire(import.meta.resolve("vite-plugin-solid"))
const babel = require("@babel/core")
plugin({
  name: "schedule-solid-dom",
  setup(build) {
    build.onResolve({ filter: /\?worker&url$/ }, ({ path }) => ({ path, namespace: "worker-url" }))
    build.onLoad({ filter: /.*/, namespace: "worker-url" }, () => ({
      contents: 'export default "data:text/javascript,"',
      loader: "js",
    }))
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (
        await babel.transformAsync(await Bun.file(path).text(), {
          filename: path,
          presets: [[require.resolve("babel-preset-solid"), { generate: "dom" }]],
          parserOpts: { plugins: ["typescript", "jsx"] },
        })
      ).code.replace(/(["'])@\/context\/(?:sdk|server-sdk)\1/g, (match: string) =>
        path.endsWith("/dialog-session-schedule.tsx") ? JSON.stringify(import.meta.path) : match,
      ),
      loader: "tsx",
    }))
  },
})

const { LanguageProvider } = await import("../src/context/language")
const { PlatformProvider } = await import("../src/context/platform")
const { SessionScheduleEditor } = await import("../src/components/session-schedule-editor")
const { UserMessageDisplay } = await import("../../session-ui/src/components/message-part")
const { DataProvider } = await import("../../session-ui/src/context/data")
const { DialogProvider } = await import("@opencode-ai/ui/context/dialog")
const { Dialog: KobalteDialog } = await import("@kobalte/core/dialog")
const scheduleTransport: { client?: unknown } = {}
export const useSDK = () => () => ({ directory: "/tmp" })
export const useServerSDK = () => () => ({ client: scheduleTransport.client })
const { DialogSessionSchedule } = await import("../src/components/dialog-session-schedule")

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))

function mount(component: () => ReturnType<typeof createComponent>) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(component, host)
  cleanup.push(() => {
    dispose()
    host.remove()
  })
  return host
}

function control<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  host: HTMLElement,
  text: string,
) {
  const label = [...host.querySelectorAll("label")].find(
    (label) =>
      [...label.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join("") === text,
  )
  return label?.querySelector("input,select,textarea") as T | undefined
}

function change(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined, value: string) {
  expect(input).toBeDefined()
  input!.value = value
  input!.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }))
}

function editor(
  preview: (spec: SessionScheduleV1.Spec) => Promise<SessionScheduleV1.Preview>,
  save = async (_: SessionScheduleV1.Input) => {},
) {
  return mount(() =>
    createComponent(PlatformProvider, {
      value: { platform: "web", openExternal() {}, async restart() {}, async notify() {} },
      get children() {
        return createComponent(LanguageProvider, {
          locale: "en",
          get children() {
            return createComponent(SessionScheduleEditor, { preview, onSave: save, onCancel() {} })
          },
        })
      },
    }),
  )
}

test("an older list response cannot overwrite a paused schedule", async () => {
  const active = {
    id: "schedule_1",
    sessionID: "ses_schedule",
    created: 1,
    anchor: 1,
    status: "active",
    completed: 0,
    summary: "Every 15 minutes",
    message: "Hello",
    spec: { mode: "interval", amount: 15, unit: "minutes", immediate: false },
    sessionState: "always",
    deferUntilIdle: false,
    missed: "latest",
  }
  const paused = { ...active, status: "paused" }
  const old = Promise.withResolvers<{ data: unknown }>()
  const latest = Promise.withResolvers<{ data: unknown }>()
  const calls: string[] = []
  scheduleTransport.client = {
    client: {
      get: () => {
        calls.push("list")
        if (calls.length === 1) return Promise.resolve({ data: [active] })
        return calls.length === 2 ? old.promise : latest.promise
      },
      post: () => Promise.resolve({ data: paused }),
    },
  }
  const host = mount(() =>
    createComponent(PlatformProvider, {
      value: { platform: "web", openExternal() {}, async restart() {}, async notify() {} },
      get children() {
        return createComponent(LanguageProvider, {
          locale: "en",
          get children() {
            return createComponent(KobalteDialog, {
              open: true,
              get children() {
                return createComponent(DialogSessionSchedule, { sessionID: "ses_schedule" })
              },
            })
          },
        })
      },
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === text)!
  expect(host.textContent).toContain("Active")
  button("Refresh").click()
  button("Pause").click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toHaveLength(3)
  latest.resolve({ data: [paused] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toContain("Paused")
  expect(button("Resume")).toBeDefined()
  old.resolve({ data: [active] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toContain("Paused")
  expect(button("Resume")).toBeDefined()
  expect(host.textContent).not.toContain("Active")
})

test("actual picker defaults, calendar controls, idle-only deferral and success limit", () => {
  const host = editor(async () => ({ summary: "Every 15 minutes", times: [] }))
  expect(control<HTMLInputElement>(host, "Every")?.value).toBe("15")
  expect(control<HTMLSelectElement>(host, "Unit")?.value).toBe("minutes")
  expect(control<HTMLInputElement>(host, "Send the first message immediately")?.checked).toBe(false)
  expect(control<HTMLSelectElement>(host, "Send when")?.options.length).toBe(3)
  expect(control(host, "Wait until idle instead of skipping a busy occurrence")).toBeUndefined()
  change(control(host, "Send when"), "idle")
  expect(control(host, "Wait until idle instead of skipping a busy occurrence")).toBeDefined()
  change(control(host, "Send when"), "busy")
  expect(control(host, "Wait until idle instead of skipping a busy occurrence")).toBeUndefined()
  change(control(host, "Repeat"), "calendar")
  expect(control(host, "Time")).toBeDefined()
  expect(control<HTMLInputElement>(host, "IANA time zone")?.value).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
  change(control(host, "Calendar rule"), "weekly")
  const weekends = [...host.querySelectorAll("button")].find((button) => button.textContent === "Weekends")!
  weekends.click()
  expect(control<HTMLInputElement>(host, "Sun")?.checked).toBe(true)
  expect(control<HTMLInputElement>(host, "Mon")?.checked).toBe(false)
  expect(control<HTMLInputElement>(host, "Sat")?.checked).toBe(true)
  change(control(host, "Calendar rule"), "monthly")
  expect(control<HTMLSelectElement>(host, "Day of month")?.options.length).toBe(31)
  change(control(host, "Calendar rule"), "last-day")
  expect(control(host, "Day of month")).toBeUndefined()
  change(control(host, "Stop after"), "limited")
  expect(control(host, "Successful send limit")).toBeDefined()
})

test("server preview errors block saving and corrected cron preserves exact message", async () => {
  const saved: SessionScheduleV1.Input[] = []
  const calls: SessionScheduleV1.Spec[] = []
  const host = editor(
    async (spec) => {
      calls.push(spec)
      if (spec.mode === "cron" && spec.expression === "invalid") throw new Error("Invalid cron expression")
      return { summary: "Server summary", times: [1, 2, 3, 4, 5] }
    },
    async (input) => {
      saved.push(input)
    },
  )
  change(control(host, "Repeat"), "cron")
  change(control(host, "Cron expression"), "invalid")
  change(control(host, "Message (sent exactly as written)"), "  exact\nmessage  ")
  change(control(host, "Send when"), "idle")
  control<HTMLInputElement>(host, "Wait until idle instead of skipping a busy occurrence")!.click()
  change(control(host, "Send when"), "busy")
  await new Promise((resolve) => setTimeout(resolve, 350))
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Invalid cron expression")
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  change(control(host, "Cron expression"), "0 9 * * *")
  await new Promise((resolve) => setTimeout(resolve, 350))
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('[data-slot="schedule-summary"]')?.textContent).toBe("Server summary")
  expect(host.querySelectorAll("ol time").length).toBe(5)
  host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
  await Promise.resolve()
  expect(saved[0]?.message).toBe("  exact\nmessage  ")
  expect(saved[0]?.deferUntilIdle).toBe(false)
  expect(saved[0]?.sessionState).toBe("busy")
  expect(calls.at(-1)?.mode).toBe("cron")
})

test("default delayed interval is previewed and stale server replies cannot overwrite edits", async () => {
  const first = Promise.withResolvers<SessionScheduleV1.Preview>()
  const calls: SessionScheduleV1.Spec[] = []
  const host = editor(async (spec) => {
    calls.push(spec)
    if (calls.length === 1) return first.promise
    return { summary: "Current interval", times: [1, 2, 3, 4, 5] }
  })
  await new Promise((resolve) => setTimeout(resolve, 350))
  expect(calls[0]).toEqual({ mode: "interval", amount: 15, unit: "minutes", immediate: false })
  change(control(host, "Every"), "30")
  await new Promise((resolve) => setTimeout(resolve, 350))
  first.resolve({ summary: "Stale interval", times: [6] })
  await Promise.resolve()
  expect(host.querySelector('[data-slot="schedule-summary"]')?.textContent).toBe("Current interval")
  expect(host.querySelectorAll("ol time").length).toBe(5)
})

for (const useV2Actions of [false, true]) {
  test(`scheduled origin is after timestamp, before Revert, outside body (v2=${useV2Actions})`, () => {
    const message = {
      id: "msg_schedule",
      sessionID: "ses_schedule",
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      origin: { type: "scheduled", scheduleID: "schedule_1", occurrenceID: "occurrence_1" },
    }
    const host = mount(() =>
      createComponent(DialogProvider, {
        get children() {
          return createComponent(DataProvider, {
            directory: "/tmp",
            data: { session: [], session_status: {}, session_diff: {}, message: {}, part: {} },
            get children() {
              return createComponent(UserMessageDisplay, {
                message,
                parts: [],
                useV2Actions,
                scheduledLabel: "Scheduled",
                actions: { revert() {} },
              })
            },
          })
        },
      }),
    )
    const timestamp = host.querySelector('[data-slot="user-message-meta-tail"]')!
    const indicator = host.querySelector('[data-slot="user-message-scheduled"]')!
    const revert = host.querySelector('[aria-label="Revert message"]')!
    expect(indicator?.textContent).toBe("Scheduled")
    expect(indicator?.previousElementSibling).toBe(timestamp)
    expect(indicator?.compareDocumentPosition(revert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(host.querySelector('[data-slot="user-message-body"]')).toBeNull()
  })
}

test("ordinary messages do not acquire a scheduled indicator", () => {
  const host = mount(() =>
    createComponent(DialogProvider, {
      get children() {
        return createComponent(DataProvider, {
          directory: "/tmp",
          data: { session: [], session_status: {}, session_diff: {}, message: {}, part: {} },
          get children() {
            return createComponent(UserMessageDisplay, {
              message: {
                id: "msg_plain",
                sessionID: "ses_plain",
                role: "user",
                time: { created: 1 },
                agent: "build",
                model: { providerID: "test", modelID: "test" },
              },
              parts: [],
              scheduledLabel: "Scheduled",
            })
          },
        })
      },
    }),
  )
  expect(host.querySelector('[data-slot="user-message-scheduled"]')).toBeNull()
})
