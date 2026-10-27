import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  directory,
  projectID,
  sessionID,
  setupTimeline,
  textPart,
  title,
  toolPart,
  userMessage,
  userText,
} from "../performance/timeline-stability/fixture"

for (const layout of [
  { name: "legacy desktop", newLayoutDesigns: false, viewport: undefined },
  { name: "V2 mobile", newLayoutDesigns: true, viewport: { width: 390, height: 844 } },
]) {
  test(`opens global transcript search from the ${layout.name} titlebar and command`, async ({ page }) => {
    await setupTimeline(page, {
      messages: [],
      settings: { newLayoutDesigns: layout.newLayoutDesigns },
      viewport: layout.viewport,
    })

    const open = page.getByRole("button", { name: "Search transcripts", exact: true })
    await expect(open).toBeVisible()
    await page.keyboard.press("ControlOrMeta+Shift+f")
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Search transcripts" })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await open.click()

    const dialog = page.getByRole("dialog")
    await expect(dialog.getByRole("heading", { name: "Search transcripts" })).toBeVisible()
    const search = dialog.getByRole("combobox", { name: "Search transcripts" })
    await expect(search).toBeFocused()
    await expect(dialog.locator(".transcript-search-filters > details > summary")).toHaveText([
      "Project",
      "Model",
      "Agent",
      "Role",
      "Content",
      "Tool status",
      "Date",
      "More",
    ])
    if (layout.viewport) {
      expect(await dialog.evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true)
    }

    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
  })
}

