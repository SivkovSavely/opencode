import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const server = "http://127.0.0.1:4096"
const directory = "C:/tab-width-project"
const project = {
  id: "project-tab-width",
  worktree: directory,
  vcs: "git",
  time: { created: 1, updated: 1 },
  sandboxes: [],
}
const titles = [
  "A very long session title that should have enough room to be fully visible",
  "A medium length session title",
  "Short",
]

async function open(page: Page, names: string[], width = 1600) {
  const sessions = names.map((title, index) => ({
    id: `ses_width_${index}`,
    slug: `width-${index}`,
    projectID: project.id,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }))
  await page.setViewportSize({ width, height: 800 })
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions,
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    pageMessages: () => ({ items: [] }),
  })
  await page.route(/\/api\/(location|model\/default)$/, (route) =>
    route.fulfill({ status: 404, json: {}, headers: { "access-control-allow-origin": "*" } }),
  )
  await page.route(/\/(?:api\/)?session\/[^/]+(?:\/rename)?(?:\?.*)?$/, async (route) => {
    if (!["PATCH", "POST"].includes(route.request().method())) return route.fallback()
    const session = sessions.find((item) => new URL(route.request().url()).pathname.split("/").includes(item.id))
    const body = route.request().postDataJSON() as { title: string }
    if (!session) throw new Error("Unknown session")
    session.title = body.title
    if (route.request().method() === "POST")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    await route.fulfill({ json: session, headers: { "access-control-allow-origin": "*" } })
  })
  await page.addInitScript(
    ({ server, directory, sessions }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: true, shouldDisplayTabsToast: false } }),
      )
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", JSON.stringify(server))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [server],
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(sessions.map((session) => ({ type: "session", server, sessionId: session.id }))),
      )
    },
    { server, directory, sessions },
  )
  await page.goto(`/server/${base64Encode(server)}/session/${sessions[0].id}`)
  await expect(page.locator("[data-titlebar-tab-slot]:visible")).toHaveCount(names.length)
  for (const session of sessions)
    await expect(tab(page, session.id).locator("[data-titlebar-tab-title]")).toHaveText(session.title)
}

function tab(page: Page, id: string) {
  return page
    .locator("[data-titlebar-tab-slot]:not([inert])")
    .filter({ has: page.locator(`a[data-titlebar-tab-link][href$="/session/${id}"]`) })
}

async function width(page: Page, id: string) {
  return tab(page, id).evaluate((element) => element.getBoundingClientRect().width)
}

for (const direction of ["ltr", "rtl"]) {
  test(`fits content and clears the close control in ${direction}`, async ({ page }) => {
    await open(page, [...titles, "A"])
    await page.getByRole("banner").evaluate((element, direction) => element.setAttribute("dir", direction), direction)
    await expect.poll(() => width(page, "ses_width_0")).toBeGreaterThan(224)
    await expect.poll(() => width(page, "ses_width_2")).toBeLessThan(150)
    for (const id of ["ses_width_0", "ses_width_1", "ses_width_2", "ses_width_3"]) {
      const slot = tab(page, id)
      await slot.hover()
      await expect(slot.locator("[data-titlebar-tab-title]")).toBeVisible()
      await expect
        .poll(() =>
          slot.evaluate((element) => {
            const title = element.querySelector<HTMLElement>("[data-titlebar-tab-title]")!
            const close = element.querySelector<HTMLElement>('[data-slot="tab-close"]')!
            const range = document.createRange()
            range.selectNodeContents(title)
            const text = range.getBoundingClientRect()
            const box = title.getBoundingClientRect()
            const button = close.getBoundingClientRect()
            return Math.abs(text.width - box.width) < 1 && (text.right <= button.left || text.left >= button.right)
          }),
        )
        .toBe(true)
    }
  })
}

