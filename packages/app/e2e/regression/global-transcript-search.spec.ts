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
    await page.keyboard.press("Control+Shift+f")
    await expect(page.getByRole("dialog")).toBeVisible()
  })
}

test("opens exact user, assistant, tool, and message-error search targets", async ({ page }) => {
  const userID = "msg_search_user"
  const assistantID = "msg_search_assistant"
  const duplicateAssistantID = "msg_search_assistant_duplicate"
  const errorID = "msg_search_error"
  const userPartID = "part_search_user"
  const assistantPartID = "part_search_assistant"
  const inputPartID = "part_search_input"
  const errorPartID = "part_search_tool_error"
  const messages = [
    userMessage([userText("needle user source", { id: userPartID })], { id: userID }),
    assistantMessage(
      [
        textPart(assistantPartID, "needle assistant source"),
        toolPart(inputPartID, "bash", "completed", { command: "needle tool input" }, { output: "needle tool output" }),
        toolPart(errorPartID, "bash", "error", { command: "failing command" }, { error: "needle tool error" }),
      ],
      { id: assistantID, parentID: userID },
    ),
    assistantMessage(
      [
        toolPart(
          inputPartID,
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
      [duplicateAssistantID, inputPartID, "tool-input", "assistant", "needle second tool input"],
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
  await search("needle second tool input", inputPartID, duplicateAssistantID)
  await search("needle tool output", inputPartID, assistantID)
  await search("needle tool error", errorPartID, assistantID)
  await search("needle assistant error", errorID, errorID, true)
})
