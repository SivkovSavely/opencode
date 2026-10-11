import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import {
  assistantMessage,
  directory,
  event,
  setupTimeline,
  session,
  sessionID,
  userMessage,
  userText,
} from "../performance/timeline-stability/fixture"

const earlierID = "msg_1000_jump_earlier"
const laterID = "msg_2000_jump_later"
const otherSessionID = "ses_jump_other_session"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const lastPaddingIndex = 1_000
const timeline = [
  userMessage([userText("Earlier prompt", { id: `prt_${earlierID}_text` })], {
    id: earlierID,
    created: 1_700_000_000_000,
  }),
  assistantMessage([], {
    id: "msg_1001_jump_earlier_assistant",
    parentID: earlierID,
    created: 1_700_000_001_000,
  }),
  userMessage([userText("Later prompt", { id: `prt_${laterID}_text` })], {
    id: laterID,
    created: 1_700_000_002_000,
  }),
  assistantMessage([], {
    id: "msg_2001_jump_later_assistant",
    parentID: laterID,
    created: 1_700_000_003_000,
  }),
]
const pagedTimeline = [
  ...timeline,
  ...Array.from({ length: lastPaddingIndex + 1 }, (_, index) => {
    const id = `msg_3000_jump_padding_${index}`
    const created = 1_700_000_010_000 + index * 2_000
    return [
      userMessage([userText(`Padding prompt ${index}`, { id: `prt_${id}_text` })], { id, created }),
      assistantMessage([], {
        id: `${id}_assistant`,
        parentID: id,
        created: created + 1_000,
      }),
    ]
  }).flat(),
]
const manySearchMessages = Array.from({ length: 200 }, (_, index) => {
  const id = `msg_4000_jump_search_${String(index).padStart(4, "0")}`
  return userMessage([userText(`Search prompt ${index}`, { id: `prt_${id}_text` })], {
    id,
    created: 1_700_100_000_000 + index * 1_000,
  })
})

