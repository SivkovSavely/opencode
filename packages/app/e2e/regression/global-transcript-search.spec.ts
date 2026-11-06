import { expect, test } from "@playwright/test"
import { mockRemoteServer, openSession } from "../utils/workspace"
import { REMOTE_SERVER, SERVER, seed, sessionHref } from "../utils/app"
import type { TranscriptSearch } from "@opencode/schema/transcript-search"
import { startTranscriptServer, transcriptHit, transcriptPage } from "../utils/transcript"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"

test("new empty and invalid generations clear the previous candidate scan warning", async ({ page }) => {
  const requests: string[] = []
  await openSession(page, {
    name: "TranscriptScanGeneration",
    transcript: {
      search: (request) => {
        requests.push(request.query)

        return { ...transcriptPage([]), scanned: 500, scanLimited: true, complete: false }
      },
    },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  const query = dialog.getByRole("combobox", { name: "Search transcript content" })
  const status = dialog.getByRole("status")
  const warning = "Candidate scan limit reached. Continue to examine more content."
  await query.fill("needle")
  await expect(status).toContainText(warning)
  await query.fill("")
  await expect(status).toContainText("Enter at least three Unicode characters.")
  await expect(status).not.toContainText(warning)
  await query.fill("another")
  await expect(status).toContainText(warning)
  await query.fill("ab")
  await expect(status).toContainText("Invalid query. Use at least three characters or a supported bounded regex.")
  await expect(status).not.toContainText(warning)
  expect(requests).toEqual(["needle", "another"])
})

test("legacy IME Enter 229 preserves the dialog, query, location and default action", async ({ page }) => {
  await openSession(page, {
    name: "TranscriptLegacyIME",
    transcript: { search: () => transcriptPage([transcriptHit()]) },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  const query = dialog.getByRole("combobox", { name: "Search transcript content" })
  await query.fill("needle")
  await expect(dialog.getByRole("option", { name: /Closed historical session/ })).toBeVisible()
  const location = page.url()

  const event = await query.evaluate((element) => {
    const input = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      isComposing: false,
      bubbles: true,
      cancelable: true,
    })

    const accepted = element.dispatchEvent(input)

    return {
      accepted,
      defaultPrevented: input.defaultPrevented,
      keyCode: input.keyCode,
      isComposing: input.isComposing,
    }
  })

  expect(event).toEqual({ accepted: true, defaultPrevented: false, keyCode: 229, isComposing: false })
  await expect(dialog).toBeVisible()
  await expect(query).toHaveValue("needle")
  await expect(query).toBeFocused()
  await expect(page).toHaveURL(location)
  await query.press("Enter")
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/#search:/)
})

test("outer transcript dialog and fixed controls stay fully in short and narrow viewports", async ({ page }) => {
  await openSession(page, {
    name: "TranscriptViewport",
    transcript: {
      search: () =>
        transcriptPage([
          transcriptHit({ documentID: "first", title: "First viewport result" }),
          transcriptHit({ documentID: "second", title: "Second viewport result" }),
        ]),
    },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  const query = dialog.getByRole("combobox", { name: "Search transcript content" })
  const selected = dialog.getByRole("listbox", { name: "Transcript results" }).getByRole("option", { selected: true })
  await query.fill("needle")
  await expect(selected).toContainText("First viewport result")
  await query.press("ArrowDown")
  await expect(selected).toContainText("Second viewport result")

  for (const viewport of [
    { width: 900, height: 390 },
    { width: 900, height: 320 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await expect(query).toHaveValue("needle")
    await expect(selected).toContainText("Second viewport result")

    for (const element of [
      page.locator('[data-slot="dialog-container"]').filter({ has: dialog }),
      dialog.getByRole("heading", { name: "Search transcripts", exact: true }),
      dialog.locator('[data-slot="dialog-header"]').getByRole("button", { name: "Close", exact: true }),
      dialog.locator('[data-slot="dialog-footer"]'),
    ]) {
      await expect
        .poll(() =>
          element.evaluate((node) => {
            const box = node.getBoundingClientRect()

            return (
              box.width > 0 &&
              box.height > 0 &&
              box.left >= 0 &&
              box.top >= 0 &&
              box.right <= innerWidth &&
              box.bottom <= innerHeight
            )
          }),
        )
        .toBe(true)
    }

    await dialog.getByText("Filters and servers", { exact: true }).click()
    await dialog.getByRole("textbox", { name: "Find filter options", exact: true }).fill("read")
    await expect(query).toHaveValue("needle")
    await expect(dialog.locator('[data-slot="dialog-footer"]')).toBeInViewport({ ratio: 1 })
    await dialog.getByText("Filters and servers", { exact: true }).click()
  }
})

test("global transcript entry, safe preview, IME, filters, reset and mobile viewport", async ({ page }) => {
  const requests: TranscriptSearch.Request[] = []
  await openSession(page, {
    name: "TranscriptSearch",
    transcript: {
      search: (request) => {
        requests.push(request)

        return transcriptPage([transcriptHit()])
      },
    },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  const query = dialog.getByRole("combobox", { name: "Search transcript content" })
  await expect(query).toBeFocused()
  await query.fill("needle")
  const option = dialog.getByRole("option", { name: /Closed historical session/ })
  await expect(option).toContainText("😀 needle")
  await expect(option.locator("mark")).toHaveText("needle")
  await expect(option).toContainText("<script>plain text</script>")
  await query.dispatchEvent("keydown", { key: "Enter", isComposing: true })
  await expect(dialog).toBeVisible()
  await dialog.getByText("Filters and servers", { exact: true }).click()
  await dialog.getByRole("checkbox", { name: "User text", exact: true }).check()
  await dialog.getByRole("checkbox", { name: "Tool output", exact: true }).check()
  await expect
    .poll(() => requests.at(-1)?.content)
    .toEqual([
      { role: "user", category: "text" },
      { role: "assistant", category: "tool-output" },
    ])
  await dialog.getByRole("button", { name: "Reset", exact: true }).click()
  await expect(query).toHaveValue("")
  await expect(dialog.getByRole("checkbox", { name: "User text", exact: true })).not.toBeChecked()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(query).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await page.getByRole("button", { name: "Search transcripts", exact: true }).click()
  await expect(query).toBeFocused()
})

test("ordered cross-server failure keeps a safe prefix; available-only explicitly restarts without dropping facet failures", async ({
  page,
}) => {
  let localCalls = 0
  await mockRemoteServer(page, {
    name: "Remote fixture",
    transcript: {
      search: (request) =>
        request.cursor
          ? { status: 503, body: { message: "remote offline" } }
          : transcriptPage(
              [transcriptHit({ documentID: "remote9", title: "Remote newest", timeCreated: 9 })],
              "remote-failed",
            ),
    },
  })
  await openSession(page, {
    name: "TranscriptScope",
    seed: {
      servers: [
        { url: SERVER, name: "Local fixture" },
        { url: REMOTE_SERVER, name: "Remote fixture" },
      ],
    },
    transcript: {
      facets: () => ({ status: 503, body: { message: "local facets unavailable" } }),
      search: () => {
        localCalls++

        return transcriptPage([transcriptHit({ documentID: "local8", title: "Local next", timeCreated: 8 })])
      },
    },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  await dialog.getByText("Filters and servers", { exact: true }).click()
  await dialog.getByRole("checkbox", { name: "Remote fixture", exact: true }).check()
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("needle")
  const results = dialog.getByRole("listbox", { name: "Transcript results" })
  await expect(results.getByRole("option", { name: /Remote newest/ })).toBeVisible()
  await expect(results.getByRole("option", { name: /Local next/ })).toHaveCount(0)
  await expect(dialog.getByText(/Search failed; successful buffers/)).toContainText("Remote fixture")
  await dialog.getByRole("button", { name: "Restart with available servers only", exact: true }).click()
  await expect(results.getByRole("option", { name: /Local next/ })).toBeVisible()
  await expect(results.getByRole("option", { name: /Remote newest/ })).toHaveCount(0)
  await expect(dialog.getByRole("checkbox", { name: "Local fixture", exact: true })).toBeChecked()
  await expect(dialog.getByRole("checkbox", { name: "Remote fixture", exact: true })).not.toBeChecked()
  await expect(dialog.getByText(/Historical filters unavailable/)).toContainText("Local fixture")
  expect(localCalls).toBe(2)
})

test("obsolete delayed query responses cannot replace the current generation", async ({ page }) => {
  const arrived = Promise.withResolvers<void>()
  const held = Promise.withResolvers<TranscriptSearch.Response>()
  await openSession(page, {
    name: "TranscriptGeneration",
    transcript: {
      search: (request) => {
        if (request.query === "older") {
          arrived.resolve()

          return held.promise
        }

        return transcriptPage([transcriptHit({ title: "Current generation" })])
      },
    },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  const query = dialog.getByRole("combobox", { name: "Search transcript content" })
  await query.fill("older")
  await arrived.promise
  await query.fill("current")
  await expect(dialog.getByRole("option", { name: /Current generation/ })).toBeVisible()
  held.resolve(transcriptPage([transcriptHit({ title: "Stale generation" })]))
  await expect(dialog.getByRole("option", { name: /Stale generation/ })).toHaveCount(0)
  await expect(query).toHaveValue("current")
})

test("search failure is not empty success, retry retains cursor and facet failure is separate", async ({ page }) => {
  let failed = true
  const cursors: (string | undefined)[] = []
  await openSession(page, {
    name: "TranscriptFailures",
    transcript: {
      facets: () => ({ status: 503, body: { message: "facets unavailable" } }),
      search: (request) => {
        cursors.push(request.cursor)

        if (!request.cursor) return transcriptPage([transcriptHit()], "retry-this")

        return failed
          ? { status: 503, body: { message: "search unavailable" } }
          : transcriptPage([transcriptHit({ documentID: "second", title: "Second result", timeCreated: 1 })])
      },
    },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("needle")
  await expect(dialog.getByRole("option", { name: /Closed historical session/ })).toBeVisible()
  await expect(dialog.getByText(/Historical filters unavailable/)).toBeVisible()
  await expect(dialog.getByText(/Search failed; successful buffers/)).toBeVisible()
  await expect(dialog.getByText("No matching indexed content.", { exact: true })).toHaveCount(0)
  failed = false
  await dialog.getByRole("button", { name: "Retry failed page", exact: true }).click()
  await expect(dialog.getByRole("option", { name: /Second result/ })).toBeVisible()
  expect(cursors).toEqual([undefined, "retry-this", "retry-this"])
  await expect(dialog.getByText(/Historical filters unavailable/)).toBeVisible()
})

test("native Find opens folded imported multipart text and moves each occurrence", async ({ page }) => {
  const parts = [
    {
      id: "part_fold_first",
      text: Array.from({ length: 14 }, (_, index) => `Padding line ${index}\n`).join("") + "foldneedle first\n",
      timeCreated: 1,
    },
    { id: "part_fold_second", text: "foldneedle second\nfoldneedle third", timeCreated: 2 },
  ]

  await openSession(page, {
    name: "MultipartFind",
    seed: { settings: { general: { foldUserMessages: true } } },
    pageMessages: () => ({
      items: [
        {
          id: "msg_find",
          type: "user",
          text: parts.map((part) => part.text).join(""),
          experimental: { textParts: parts },
          time: { created: 1 },
        },
      ],
    }),
  })
  const fold = page.locator('[data-slot="user-message-fold"]')
  await expect(fold).toHaveAttribute("data-folded", "")
  await page.keyboard.press("Control+f")
  const query = page.locator('[data-component="timeline-search-bar"] input')
  await expect(query).toBeFocused()
  await query.fill("foldneedle")

  const activeText = () =>
    page.evaluate(() => {
      const range = CSS.highlights.get("timeline-search-hit-active")?.values().next().value

      return range
        ? {
            part: range.startContainer.parentElement
              ?.closest("[data-timeline-part-id]")
              ?.getAttribute("data-timeline-part-id"),
            text: range.startContainer.textContent?.slice(range.startOffset),
          }
        : null
    })

  await expect(fold).not.toHaveAttribute("data-folded", "")
  await expect.poll(activeText).toEqual({ part: parts[0].id, text: "foldneedle first\n" })
  await query.press("Enter")
  await expect.poll(activeText).toEqual({ part: parts[1].id, text: parts[1].text })
  await query.press("Enter")
  await expect.poll(activeText).toEqual({ part: parts[1].id, text: "foldneedle third" })
  await query.press("Enter")
  await expect.poll(activeText).toEqual({ part: parts[0].id, text: "foldneedle first\n" })
  expect(await page.locator('[data-slot="user-message-text"] [data-timeline-part-id]').allTextContents()).toEqual(
    parts.map((part) => part.text),
  )
})

for (const folded of [false, true]) {
  test(`native Find crosses multipart boundaries${folded ? " in folded Unicode text" : ""}`, async ({ page }) => {
    const prefix = folded ? `${"Padding line\n".repeat(14)}\u{1f600} ` : ""

    const parts = [
      { id: "part_boundary_first", text: `${prefix}hello `, timeCreated: 1 },
      { id: "part_boundary_second", text: "world hello world", timeCreated: 2 },
    ]

    await openSession(page, {
      name: "MultipartBoundaryFind",
      seed: { settings: { general: { foldUserMessages: folded } } },
      pageMessages: () => ({
        items: [
          {
            id: "msg_1_boundary",
            type: "user",
            text: parts.map((part) => part.text).join(""),
            experimental: { textParts: parts },
            time: { created: 1 },
          },
          {
            id: "msg_2_markdown",
            type: "assistant",
            agent: "build",
            model: { id: "test", providerID: "test" },
            time: { created: 2, completed: 3 },
            content: [{ type: "text", text: "markup **needle** markup needle", phase: "final" }],
          },
        ],
      }),
    })
    const fold = page.locator('[data-slot="user-message-fold"]')

    if (folded) await expect(fold).toHaveAttribute("data-folded", "")
    await page.keyboard.press("Control+f")
    const query = page.locator('[data-component="timeline-search-bar"] input')
    await expect(query).toBeFocused()
    await query.fill("hello world")

    const activeRange = () =>
      page.evaluate(() => {
        const range = CSS.highlights.get("timeline-search-hit-active")?.values().next().value

        return range
          ? {
              text: range.toString(),
              startPart: range.startContainer.parentElement
                ?.closest("[data-timeline-part-id]")
                ?.getAttribute("data-timeline-part-id"),
              endPart: range.endContainer.parentElement
                ?.closest("[data-timeline-part-id]")
                ?.getAttribute("data-timeline-part-id"),
              startOffset: range.startOffset,
              endOffset: range.endOffset,
            }
          : null
      })

    const first = {
      text: "hello world",
      startPart: parts[0].id,
      endPart: parts[1].id,
      startOffset: prefix.length,
      endOffset: 5,
    }

    await expect.poll(activeRange).toEqual(first)
    await expect(page.locator('[data-component="timeline-search-bar"]')).toContainText("1/2")

    if (folded) await expect(fold).not.toHaveAttribute("data-folded", "")
    await query.press("Enter")
    await expect.poll(activeRange).toEqual({
      text: "hello world",
      startPart: parts[1].id,
      endPart: parts[1].id,
      startOffset: 6,
      endOffset: 17,
    })
    await expect(page.locator('[data-component="timeline-search-bar"]')).toContainText("2/2")
    await query.press("Enter")
    await expect.poll(activeRange).toEqual(first)
    await query.press("Shift+Enter")
    await expect.poll(activeRange).toMatchObject({ startPart: parts[1].id, startOffset: 6, endOffset: 17 })
    expect(await page.locator('[data-slot="user-message-text"] [data-timeline-part-id]').allTextContents()).toEqual(
      parts.map((part) => part.text),
    )

    // Markdown source includes delimiters: its rendered inline nodes must not invent another source match.
    await query.fill("markup needle")
    await expect(page.locator('[data-component="timeline-search-bar"]')).toContainText("1/1")
    await expect.poll(activeRange).toEqual({
      text: "markup needle",
      startPart: "msg_2_markdown:text:0",
      endPart: "msg_2_markdown:text:0",
      startOffset: 1,
      endOffset: 14,
    })
  })
}

for (const repeated of [false, true]) {
  test(`native Find maps lowercase expansion to original multipart offsets${repeated ? " with repeated Unicode matches" : ""}`, async ({
    page,
  }) => {
    const parts = [
      { id: "part_lower_first", text: repeated ? "\u{1f600} \u0130 " : "\u0130 ", timeCreated: 1 },
      { id: "part_lower_second", text: repeated ? "\u0130 \u0130 \u039f\u03a3" : "needle", timeCreated: 2 },
    ]

    const errors: string[] = []
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error("Native Find page error:", error.stack)
    })
    await openSession(page, {
      name: "LowercaseOffsetFind",
      pageMessages: () => ({
        items: [
          {
            id: "msg_lowercase",
            type: "user",
            text: parts.map((part) => part.text).join(""),
            experimental: { textParts: parts },
            time: { created: 1 },
          },
        ],
      }),
    })
    await page.keyboard.press("Control+f")
    const bar = page.locator('[data-component="timeline-search-bar"]')
    const query = bar.locator("input")
    await expect(query).toBeFocused()

    const activeRange = () =>
      page.evaluate(() => {
        const range = CSS.highlights.get("timeline-search-hit-active")?.values().next().value

        return range
          ? {
              text: range.toString(),
              startPart: range.startContainer.parentElement
                ?.closest("[data-timeline-part-id]")
                ?.getAttribute("data-timeline-part-id"),
              endPart: range.endContainer.parentElement
                ?.closest("[data-timeline-part-id]")
                ?.getAttribute("data-timeline-part-id"),
              startOffset: range.startOffset,
              endOffset: range.endOffset,
            }
          : null
      })

    if (!repeated) {
      await query.fill("needle")
      await expect.poll(activeRange).toEqual({
        text: "needle",
        startPart: parts[1].id,
        endPart: parts[1].id,
        startOffset: 0,
        endOffset: 6,
      })
      await expect(bar).toContainText("1/1")
      await query.fill("\u0130 needle")
      await expect.poll(activeRange).toEqual({
        text: "\u0130 needle",
        startPart: parts[0].id,
        endPart: parts[1].id,
        startOffset: 0,
        endOffset: 6,
      })
    }

    await query.fill("\u0130")

    const first = {
      text: "\u0130",
      startPart: parts[0].id,
      endPart: parts[0].id,
      startOffset: repeated ? 3 : 0,
      endOffset: repeated ? 4 : 1,
    }

    await expect.poll(activeRange).toEqual(first)
    await expect(bar).toContainText(repeated ? "1/3" : "1/1")

    if (repeated) {
      for (const [index, offset] of [0, 2].entries()) {
        await query.press("Enter")
        await expect.poll(activeRange).toEqual({
          text: "\u0130",
          startPart: parts[1].id,
          endPart: parts[1].id,
          startOffset: offset,
          endOffset: offset + 1,
        })
        await expect(bar).toContainText(`${index + 2}/3`)
      }
    }

    await query.press("Enter")
    await expect.poll(activeRange).toEqual(first)

    // Either normalized half of the expansion still identifies the original character, not a clamped fragment.
    for (const value of ["i", "\u0307"]) {
      await query.fill(value)
      await expect.poll(activeRange).toEqual(first)
    }

    if (repeated) {
      // Whole-string lowercase retains contextual final sigma while endpoint mapping uses original UTF-16.
      await query.fill("\u03bf\u03c2")
      await expect.poll(activeRange).toEqual({
        text: "\u039f\u03a3",
        startPart: parts[1].id,
        endPart: parts[1].id,
        startOffset: 4,
        endOffset: 6,
      })
      await expect(bar).toContainText("1/1")
    }

    expect(await page.locator('[data-slot="user-message-text"] [data-timeline-part-id]').allTextContents()).toEqual(
      parts.map((part) => part.text),
    )
    expect(errors).toEqual([])
  })
}

test("global text target expands the owning collapsed commentary context", async ({ page }) => {
  await openSession(page, {
    name: "CommentaryTarget",
    sessions: [{ id: "ses_commentary" }],
    seed: {
      settings: { general: { timelineDetail: { ...timelinePresets[2].value, commentary: { placement: "grouped" } } } },
    },
    pageMessages: () => ({
      items: [
        { id: "msg_1_commentary", type: "user", text: "Inspect the fixture", time: { created: 1 } },
        {
          id: "msg_2_commentary",
          type: "assistant",
          agent: "build",
          model: { id: "test", providerID: "test" },
          time: { created: 2, completed: 3 },
          content: [
            { type: "text", text: "Hidden commentary needle before inspecting files" },
            {
              type: "tool",
              id: "call_commentary",
              name: "read",
              time: { created: 2, completed: 3 },
              state: {
                status: "completed",
                input: { filePath: "/fixture/context.ts" },
                metadata: {},
                content: [{ type: "text", text: "Public fixture" }],
              },
            },
            { type: "text", text: "Visible final answer after inspection" },
          ],
        },
      ],
    }),
    transcript: {
      search: () =>
        transcriptPage([
          transcriptHit({
            sessionID: "ses_commentary",
            messageID: "msg_2_commentary",
            partID: "msg_2_commentary:text:0",
            role: "assistant",
          }),
        ]),
    },
  })
  await expect(page.getByText("Visible final answer after inspection", { exact: true })).toBeVisible()
  const target = page.locator('[data-timeline-part-id="msg_2_commentary:text:0"]')
  await expect(target).toHaveCount(0)
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("commentary needle")
  await dialog.getByRole("option", { name: /Closed historical session/ }).click()
  await expect(target).toBeVisible()
  await expect(target).toHaveClass(/transcript-target-highlight/)
  await expect(target).toContainText("Hidden commentary needle")
  await expect(target).toBeInViewport()
  await expect(
    page.getByText("The exact search target is unavailable. Select the result again to retry.", { exact: true }),
  ).toHaveCount(0)
})

test("below-viewport attachment card and image targets have a visible boxed highlight", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 390 })

  const files = Array.from({ length: 30 }, (_, index) => ({
    name: `attachment-${index}.txt`,
    mime: "text/plain",
    data: "Zml4dHVyZQ==",
    source: { type: "inline" as const },
  }))

  const image = {
    name: "target-image.png",
    mime: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGRsAAAAASUVORK5CYII=",
    source: { type: "inline" as const },
  }

  await openSession(page, {
    name: "BoxedAttachment",
    sessions: [{ id: "ses_attachments" }],
    pageMessages: () => ({
      items: [
        {
          id: "msg_attachments",
          type: "user",
          text: "Attachment fixture",
          files: [...files, image],
          experimental: { filePartIDs: [...files, image].map((_, index) => `file_attachment_${index}`) },
          time: { created: 1 },
        },
      ],
    }),
    transcript: {
      search: (request) =>
        transcriptPage([
          transcriptHit({
            sessionID: "ses_attachments",
            messageID: "msg_attachments",
            partID: request.query === "target-image" ? "file_attachment_30" : "file_attachment_29",
            category: "file",
          }),
        ]),
    },
  })
  const scroller = page.getByRole("region", { name: "scrollable content", exact: true })

  for (const item of [
    {
      id: "file_attachment_29",
      query: "attachment-29",
      element: page.locator('[data-component="attachment-card"][title="attachment-29.txt"]'),
    },
    {
      id: "file_attachment_30",
      query: "target-image",
      element: page.locator('[data-slot="user-message-attachment"][data-type="image"]'),
    },
  ]) {
    await scroller.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }))
    await expect
      .poll(
        async () =>
          (await item.element.boundingBox())!.y >
          (await scroller.boundingBox())!.y + (await scroller.boundingBox())!.height,
      )
      .toBe(true)
    await page.keyboard.press("Control+Shift+f")
    const dialog = page.getByRole("dialog", { name: "Search transcripts" })
    await dialog.getByRole("combobox", { name: "Search transcript content" }).fill(item.query)
    await dialog.getByRole("option", { name: /Closed historical session/ }).click()
    const marker = page.locator(`[data-timeline-part-id="${item.id}"].transcript-target-highlight`)
    await expect(marker).toBeVisible()
    await expect
      .poll(() =>
        marker.evaluate((element) => {
          const box = element.getBoundingClientRect()

          return box.width > 0 && box.height > 0 && getComputedStyle(element).outlineStyle !== "none"
        }),
      )
      .toBe(true)
    await expect(item.element).toBeInViewport({ ratio: 1 })
    expect(await marker.boundingBox()).toEqual(await item.element.boundingBox())
  }
})

test("real disposable V1 import, native API and older multipart/tool destination history", async ({ page }) => {
  await using backend = await startTranscriptServer()
  console.log(`F002 native browser fixture log: ${backend.log}`)
  await page.setExtraHTTPHeaders({ authorization: `Basic ${btoa("opencode:synthetic-f002")}` })
  await seed(page, {
    servers: [{ url: backend.origin, name: "Disposable import" }],
    tabs: [{ session: "ses_f002_import", server: backend.origin }],
  })
  await page.goto(sessionHref("ses_f002_import", backend.origin))
  await expect(page.getByRole("heading", { name: "Imported closed history", exact: true })).toBeVisible()
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  const results = dialog.getByRole("listbox", { name: "Transcript results" })
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("second sentinel")
  await expect(results.getByRole("option")).toHaveCount(1)
  await results.getByRole("option").click()
  const second = page.locator('[data-timeline-part-id="prt_000000000002aaaaaaaaaaaaaa"]')
  await expect(second).toBeVisible()
  expect(await second.textContent()).toBe("\tsecond sentinel @retired-agent ")
  await expect(second).toHaveClass(/transcript-target-highlight/)
  expect(await page.locator('[data-timeline-part-id="prt_000000000001aaaaaaaaaaaaaa"]').textContent()).toBe(
    " first @notes.txt\n",
  )
  await page.keyboard.press("Control+f")
  const find = page.locator('[data-component="timeline-search-bar"] input')
  await expect(find).toBeFocused()
  await find.fill("@")

  const activePart = () =>
    page.evaluate(() =>
      CSS.highlights
        .get("timeline-search-hit-active")
        ?.values()
        .next()
        .value?.startContainer.parentElement?.closest("[data-timeline-part-id]")
        ?.getAttribute("data-timeline-part-id"),
    )

  await expect.poll(activePart).toBe("prt_000000000001aaaaaaaaaaaaaa")
  await find.press("Enter")
  await expect.poll(activePart).toBe("prt_000000000002aaaaaaaaaaaaaa")
  await find.press("Shift+Enter")
  await expect.poll(activePart).toBe("prt_000000000001aaaaaaaaaaaaaa")
  await find.press("Escape")
  const originalURL = page.url()
  await page.getByRole("region", { name: "scrollable content", exact: true }).hover()
  await page.mouse.wheel(0, 500)
  await expect(second).not.toBeInViewport()
  expect(page.url()).toBe(originalURL)
  await page.keyboard.press("Control+Shift+f")
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("second sentinel")
  await expect(results.getByRole("option")).toHaveCount(1)
  await results.getByRole("option").click()
  await expect(second).toHaveClass(/transcript-target-highlight/)
  expect(page.url()).toBe(originalURL)
  await page.keyboard.press("Control+Shift+f")
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("public-output-sentinel")
  await expect(results.getByRole("option")).toHaveCount(1)
  await results.getByRole("option").click()
  const tool = page.locator('[data-timeline-part-id="call_import_read"]')
  await expect(tool).toHaveClass(/transcript-target-highlight/)
  await expect(tool).toContainText("public-input-sentinel")
  await page.keyboard.press("Control+Shift+f")
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("notes-sentinel")
  await expect(results.getByRole("option")).toHaveCount(1)
  await results.getByRole("option").click()
  await expect(page.locator('[data-timeline-part-id="prt_000000000005aaaaaaaaaaaaaa"]')).toHaveClass(
    /transcript-target-highlight/,
  )
  await page.keyboard.press("Control+Shift+f")
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("public assistant-error")
  await expect(results.getByRole("option")).toHaveCount(1)
  await results.getByRole("option").click()
  await expect(
    page.locator('[data-timeline-row="Error"][data-transcript-message-id="msg_000000000002aaaaaaaaaaaaaa"]'),
  ).toHaveClass(/transcript-target-highlight/)
  await page.keyboard.press("Control+Shift+f")
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("preferred durable")
  await expect(results.getByRole("option")).toHaveCount(1)
  await results.getByRole("option").click()
  await expect(
    page.locator('[data-timeline-part-id="msg_000000000003aaaaaaaaaaaaaa:text:0"].transcript-target-highlight'),
  ).toContainText("preferred durable sentinel")
  await page.keyboard.press("Control+Shift+f")
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("durable-shell output")
  await expect(results.getByRole("option")).toHaveCount(1)
  await results.getByRole("option").click()
  await expect(
    page.locator('[data-transcript-message-id="msg_000000000004aaaaaaaaaaaaaa"].transcript-target-highlight'),
  ).toContainText("durable-shell")
  await page.keyboard.press("Control+Shift+f")
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("excluded")
  await expect(dialog.getByText("No matching indexed content.", { exact: true })).toBeVisible()
  await expect(results.getByRole("option")).toHaveCount(0)
})

test("missing exact part performs one targeted refresh and reports unavailable instead of highlighting a sibling", async ({
  page,
}) => {
  let refreshes = 0
  await openSession(page, {
    name: "MissingPart",
    sessions: [{ id: "ses_target_missing" }],
    pageMessages: () => ({
      items: [{ id: "msg_target", type: "user", text: "A sibling is not the deleted target", time: { created: 1 } }],
    }),
    message: () => {
      refreshes++

      return { id: "msg_target", type: "user", text: "A sibling is not the deleted target", time: { created: 1 } }
    },
    transcript: {
      search: () =>
        transcriptPage([
          transcriptHit({ sessionID: "ses_target_missing", messageID: "msg_target", partID: "part_deleted" }),
        ]),
    },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("needle")
  await dialog.getByRole("option", { name: /Closed historical session/ }).click()
  await expect(
    page.getByText("The exact search target is unavailable. Select the result again to retry.", { exact: true }),
  ).toBeVisible()
  expect(refreshes).toBe(1)
  await expect(page.locator('[data-timeline-part-id="msg_target:text:0"]')).not.toHaveClass(
    /transcript-target-highlight/,
  )
})

test("index readiness is honest and completing explicit backfill restarts the query and its cursors", async ({
  page,
}) => {
  let ready = false
  let searches = 0
  let failIndex = false
  let failedBackfills = 0
  const indexing = Promise.withResolvers<void>()
  const backfill = Promise.withResolvers<void>()

  const status = () => ({
    ready,
    backfillCursor: ready ? "part:" : "message:pending",
    generation: ready ? "indexed" : "building",
  })

  await openSession(page, {
    name: "TranscriptIndexing",
    transcript: {
      status,
      backfill: async () => {
        if (failIndex) {
          failedBackfills++

          return { status: 503, body: { message: "backfill unavailable" } }
        }

        indexing.resolve()
        await backfill.promise

        return status()
      },
      search: () => {
        searches++

        return {
          ...transcriptPage([transcriptHit({ title: ready ? "Complete indexed result" : "Partial indexed result" })]),
          complete: ready,
          status: status(),
        }
      },
    },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  await indexing.promise
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("needle")
  await expect(dialog.getByRole("option", { name: /Partial indexed result/ })).toBeVisible()
  await expect(dialog.getByText("All indexed results loaded.", { exact: true })).toHaveCount(0)
  ready = true
  backfill.resolve()
  await expect(dialog.getByRole("option", { name: /Complete indexed result/ })).toBeVisible()
  await expect(dialog.getByRole("option", { name: /Partial indexed result/ })).toHaveCount(0)
  expect(searches).toBe(2)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  ready = false
  failIndex = true
  await page.keyboard.press("Control+Shift+f")
  await expect(dialog.getByText(/Index readiness\/backfill failed/)).toBeVisible()
  await dialog.getByRole("combobox", { name: "Search transcript content" }).fill("needle")
  await expect(dialog.getByRole("option", { name: /Partial indexed result/ })).toBeVisible()
  await expect(dialog.getByText("All indexed results loaded.", { exact: true })).toHaveCount(0)
  expect(failedBackfills).toBe(1)
  ready = true
  failIndex = false
  await dialog.getByRole("button", { name: "Retry indexing", exact: true }).click()
  await expect(dialog.getByRole("option", { name: /Complete indexed result/ })).toBeVisible()
  await expect(dialog.getByText(/Index readiness\/backfill failed/)).toHaveCount(0)
})

test("virtualized keyboard selection stays accessible and historical model selections stay server-qualified", async ({
  page,
}) => {
  const local: TranscriptSearch.Request[] = []
  const remote: TranscriptSearch.Request[] = []

  const facets: TranscriptSearch.Facets = {
    projects: [],
    agents: [],
    providers: [],
    tools: [],
    models: [{ providerID: "retired-provider", modelID: "same-model", lastUsed: 1 }],
    truncated: false,
  }

  await mockRemoteServer(page, {
    name: "Remote fixture",
    transcript: {
      facets: () => facets,
      search: (request) => {
        remote.push(request)

        return transcriptPage([])
      },
    },
  })
  await openSession(page, {
    name: "TranscriptVirtual",
    seed: {
      servers: [
        { url: SERVER, name: "Local fixture" },
        { url: REMOTE_SERVER, name: "Remote fixture" },
      ],
    },
    transcript: {
      facets: () => facets,
      search: (request) => {
        local.push(request)

        return transcriptPage(
          Array.from({ length: 40 }, (_, index) =>
            transcriptHit({ documentID: `document_${index}`, title: `Result ${index}`, timeCreated: 40 - index }),
          ),
        )
      },
    },
  })
  await page.keyboard.press("Control+Shift+f")
  const dialog = page.getByRole("dialog", { name: "Search transcripts" })
  const query = dialog.getByRole("combobox", { name: "Search transcript content" })
  const results = dialog.getByRole("listbox", { name: "Transcript results" })
  await query.fill("needle")
  await expect(results.getByRole("option", { name: /Result 0/ })).toBeVisible()
  expect(await results.getByRole("option").count()).toBeLessThan(40)
  await query.press("ArrowUp")
  await expect(results.getByRole("option", { selected: true })).toContainText("Result 39")
  await expect(query).toHaveAttribute(
    "aria-activedescendant",
    (await results.getByRole("option", { selected: true }).getAttribute("id")) ?? "",
  )
  await dialog.getByText("Filters and servers", { exact: true }).click()
  await dialog.getByRole("checkbox", { name: "Remote fixture", exact: true }).check()
  await expect(
    dialog.getByRole("checkbox", { name: "retired-provider / same-model · Remote fixture", exact: true }),
  ).toBeVisible()
  const remoteBeforeFilter = remote.length
  await dialog.getByRole("checkbox", { name: "retired-provider / same-model · Local fixture", exact: true }).check()
  await expect.poll(() => local.at(-1)?.models).toEqual([{ providerID: "retired-provider", modelID: "same-model" }])
  await expect(results.getByRole("option", { name: /Result 0/ })).toBeVisible()
  expect(remote).toHaveLength(remoteBeforeFilter)
  const filter = dialog.getByRole("textbox", { name: "Find filter options", exact: true })
  await filter.fill("retired")
  const active = await query.getAttribute("aria-activedescendant")
  await filter.press("ArrowDown")
  await expect(query).toHaveAttribute("aria-activedescendant", active ?? "")
})
