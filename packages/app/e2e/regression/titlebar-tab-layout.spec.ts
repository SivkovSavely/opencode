import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2"
import { mockOpenCodeServer } from "../utils/mock-server"

const server = "http://127.0.0.1:4096"
const directory = "C:/a-long-repository-name-for-tab-layout"
const project = {
  id: "project-tab-layout",
  worktree: directory,
  vcs: "git",
  time: { created: 1, updated: 1 },
  sandboxes: [],
}
const titles = ["A long session title that should never determine the vertical tab width", "Short", "Beta"]
const diagnostics = new WeakMap<Page, { errors: string[]; requests: string[] }>()

test.beforeEach(({ page }) => {
  const entries = { errors: [] as string[], requests: [] as string[] }
  diagnostics.set(page, entries)
  page.on("pageerror", (error) => {
    entries.errors.push(error.stack ?? error.message)
    console.error(`[pageerror] ${error.stack ?? error.message}`)
  })
  page.on("request", (request) => {
    if (new URL(request.url()).port === new URL(server).port)
      entries.requests.push(`${request.method()} ${request.url()}`)
  })
  page.on("requestfailed", (request) => {
    entries.requests.push(`FAILED ${request.failure()?.errorText}: ${request.url()}`)
  })
})

test.afterEach(async ({ page }, info) => {
  const entries = diagnostics.get(page)!
  if (info.status !== info.expectedStatus || entries.errors.length)
    await info.attach("browser-diagnostics", {
      body: JSON.stringify(
        {
          ...entries,
          document: await page.evaluate(() => ({
            url: location.href,
            ready: document.readyState,
            body: document.body.innerHTML.slice(0, 8000),
          })),
        },
        null,
        2,
      ),
      contentType: "application/json",
    })
  expect(entries.errors, "No uncaught browser errors").toEqual([])
})

async function open(
  page: Page,
  appearance: Record<string, unknown> = {},
  names = titles,
  width = 1600,
  configure?: (sessions: Session[]) => Promise<void>,
) {
  const sessions = names.map((title, index) => ({
    id: `ses_layout_${index}`,
    slug: `layout-${index}`,
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
  await page.route(/\/pty\/shells(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [], headers: { "access-control-allow-origin": "*" } }),
  )
  await page.route(/\/(?:api\/)?session\/[^/]+(?:\/rename)?(?:\?.*)?$/, async (route) => {
    if (!["PATCH", "POST"].includes(route.request().method())) return route.fallback()
    const session = sessions.find((item) => new URL(route.request().url()).pathname.split("/").includes(item.id))
    if (!session) throw new Error("Unknown session")
    session.title = (route.request().postDataJSON() as { title: string }).title
    if (route.request().method() === "POST")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    await route.fulfill({ json: session, headers: { "access-control-allow-origin": "*" } })
  })
  await page.addInitScript(
    ({ server, directory, sessions, appearance }) => {
      if (localStorage.getItem("settings.v3")) return
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: true, shouldDisplayTabsToast: false }, appearance }),
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
    { server, directory, sessions, appearance },
  )
  await configure?.(sessions)
  await page.goto(`/server/${base64Encode(server)}/session/${sessions[0].id}`)
  await expect(page.locator("[data-titlebar-tab-slot]:not([inert])")).toHaveCount(names.length)
  for (const session of sessions)
    await expect(tab(page, session.id).locator("[data-titlebar-tab-title]")).toHaveText(session.title)
}

function tab(page: Page, id: string) {
  return page
    .locator("[data-titlebar-tab-slot]:not([inert])")
    .filter({ has: page.locator(`a[data-titlebar-tab-link][href$="/session/${id}"]`) })
}

async function width(locator: Locator) {
  return locator.evaluate((element) => element.getBoundingClientRect().width)
}

async function choose(page: Page, title: string, option: string) {
  const select = page
    .locator('.settings-v2-dialog [data-component="settings-v2-row"]')
    .filter({ has: page.getByText(title, { exact: true }) })
    .getByRole("button")
  await select.click()
  // The shared settings dialog currently aria-hides SelectV2 portals, but their labels remain visible.
  await page.locator('[data-slot="select-v2-listbox"]').getByText(option, { exact: true }).click()
  await expect(select).toHaveText(option)
}

async function reorder(page: Page, sourceID: string, targetID: string, orientation: "horizontal" | "vertical") {
  const source = tab(page, sourceID)
  const target = tab(page, targetID)
  await expect(source).toBeInViewport({ ratio: 1 })
  await expect(target).toBeInViewport({ ratio: 1 })
  const start = await source.locator("[data-titlebar-tab-icon]").boundingBox()
  const end = await target.boundingBox()
  if (!start || !end) throw new Error("Missing tab drag bounds")
  const x = start.x + start.width / 2
  const y = start.y + start.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + (orientation === "horizontal" ? 6 : 0), y + (orientation === "vertical" ? 6 : 0))
  await expect(source.locator("[data-titlebar-tab]")).toHaveAttribute("data-dragging", "true")
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(source.locator("[data-titlebar-tab]")).not.toHaveAttribute("data-dragging", "true")
}