for (const newLayoutDesigns of [false, true]) {
  test(`uses the approved Jump to message dialog from the ${newLayoutDesigns ? "V2" : "legacy"} menu`, async ({ page }) => {
    await setupTimeline(page, {
      messages: timeline,
      settings: { newLayoutDesigns },
      viewport: newLayoutDesigns ? { width: 390, height: 844 } : undefined,
    })

    await page.getByRole("button", { name: "More options", exact: true }).click()
    const menuItems = page.getByRole("menuitem")
    const labels = (await menuItems.allTextContents()).map((label) => label.trim())
    const jumpIndex = labels.indexOf("Jump to message...")
    expect(labels[jumpIndex - 1]).toBe("Export...")
    expect(labels[jumpIndex + 1]).toBe("Archive")
    await page.getByRole("menuitem", { name: "Jump to message...", exact: true }).click()

    const dialog = page.getByRole("dialog")
    const search = dialog.getByRole("textbox", { name: "Search user messages..." })
    await expect(dialog.getByRole("heading", { name: "Jump to message" })).toBeVisible()
    await expect(search).toBeFocused()
    await expect(search).toHaveAttribute("placeholder", "Search user messages...")
    await expect(dialog.getByText("2 of 2 messages", { exact: true })).toBeVisible()
    await expect(dialog.getByText("· / regex", { exact: true })).toBeVisible()

    const earlier = dialog.getByRole("option").filter({ hasText: "Earlier prompt" })
    await expect(earlier).toHaveCount(1)
    await expect(earlier.locator("time")).toHaveText(/\d{2}:\d{2}:\d{2}/)
    await earlier.locator("time").hover()
    await expect(earlier.locator("time")).toHaveAttribute("title", /2023.*\d{2}:\d{2}:\d{2}/)
    await expect(earlier).toHaveCSS("height", "34px")
    await expect(earlier.locator(".dialog-jump-to-message-preview")).toHaveCSS("white-space", "nowrap")
    expect(await earlier.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

    await search.fill("Earlier")
    const clear = dialog.getByRole("button", { name: "Clear", exact: true })
    await expect(clear).toBeVisible()
    await clear.click()
    await expect(search).toHaveValue("")
    await expect(search).toBeFocused()

    await search.fill("/[")
    await expect(dialog.getByRole("alert")).toHaveText("Invalid regular expression")
    await expect(dialog.getByText("Regex mode", { exact: false })).toBeVisible()
    await search.press("Escape")
    await expect(search).toHaveValue("")
    await expect(dialog).toBeVisible()
    await search.press("Escape")
    await expect(dialog).toHaveCount(0)

    await openJumpToMessage(page)
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await openJumpToMessage(page)
    const reopened = page.getByRole("dialog")
    const reopenedSearch = reopened.getByRole("textbox", { name: "Search user messages..." })
    await reopenedSearch.fill("/Earlier/i")
    const match = reopened.getByRole("option").filter({ hasText: "Earlier prompt" })
    await expect(match.locator("mark")).toHaveText("Earlier")
    await expect(reopened.getByText("1 of 2 messages · Regex mode", { exact: true })).toBeVisible()

    if (newLayoutDesigns) {
      await match.click()
    } else {
      await reopenedSearch.fill("/prompt/i")
      const later = reopened.getByRole("option").filter({ hasText: "Later prompt" })
      await expect(reopened.getByRole("option")).toHaveCount(2)
      await reopenedSearch.press("ArrowDown")
      await expect(match).toHaveAttribute("aria-selected", "true")
      await reopenedSearch.press("ArrowDown")
      await expect(later).toHaveAttribute("aria-selected", "true")
      await reopenedSearch.press("ArrowUp")
      await expect(match).toHaveAttribute("aria-selected", "true")
      await reopenedSearch.press("Enter")
    }
    await expect(page).toHaveURL(new RegExp(`#message-${earlierID}$`))
    await expect(page.locator(`#message-${earlierID}`)).toBeInViewport()
  })
}

test("updates searchable text when a message part is reconciled in place", async ({ page }) => {
  const fixture = await setupTimeline(page, {
    messages: timeline,
    settings: { newLayoutDesigns: true },
  })
  await openJumpToMessage(page)

  const dialog = page.getByRole("dialog")
  const search = dialog.getByRole("textbox", { name: "Search user messages..." })
  await search.fill("Updated")
  await expect(dialog.getByRole("option")).toHaveCount(0)

  await fixture.send(
    event("message.part.updated", {
      sessionID,
      part: {
        ...userText("Updated earlier prompt", { id: `prt_${earlierID}_text` }),
        sessionID,
        messageID: earlierID,
      },
      time: 1_700_000_004_000,
    }),
  )

  const updated = dialog.getByRole("option").filter({ hasText: "Updated earlier prompt" })
  await expect(updated).toHaveCount(1)
  await expect(updated.locator("mark")).toHaveText("Updated")
})

test("resets the virtualized results to the first match whenever the query changes", async ({ page }) => {
  await setupTimeline(page, {
    messages: manySearchMessages,
    pageMessages: () => ({ items: manySearchMessages }),
    settings: { newLayoutDesigns: true },
  })
  await openJumpToMessage(page)

  const dialog = page.getByRole("dialog")
  const search = dialog.getByRole("textbox", { name: "Search user messages..." })
  const viewport = dialog.locator(".dialog-jump-to-message-scroll .scroll-view__viewport")
  const firstID = manySearchMessages[0].info.id
  const first = dialog.getByRole("option").filter({ hasText: "Search prompt 0" })

  await search.fill("/prompt/i")
  await expect(dialog.getByText("200 of 200 messages · Regex mode", { exact: true })).toBeVisible()
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await search.fill("prompt")
  await expect(dialog.getByText("200 of 200 messages", { exact: true })).toBeVisible()
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(first).toBeInViewport()
  await search.press("Enter")
  await expect(page).toHaveURL(new RegExp(`#message-${firstID}$`))

  await openJumpToMessage(page)
  const reopened = page.getByRole("dialog")
  const reopenedSearch = reopened.getByRole("textbox", { name: "Search user messages..." })
  const reopenedViewport = reopened.locator(".dialog-jump-to-message-scroll .scroll-view__viewport")
  const reopenedFirst = reopened.getByRole("option").filter({ hasText: "Search prompt 0" })

  await reopenedSearch.fill("prompt")
  await reopenedViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => reopenedViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await reopened.getByRole("button", { name: "Clear", exact: true }).click()
  await expect(reopenedSearch).toHaveValue("")
  await expect.poll(() => reopenedViewport.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(reopenedFirst).toBeInViewport()

  await reopenedSearch.fill("no matching message")
  await expect(reopened.getByRole("option")).toHaveCount(0)
  await reopenedSearch.fill("prompt")
  await expect(reopenedFirst).toBeInViewport()
  await expect.poll(() => reopenedViewport.evaluate((element) => element.scrollTop)).toBe(0)
  await reopenedViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => reopenedViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await reopenedSearch.press("Escape")
  await expect(reopenedSearch).toHaveValue("")
  await expect.poll(() => reopenedViewport.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(reopenedFirst).toBeInViewport()

  await reopenedSearch.fill("/prompt/i")
  await reopenedSearch.evaluate((element: HTMLInputElement) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }))
    element.value = "Search prompt 0"
    element.dispatchEvent(new InputEvent("input", { bubbles: true }))
  })
  await expect(reopened.getByText("1 of 200 messages", { exact: true })).toBeVisible()
  await expect(reopenedFirst).toBeInViewport()
  await expect.poll(() => reopenedViewport.evaluate((element) => element.scrollTop)).toBe(0)
})

