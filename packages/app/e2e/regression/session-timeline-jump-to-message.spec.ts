import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  completedAssistantInfo,
  messageUpdated,
  partUpdated,
  setupTimeline,
  status,
  textPart,
  userMessage,
  userText,
} from "../performance/timeline-stability/fixture"

const earlierID = "msg_1000_jump_earlier"
const laterID = "msg_2000_jump_later"
const timeline = [
  userMessage([userText("Earlier prompt", { id: `prt_${earlierID}_text` })], {
    id: earlierID,
    created: 1_700_000_000_000,
  }),
  assistantMessage([textPart("prt_jump_earlier_response", "Earlier response")], {
    id: "msg_1001_jump_earlier_assistant",
    parentID: earlierID,
    created: 1_700_000_001_000,
  }),
  userMessage([userText("Later prompt", { id: `prt_${laterID}_text` })], {
    id: laterID,
    created: 1_700_000_002_000,
  }),
  assistantMessage([textPart("prt_jump_later_response", "Later response")], {
    id: "msg_2001_jump_later_assistant",
    parentID: laterID,
    created: 1_700_000_003_000,
  }),
]
const pagedTimeline = [
  ...timeline,
  ...Array.from({ length: 151 }, (_, index) => {
    const id = `msg_3000_jump_padding_${index}`
    const created = 1_700_000_010_000 + index * 2_000
    return [
      userMessage([userText("Padding prompt", { id: `prt_${id}_text` })], { id, created }),
      assistantMessage([textPart(`prt_${id}_response`, "Padding response")], {
        id: `${id}_assistant`,
        parentID: id,
        created: created + 1_000,
      }),
    ]
  }).flat(),
]

for (const newLayoutDesigns of [false, true]) {
  test(`searches and jumps to a user message in the ${newLayoutDesigns ? "V2" : "legacy"} menu`, async ({ page }) => {
    let failNextHistoryPage = false
    const app = await setupTimeline(page, {
      messages: pagedTimeline,
      pageMessages: (_sessionID, limit, before) => {
        const end = before ? Number(before) : pagedTimeline.length
        const start = Math.max(0, end - limit)
        return { items: pagedTimeline.slice(start, end), cursor: start ? String(start) : undefined }
      },
      settings: { newLayoutDesigns },
      viewport: newLayoutDesigns ? { width: 390, height: 844 } : undefined,
    })
    await page.route("**/session/*/message**", async (route) => {
      const url = new URL(route.request().url())
      if (
        failNextHistoryPage &&
        (url.searchParams.has("before") || url.searchParams.has("cursor"))
      ) {
        failNextHistoryPage = false
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "temporary" }) })
        return
      }
      await route.fallback()
    })
    await page.getByRole("button", { name: "More options", exact: true }).click()
    if (!newLayoutDesigns) failNextHistoryPage = true
    await page.getByRole("menuitem", { name: "Search", exact: true }).click()
    const search = page.locator(".dialog-jump-to-message input")
    if (!newLayoutDesigns) {
      await expect(page.getByRole("alert")).toBeVisible()
      await expect(search).toBeFocused()
      await page.waitForTimeout(250)
      await expect(page.getByRole("alert")).toBeVisible()
      await page.locator(".dialog-jump-to-message-retry").click()
      await search.focus()
    }
    if (newLayoutDesigns) {
      await expect(page.locator(".dialog-jump-to-message-status")).toHaveCount(0)
      await page.keyboard.press("Escape")
      await expect(page.locator(".dialog-jump-to-message")).toHaveCount(0)
      const assistant = assistantMessage([], {
        id: "msg_jump_after_cancel",
        parentID: pagedTimeline.at(-2)!.info.id,
        completed: false,
        created: 1_700_000_500_000,
      })
      await app.sendAll([
        { event: status("busy"), delay: 50 },
        { event: messageUpdated(assistant.info), delay: 50 },
        {
          event: partUpdated(
            textPart("prt_jump_after_cancel", Array.from({ length: 100 }, (_, index) => `Follow line ${index}`).join("\n")),
            assistant.info.id,
          ),
          delay: 50,
        },
        { event: messageUpdated(completedAssistantInfo(assistant.info)), delay: 50 },
        { event: status("idle"), delay: 50 },
      ])
      const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
        .toBeLessThanOrEqual(1)
      await page.getByRole("button", { name: "More options", exact: true }).click()
      await page.getByRole("menuitem", { name: "Search", exact: true }).click()
      await expect(page.locator(".dialog-jump-to-message-status")).toHaveCount(0)
    }

    await expect(search).toBeFocused()
    await search.fill("Earlier")
    await expect(page.getByRole("option")).toHaveCount(1)
    await expect(page.locator(".dialog-jump-to-message-preview mark")).toHaveText("Earlier")

    await search.fill("EARLIER\\s+PROMPT")
    await expect(page.getByRole("option")).toHaveCount(0)
    await page.locator(".dialog-jump-to-message-regex").click()
    await expect(page.getByRole("option")).toHaveCount(1)
    await expect(page.locator(".dialog-jump-to-message-preview mark")).toHaveText("Earlier prompt")
    await search.press("ArrowDown")
    await search.press("Enter")

    await expect(page).toHaveURL(new RegExp(`#message-${earlierID}$`))
    await expect(page.locator(`#message-${earlierID}`)).toBeInViewport()
  })
}