test("a single long tab grows past the old cap and responds to fonts, scaling, and neighboring controls", async ({
  page,
}) => {
  await open(page, [titles[0]])
  await expect.poll(() => width(page, "ses_width_0")).toBeGreaterThan(224)
  const original = await width(page, "ses_width_0")
  const font = await page.addStyleTag({ content: "[data-titlebar-tab-link] { font: 18px monospace !important; }" })
  await expect.poll(() => width(page, "ses_width_0")).toBeGreaterThan(original + 50)
  await font.evaluate((element) => element.remove())
  await expect.poll(() => width(page, "ses_width_0")).toBeCloseTo(original, 0)
  await page.locator("html").evaluate((element) => (element.style.fontSize = "20px"))
  await expect.poll(() => width(page, "ses_width_0")).toBeGreaterThan(original + 5)
  await page.locator("html").evaluate((element) => element.style.removeProperty("font-size"))
  await expect.poll(() => width(page, "ses_width_0")).toBeCloseTo(original, 0)
  const chrome = await page.addStyleTag({
    content: "[data-titlebar-tab] { --tab-icon-size: 24px; --tab-gap: 10px; --tab-padding: 8px; }",
  })
  await expect.poll(() => width(page, "ses_width_0")).toBeCloseTo(original + 18, 0)
  await chrome.evaluate((element) => element.remove())
  await expect.poll(() => width(page, "ses_width_0")).toBeCloseTo(original, 0)
  const search = page.getByRole("banner").getByRole("button", { name: "Search transcripts", exact: true })
  await search.evaluate((element) => (element.style.width = "1100px"))
  await expect.poll(() => width(page, "ses_width_0")).toBeLessThan(original - 20)
  await search.evaluate((element) => element.style.removeProperty("width"))
  await expect.poll(() => width(page, "ses_width_0")).toBeCloseTo(original, 0)
})

test("shrinks the longest tabs first and restores them when space returns", async ({ page }) => {
  await open(page, [titles[0], titles[0], titles[1], titles[2]], 1600)
  await expect.poll(() => width(page, "ses_width_0")).toBeGreaterThan(224)
  const before = await Promise.all([0, 1, 2, 3].map((i) => width(page, `ses_width_${i}`)))
  await page.setViewportSize({ width: 1150, height: 800 })
  await expect.poll(() => width(page, "ses_width_0")).toBeLessThan(before[0] - 10)
  await expect
    .poll(async () => Math.abs((await width(page, "ses_width_0")) - (await width(page, "ses_width_1"))))
    .toBeLessThan(2)
  await expect.poll(async () => Math.abs((await width(page, "ses_width_2")) - before[2])).toBeLessThan(2)
  await expect.poll(async () => Math.abs((await width(page, "ses_width_3")) - before[3])).toBeLessThan(2)
  await expect(tab(page, "ses_width_0").locator("[data-titlebar-tab]")).toHaveAttribute("data-title-overflow", "true")
  await expect(tab(page, "ses_width_0").locator("[data-titlebar-tab-link]")).toHaveCSS("mask-image", /linear-gradient/)
  await tab(page, "ses_width_0").locator("[data-titlebar-tab-title]").dblclick()
  const editor = tab(page, "ses_width_0").locator('[contenteditable="true"]')
  await expect(editor).toBeFocused()
  await editor.fill("A")
  const editingWidth = await width(page, "ses_width_0")
  await page.setViewportSize({ width: 1100, height: 800 })
  await expect.poll(() => width(page, "ses_width_0")).toBeLessThan(editingWidth - 5)
  await editor.press("Escape")
  await expect(tab(page, "ses_width_0").locator("[data-titlebar-tab-title]")).toHaveText(titles[0])
  await expect(tab(page, "ses_width_0").locator("[data-titlebar-tab]")).toHaveAttribute("data-title-overflow", "true")
  await page.setViewportSize({ width: 1600, height: 800 })
  await expect.poll(async () => Math.abs((await width(page, "ses_width_0")) - before[0])).toBeLessThan(2)
  await expect(tab(page, "ses_width_0").locator("[data-titlebar-tab]")).toHaveAttribute("data-title-overflow", "false")
})