test("continues paging across V2 history pages with only metadata records", async ({ page }) => {
  const older = userMessage([userText("Older metadata prompt", { id: "prt_msg_0500_jump_metadata_text" })], {
    id: "msg_0500_jump_metadata_older",
    created: 1_699_999_000_000,
  })
  const olderAssistant = assistantMessage([], {
    id: "msg_0501_jump_metadata_assistant",
    parentID: older.info.id,
    created: 1_699_999_001_000,
  })
  await setupTimeline(page, {
    protocol: "v2",
    messages: timeline,
    pageMessages: (_sessionID, _limit, before) => {
      if (!before) return { items: timeline, cursor: "metadata" }
      if (before === "metadata") {
        return {
          items: [
            { id: "msg_0900_jump_agent", type: "agent-switched", agent: "build", time: { created: 1_699_998_000_000 } },
            {
              id: "msg_0901_jump_model",
              type: "model-switched",
              model: { id: "model", providerID: "provider" },
              time: { created: 1_699_998_001_000 },
            },
          ],
          cursor: "older",
        }
      }
      return { items: [older, olderAssistant] }
    },
    settings: { newLayoutDesigns: true },
  })

  await openJumpToMessage(page)
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("option").filter({ hasText: "Older metadata prompt" })).toHaveCount(1)
  await expect(dialog.getByText("3 of 3 messages", { exact: true })).toBeVisible()
  await expect(dialog.locator(".dialog-jump-to-message-status")).toHaveCount(0)
})

