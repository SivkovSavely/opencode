import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  assistantMessage,
  project,
  session,
  sessionID,
  title,
  userMessage,
} from "../performance/timeline-stability/fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { dict } from "../../src/i18n/ar"

const directory = "/home/user/dcp-project"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const summary = `<script>window.dcpExecuted = true</script>\n\u0645\u0631\u062d\u0628\u0627 **plain text**\n${"complete summary ".repeat(700)}END`

for (const newLayoutDesigns of [false, true]) {
  for (const mobile of [false, true]) {
    for (const direction of ["ltr", "rtl"]) {
      test(`DCP context is read-only and complete (layout ${newLayoutDesigns}, mobile ${mobile}, ${direction})`, async ({
        page,
      }) => {
        await setup(page, { newLayoutDesigns, mobile })
        await page.evaluate((direction) => document.documentElement.setAttribute("dir", direction), direction)
        const response = page.waitForResponse((value) => new URL(value.url()).pathname === `/session/${sessionID}/dcp`)
        await openContext(page, mobile)
        await response
        const dcp = page.getByRole("region", { name: "DCP", exact: true })
        await expect(dcp.getByRole("heading", { name: "Active blocks", exact: true })).toBeVisible()
        await expect(dcp.getByText("Historical gross removed tokens", { exact: true })).toBeVisible()
        await expect(dcp.getByText("+30", { exact: true })).toBeVisible()
        await expect(dcp.getByText("-4", { exact: true })).toBeVisible()
        await expect(dcp.getByText("User-decompressed", { exact: true })).toBeVisible()
        await expect(dcp.locator("pre")).toHaveCount(0)
        const block = dcp.locator("summary").filter({ hasText: "Full \u0645\u062d\u0641\u0648\u0638 summary" })
        await block.focus()
        await block.press("Enter")
        await expect(dcp.locator("pre")).toHaveText(summary)
        await expect(dcp.locator("script")).toHaveCount(0)
        expect(await page.evaluate(() => Reflect.get(window, "dcpExecuted"))).toBeUndefined()
        expect(await dcp.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        await expect(page.getByText("Raw messages", { exact: true })).toBeVisible()
        await expect(page.getByText("Context Limit", { exact: true })).toBeVisible()
      })
    }
  }

  test(`Context metrics and raw messages still work without DCP (layout ${newLayoutDesigns})`, async ({ page }) => {
    await setup(page, { newLayoutDesigns, absent: true })
    await openContext(page, false)
    const dcp = page.getByRole("region", { name: "DCP", exact: true })
    await expect(
      dcp.getByText("No saved DCP state for this session. DCP may not be installed or has not saved a snapshot yet.", {
        exact: true,
      }),
    ).toBeVisible()
    await expect(page.getByText("Context Limit", { exact: true })).toBeVisible()
    await expect(page.getByText("Raw messages", { exact: true })).toBeVisible()
    const message = page.getByRole("button").filter({ hasText: "msg_1000_timeline_user" })
    await message.click()
    await expect(page.getByText('"role": "user"', { exact: false })).toBeVisible()
  })
}

test("Arabic Context uses the documented DCP fallback and isolates mixed text", async ({ page }) => {
  await setup(page, { newLayoutDesigns: true, mobile: true, locale: "ar" })
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  await page.getByRole("tab", { name: dict["session.tab.context"], exact: true }).click()
  const dcp = page.getByRole("region", { name: "DCP", exact: true })
  const topic = dcp.locator("summary bdi")
  await expect(topic.filter({ hasText: "Full \u0645\u062d\u0641\u0648\u0638 summary" })).toHaveAttribute("dir", "auto")
  await expect(dcp.getByRole("heading", { name: "Active blocks", exact: true })).toBeVisible()
})

test("DCP polls only with visible Context and leaves the conversation DOM intact", async ({ page }) => {
  const now = new Date()
  await page.clock.install({ time: now })
  let reads = 0
  await setup(page, { newLayoutDesigns: true, read: () => ++reads })
  await page.clock.pauseAt(new Date(now.valueOf() + 60_000))
  expect(reads).toBe(0)
  await openContext(page, false)
  const dcp = page.getByRole("region", { name: "DCP", exact: true })
  await expect(dcp.getByText("901", { exact: true })).toBeVisible()
  await expect(dcp.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const root = document.querySelector("[data-timeline-virtual-content]")
    if (!root) throw new Error("Missing conversation timeline")
    Reflect.set(window, "dcpTimelineRoot", root)
    Reflect.set(window, "dcpTimelineChanges", 0)
    new MutationObserver(() =>
      Reflect.set(window, "dcpTimelineChanges", Number(Reflect.get(window, "dcpTimelineChanges")) + 1),
    ).observe(root, { childList: true, subtree: true, characterData: true })
  })
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === `/session/${sessionID}/dcp`)
  await page.clock.runFor(10_000)
  await response
  await expect(dcp.getByText("902", { exact: true })).toBeVisible()
  expect(reads).toBe(2)
  expect(
    await page.evaluate(
      () => document.querySelector("[data-timeline-virtual-content]") === Reflect.get(window, "dcpTimelineRoot"),
    ),
  ).toBe(true)
  expect(await page.evaluate(() => Reflect.get(window, "dcpTimelineChanges"))).toBe(0)
  await page.getByRole("button", { name: "View context usage", exact: true }).click()
  await expect(dcp).toHaveCount(0)
  await page.clock.runFor(30_000)
  expect(reads).toBe(2)
  await openContext(page, false)
  await expect(dcp.getByText("903", { exact: true })).toBeVisible()
})