test("excludes search failures without excluding servers with metadata failures", async ({ page }) => {
  const metadataServer = "http://metadata.example.test"
  const failedServer = "http://failed.example.test"
  await page.addInitScript((servers) => {
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: servers }))
  }, [
    `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    metadataServer,
    failedServer,
  ])
  await setupTimeline(page, { messages: [] })

  let releaseMetadata!: () => void
  const metadataPending = new Promise<void>((resolve) => (releaseMetadata = resolve))
  await page.route("**/global/transcript/search**", async (route) => {
    const url = new URL(route.request().url())
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "*",
    }
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers })
    if (url.pathname.endsWith("/facets")) {
      if (url.origin === metadataServer) {
        await metadataPending
        return route.fulfill({ status: 500, json: {}, headers })
      }
      return route.fulfill({
        json: {
          projects: [],
          agents: [],
          providers: [],
          models: [],
          tools: [],
          agentDetails: [],
          providerDetails: [],
          modelDetails: [],
          toolDetails: [],
          modelIdentities: [],
          projectDetails: [],
          truncated: false,
        },
        headers,
      })
    }
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: { ready: true, backfillCursor: "" }, headers })
    if (!url.pathname.endsWith("/search")) return route.fallback()
    if (url.origin === failedServer) return route.fulfill({ status: 500, json: {}, headers })
    return route.fulfill({
      json: {
        hits: [],
        scanned: 0,
        complete: true,
        scanLimit: 500,
        contentLimit: 65536,
        scanLimited: false,
        truncatedDocuments: 0,
        status: { ready: true, backfillCursor: "" },
      },
      headers,
    })
  })

  await page.getByRole("button", { name: "Search transcripts", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByText("More", { exact: true }).click()
  await dialog.getByText("Server", { exact: true }).click()
  const metadata = dialog.getByRole("checkbox", { name: /metadata\.example\.test/ })
  const failed = dialog.getByRole("checkbox", { name: /failed\.example\.test/ })
  await failed.check()
  await metadata.check()
  await dialog.getByText("More", { exact: true }).click()
  await dialog.getByRole("combobox", { name: "Search transcripts" }).fill("needle")
  const exclude = dialog.getByRole("button", { name: "Search available servers only" })
  await expect(exclude).toBeEnabled()
  releaseMetadata()
  await expect(
    dialog.getByText("Search status or historical filters could not be loaded. Reopen search to retry."),
  ).toBeVisible()
  await exclude.click()
  await dialog.getByText("More", { exact: true }).click()
  await expect(metadata).toBeChecked()
  await expect(failed).not.toBeChecked()
})

test("opens exact user, assistant, tool, and message-error search targets", async ({ page }) => {
  const userID = "msg_search_user"
  const assistantID = "msg_search_assistant"
  const duplicateAssistantID = "msg_search_assistant_duplicate"
  const errorID = "msg_search_error"
  const userPartID = "prt_search_user"
  const assistantPartID = "prt_search_assistant"
  const inputPartID = "prt_search_input"
  const duplicateInputPartID = "prt_search_second_input"
  const errorPartID = "prt_search_tool_error"
  const messages = [
    userMessage([userText("needle user source", { id: userPartID })], { id: userID }),
    assistantMessage(
      [
        textPart(assistantPartID, `needle assistant source\n\n${"Long assistant response for scrolling.\n\n".repeat(50)}`),
        toolPart(inputPartID, "bash", "completed", { command: "needle tool input" }, { output: "needle tool output" }),
        toolPart(errorPartID, "bash", "error", { command: "failing command" }, { error: "needle tool error" }),
      ],
      { id: assistantID, parentID: userID },
    ),
    assistantMessage(
      [
        toolPart(
          duplicateInputPartID,
          "bash",
          "completed",
          { command: "needle second tool input" },
          { output: "second output" },
        ),
      ],
      { id: duplicateAssistantID, parentID: userID },
    ),
    assistantMessage([], {
      id: errorID,
      parentID: userID,
      error: { name: "MessageAbortedError", data: { message: "needle assistant error" } },
    }),
  ]
  await setupTimeline(page, { messages })
  await page.route("**/global/transcript/search**", async (route) => {
    const path = new URL(route.request().url()).pathname
    const fulfill = (json: unknown) => route.fulfill({ json, headers: { "access-control-allow-origin": "*" } })
    if (path.endsWith("/facets"))
      return fulfill({
        projects: [],
        agents: [],
        providers: [],
        models: [],
        tools: [],
        agentDetails: [],
        providerDetails: [],
        modelDetails: [],
        toolDetails: [],
        modelIdentities: [],
        projectDetails: [],
        truncated: false,
      })
    if (path.endsWith("/status")) return fulfill({ ready: true, backfillCursor: "" })
    if (!path.endsWith("/search")) return route.fallback()
    const source = [
      [userID, userPartID, "text", "user", "needle user source"],
      [assistantID, assistantPartID, "text", "assistant", "needle assistant source"],
      [assistantID, inputPartID, "tool-input", "assistant", "needle tool input"],
      [assistantID, inputPartID, "tool-output", "assistant", "needle tool output"],
      [duplicateAssistantID, duplicateInputPartID, "tool-input", "assistant", "needle second tool input"],
      [assistantID, errorPartID, "tool-error", "assistant", "needle tool error"],
      [errorID, undefined, "assistant-error", "assistant", "needle assistant error"],
    ] as const
    const hits = source.map(([messageID, partID, category, role, excerpt], index) => ({
      ...(partID ? { partID } : {}),
      documentID: `doc-${index}`,
      messageID,
      sessionID,
      projectID,
      projectPath: directory,
      title,
      directory,
      role,
      type: category === "assistant-error" ? "error" : category === "text" ? "text" : "tool",
      category,
      agent: "build",
      providerID: "opencode",
      modelID: "claude-opus-4-6",
      ...(category.startsWith("tool-")
        ? { toolName: "bash", toolStatus: category === "tool-error" ? "error" : "completed" }
        : {}),
      archived: false,
      timeCreated: index + 1,
      excerpt,
      excerptOffset: 0,
      offset: 0,
      matchLength: 6,
      truncated: false,
    }))
    return fulfill({
      hits,
      scanned: hits.length,
      complete: true,
      scanLimit: 500,
      contentLimit: 65536,
      scanLimited: false,
      truncatedDocuments: 0,
      status: { ready: true, backfillCursor: "" },
    })
  })

  const open = page.getByRole("button", { name: "Search transcripts", exact: true })
  let previousSelector: string | undefined
  const search = async (excerpt: string, target: string, messageID: string, messageOnly = false) => {
    await open.click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Search transcripts" }).fill("needle")
    const result = dialog.getByRole("option").filter({ hasText: excerpt })
    await expect(result).toBeVisible()
    await result.click()
    const selector = messageOnly
      ? `[data-search-message-id="${target}"]`
      : `[data-timeline-message-id="${messageID}"][data-timeline-part-id="${target}"]`
    await expect(page.locator(selector)).toHaveClass(/timeline-search-target/)
    if (previousSelector && previousSelector !== selector)
      await expect(page.locator(previousSelector)).not.toHaveClass(/timeline-search-target/)
    previousSelector = selector
    await expect(page).toHaveURL(/#search:/)
  }

  await search("needle user source", userPartID, userID)
  await search("needle assistant source", assistantPartID, assistantID)
  await search("needle tool input", inputPartID, assistantID)
  const toolURL = page.url()
  const toolTarget = page.locator(`[data-timeline-message-id="${assistantID}"][data-timeline-part-id="${inputPartID}"]`)
  await expect(toolTarget).toBeInViewport()
  await expect(toolTarget).not.toHaveClass(/timeline-search-target/)
  const scroller = page
    .getByRole("region", { name: "scrollable content" })
    .filter({ has: page.getByRole("heading", { name: title }) })
  await scroller.hover({ position: { x: 20, y: 20 } })
  await page.mouse.wheel(0, -10000)
  await expect(toolTarget).not.toBeInViewport()
  await expect(page).toHaveURL(toolURL)
  await search("needle tool input", inputPartID, assistantID)
  await expect(toolTarget).toBeInViewport()
  await expect(page).toHaveURL(toolURL)
  await expect(toolTarget).not.toHaveClass(/timeline-search-target/)
  await search("needle tool output", inputPartID, assistantID)
  await expect(page).toHaveURL(toolURL)
  await search("needle second tool input", duplicateInputPartID, duplicateAssistantID)
  await search("needle tool output", inputPartID, assistantID)
  await search("needle tool error", errorPartID, assistantID)
  await search("needle assistant error", errorID, errorID, true)
})

test("reselecting a search target retries history loading after a failed request", async ({ page }) => {
  const messageID = "msg_search_history_target"
  const target = `search:${encodeURIComponent(JSON.stringify({ messageID }))}`
  await setupTimeline(page, {
    messages: [],
    pageMessages: () => ({ items: [], cursor: "older" }),
  })

  let requests = 0
  let recovered = false
  await page.route("**/session/*/message?**", async (route) => {
    const params = new URL(route.request().url()).searchParams
    if (!params.has("cursor") && !params.has("before")) return route.fallback()
    requests++
    if (!recovered) return route.fulfill({ status: 500, json: { error: "History unavailable" } })
    await route.fulfill({ json: [userMessage([userText("Recovered history")], { id: messageID })] })
  })

  await page.evaluate((hash) => {
    window.location.hash = hash
  }, target)
  await expect.poll(() => requests).toBeGreaterThanOrEqual(1)

  recovered = true
  await page.evaluate(() => window.dispatchEvent(new Event("opencode:repeat-search-navigation")))
  await expect.poll(() => requests).toBeGreaterThanOrEqual(2)
  await expect(page.getByText("Recovered history")).toBeVisible()
})