async function naturalWidthError(slot: Locator) {
  return slot.evaluate((element) => {
    const root = element.querySelector<HTMLElement>("[data-titlebar-tab]")!
    const link = root.querySelector<HTMLElement>("[data-titlebar-tab-link]")!
    const icon = root.querySelector<HTMLElement>("[data-titlebar-tab-icon]")!
    const lines = [
      root.querySelector<HTMLElement>("[data-titlebar-tab-title]")!,
      root.querySelector<HTMLElement>('[data-slot="tab-project"]')!,
    ].map((line) => {
      const range = document.createRange()
      range.selectNodeContents(line)
      return range.getBoundingClientRect().width
    })
    const outer = getComputedStyle(root)
    const inner = getComputedStyle(link)
    const chrome =
      parseFloat(outer.paddingLeft) +
      parseFloat(outer.paddingRight) +
      parseFloat(inner.paddingLeft) +
      parseFloat(inner.paddingRight) +
      parseFloat(inner.columnGap) +
      icon.getBoundingClientRect().width
    return Math.abs(element.getBoundingClientRect().width - chrome - Math.max(...lines))
  })
}

test("loads the persisted left two-line layout with uniform draft and session widths through rename", async ({
  page,
}) => {
  await open(page, { tabPosition: "left", tabContent: "two-line", tabSidebarWidth: 276 })
  const strip = page.locator('[data-slot="titlebar-tabs"]')
  const sidebar = page.locator('aside[data-slot="titlebar-tabs-sidebar"]')
  await expect(strip).toHaveCount(1)
  await expect(strip).toHaveAttribute("data-orientation", "vertical")
  await expect(strip).toHaveAttribute("data-content", "two-line")
  await expect(sidebar).toBeVisible()
  await expect.poll(() => width(sidebar)).toBeCloseTo(276, 0)
  await expect(tab(page, "ses_layout_1").locator('[data-slot="tab-project"]')).toHaveText(
    "a-long-repository-name-for-tab-layout",
  )
  await sidebar.getByRole("button", { name: "New session", exact: true }).click()
  const draft = sidebar.locator('[data-titlebar-tab-slot][data-tab-key^="draft:"]')
  await expect(draft.locator("[data-titlebar-tab-title]")).toHaveText("New session")
  const original = await width(tab(page, "ses_layout_1"))
  await tab(page, "ses_layout_1").locator("[data-titlebar-tab-title]").dblclick()
  const editor = tab(page, "ses_layout_1").locator('[contenteditable="true"]')
  await expect(editor).toBeFocused()
  await editor.fill("A renamed session with an exceptionally long title that must not widen the sidebar")
  await expect(editor).toBeFocused()
  await expect.poll(() => width(tab(page, "ses_layout_1"))).toBeCloseTo(original, 0)
  await editor.press("Enter")
  await expect(tab(page, "ses_layout_1").locator("[data-titlebar-tab-title]")).toHaveText(
    "A renamed session with an exceptionally long title that must not widen the sidebar",
  )
  await expect(sidebar.locator("[data-titlebar-tab-slot]:not([inert])")).toHaveCount(4)
  await expect
    .poll(() =>
      sidebar.locator("[data-titlebar-tab-slot]:not([inert])").evaluateAll((elements) => {
        const widths = elements.map((element) => element.getBoundingClientRect().width)
        const list = elements[0].closest<HTMLElement>("[data-titlebar-tab-list]")!
        const style = getComputedStyle(list)
        const available = list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        return Math.max(...widths.map((width) => Math.abs(width - available)))
      }),
    )
    .toBeLessThan(1)
  await expect.poll(() => width(draft)).toBeGreaterThan(244)
  await expect(sidebar.locator("[data-titlebar-tab-slot][data-shrunk], [data-titlebar-tab-size]")).toHaveCount(0)
  await expect
    .poll(() =>
      sidebar
        .locator<HTMLElement>('[data-slot="titlebar-tabs"], [data-titlebar-tab-slot]')
        .evaluateAll((elements) => elements.every((element) => element.style.width === "")),
    )
    .toBe(true)
})

for (const preferences of [
  { name: "missing", appearance: {} },
  { name: "malformed", appearance: { tabPosition: "bottom", tabContent: "three-line", tabSidebarWidth: "wide" } },
]) {
  test(`uses safe defaults for ${preferences.name} tab preferences`, async ({ page }) => {
    await open(page, preferences.appearance)
    const strip = page.locator('[data-slot="titlebar-tabs"]')
    await expect(strip).toHaveCount(1)
    await expect(strip).toHaveAttribute("data-orientation", "horizontal")
    await expect(strip).toHaveAttribute("data-content", "one-line")
    await expect(page.locator('[data-slot="titlebar-tabs-sidebar"]')).toHaveCount(0)
    await expect(tab(page, "ses_layout_1").locator('[data-slot="tab-project"]')).toBeHidden()
    await page.keyboard.press("Control+,")
    await choose(page, "Tab position", "Left")
    await expect(strip).toHaveAttribute("data-orientation", "vertical")
    await expect.poll(() => width(page.locator('[data-slot="titlebar-tabs-sidebar"]'))).toBeCloseTo(276, 0)
  })
}