test("searches loaded messages while older pages load, then jumps to an unloaded result", async ({ page }) => {
  let holdNextHistoryPage = false
  let releaseHistoryPage!: () => void
  const historyGate = new Promise<void>((resolve) => (releaseHistoryPage = resolve))
  await setupTimeline(page, {
    messages: pagedTimeline,
    pageMessages: (_sessionID, limit, before) => {
      const end = before ? Number(before) : pagedTimeline.length
      const start = Math.max(0, end - limit)
      return { items: pagedTimeline.slice(start, end), cursor: start ? String(start) : undefined }
    },
    settings: { newLayoutDesigns: true },
    viewport: { width: 390, height: 844 },
  })
  await page.route("**/session/*/message**", async (route) => {
    const url = new URL(route.request().url())
    if (holdNextHistoryPage && (url.searchParams.has("before") || url.searchParams.has("cursor"))) {
      holdNextHistoryPage = false
      await historyGate
    }
    await route.fallback()
  })

  holdNextHistoryPage = true
  const historyRequest = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname.includes("/message") && (url.searchParams.has("before") || url.searchParams.has("cursor"))
  })
  await openJumpToMessage(page)
  await historyRequest

  const dialog = page.getByRole("dialog")
  const search = dialog.getByRole("textbox", { name: "Search user messages..." })
  await expect(dialog.locator(".dialog-jump-to-message-status")).toBeVisible()
  await expect(dialog.locator(".dialog-jump-to-message-count")).toHaveText(/\d+ of \d+ loaded messages/)
  await search.fill(`Padding prompt ${lastPaddingIndex}`)
  await expect(dialog.getByRole("option")).toHaveCount(1)
  const mobileRow = dialog.getByRole("option")
  await expect(mobileRow.locator(".dialog-jump-to-message-preview")).toHaveCSS("white-space", "nowrap")
  expect(await mobileRow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

  await search.fill("Earlier")
  await expect(dialog.getByRole("option")).toHaveCount(0)
  releaseHistoryPage()
  await expect(dialog.getByRole("option")).toHaveCount(1)
  await expect(dialog.locator(".dialog-jump-to-message-status")).toHaveCount(0)
  await expect(dialog.getByText("1 of 1003 messages", { exact: true })).toBeVisible()

  await search.fill("/./g")
  await expect(dialog.getByText("Regex mode", { exact: false })).toBeVisible()
  await expect.poll(() => dialog.getByRole("option").count()).toBeGreaterThan(0)
  expect(await dialog.getByRole("option").count()).toBeLessThan(50)
  expect(await dialog.locator("mark").count()).toBe(await dialog.getByRole("option").count())

  await search.press("ArrowDown")
  const activeID = await search.getAttribute("aria-activedescendant")
  expect(activeID).not.toBeNull()
  if (!activeID) throw new Error("Arrow navigation should activate a result")
  const activeOption = dialog.locator(`#${activeID}`)
  const resultViewport = dialog.locator(".dialog-jump-to-message-scroll .scroll-view__viewport")
  await expect(activeOption).toHaveAttribute("aria-selected", "true")
  await resultViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(activeOption).toHaveAttribute("aria-selected", "true")
  await expect(search).toHaveAttribute("aria-activedescendant", activeID)

  await search.fill("Earlier")
  await dialog.getByRole("option").filter({ hasText: "Earlier prompt" }).click()
  await expect(page).toHaveURL(new RegExp(`#message-${earlierID}$`))
  await expect(page.locator(`#message-${earlierID}`)).toBeInViewport()
})

test("keeps the results scroll position when an older page adds matches", async ({ page }) => {
  let holdNextHistoryPage = false
  let releaseHistoryPage!: () => void
  const historyGate = new Promise<void>((resolve) => (releaseHistoryPage = resolve))
  await setupTimeline(page, {
    messages: pagedTimeline,
    pageMessages: (_sessionID, limit, before) => {
      const end = before ? Number(before) : pagedTimeline.length
      const start = Math.max(0, end - (before ? limit : 120))
      return { items: pagedTimeline.slice(start, end), cursor: start ? String(start) : undefined }
    },
    settings: { newLayoutDesigns: true },
    viewport: { width: 390, height: 500 },
  })
  await page.route("**/session/*/message**", async (route) => {
    const url = new URL(route.request().url())
    if (holdNextHistoryPage && (url.searchParams.has("before") || url.searchParams.has("cursor"))) {
      holdNextHistoryPage = false
      await historyGate
    }
    await route.fallback()
  })

  holdNextHistoryPage = true
  const historyRequest = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname.includes("/message") && (url.searchParams.has("before") || url.searchParams.has("cursor"))
  })
  await openJumpToMessage(page)
  await historyRequest

  const dialog = page.getByRole("dialog")
  const search = dialog.getByRole("textbox", { name: "Search user messages..." })
  const viewport = dialog.locator(".dialog-jump-to-message-scroll .scroll-view__viewport")
  await search.fill("/./g")
  await expect(dialog.locator(".dialog-jump-to-message-count")).toHaveText("60 of 60 loaded messages · Regex mode")
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  releaseHistoryPage()
  await expect(dialog.locator(".dialog-jump-to-message-count")).toHaveText("1003 of 1003 messages · Regex mode")
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})

