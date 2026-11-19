import { afterEach, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { createSdkForServer } from "../src/utils/server"

const require = createRequire(import.meta.resolve("vite-plugin-solid"))
const babel = require("@babel/core")
plugin({
  name: "dcp-solid-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (
        await babel.transformAsync(await Bun.file(path).text(), {
          filename: path,
          presets: [[require.resolve("babel-preset-solid"), { generate: "dom" }]],
          parserOpts: { plugins: ["typescript", "jsx"] },
        })
      ).code.replace(/(["'])@\/context\/sdk\1/g, (match: string) =>
        path.endsWith("/session-dcp-section.tsx") ? JSON.stringify(import.meta.path) : match,
      ),
      loader: "tsx",
    }))
  },
})

const { LanguageProvider } = await import("../src/context/language")
const { PlatformProvider } = await import("../src/context/platform")
const transport: { body?: unknown; status?: number; requests: number } = { requests: 0 }
const sdk = {
  scope: "test-server",
  directory: "/project",
  client: createSdkForServer({
    server: { url: "https://selected.example" },
    fetch: Object.assign(
      async () => {
        transport.requests++
        return Response.json(transport.body, { status: transport.status ?? 200 })
      },
      {
        preconnect: fetch.preconnect,
      },
    ),
  }),
}
export const useSDK = () => () => sdk
const { SessionDcpSection } = await import("../src/components/session/session-dcp-section")
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function mount() {
  const host = document.createElement("div")
  host.dir = "rtl"
  document.body.append(host)
  const [state, setState] = createStore({ id: "ses_one" })
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: { platform: "web", openExternal() {}, async restart() {}, async notify() {} },
        get children() {
          return createComponent(LanguageProvider, {
            locale: "en",
            get children() {
              return createComponent(SessionDcpSection, {
                get sessionID() {
                  return state.id
                },
              })
            },
          })
        },
      }),
    host,
  )
  cleanup.push(() => {
    dispose()
    host.remove()
  })
  return { host, setState }
}

test("renders safe expandable full summaries, signed savings, statuses and unknown legacy metrics", async () => {
  const summary = '<script>alert("unsafe")</script> **not markdown**\n' + "full summary ".repeat(1000)
  transport.status = 200
  transport.body = {
    sessionID: "ses_one",
    state: "available",
    stats: { historicalRemovedTokens: 123 },
    blocks: ["active", "pruned", "nested", "superseded", "user-decompressed"].map((status, i) => ({
      blockId: i + 1,
      status,
      topic: "mixed topic",
      summary,
      startId: "msg_start",
      endId: "msg_end",
      parentBlockIds: [6],
    })),
    operations: [
      { id: 1, type: "recompress", savings: { before: 10, after: 14, saved: -4 } },
      { id: 2, type: "prune", savings: { before: 14, after: 10, saved: 4 } },
    ],
  }
  const { host } = mount()
  await tick()
  expect(transport.requests).toBeGreaterThan(0)
  expect(host.textContent).toContain("Historical gross removed tokens")
  expect(host.textContent).toContain("Unrecorded")
  expect(host.textContent).toContain("User-decompressed")
  expect(host.textContent).toContain("Superseded")
  expect(host.textContent).toContain("-4")
  expect(host.textContent).toContain("+4")
  expect(host.querySelector("pre")).toBeNull()
  const detail = host.querySelector("details")!
  detail.open = true
  detail.dispatchEvent(new Event("toggle"))
  expect(host.querySelector("pre")?.textContent).toBe(summary)
  expect(host.querySelector("script")).toBeNull()
  expect(host.querySelector("pre")?.getAttribute("dir")).toBe("auto")
  expect(host.textContent).toContain("msg_start")
  expect(host.textContent).toContain("msg_end")
})

test("distinguishes absent, malformed, oversized and network-error states and clears on switch", async () => {
  transport.status = 200
  transport.body = { sessionID: "ses_one", state: "absent" }
  const { host, setState } = mount()
  await tick()
  expect(host.textContent).toContain("No saved DCP state")
  transport.body = { sessionID: "ses_two", state: "too-large" }
  setState("id", "ses_two")
  expect(host.textContent).not.toContain("No saved DCP state")
  await tick()
  expect(host.textContent).toContain("8 MiB")
  transport.body = { sessionID: "ses_three", state: "invalid" }
  setState("id", "ses_three")
  await tick()
  expect(host.textContent).toContain("invalid")
  transport.status = 403
  setState("id", "ses_four")
  await tick()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load DCP")
  expect(host.querySelector("button")?.textContent).toContain("Refresh")
})