test("changes all four layout combinations live and persists the selection on reload", async ({ page }) => {
  await open(page)
  const composer = page.locator('[data-component="prompt-input"]')
  await expect(composer).toBeEditable()
  await composer.fill("Unsent draft preserved while changing tab appearance")
  const node = await composer.elementHandle()
  if (!node) throw new Error("Missing composer node")
  await page.keyboard.press("Control+,")
  const strip = page.locator('[data-slot="titlebar-tabs"]')
  for (const layout of [
    { position: "Top", orientation: "horizontal", content: "One line", value: "one-line" },
    { position: "Top", orientation: "horizontal", content: "Two lines", value: "two-line" },
    { position: "Left", orientation: "vertical", content: "One line", value: "one-line" },
    { position: "Left", orientation: "vertical", content: "Two lines", value: "two-line" },
  ]) {
    const content = await strip.getAttribute("data-content")
    if (!content) throw new Error("Missing tab content mode")
    await choose(page, "Tab position", layout.position)
    await expect(strip).toHaveAttribute("data-content", content)
    await choose(page, "Tab content", layout.content)
    await expect(strip).toHaveCount(1)
    await expect(strip).toHaveAttribute("data-orientation", layout.orientation)
    await expect(strip).toHaveAttribute("data-content", layout.value)
    await expect(strip.locator("[data-titlebar-tab-slot]:not([inert])")).toHaveCount(3)
    await expect
      .poll(() => composer.evaluate((element, original) => element === original && original.isConnected, node))
      .toBe(true)
    await expect(composer).toHaveText("Unsent draft preserved while changing tab appearance")
    await expect(page.locator('[data-slot="titlebar-tabs-sidebar"]')).toHaveCount(layout.position === "Left" ? 1 : 0)
    const repository = tab(page, "ses_layout_1").locator('[data-slot="tab-project"]')
    if (layout.value === "one-line") await expect(repository).toBeHidden()
    if (layout.value === "two-line") {
      await expect(repository).toHaveText("a-long-repository-name-for-tab-layout")
      await expect
        .poll(() =>
          tab(page, "ses_layout_1").evaluate((element) => {
            const title = element.querySelector("[data-titlebar-tab-title]")!.getBoundingClientRect()
            const project = element.querySelector('[data-slot="tab-project"]')!.getBoundingClientRect()
            return project.top >= title.bottom - 1
          }),
        )
        .toBe(true)
    }
  }
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3")!).appearance))
    .toMatchObject({ tabPosition: "left", tabContent: "two-line" })
  await page.keyboard.press("Escape")
  await expect(page.locator(".settings-v2-dialog")).toBeHidden()
  await page.reload()
  await expect(strip).toHaveCount(1)
  await expect(strip).toHaveAttribute("data-orientation", "vertical")
  await expect(strip).toHaveAttribute("data-content", "two-line")
  await expect(tab(page, "ses_layout_1").locator('[data-slot="tab-project"]')).toBeVisible()
  await expect(page).toHaveURL(/\/session\/ses_layout_0$/)
})

test("sizes top two-line tabs to the wider text line and restores width after resize and rename", async ({ page }) => {
  await open(page, { tabPosition: "top", tabContent: "two-line" }, ["A", "Beta", "Short"])
  const slot = tab(page, "ses_layout_0")
  await expect(slot.locator('[data-slot="tab-project"]')).toBeVisible()
  await expect.poll(() => naturalWidthError(slot)).toBeLessThan(2)
  const original = await width(slot)
  await expect.poll(() => width(tab(page, "ses_layout_1"))).toBeCloseTo(original, 0)
  await page.setViewportSize({ width: 900, height: 800 })
  await expect.poll(() => width(slot)).toBeLessThan(original - 10)
  await page.setViewportSize({ width: 1600, height: 800 })
  await expect.poll(() => width(slot)).toBeCloseTo(original, 0)
  const font = await page.addStyleTag({
    content: "[data-titlebar-tab-link] { font-family: monospace !important; }",
  })
  await expect.poll(() => width(slot)).toBeGreaterThan(original + 10)
  await expect.poll(() => naturalWidthError(slot)).toBeLessThan(2)
  await font.evaluate((element) => element.remove())
  await expect.poll(() => width(slot)).toBeCloseTo(original, 0)
  await page.locator("html").evaluate((element) => (element.style.fontSize = "20px"))
  await expect.poll(() => width(slot)).toBeGreaterThan(original + 5)
  await expect.poll(() => naturalWidthError(slot)).toBeLessThan(2)
  await page.locator("html").evaluate((element) => element.style.removeProperty("font-size"))
  await expect.poll(() => width(slot)).toBeCloseTo(original, 0)
  await page.keyboard.press("Control+,")
  await choose(page, "Tab content", "One line")
  await expect.poll(() => width(slot)).toBeLessThan(original - 40)
  await choose(page, "Tab content", "Two lines")
  await expect.poll(() => width(slot)).toBeCloseTo(original, 0)
  await page.keyboard.press("Escape")
  await expect(page.locator(".settings-v2-dialog")).toBeHidden()
  await slot.locator("[data-titlebar-tab-title]").dblclick()
  const editor = slot.locator('[contenteditable="true"]')
  await expect(editor).toBeFocused()
  await editor.fill("A renamed session whose title is significantly wider than the repository name")
  await expect(editor).toBeFocused()
  await expect.poll(() => width(slot)).toBeCloseTo(original, 0)
  await editor.press("Enter")
  await expect(slot.locator("[data-titlebar-tab-title]")).toHaveText(
    "A renamed session whose title is significantly wider than the repository name",
  )
  await expect.poll(() => width(slot)).toBeGreaterThan(original + 40)
  await expect.poll(() => naturalWidthError(slot)).toBeLessThan(2)
  const renamed = await width(slot)
  await page.setViewportSize({ width: 900, height: 800 })
  await expect.poll(() => width(slot)).toBeLessThan(renamed - 10)
  await page.setViewportSize({ width: 1600, height: 800 })
  await expect.poll(() => width(slot)).toBeCloseTo(renamed, 0)
})