test("recalculates after rename and close without disrupting the inline editor", async ({ page }) => {
  await open(page, titles, 1200)
  const slot = tab(page, "ses_width_1")
  const original = await width(page, "ses_width_1")
  await slot.locator("[data-titlebar-tab-title]").dblclick()
  const editor = slot.locator('[data-titlebar-tab-title][contenteditable="true"]')
  await expect(editor).toBeFocused()
  await editor.fill("A considerably longer title typed into the inline session editor")
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText("A considerably longer title typed into the inline session editor")
  expect(await width(page, "ses_width_1")).toBeCloseTo(original, 0)
  await editor.press("Enter")
  await expect(slot.locator("[data-titlebar-tab-title]")).toHaveText(
    "A considerably longer title typed into the inline session editor",
  )
  await expect.poll(() => width(page, "ses_width_1")).toBeGreaterThan(original + 10)
  const before = await width(page, "ses_width_1")
  await tab(page, "ses_width_0").locator("[data-titlebar-tab-link]").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Close tab", exact: true }).click()
  await expect(tab(page, "ses_width_0")).toHaveCount(0)
  await expect.poll(() => width(page, "ses_width_1")).toBeGreaterThan(before)
  await page.keyboard.press("Control+Shift+t")
  await expect(tab(page, "ses_width_0")).toBeVisible()
  await expect.poll(() => width(page, "ses_width_1")).toBeCloseTo(before, 0)
  await page.getByRole("banner").getByRole("button", { name: "New session", exact: true }).click()
  const draft = page.locator('[data-titlebar-tab-slot][data-tab-key^="draft:"]')
  await expect(draft.locator("[data-titlebar-tab-title]")).toHaveText("New session")
  await expect.poll(() => draft.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(180)
  await draft.getByRole("button", { name: "Close tab", exact: true }).click()
  await expect(draft).toHaveCount(0)
})

test("keeps selection, reordering, and middle-click closing intact", async ({ page }) => {
  await open(page, ["Alpha", "A longer tab title", "Beta"])
  const source = tab(page, "ses_width_0")
  const target = tab(page, "ses_width_2")
  const before = await width(page, "ses_width_0")
  const start = await source.boundingBox()
  const end = await target.boundingBox()
  if (!start || !end) throw new Error("Missing tab bounds")
  await page.mouse.move(start.x + 12, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + 18, start.y + start.height / 2)
  await expect(source.locator("[data-titlebar-tab]")).toHaveAttribute("data-dragging", "true")
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 })
  expect(await width(page, "ses_width_0")).toBeCloseTo(before, 0)
  await page.mouse.up()
  await expect
    .poll(() => page.locator("[data-titlebar-tab-slot] [data-titlebar-tab-title]").allTextContents())
    .toEqual(["A longer tab title", "Beta", "Alpha"])
  await target.locator("[data-titlebar-tab-link]").click()
  await expect(page).toHaveURL(/\/session\/ses_width_2$/)
  await source.click({ button: "middle" })
  await expect(source).toHaveCount(0)
})

test("retains minimum tab widths and horizontal scrolling with many tabs", async ({ page }) => {
  await open(
    page,
    Array.from({ length: 30 }, (_, i) => `Session ${i} with a long title`),
    900,
  )
  const scroll = page.locator('[data-slot="titlebar-tabs-scroll"]')
  await expect.poll(() => scroll.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)
  await expect
    .poll(() =>
      page
        .locator("[data-titlebar-tab-slot]:visible")
        .evaluateAll((elements) => Math.min(...elements.map((element) => element.getBoundingClientRect().width))),
    )
    .toBeGreaterThanOrEqual(27.5)
  await expect
    .poll(() =>
      page
        .locator("[data-titlebar-tab-slot]:visible")
        .evaluateAll((elements) => Math.max(...elements.map((element) => element.getBoundingClientRect().width))),
    )
    .toBeLessThan(28.5)
  await expect(tab(page, "ses_width_0").locator("[data-titlebar-tab-title]")).toBeHidden()
  await scroll.hover()
  await page.mouse.wheel(400, 0)
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await tab(page, "ses_width_29").locator("[data-titlebar-tab-link]").focus()
  await tab(page, "ses_width_29").locator("[data-titlebar-tab-link]").press("Enter")
  await expect(page).toHaveURL(/\/session\/ses_width_29$/)
  await expect(tab(page, "ses_width_29")).toBeInViewport()
})