test("continues through overlapping history pages with advancing cursors", async ({ page }) => {
  const older = userMessage([userText("Older overlapping prompt", { id: "prt_msg_0500_jump_overlap_text" })], {
    id: "msg_0500_jump_overlap_older",
    created: 1_699_999_000_000,
  })
  const olderAssistant = assistantMessage([], {
    id: "msg_0501_jump_overlap_assistant",
    parentID: older.info.id,
    created: 1_699_999_001_000,
  })
  const cursors: Array<string | undefined> = []
  await setupTimeline(page, {
    protocol: "v2",
    messages: timeline,
    pageMessages: (_sessionID, _limit, before) => {
      cursors.push(before)
      if (!before) return { items: timeline, cursor: "cursor-A" }
      if (before === "cursor-A") return { items: timeline, cursor: "cursor-B" }
      if (before === "cursor-B") return { items: [older, olderAssistant] }
      throw new Error(`Unexpected cursor: ${before}`)
    },
    settings: { newLayoutDesigns: true },
  })

  await openJumpToMessage(page)
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("3 of 3 messages", { exact: true })).toBeVisible()
  await expect(dialog.locator(".dialog-jump-to-message-status")).toHaveCount(0)
  await expect(dialog.getByRole("option")).toHaveCount(3)
  const optionIDs = await dialog.getByRole("option").evaluateAll((items) => items.map((item) => item.id))
  expect(new Set(optionIDs).size).toBe(3)
  expect(cursors.filter((cursor) => cursor !== undefined)).toEqual(["cursor-A", "cursor-B"])

  const search = dialog.getByRole("textbox", { name: "Search user messages..." })
  await search.fill("Older overlapping prompt")
  await expect(dialog.getByRole("option")).toHaveCount(1)
  await search.press("Enter")
  await expect(page).toHaveURL(/#message-msg_0500_jump_overlap_older$/)
  await expect(page.locator("#message-msg_0500_jump_overlap_older")).toBeInViewport()
})

test("keeps a selected result visible when an older page finishes afterward", async ({ page }) => {
  let holdNextHistoryPage = false
  let releaseHistoryPage!: () => void
  const historyGate = new Promise<void>((resolve) => (releaseHistoryPage = resolve))
  await setupTimeline(page, {
    messages: pagedTimeline,
    pageMessages: (_sessionID, limit, before) => {
      const end = before ? Number(before) : pagedTimeline.length
      const start = Math.max(0, end - limit)
      return { items: pagedTimeline.slice(start, end), cursor: before ? undefined : String(start) }
    },
    settings: { newLayoutDesigns: true },
    reducedMotion: true,
  })
  await page.route("**/session/*/message**", async (route) => {
    const url = new URL(route.request().url())
    if (holdNextHistoryPage && (url.searchParams.has("before") || url.searchParams.has("cursor"))) {
      holdNextHistoryPage = false
      await historyGate
    }
    await route.fallback()
  })

  holdNextHistoryPage = true
  const isHistoryPage = (url: URL) => url.pathname.includes("/message") && (url.searchParams.has("before") || url.searchParams.has("cursor"))
  const historyRequest = page.waitForRequest((request) => isHistoryPage(new URL(request.url())))
  const historyResponse = page.waitForResponse((response) => isHistoryPage(new URL(response.url())))
  await openJumpToMessage(page)
  await historyRequest

  const dialog = page.getByRole("dialog")
  const search = dialog.getByRole("textbox", { name: "Search user messages..." })
  const targetID = "msg_3000_jump_padding_991"
  await search.fill("Padding prompt 991")
  await dialog.getByRole("option").filter({ hasText: "Padding prompt 991" }).click()
  await expect(page).toHaveURL(new RegExp(`#message-${targetID}$`))
  const target = page.locator(`#message-${targetID}`)
  await expect(target).toBeInViewport()

  releaseHistoryPage()
  await historyResponse
  await openJumpToMessage(page)
  const loadedDialog = page.getByRole("dialog")
  await expect(loadedDialog.getByText("110 of 110 messages", { exact: true })).toBeVisible()
  await loadedDialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(target).toBeInViewport()
})