test("updates delayed project names while distinguishing worktrees, other repositories, and cached missing sessions", async ({
  page,
}) => {
  const sandbox = "C:/worktrees/feature-branch"
  const other = { ...project, id: "project-independent", worktree: "C:/independent", name: "Independent Repository" }
  const main = { ...project, sandboxes: [sandbox] }
  const projects = [main, other]
  const release = Promise.withResolvers<void>()
  const stream = Promise.withResolvers<void>()
  const connected = { value: false }
  await open(
    page,
    { tabPosition: "top", tabContent: "two-line" },
    ["Root", "Worktree", "Other", "Saved offline"],
    1600,
    async (sessions) => {
      sessions[1].directory = sandbox
      sessions[2].directory = other.worktree
      sessions[2].projectID = other.id
      await page.route(/\/(?:api\/)?project(?:\/current)?(?:\?.*)?$/, (route) => {
        const url = new URL(route.request().url())
        const current = url.searchParams.get("directory") === other.worktree ? other : projects[0]
        return route.fulfill({
          json: url.pathname.endsWith("/current") ? current : projects,
          headers: { "access-control-allow-origin": "*" },
        })
      })
      await page.route(/\/session(?:\?.*)?$/, (route) =>
        route.fulfill({ json: sessions.slice(0, 3), headers: { "access-control-allow-origin": "*" } }),
      )
      await page.route(/\/(?:api\/)?session\/ses_layout_3(?:\?.*)?$/, (route) =>
        route.fulfill({
          status: 404,
          json: { name: "NotFoundError" },
          headers: { "access-control-allow-origin": "*" },
        }),
      )
      await page.addInitScript(
        ({ server, href }) => {
          localStorage.setItem(
            "opencode.window.browser.dat:tabs.info",
            JSON.stringify({
              [`${server}\n${href}`]: { title: "Saved offline", directory: "C:/cached/offline-repository" },
            }),
          )
        },
        { server, href: `/server/${base64Encode(server)}/session/ses_layout_3` },
      )
      await page.route(/\/global\/event$/, async (route) => {
        if (!connected.value) {
          connected.value = true
          return route.fallback()
        }
        stream.resolve()
        await release.promise
        await route.fulfill({
          contentType: "text/event-stream",
          headers: { "access-control-allow-origin": "*" },
          body: `data: ${JSON.stringify({ directory: "global", payload: { type: "project.updated", properties: projects[0] } })}\n\n`,
        })
      })
    },
  )
  await expect(tab(page, "ses_layout_0").locator('[data-slot="tab-project"]')).toHaveText(
    "a-long-repository-name-for-tab-layout",
  )
  await expect(tab(page, "ses_layout_1").locator('[data-slot="tab-project"]')).toHaveText(
    "a-long-repository-name-for-tab-layout",
  )
  await expect(tab(page, "ses_layout_3").locator('[data-slot="tab-project"]')).toHaveText("offline-repository")
  const before = await width(tab(page, "ses_layout_1"))
  await stream.promise
  const updated = { ...main, name: "A Configured Repository Name That Arrives After The Tabs" }
  projects[0] = updated
  release.resolve()
  for (const id of ["ses_layout_0", "ses_layout_1"]) {
    await expect(tab(page, id).locator('[data-slot="tab-project"]')).toHaveText(updated.name)
    await expect.poll(() => naturalWidthError(tab(page, id))).toBeLessThan(2)
  }
  await expect.poll(() => width(tab(page, "ses_layout_1"))).toBeGreaterThan(before + 30)
  await expect(tab(page, "ses_layout_2").locator('[data-slot="tab-project"]')).toHaveText("Independent Repository")
  await expect(tab(page, "ses_layout_3").locator('[data-slot="tab-project"]')).toHaveText("offline-repository")
})