async function openContext(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("tab", { name: "Context", exact: true }).click()
    return
  }
  await page.getByRole("button", { name: "View context usage", exact: true }).click()
}

async function setup(
  page: Page,
  input: { newLayoutDesigns: boolean; mobile?: boolean; absent?: boolean; read?: () => number; locale?: string },
) {
  await page.setViewportSize(input.mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 })
  await installSseTransport(page, { server })
  await mockOpenCodeServer(page, {
    directory,
    project: { ...project(), worktree: directory },
    provider: { all: [], connected: [], default: {} },
    sessions: [session({ directory })],
    sessionStatus: { [sessionID]: { type: "idle" } },
    pageMessages: () => ({ items: [userMessage(), assistantMessage()] }),
  })
  await page.route(/\/api\/(health|location|model\/default)(?:\?|$)/, (route) => route.fulfill({ status: 404 }))
  await page.route("**/global/projects", (route) => route.fulfill({ json: [{ ...project(), worktree: directory }] }))
  await page.route(`**/session/${sessionID}/dcp*`, (route) =>
    route.fulfill({
      json: input.absent
        ? { sessionID, state: "absent" }
        : {
            sessionID,
            state: "available",
            lastUpdated: "2026-11-19T12:00:00.000Z",
            stats: { activeSummaryTokens: 21, historicalRemovedTokens: 900 + (input.read?.() ?? 0) },
            blocks: [
              {
                blockId: 1,
                status: "active",
                active: true,
                topic: "Full \u0645\u062d\u0641\u0648\u0638 summary",
                summary,
                summaryTokens: 21,
              },
              { blockId: 2, status: "user-decompressed", active: false, topic: "Restored block" },
            ],
            operations: [
              { id: 1, type: "compress", topic: "Positive operation", savings: { before: 40, after: 10, saved: 30 } },
              { id: 2, type: "recompress", topic: "Negative operation", savings: { before: 10, after: 14, saved: -4 } },
              { id: 3, type: "user-decompress", blockIds: [2] },
            ],
          },
    }),
  )
  await page.addInitScript(
    ({ newLayoutDesigns, server, sessionID, locale }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns, shouldDisplayTabsToast: false } }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
      if (!newLayoutDesigns) localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
      if (locale) localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale }))
    },
    { newLayoutDesigns: input.newLayoutDesigns, server, sessionID, locale: input.locale },
  )
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible()
}
