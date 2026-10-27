import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, userMessage, userText } from "../performance/timeline-stability/fixture"

for (const newLayoutDesigns of [false, true]) {
  test(`renders and navigates to individual user text parts (new layout: ${newLayoutDesigns})`, async ({ page }) => {
    const messageID = "msg_multipart_user"
    const firstID = "prt_multipart_first"
    const secondID = "prt_multipart_second"
    const singleID = "prt_single_text"
    const first = "  Use @src/a.ts\n"
    const second = "  Use @src/a.ts needle @src/b.ts @explore  "
    await setupTimeline(page, {
      settings: { newLayoutDesigns },
      messages: [
        userMessage(
          [
            userText(first, { id: firstID }),
            userText("hidden synthetic", { id: "prt_synthetic", synthetic: true }),
            userText("hidden comment source", {
              id: "prt_comment",
              synthetic: true,
              metadata: { opencodeComment: { path: "src/a.ts", comment: "Keep this comment" } },
            }),
            {
              id: "prt_inline_file",
              type: "file",
              mime: "text/plain",
              filename: "a.ts",
              url: "src/a.ts",
              source: { type: "file", path: "src/a.ts", text: { value: "@src/a.ts", start: 6, end: 15 } },
            },
            userText(second, { id: secondID }),
            {
              id: "prt_repeat_file",
              type: "file",
              mime: "text/plain",
              url: "src/a.ts",
              source: { type: "file", path: "src/a.ts", text: { value: "@src/a.ts", start: 6, end: 15 } },
            },
            {
              id: "prt_second_file",
              type: "file",
              mime: "text/plain",
              filename: "b.ts",
              url: "src/b.ts",
              source: {
                type: "file",
                path: "src/b.ts",
                text: { value: "@src/b.ts", start: second.indexOf("@src/b.ts"), end: second.indexOf("@src/b.ts") + 9 },
              },
            },
            {
              id: "prt_second_agent",
              type: "agent",
              name: "explore",
              source: { value: "@explore", start: second.indexOf("@explore"), end: second.indexOf("@explore") + 8 },
            },
            {
              id: "prt_stale_file",
              type: "file",
              mime: "text/plain",
              url: "src/stale.ts",
              source: { type: "file", path: "src/stale.ts", text: { value: "@missing", start: 2, end: 10 } },
            },
            {
              id: "prt_attachment",
              type: "file",
              mime: "application/json",
              filename: "data.json",
              url: "data:application/json;base64,e30=",
            },
          ],
          { id: messageID },
        ),
        assistantMessage([], { id: "msg_multipart_assistant", parentID: messageID }),
        userMessage(
          [
            userText("single @file @agent", { id: singleID }),
            {
              id: "prt_single_file",
              type: "file",
              mime: "text/plain",
              url: "file",
              source: { type: "file", path: "file", text: { value: "@file", start: 7, end: 12 } },
            },
            { id: "prt_single_agent", type: "agent", name: "agent", source: { value: "@agent", start: 13, end: 19 } },
          ],
          { id: "msg_single_user", created: 1700000003000 },
        ),
      ],
    })

    const part = (id: string) =>
      page.locator(`[data-timeline-message-id="${messageID}"][data-timeline-part-id="${id}"]`)
    const firstPart = part(firstID)
    const secondPart = part(secondID)
    await expect(firstPart).toHaveCount(1)
    await expect(secondPart).toHaveCount(1)
    await expect(firstPart).toHaveJSProperty("textContent", first)
    await expect(secondPart).toHaveJSProperty("textContent", second)
    await expect(firstPart.locator('[data-highlight="file"]')).toHaveText("@src/a.ts")
    await expect(secondPart.locator('[data-highlight="file"]')).toHaveText(["@src/a.ts", "@src/b.ts"])
    await expect(secondPart.locator('[data-highlight="agent"]')).toHaveText("@explore")
    await expect(firstPart.locator('[data-highlight="agent"]')).toHaveCount(0)
    const bubble = firstPart.locator('xpath=ancestor::*[@data-slot="user-message-text"]')
    const comments = bubble.locator('[data-slot="user-message-comments"]')
    await expect(comments).toHaveAttribute("data-bounded", "true")
    await expect(comments).toContainText("Keep this comment")
    await expect(page.getByText("data.json", { exact: true })).toBeVisible()
    await expect(page.getByText("hidden synthetic", { exact: true })).toHaveCount(0)
    const single = page.locator(`[data-slot="user-message-text"][data-timeline-part-id="${singleID}"]`)
    await expect(single).toHaveText("single @file @agent")
    await expect(single.locator('[data-highlight="file"]')).toHaveText("@file")
    await expect(single.locator('[data-highlight="agent"]')).toHaveText("@agent")

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    const message = bubble.locator('xpath=ancestor::*[@data-component="user-message"]')
    await bubble.hover()
    await message.getByRole("button", { name: "Copy message" }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(first + second)

    for (const id of [secondID, firstID]) {
      const hash = `search:${encodeURIComponent(JSON.stringify({ messageID, partID: id }))}`
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, hash)
      await expect(part(id)).toHaveClass(/timeline-search-target/)
      await expect(part(id === firstID ? secondID : firstID)).not.toHaveClass(/timeline-search-target/)
    }
  })
}