test("keeps repository metadata with its owning server and preserves resized width while switching servers", async ({
  page,
}) => {
  const secondary = "http://localhost:4096"
  await open(
    page,
    { tabPosition: "left", tabContent: "two-line", tabSidebarWidth: 276 },
    ["Local", "Remote"],
    1600,
    async () => {
      await page.route(/\/(?:api\/)?project(?:\/current)?(?:\?.*)?$/, (route) => {
        const url = new URL(route.request().url())
        const current = { ...project, name: url.origin === server ? "Local Repository" : "Remote Repository" }
        return route.fulfill({
          json: url.pathname.endsWith("/current") ? current : [current],
          headers: { "access-control-allow-origin": "*" },
        })
      })
    },
  )
  await page.evaluate(
    ({ secondary }) => {
      const servers = JSON.parse(localStorage.getItem("opencode.global.dat:server")!)
      servers.list.push(secondary)
      localStorage.setItem("opencode.global.dat:server", JSON.stringify(servers))
      const tabs = JSON.parse(localStorage.getItem("opencode.window.browser.dat:tabs")!)
      tabs[1].server = secondary
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { secondary },
  )
  await page.reload()
  const sidebar = page.locator('[data-slot="titlebar-tabs-sidebar"]')
  await expect(tab(page, "ses_layout_0").locator('[data-slot="tab-project"]')).toHaveText("Local Repository")
  await expect(tab(page, "ses_layout_1").locator('[data-slot="tab-project"]')).toHaveText("Remote Repository")
  await expect.poll(() => width(sidebar)).toBeCloseTo(276, 0)
  await page.getByRole("separator", { name: "Resize tab sidebar", exact: true }).press("Shift+ArrowRight")
  await expect.poll(() => width(sidebar)).toBeGreaterThan(276)
  const preferred = await width(sidebar)
  for (const [id, owner] of [
    ["ses_layout_1", secondary],
    ["ses_layout_0", server],
  ]) {
    await tab(page, id).locator("[data-titlebar-tab-link]").click()
    await expect(page).toHaveURL(new RegExp(`/server/${base64Encode(owner)}/session/${id}$`))
    await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(1)
    await expect.poll(() => width(sidebar)).toBeCloseTo(preferred, 0)
    await expect(tab(page, "ses_layout_0").locator('[data-slot="tab-project"]')).toHaveText("Local Repository")
    await expect(tab(page, "ses_layout_1").locator('[data-slot="tab-project"]')).toHaveText("Remote Repository")
  }
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3")!).appearance.tabSidebarWidth))
    .toBeCloseTo(preferred, 0)
})

for (const direction of ["ltr", "rtl"]) {
  test(`shrinks the widest two-line labels first and clears both lines from close controls in ${direction}`, async ({
    page,
  }) => {
    const repositories = ["X", "A repository name that is substantially wider than its short session title", "Q"]
    await open(
      page,
      { tabPosition: "top", tabContent: "two-line" },
      [
        "An exceptionally long session title that is deliberately wider than every repository name in this strip",
        "Short",
        "Tiny",
      ],
      1600,
      async (sessions) => {
        const projects = sessions.map((session, index) => {
          session.projectID = `project-width-${index}`
          session.directory = `C:/${repositories[index]}`
          return { ...project, id: session.projectID, worktree: session.directory, name: repositories[index] }
        })
        await page.route(/\/(?:api\/)?project(?:\/current)?(?:\?.*)?$/, (route) => {
          const url = new URL(route.request().url())
          const current = projects.find((item) => item.worktree === url.searchParams.get("directory")) ?? projects[0]
          return route.fulfill({
            json: url.pathname.endsWith("/current") ? current : projects,
            headers: { "access-control-allow-origin": "*" },
          })
        })
      },
    )
    if (direction === "rtl") await page.getByRole("button", { name: "DIR: LTR", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("dir", direction)
    for (const index of [0, 1, 2]) {
      await expect(tab(page, `ses_layout_${index}`).locator('[data-slot="tab-project"]')).toHaveText(
        repositories[index],
      )
      await expect.poll(() => naturalWidthError(tab(page, `ses_layout_${index}`))).toBeLessThan(2)
    }
    const before = await Promise.all([0, 1, 2].map((index) => width(tab(page, `ses_layout_${index}`))))
    expect(before[0]).toBeGreaterThan(before[1] + 40)
    const spare = await width(page.locator("[data-titlebar-tabs-spacer]"))
    await page.setViewportSize({ width: Math.floor(1600 - spare - 30), height: 800 })
    await expect.poll(() => width(tab(page, "ses_layout_0"))).toBeLessThan(before[0] - 20)
    await expect.poll(() => width(tab(page, "ses_layout_1"))).toBeCloseTo(before[1], 0)
    await expect.poll(() => width(tab(page, "ses_layout_2"))).toBeCloseTo(before[2], 0)
    await page.setViewportSize({ width: 900, height: 800 })
    await expect
      .poll(async () => Math.abs((await width(tab(page, "ses_layout_0"))) - (await width(tab(page, "ses_layout_1")))))
      .toBeLessThan(2)
    await expect.poll(() => width(tab(page, "ses_layout_2"))).toBeCloseTo(before[2], 0)
    for (const [index, line] of [
      [0, "[data-titlebar-tab-title]"],
      [1, '[data-slot="tab-project"]'],
    ] as const) {
      const slot = tab(page, `ses_layout_${index}`)
      await slot.hover()
      await expect(slot.locator(line)).toHaveCSS("text-overflow", "ellipsis")
      await expect
        .poll(() => slot.locator(line).evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeGreaterThan(10)
      await expect
        .poll(() =>
          slot.evaluate((element) => {
            const close = element.querySelector('[data-slot="tab-close"]')!.getBoundingClientRect()
            return ["[data-titlebar-tab-title]", '[data-slot="tab-project"]'].every((selector) => {
              const box = element.querySelector(selector)!.getBoundingClientRect()
              return box.right <= close.left || box.left >= close.right
            })
          }),
        )
        .toBe(true)
    }
    await page.setViewportSize({ width: 1600, height: 800 })
    for (const index of [0, 1, 2]) {
      await expect.poll(() => width(tab(page, `ses_layout_${index}`))).toBeCloseTo(before[index], 0)
      await expect.poll(() => naturalWidthError(tab(page, `ses_layout_${index}`))).toBeLessThan(2)
    }
  })
}

for (const direction of ["ltr", "rtl"]) {
  test(`resizes continuously with mouse and keyboard within bounds in ${direction}`, async ({ page }) => {
    await open(page, { tabPosition: "left", tabContent: "two-line", tabSidebarWidth: 276 })
    if (direction === "rtl") await page.getByRole("button", { name: "DIR: LTR", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("dir", direction)
    const sidebar = page.locator('[data-slot="titlebar-tabs-sidebar"]')
    const separator = page.getByRole("separator", { name: "Resize tab sidebar", exact: true })
    const main = page.getByRole("main")
    await expect(separator).toHaveAttribute("aria-orientation", "vertical")
    await expect.poll(() => width(sidebar)).toBeCloseTo(276, 0)
    await separator.press(direction === "ltr" ? "ArrowRight" : "ArrowLeft")
    await expect(separator).toBeFocused()
    await expect.poll(() => width(sidebar)).toBeGreaterThan(276)
    const before = await width(sidebar)
    const content = await width(main)
    const handle = await separator.boundingBox()
    if (!handle) throw new Error("Missing sidebar separator bounds")
    const sign = direction === "ltr" ? 1 : -1
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + sign * 40, handle.y + handle.height / 2, { steps: 5 })
    await expect.poll(() => width(sidebar)).toBeCloseTo(before + 40, 0)
    await expect.poll(() => width(main)).toBeCloseTo(content - 40, 0)
    await page.mouse.move(handle.x + handle.width / 2 + sign * 80, handle.y + handle.height / 2, { steps: 5 })
    await expect.poll(() => width(sidebar)).toBeCloseTo(before + 80, 0)
    await expect.poll(() => width(main)).toBeCloseTo(content - 80, 0)
    await page.mouse.up()
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3")!).appearance.tabSidebarWidth))
      .toBeCloseTo(before + 80, 0)
    await separator.press(direction === "ltr" ? "ArrowLeft" : "ArrowRight")
    await expect.poll(() => width(sidebar)).toBeLessThan(before + 80)
    const minimum = Number(await separator.getAttribute("aria-valuemin"))
    const maximum = Number(await separator.getAttribute("aria-valuemax"))
    expect(minimum).toBeGreaterThan(0)
    expect(maximum).toBeGreaterThan(minimum)
    const bounds = await separator.boundingBox()
    if (!bounds) throw new Error("Missing resized sidebar separator bounds")
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(direction === "ltr" ? 1590 : 10, bounds.y + bounds.height / 2, { steps: 5 })
    await expect.poll(() => width(sidebar)).toBeCloseTo(maximum, 0)
    await page.mouse.move(direction === "ltr" ? 10 : 1590, bounds.y + bounds.height / 2, { steps: 5 })
    await expect.poll(() => width(sidebar)).toBeCloseTo(minimum, 0)
    await page.mouse.up()
    await separator.press("Home")
    await expect.poll(() => width(sidebar)).toBeCloseTo(minimum, 0)
    await separator.press(direction === "ltr" ? "ArrowLeft" : "ArrowRight")
    await expect.poll(() => width(sidebar)).toBeCloseTo(minimum, 0)
    await separator.press("End")
    await expect.poll(() => width(sidebar)).toBeCloseTo(maximum, 0)
    await separator.press(direction === "ltr" ? "ArrowRight" : "ArrowLeft")
    await expect.poll(() => width(sidebar)).toBeCloseTo(maximum, 0)
    await expect.poll(() => width(main)).toBeGreaterThan(0)
    await expect(separator).toHaveAttribute("aria-valuenow", String(maximum))
  })
}

test("clamps the rendered sidebar without losing its preferred width across viewport and layout changes", async ({
  page,
}) => {
  await open(page, { tabPosition: "left", tabContent: "one-line", tabSidebarWidth: 420 })
  const sidebar = page.locator('[data-slot="titlebar-tabs-sidebar"]')
  const strip = page.locator('[data-slot="titlebar-tabs"]')
  await expect.poll(() => width(sidebar)).toBeCloseTo(420, 0)
  await page.setViewportSize({ width: 800, height: 800 })
  await expect.poll(() => width(sidebar)).toBeLessThan(420)
  await expect.poll(() => width(page.getByRole("main"))).toBeGreaterThan(0)
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3")!).appearance.tabSidebarWidth))
    .toBe(420)
  await page.setViewportSize({ width: 1600, height: 800 })
  await expect.poll(() => width(sidebar)).toBeCloseTo(420, 0)
  await page.keyboard.press("Control+,")
  await choose(page, "Tab content", "Two lines")
  await expect(strip).toHaveAttribute("data-content", "two-line")
  await expect.poll(() => width(sidebar)).toBeCloseTo(420, 0)
  await choose(page, "Tab position", "Top")
  await expect(sidebar).toHaveCount(0)
  await choose(page, "Tab content", "One line")
  await choose(page, "Tab position", "Left")
  await expect(strip).toHaveAttribute("data-orientation", "vertical")
  await expect.poll(() => width(sidebar)).toBeCloseTo(420, 0)
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3")!).appearance))
    .toMatchObject({ tabPosition: "left", tabContent: "one-line", tabSidebarWidth: 420 })
  await page.keyboard.press("Escape")
  await expect(page.locator(".settings-v2-dialog")).toBeHidden()
  await page.reload()
  await expect(strip).toHaveAttribute("data-orientation", "vertical")
  await expect(strip).toHaveAttribute("data-content", "one-line")
  await expect.poll(() => width(sidebar)).toBeCloseTo(420, 0)
})

test("falls back to top tabs on narrow screens without changing saved placement or remounting the composer", async ({
  page,
}) => {
  await open(page, { tabPosition: "left", tabContent: "two-line", tabSidebarWidth: 420 })
  const strip = page.locator('[data-slot="titlebar-tabs"]')
  const sidebar = page.locator('[data-slot="titlebar-tabs-sidebar"]')
  const composer = page.locator('[data-component="prompt-input"]')
  await expect(strip).toHaveAttribute("data-orientation", "vertical")
  await expect(composer).toBeEditable()
  await composer.fill("Unsent draft preserved through responsive tab placement")
  const node = await composer.elementHandle()
  if (!node) throw new Error("Missing composer node")
  await page.setViewportSize({ width: 600, height: 800 })
  await expect(sidebar).toHaveCount(0)
  await expect(strip).toHaveCount(1)
  await expect(strip).toHaveAttribute("data-orientation", "horizontal")
  await expect(strip).toHaveAttribute("data-content", "two-line")
  await expect(strip.locator("[data-titlebar-tab-slot]:not([inert])")).toHaveCount(3)
  await expect
    .poll(() => composer.evaluate((element, original) => element === original && original.isConnected, node))
    .toBe(true)
  await expect(composer).toHaveText("Unsent draft preserved through responsive tab placement")
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3")!).appearance))
    .toMatchObject({ tabPosition: "left", tabContent: "two-line", tabSidebarWidth: 420 })
  await page.setViewportSize({ width: 1600, height: 800 })
  await expect(strip).toHaveCount(1)
  await expect(strip).toHaveAttribute("data-orientation", "vertical")
  await expect(strip).toHaveAttribute("data-content", "two-line")
  await expect.poll(() => width(sidebar)).toBeCloseTo(420, 0)
  await expect
    .poll(() => composer.evaluate((element, original) => element === original && original.isConnected, node))
    .toBe(true)
  await expect(composer).toHaveText("Unsent draft preserved through responsive tab placement")
})

test("reorders vertically and retains the order when returning to top tabs and reloading", async ({ page }) => {
  await open(page, { tabPosition: "left", tabContent: "one-line" }, ["Alpha", "Gamma", "Beta"])
  const source = tab(page, "ses_layout_0")
  const target = tab(page, "ses_layout_2")
  const start = await source.boundingBox()
  const end = await target.boundingBox()
  if (!start || !end) throw new Error("Missing vertical tab bounds")
  await page.mouse.move(start.x + 12, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + start.height / 2 + 6)
  await expect(source.locator("[data-titlebar-tab]")).toHaveAttribute("data-dragging", "true")
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 })
  await page.mouse.up()
  const labels = page.locator("[data-titlebar-tab-slot]:not([inert]) [data-titlebar-tab-title]")
  await expect(labels).toHaveText(["Gamma", "Beta", "Alpha"])
  await page.keyboard.press("Control+,")
  await choose(page, "Tab position", "Top")
  await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveAttribute("data-orientation", "horizontal")
  await expect(labels).toHaveText(["Gamma", "Beta", "Alpha"])
  await expect.poll(() => width(source)).toBeLessThan(200)
  await page.keyboard.press("Escape")
  await expect(page.locator(".settings-v2-dialog")).toBeHidden()
  await page.reload()
  await expect(labels).toHaveText(["Gamma", "Beta", "Alpha"])
  await target.locator("[data-titlebar-tab-link]").click()
  await expect(page).toHaveURL(/\/session\/ses_layout_2$/)
})

for (const direction of ["ltr", "rtl"]) {
  test(`reorders after live placement, density, and responsive orientation changes in ${direction}`, async ({
    page,
  }) => {
    await open(page, { tabPosition: "top", tabContent: "one-line" }, ["Alpha", "Beta", "Gamma"])
    if (direction === "rtl") await page.getByRole("button", { name: "DIR: LTR", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("dir", direction)
    const strip = page.locator('[data-slot="titlebar-tabs"]')
    const labels = strip.locator("[data-titlebar-tab-slot]:not([inert]) [data-titlebar-tab-title]")
    await page.keyboard.press("Control+,")
    await choose(page, "Tab position", "Left")
    await page.keyboard.press("Escape")
    await expect(page.locator(".settings-v2-dialog")).toBeHidden()
    await expect(strip).toHaveAttribute("data-orientation", "vertical")
    await reorder(page, "ses_layout_0", "ses_layout_2", "vertical")
    await expect(labels).toHaveText(["Beta", "Gamma", "Alpha"])

    await page.keyboard.press("Control+,")
    await choose(page, "Tab position", "Top")
    await choose(page, "Tab content", "Two lines")
    await page.keyboard.press("Escape")
    await expect(page.locator(".settings-v2-dialog")).toBeHidden()
    await expect(strip).toHaveAttribute("data-orientation", "horizontal")
    await expect(strip).toHaveAttribute("data-content", "two-line")
    await reorder(page, "ses_layout_0", "ses_layout_1", "horizontal")
    await expect(labels).toHaveText(["Alpha", "Beta", "Gamma"])

    await page.keyboard.press("Control+,")
    await choose(page, "Tab position", "Left")
    await page.keyboard.press("Escape")
    await expect(page.locator(".settings-v2-dialog")).toBeHidden()
    await expect(strip).toHaveAttribute("data-orientation", "vertical")
    await reorder(page, "ses_layout_0", "ses_layout_2", "vertical")
    await expect(labels).toHaveText(["Beta", "Gamma", "Alpha"])

    await page.setViewportSize({ width: 760, height: 800 })
    await expect(strip).toHaveAttribute("data-orientation", "horizontal")
    await reorder(page, "ses_layout_0", "ses_layout_1", "horizontal")
    await expect(labels).toHaveText(["Alpha", "Beta", "Gamma"])
    await page.setViewportSize({ width: 1600, height: 800 })
    await expect(strip).toHaveAttribute("data-orientation", "vertical")
    await reorder(page, "ses_layout_0", "ses_layout_2", "vertical")
    await expect(labels).toHaveText(["Beta", "Gamma", "Alpha"])
  })
}

test("cancels a drag across responsive orientation changes and keeps keyboard cycling functional", async ({ page }) => {
  await open(page, { tabPosition: "left", tabContent: "two-line" }, ["Alpha", "Beta", "Gamma"])
  const source = tab(page, "ses_layout_0")
  const start = await source.boundingBox()
  if (!start) throw new Error("Missing vertical tab bounds")
  await page.mouse.move(start.x + 12, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + start.height / 2 + 6)
  await expect(source.locator("[data-titlebar-tab]")).toHaveAttribute("data-dragging", "true")
  const strip = page.locator('[data-slot="titlebar-tabs"]')
  await page.setViewportSize({ width: 600, height: 800 })
  await expect(strip).toHaveAttribute("data-orientation", "horizontal")
  await expect(strip.locator('[data-titlebar-tab][data-dragging="true"]')).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.mouse.up()
  await expect(strip.locator('[data-titlebar-tab][data-dragging="true"]')).toHaveCount(0)
  for (const size of [1600, 600, 1600]) {
    await page.setViewportSize({ width: size, height: 800 })
    await expect(strip).toHaveAttribute("data-orientation", size === 600 ? "horizontal" : "vertical")
    await expect(strip.locator("[data-titlebar-tab-slot]:not([inert]) [data-titlebar-tab-title]")).toHaveText([
      "Alpha",
      "Beta",
      "Gamma",
    ])
  }
  await source.locator("[data-titlebar-tab-link]").focus()
  await page.keyboard.press("Control+Tab")
  await expect(page).toHaveURL(/\/session\/ses_layout_1$/)
  await page.keyboard.press("Control+Tab")
  await expect(page).toHaveURL(/\/session\/ses_layout_2$/)
  await page.keyboard.press("Control+Shift+Tab")
  await expect(page).toHaveURL(/\/session\/ses_layout_1$/)
  await expect(tab(page, "ses_layout_1")).toBeInViewport({ ratio: 1 })
  await reorder(page, "ses_layout_0", "ses_layout_2", "vertical")
  await expect(strip.locator("[data-titlebar-tab-slot]:not([inert]) [data-titlebar-tab-title]")).toHaveText([
    "Beta",
    "Gamma",
    "Alpha",
  ])
})

test("reveals the active vertical tab and keeps session previews available", async ({ page }) => {
  await open(
    page,
    { tabPosition: "left", tabContent: "two-line" },
    Array.from({ length: 24 }, (_, index) => `Session ${index}`),
  )
  await page.setViewportSize({ width: 1600, height: 300 })
  const scroll = page.locator('[data-slot="titlebar-tabs-scroll"]')
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
  await page.keyboard.press("Control+9")
  await expect(page).toHaveURL(/\/session\/ses_layout_8$/)
  await expect(tab(page, "ses_layout_8")).toBeInViewport({ ratio: 1 })
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const preview = page.locator('[data-component="session-tab-popover"]')
  for (const direction of ["ltr", "rtl"]) {
    if (direction === "rtl") await page.getByRole("button", { name: "DIR: LTR", exact: true }).click()
    await expect(page.locator("html")).toHaveAttribute("dir", direction)
    await tab(page, "ses_layout_7").locator("[data-titlebar-tab-link]").hover()
    await expect(preview).toBeVisible()
    await expect(preview.locator('[data-slot="title"]')).toHaveText("Session 7")
    await expect(preview.locator('[data-slot="project"]')).toHaveText("a-long-repository-name-for-tab-layout")
    await expect
      .poll(() =>
        tab(page, "ses_layout_7").evaluate((element, direction) => {
          const row = element.getBoundingClientRect()
          const popup = document.querySelector('[data-component="session-tab-popover"]')!.getBoundingClientRect()
          const beside = direction === "ltr" ? popup.left >= row.right : popup.right <= row.left
          return beside && popup.top < row.bottom && popup.bottom > row.top
        }, direction),
      )
      .toBe(true)
  }
  await expect(page).toHaveURL(/\/session\/ses_layout_8$/)
})
