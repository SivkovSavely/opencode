import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  assistantMessage,
  completedAssistantInfo,
  messageUpdated,
  partDelta,
  project,
  session,
  sessionID,
  status,
  textPart,
  userMessage,
  type TimelineEvent,
  type TimelineMessage,
} from "../performance/timeline-stability/fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"

const directory = "/home/user/projects"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

const reproduction = [
  "[HTML preview](AmlService/docs/watchlist-report-email-preview.html)",
  "[Desktop screenshot](/tmp/opencode/aml-email-desktop.png)",
  "[Mobile screenshot](/tmp/opencode/aml-email-mobile-candidates.png)",
].join("\n\n")

for (const newLayoutDesigns of [false, true]) {
  test(`copies relative links in session context (new layout: ${newLayoutDesigns})`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await setup(page, newLayoutDesigns, {
      messages: () => {
        const user = userMessage()
        return [
          { ...user, info: { ...user.info, system: "[System docs](./docs/report.md)" } },
          assistantMessage([textPart("prt_local_links", reproduction)]),
        ]
      },
    })
    await page.getByRole("button", { name: "View context usage", exact: true }).click()
    const link = page.getByRole("link", { name: "System docs", exact: true })
    await expect(link).not.toHaveAttribute("href")
    const url = page.url()
    await link.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${directory}/docs/report.md`)
    await expect(page.getByText("Copied", { exact: true })).toBeVisible()
    await expect(page).toHaveURL(url)
    await page.getByRole("button", { name: "Dismiss", exact: true }).click()
    await expect(page.getByText("Copied", { exact: true })).toHaveCount(0)
    await page.evaluate(() => navigator.clipboard.writeText("before keyboard activation"))
    await link.focus()
    await link.press("Enter")
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${directory}/docs/report.md`)
    await expect(page.getByText("Copied", { exact: true })).toBeVisible()
  })

  test(`copies local Markdown links without navigating (new layout: ${newLayoutDesigns})`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await setup(page, newLayoutDesigns)
    const markdown = page.locator('[data-timeline-part-id="prt_local_links"] [data-component="markdown"]')
    const url = page.url()
    const pages = context.pages().length
    const fileRequests: string[] = []
    page.on("request", (request) => {
      if (/aml-email|watchlist-report-email-preview/.test(request.url())) fileRequests.push(request.url())
    })
    for (const [label, path] of [
      ["HTML preview", `${directory}/AmlService/docs/watchlist-report-email-preview.html`],
      ["Desktop screenshot", "/tmp/opencode/aml-email-desktop.png"],
      ["Mobile screenshot", "/tmp/opencode/aml-email-mobile-candidates.png"],
    ]) {
      const link = markdown.getByRole("link", { name: label, exact: true })
      await expect(link).not.toHaveAttribute("href")
      await expect(link).not.toHaveAttribute("target")
      await expect(link).toHaveAttribute("tabindex", "0")
      await expect(link).toHaveCSS("cursor", "pointer")
      await link.click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(path)
      await expect(page.getByText("Copied", { exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Dismiss", exact: true }).click()
      await expect(page.getByText("Copied", { exact: true })).toHaveCount(0)
      await expect(page).toHaveURL(url)
      expect(context.pages()).toHaveLength(pages)
    }
    const link = markdown.getByRole("link", { name: "HTML preview", exact: true })
    await link.focus()
    await expect(link).toBeFocused()
    await link.press("Enter")
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${directory}/AmlService/docs/watchlist-report-email-preview.html`)
    await expect(page).toHaveURL(url)
    expect(context.pages()).toHaveLength(pages)
    await link.click({ button: "middle" })
    await link.click({ modifiers: ["Control"] })
    await expect(page).toHaveURL(url)
    expect(context.pages()).toHaveLength(pages)
    expect(fileRequests).toEqual([])
  })

  test(`preserves nested labels and decodes filesystem paths once (new layout: ${newLayoutDesigns})`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await setup(page, newLayoutDesigns, {
      text: [
        '<a href="./docs/../preview%20%23%3F%25.html"><strong>Nested label</strong></a>',
        '<a href="../shared/report.html"><code>Code label</code></a>',
        "[File URL](file:///localhost/tmp/a%20b%2520.html)",
        "[Windows](C:%5CUsers%5CAlice%5Cdocs%5C..%5Creport.html)",
      ].join("\n\n"),
    })
    const markdown = page.locator('[data-component="markdown"]').filter({ hasText: "Nested label" })
    for (const [label, path] of [
      ["Nested label", "/home/user/projects/preview #?%.html"],
      ["Code label", "/home/user/shared/report.html"],
      ["File URL", "/localhost/tmp/a b%20.html"],
      ["Windows", "C:/Users/Alice/report.html"],
    ]) {
      const link = markdown.getByRole("link", { name: label, exact: true })
      await expect(link).not.toHaveAttribute("href")
      if (label === "Nested label") await link.locator("strong").click()
      else if (label === "Code label") await link.locator("code").click()
      else await link.click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(path)
    }
    await markdown.evaluate((element) => {
      element.setAttribute("dir", "rtl")
    })
    const nested = markdown.getByRole("link", { name: "Nested label", exact: true })
    await nested.focus()
    await nested.press("Enter")
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("/home/user/projects/preview #?%.html")
  })

  test(`keeps non-file URLs and rejects unsafe local targets (new layout: ${newLayoutDesigns})`, async ({
    page,
    context,
  }) => {
    await setup(page, newLayoutDesigns, {
      text: [
        "[HTTP](http://127.0.0.1:4096/tmp/a.html)",
        "[HTTPS](https://example.com/report)",
        "[Mail](mailto:a@example.com)",
        "[Telephone](tel:1234)",
        "[Protocol relative](//example.com/a)",
        "[Fragment](#section)",
        "[Query](?search=report)",
        "[Unsafe](javascript:alert(1))",
        "[Malformed](./docs/%ZZ.html)",
        "[Remote file](file://remote-host/tmp/a.html)",
        '<a href="https://example.com/forged" data-local-link="/tmp/injected">Forged metadata</a>',
        '<a href="javascript:alert(1)" data-local-link="/tmp/injected" onclick="document.body.dataset.unsafe=1">Raw unsafe</a>',
      ].join("\n\n"),
    })
    const markdown = page.locator('[data-component="markdown"]').filter({ hasText: "HTTPS" })
    for (const [name, href] of [
      ["HTTP", "http://127.0.0.1:4096/tmp/a.html"],
      ["HTTPS", "https://example.com/report"],
      ["Mail", "mailto:a@example.com"],
      ["Telephone", "tel:1234"],
      ["Protocol relative", "//example.com/a"],
      ["Fragment", "#section"],
      ["Query", "?search=report"],
      ["Forged metadata", "https://example.com/forged"],
    ]) {
      const link = markdown.getByRole("link", { name, exact: true })
      await expect(link).toHaveAttribute("href", href)
      await expect(link).not.toHaveAttribute("data-local-link")
      if (name !== "Forged metadata") {
        await expect(link).toHaveAttribute("target", "_blank")
        await expect(link).toHaveAttribute("rel", "noopener noreferrer")
      }
    }
    for (const name of ["Unsafe", "Malformed", "Remote file", "Raw unsafe"]) {
      const link = markdown.getByText(name, { exact: true })
      await expect(link).toHaveCount(1)
      await expect(link).not.toHaveAttribute("href")
      await expect(link).not.toHaveAttribute("data-local-link")
      await expect(link).not.toHaveAttribute("onclick")
    }
    const popup = context.waitForEvent("page")
    await context.route("https://example.com/report", (route) => route.fulfill({ body: "External report" }))
    await markdown.getByRole("link", { name: "HTTPS", exact: true }).click()
    const external = await popup
    await expect(external).toHaveURL("https://example.com/report")
    expect(await external.evaluate(() => window.opener)).toBeNull()
    await external.close()
    await expect(page.getByText("Copied", { exact: true })).toHaveCount(0)
  })

  for (const failure of ["rejected", "missing", "throwing"] as const) {
    test(`reports ${failure} clipboard failure without success (new layout: ${newLayoutDesigns})`, async ({ page }) => {
      await setup(page, newLayoutDesigns)
      await page.evaluate((failure) => {
        if (failure === "missing") {
          Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
          return
        }
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: () => {
            if (failure === "throwing") throw new Error("Clipboard unavailable")
            return Promise.reject(new DOMException("Clipboard denied", "NotAllowedError"))
          },
        })
      }, failure)
      const url = page.url()
      const link = page
        .locator('[data-timeline-part-id="prt_local_links"]')
        .getByRole("link", { name: "HTML preview", exact: true })
      await expect(link).not.toHaveAttribute("href")
      await link.click()
      await expect(page.getByText("Error", { exact: true })).toBeVisible()
      await expect(page.getByText("Copied", { exact: true })).toHaveCount(0)
      await expect(page).toHaveURL(url)
    })
  }

  test(`copies through streaming, completion and cached rerenders (new layout: ${newLayoutDesigns})`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    const fixture = await setup(page, newLayoutDesigns, { text: "[Initial](./initial.html)", completed: false })
    await fixture.transport.waitForConnection()
    const markdown = page.locator('[data-component="markdown"]').filter({ hasText: "Initial" })
    await expect(markdown).toContainText("Initial")
    await expect(markdown.locator("a")).toHaveCount(1)
    await markdown.scrollIntoViewIfNeeded()
    // The existing live transcript is aria-hidden until the session becomes idle.
    const initial = markdown.locator("a").filter({ hasText: "Initial" })
    await expect(initial).not.toHaveAttribute("href")
    await initial.click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("/home/user/projects/initial.html")
    const delta = '\n\n<a href="../shared/streamed%20file.html"><strong>Streamed</strong></a>'
    await fixture.transport.send(partDelta("prt_local_links", delta))
    const streamed = markdown.locator("a").filter({ hasText: "Streamed" })
    await expect(streamed).not.toHaveAttribute("href")
    await streamed.locator("strong").click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("/home/user/shared/streamed file.html")
    fixture.message.parts[0] = { ...fixture.message.parts[0]!, text: "[Initial](./initial.html)" + delta, type: "text" }
    fixture.message.info = completedAssistantInfo(fixture.message.info)
    await fixture.transport.send(messageUpdated(fixture.message.info))
    await fixture.transport.send(partDelta("prt_local_links", "\n\nCompleted."))
    await expect(markdown).toContainText("Completed.")
    await fixture.transport.send(status("idle"))
    await expect(markdown.getByRole("link", { name: "Streamed", exact: true })).toBeVisible()
    await streamed.focus()
    await streamed.press("Enter")
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("/home/user/shared/streamed file.html")
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await expect(markdown).toHaveCount(0)
    await page.goBack()
    await expect(streamed).not.toHaveAttribute("href")
    await initial.click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("/home/user/projects/initial.html")
  })

  test(`resolves each session against its own workspace (new layout: ${newLayoutDesigns})`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    const otherID = "ses_other_workspace"
    await setup(page, newLayoutDesigns, {
      sessions: [
        session({ directory }),
        session({ id: otherID, directory: "/srv/other-project", title: "Other workspace" }),
      ],
      messages: (id) =>
        [userMessage(), assistantMessage([textPart(`prt_${id}_links`, "[Workspace report](./docs/report.html)")])].map(
          (message) => ({
            ...message,
            info: { ...message.info, sessionID: id },
            parts: message.parts.map((part) => ({ ...part, sessionID: id })),
          }),
        ),
    })
    for (const [id, expected] of [
      [sessionID, "/home/user/projects/docs/report.html"],
      [otherID, "/srv/other-project/docs/report.html"],
      [sessionID, "/home/user/projects/docs/report.html"],
    ]) {
      if (id !== sessionID || page.url().endsWith(otherID)) {
        const href = `/server/${base64Encode(server)}/session/${id}`
        if (newLayoutDesigns) await page.locator(`a[data-titlebar-tab-link][href="${href}"]`).click()
        else await page.goto(href)
      }
      const link = page
        .locator('[data-component="markdown"]')
        .getByRole("link", { name: "Workspace report", exact: true })
      await expect(link).not.toHaveAttribute("href")
      await link.click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected)
    }
  })
  test(`preserves selection and copy-response behavior (new layout: ${newLayoutDesigns})`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await setup(page, newLayoutDesigns)
    const markdown = page.locator('[data-timeline-part-id="prt_local_links"] [data-component="markdown"]')
    const link = markdown.getByRole("link", { name: "HTML preview", exact: true })
    await expect(link).not.toHaveAttribute("href")
    await page.evaluate(() => navigator.clipboard.writeText("Unchanged clipboard"))
    await link.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })
    await link.dispatchEvent("click", { button: 0 })
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Unchanged clipboard")
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("HTML preview")
    await expect(page.getByText("Copied", { exact: true })).toHaveCount(0)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await markdown.hover()
    await page.getByRole("button", { name: "Copy response", exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(reproduction)
  })

  test(`copies local paths on a narrow viewport (new layout: ${newLayoutDesigns})`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.setViewportSize({ width: 390, height: 844 })
    await setup(page, newLayoutDesigns)
    const link = page
      .locator('[data-timeline-part-id="prt_local_links"]')
      .getByRole("link", { name: "Mobile screenshot", exact: true })
    await expect(link).not.toHaveAttribute("href")
    const url = page.url()
    await link.click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("/tmp/opencode/aml-email-mobile-candidates.png")
    await expect(page.getByText("Copied", { exact: true })).toBeVisible()
    await expect(page).toHaveURL(url)
  })
}

async function setup(
  page: Page,
  newLayoutDesigns: boolean,
  input: {
    text?: string
    completed?: boolean
    sessions?: ReturnType<typeof session>[]
    messages?: (sessionID: string) => TimelineMessage[]
  } = {},
) {
  // Keep the classic layout available before its existing retirement date.
  await page.clock.setFixedTime(new Date("2026-09-01T12:00:00Z"))
  const message = assistantMessage([textPart("prt_local_links", input.text ?? reproduction)], {
    completed: input.completed,
  })
  const transport = await installSseTransport<TimelineEvent>(page, { server })
  await mockOpenCodeServer(page, {
    directory,
    project: { ...project(), worktree: directory },
    provider: { all: [], connected: [], default: {} },
    sessions: input.sessions ?? [session({ directory })],
    sessionStatus: { [sessionID]: { type: input.completed === false ? "busy" : "idle" } },
    pageMessages: (id) => ({ items: input.messages?.(id) ?? [userMessage(), message] }),
  })
  await page.route(/\/api\/(health|location|model\/default)(?:\?|$)/, (route) =>
    route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" } }),
  )
  await page.route("**/global/projects", (route) =>
    route.fulfill({ json: [{ ...project(), worktree: directory }], headers: { "access-control-allow-origin": "*" } }),
  )
  await page.addInitScript(
    ({ newLayoutDesigns, server, sessions }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns, shouldDisplayTabsToast: false } }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(sessions.map((sessionId) => ({ type: "session", server, sessionId }))),
      )
      if (!newLayoutDesigns) localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
    },
    { newLayoutDesigns, server, sessions: (input.sessions ?? [session()]).map((session) => session.id) },
  )
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expect(page).toHaveURL(
    new RegExp(
      `/${newLayoutDesigns ? `server/${base64Encode(server)}` : base64Encode(directory)}/session/${sessionID}$`,
    ),
  )
  if (newLayoutDesigns) await expect(page.locator("body")).toHaveAttribute("data-new-layout")
  else await expect(page.locator("body")).not.toHaveAttribute("data-new-layout")
  return { transport, message }
}