test("switching sessions during history loading discards the old dialog results", async ({ page }) => {
  let holdNextHistoryPage = false
  let releaseHistoryPage!: () => void
  const historyGate = new Promise<void>((resolve) => (releaseHistoryPage = resolve))
  const pageErrors: Error[] = []
  await page.addInitScript(({ directory, dirBase64, server, sessionIDs }) => {
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({
      projects: { local: [{ worktree: directory, expanded: true }] },
      lastProject: { local: directory },
    }))
    localStorage.setItem(
      "opencode.window.browser.dat:tabs",
      JSON.stringify(sessionIDs.map((id) => ({ type: "session", server, dirBase64, sessionId: id }))),
    )
  }, {
    directory,
    dirBase64: base64Encode(directory),
    server,
    sessionIDs: [sessionID, otherSessionID],
  })
  await setupTimeline(page, {
    messages: pagedTimeline,
    sessions: [session(), session({ id: otherSessionID, title: "Other session" })],
    pageMessages: (id, limit, before) => {
      if (id !== sessionID) return { items: [] }
      const end = before ? Number(before) : pagedTimeline.length
      const start = Math.max(0, end - limit)
      return { items: pagedTimeline.slice(start, end), cursor: start ? String(start) : undefined }
    },
    settings: { newLayoutDesigns: true },
    viewport: { width: 390, height: 844 },
  })
  const sourceTab = page.locator('[data-slot="titlebar-tabs"] a').filter({ hasText: "Timeline visual stability" })
  const otherTab = page.locator('[data-slot="titlebar-tabs"] a').filter({ hasText: "Other session" })
  await expect(otherTab).toBeVisible()
  await otherTab.click()
  await expect(page.getByRole("heading", { name: "Other session", exact: true })).toBeVisible()
  await sourceTab.click()
  await expect(page.getByRole("heading", { name: "Timeline visual stability", exact: true })).toBeVisible()

  page.on("pageerror", (error) => pageErrors.push(error))
  await page.route("**/session/*/message**", async (route) => {
    const url = new URL(route.request().url())
    if (holdNextHistoryPage && (url.searchParams.has("before") || url.searchParams.has("cursor"))) {
      holdNextHistoryPage = false
      await historyGate
    }
    await route.fallback()
  })

  holdNextHistoryPage = true
  const historyRequest = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname.includes("/message") && (url.searchParams.has("before") || url.searchParams.has("cursor"))
  })
  await openJumpToMessage(page)
  await historyRequest
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Other session", exact: true })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  releaseHistoryPage()
  await expect(page).toHaveURL(new RegExp(`/session/${otherSessionID}$`))
  expect(pageErrors).toEqual([])
})

test("keeps partial results after history failure and retries older pages", async ({ page }) => {
  let failNextHistoryPage = true
  await setupTimeline(page, {
    messages: pagedTimeline,
    pageMessages: (_sessionID, limit, before) => {
      const end = before ? Number(before) : pagedTimeline.length
      const start = Math.max(0, end - limit)
      return { items: pagedTimeline.slice(start, end), cursor: start ? String(start) : undefined }
    },
    settings: { newLayoutDesigns: true },
  })
  await page.route("**/session/*/message**", async (route) => {
    const url = new URL(route.request().url())
    if (failNextHistoryPage && (url.searchParams.has("before") || url.searchParams.has("cursor"))) {
      failNextHistoryPage = false
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "temporary" }) })
      return
    }
    await route.fallback()
  })

  await openJumpToMessage(page)
  const dialog = page.getByRole("dialog")
  const search = dialog.getByRole("textbox", { name: "Search user messages..." })
  await expect(dialog.getByRole("alert")).toHaveText("Request failed")
  await expect(dialog.locator(".dialog-jump-to-message-count")).toHaveText(/\d+ of \d+ loaded messages/)
  await search.fill(`Padding prompt ${lastPaddingIndex}`)
  await expect(dialog.getByRole("option")).toHaveCount(1)
  await search.fill("Earlier")
  await expect(dialog.getByRole("option")).toHaveCount(0)

  await dialog.getByRole("button", { name: "Load more", exact: true }).click()
  await expect(dialog.getByRole("option")).toHaveCount(1)
  await expect(dialog.getByText("1 of 1003 messages", { exact: true })).toBeVisible()
})

test("closes during history loading without losing follow state or reporting late failures", async ({ page }) => {
  let holdNextHistoryPage = false
  let releaseHistoryPage!: () => void
  const historyGate = new Promise<void>((resolve) => (releaseHistoryPage = resolve))
  const pageErrors: Error[] = []
  await setupTimeline(page, {
    messages: pagedTimeline,
    pageMessages: (_sessionID, limit, before) => {
      const end = before ? Number(before) : pagedTimeline.length
      const start = Math.max(0, end - limit)
      return { items: pagedTimeline.slice(start, end), cursor: start ? String(start) : undefined }
    },
    settings: { newLayoutDesigns: true },
  })
  page.on("pageerror", (error) => pageErrors.push(error))
  await page.route("**/session/*/message**", async (route) => {
    const url = new URL(route.request().url())
    if (holdNextHistoryPage && (url.searchParams.has("before") || url.searchParams.has("cursor"))) {
      holdNextHistoryPage = false
      await historyGate
    }
    await route.fallback()
  })

  holdNextHistoryPage = true
  const isHistoryRequest = (url: URL) => url.pathname.includes("/message") && (url.searchParams.has("before") || url.searchParams.has("cursor"))
  const historyRequest = page.waitForRequest((request) => isHistoryRequest(new URL(request.url())))
  const historyResponse = page.waitForResponse((response) => isHistoryRequest(new URL(response.url())))
  await openJumpToMessage(page)
  await historyRequest
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator(".dialog-jump-to-message-status")).toBeVisible()
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  releaseHistoryPage()
  await historyResponse

  const timelineScroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await expect
    .poll(() => timelineScroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
  expect(pageErrors).toEqual([])
})

test("stops automatic pagination when an older page makes no progress", async ({ page }) => {
  let historyRequests = 0
  await setupTimeline(page, {
    messages: pagedTimeline,
    pageMessages: (_sessionID, limit, before) => {
      const end = before ? Number(before) : pagedTimeline.length
      const start = Math.max(0, end - limit)
      if (before) return { items: pagedTimeline.slice(-limit), cursor: before }
      return { items: pagedTimeline.slice(start, end), cursor: start ? String(start) : undefined }
    },
    settings: { newLayoutDesigns: true },
  })
  await page.route("**/session/*/message**", async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.has("before") || url.searchParams.has("cursor")) {
      historyRequests++
    }
    await route.fallback()
  })

  await openJumpToMessage(page)
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect.poll(() => historyRequests).toBe(2)
  await expect(dialog.locator(".dialog-jump-to-message-count")).toHaveText(/\d+ of \d+ loaded messages/)
})

async function openJumpToMessage(page: Page) {
  await page.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Jump to message...", exact: true }).click()
}
