import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  partUpdated,
  session,
  sessionID,
  setupTimeline,
  toolPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

test("shows the exact denied shell request before the error and preserves its copy action", async ({ page }) => {
  const shellID = "prt_denied_shell_raw"
  const command = "  printf '%s  \\n' \"two words\" && echo ' exact '  "
  const error =
    "Error: Shell command requires approval. The following permission rules were matched: { permission: bash, pattern: * }"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(shellID, "bash", "error", { command }, { error }),
      ]),
    ],
  })
  const wrapper = page.locator(`[data-timeline-part-id="${shellID}"]`)
  const trigger = wrapper.locator('[data-slot="collapsible-trigger"]').first()
  await trigger.click()

  const raw = wrapper.locator('[data-component="raw-tool-details"]')
  const request = raw.getByRole("button", { name: "Request" })
  const response = raw.getByRole("button", { name: "Response" })
  await expect(request).toHaveAttribute("aria-expanded", "false")
  await expect(response).toHaveAttribute("aria-expanded", "false")
  await request.click()
  expect(JSON.parse(await raw.locator('[aria-label="Request"][data-slot="raw-tool-details-body"]').innerText())).toEqual({
    command,
  })
  await response.click()
  expect(
    JSON.parse(await raw.locator('[aria-label="Response"][data-slot="raw-tool-details-body"]').innerText()),
  ).toEqual({ error })
  expect(
    await wrapper.locator('[data-slot="tool-error-card-content"]').evaluate((content) => {
      const children = Array.from(content.children)
      return (
        children.findIndex((child) => child.matches('[data-component="raw-tool-details"]')) <
        children.findIndex((child) => child.matches('[data-slot="card-description"]'))
      )
    }),
  ).toBe(true)
  await expect(wrapper).toContainText("Shell command requires approval")
  await expect(wrapper).toContainText("permission rules were matched")
  const copy = wrapper.locator('[data-slot="tool-error-card-copy"] button')
  await expect(copy).toBeAttached()
  await copy.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await timeline.settle()
})

test("keeps shell output and live raw details together", async ({ page }) => {
  const shellID = "prt_running_shell_raw"
  const command = "printf 'raw shell request'"
  const output = "raw shell response"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([toolPart(shellID, "bash", "running", { command })], { completed: false }),
    ],
  })
  const wrapper = page.locator(`[data-timeline-part-id="${shellID}"]`)
  const trigger = wrapper.locator('[data-slot="collapsible-trigger"]').first()
  await trigger.click()

  const raw = wrapper.locator('[data-component="raw-tool-details"]')
  const request = raw.locator('[data-slot="collapsible-trigger"]').nth(0)
  const response = raw.locator('[data-slot="collapsible-trigger"]').nth(1)
  await expect(wrapper.locator('[data-component="bash-output"]')).toContainText(command)
  await expect(request).toBeVisible()
  await request.click()
  expect(JSON.parse(await raw.locator('[data-slot="raw-tool-details-body"]').first().innerText())).toEqual({ command })
  await response.click()
  await expect(raw.locator('[data-slot="raw-tool-details-empty"]')).toBeVisible()

  await timeline.send(
    partUpdated(toolPart(shellID, "bash", "completed", { command }, { output })),
    300,
  )
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(wrapper.locator('[data-component="bash-output"]')).toContainText(output)
  await expect(raw.locator('[data-slot="raw-tool-details-body"]').last()).toHaveText(output)
  await expect(wrapper.locator('[data-slot="bash-copy"] button')).toBeAttached()
})

test("opens a running non-shell request and updates its response when complete", async ({ page }) => {
  const fetchID = "prt_running_webfetch_raw"
  const input = { url: "https://example.com/pending" }
  const output = "loaded after completion"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([toolPart(fetchID, "webfetch", "running", input)], { completed: false })],
  })
  const wrapper = page.locator(`[data-timeline-part-id="${fetchID}"]`)
  const trigger = wrapper.locator('[data-slot="collapsible-trigger"]').first()
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")

  const raw = wrapper.locator('[data-component="raw-tool-details"]')
  await expect(raw).toBeVisible()
  await raw.locator('[data-slot="collapsible-trigger"]').nth(0).click()
  expect(JSON.parse(await raw.locator('[aria-label="Request"][data-slot="raw-tool-details-body"]').innerText())).toEqual(
    input,
  )
  const response = raw.locator('[data-slot="collapsible-trigger"]').nth(1)
  await response.click()
  await expect(raw.locator('[data-slot="raw-tool-details-empty"]')).toBeVisible()

  await timeline.send(partUpdated(toolPart(fetchID, "webfetch", "completed", input, { output })), 300)
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(raw.locator('[aria-label="Response"][data-slot="raw-tool-details-body"]')).toHaveText(output)
  await timeline.settle()
})

test("shows raw details after edit, write, and patch presentations", async ({ page }) => {
  const editID = "prt_edit_with_raw"
  const writeID = "prt_write_with_raw"
  const patchID = "prt_patch_with_raw"
  const patchFile = {
    filePath: "src/patch-raw.ts",
    relativePath: "src/patch-raw.ts",
    type: "update",
    additions: 1,
    deletions: 1,
    before: "const before = true\n",
    after: "const after = true\n",
  }
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          editID,
          "edit",
          "completed",
          { filePath: "src/edit-raw.ts", oldString: "const before = true\n", newString: "const after = true\n" },
          {
            metadata: {
              filediff: {
                file: "src/edit-raw.ts",
                before: "const before = true\n",
                after: "const after = true\n",
                additions: 1,
                deletions: 1,
              },
            },
          },
        ),
        toolPart(writeID, "write", "completed", { filePath: "src/write-raw.ts", content: "const written = true\n" }),
        toolPart(
          patchID,
          "patch",
          "completed",
          { files: [patchFile.filePath] },
          { metadata: { files: [patchFile] } },
        ),
      ]),
    ],
  })

  for (const [id, presentation] of [
    [editID, "edit-content"],
    [writeID, "write-content"],
    [patchID, "apply-patch-file-diff"],
  ] as const) {
    const wrapper = page.locator(`[data-timeline-part-id="${id}"]`)
    await wrapper.locator('[data-slot="collapsible-trigger"]').first().click()
    await expect(wrapper.locator(`[data-component="${presentation}"]`)).toBeVisible()
    const raw = wrapper.locator('[data-component="raw-tool-details"]')
    await expect(raw.getByRole("button", { name: "Request" })).toBeVisible()
    await expect(raw.getByRole("button", { name: "Response" })).toBeVisible()
  }
  await timeline.settle()
})

test("keeps Task navigation independent from expandable raw details", async ({ page }) => {
  const taskID = "prt_task_with_raw"
  const childID = "ses_task_raw_child"
  const input = { description: "Inspect the raw request", subagent_type: "explore" }
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(taskID, "task", "completed", input, {
          output: "Task completed",
          metadata: { sessionId: childID },
        }),
      ]),
    ],
    sessions: [session(), session({ id: childID, parentID: sessionID, title: input.description })],
  })
  const wrapper = page.locator(`[data-timeline-part-id="${taskID}"]`)
  const link = wrapper.locator('a[data-slot="tool-navigation-link"]')
  const row = wrapper.locator('[data-component="tool-separate-trigger-row"]')
  const details = row.locator(".tool-separate-details-trigger")
  await expect(link).toHaveAttribute("href", new RegExp(`/session/${childID}$`))
  await link.hover()
  await expect(details).toHaveCSS("opacity", "1")
  await expect(row.locator('[data-component="task-tool-action"]')).toHaveCSS("opacity", "1")
  await details.focus()
  await expect(details).toHaveAttribute("aria-expanded", "false")
  await details.press("Enter")
  await expect(details).toHaveAttribute("aria-expanded", "true")
  await expect(page).toHaveURL(new RegExp(`/session/${sessionID}$`))
  const raw = wrapper.locator('[data-component="raw-tool-details"]')
  await raw.getByRole("button", { name: "Request" }).click()
  expect(JSON.parse(await raw.locator('[aria-label="Request"][data-slot="raw-tool-details-body"]').innerText())).toEqual(
    input,
  )
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/session/${childID}$`))
})

test("keeps the Task details control available without a child session in the legacy layout", async ({ page }) => {
  const taskID = "prt_task_without_child_raw"
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(taskID, "task", "completed", { description: "Task without a child session", subagent_type: "explore" }),
      ]),
    ],
    settings: { newLayoutDesigns: false },
  })
  const wrapper = page.locator(`[data-timeline-part-id="${taskID}"]`)
  const row = wrapper.locator('[data-component="tool-separate-trigger-row"]')
  const details = row.locator(".tool-separate-details-trigger")
  await expect(row.locator('a[data-slot="tool-navigation-link"]')).toHaveCount(0)
  await details.focus()
  await details.press("Space")
  await expect(details).toHaveAttribute("aria-expanded", "true")
  await expect(wrapper.locator('[data-component="raw-tool-details"]')).toBeVisible()
})

test("keeps raw details and child navigation on failed Task cards", async ({ page }) => {
  const taskID = "prt_failed_task_with_raw"
  const childID = "ses_failed_task_child"
  const input = { description: "Inspect failed child", subagent_type: "explore" }
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(taskID, "task", "error", input, {
          error: "Error: Subagent execution failed",
          metadata: { sessionId: childID },
        }),
      ]),
    ],
    sessions: [session(), session({ id: childID, parentID: sessionID, title: input.description })],
  })
  const wrapper = page.locator(`[data-timeline-part-id="${taskID}"]`)
  const trigger = wrapper.locator('[data-slot="collapsible-trigger"]').first()
  await trigger.click()
  const raw = wrapper.locator('[data-component="raw-tool-details"]')
  await raw.getByRole("button", { name: "Request" }).click()
  expect(JSON.parse(await raw.locator('[data-slot="raw-tool-details-body"]').first().innerText())).toEqual(input)
  await raw.getByRole("button", { name: "Response" }).click()
  expect(JSON.parse(await raw.locator('[data-slot="raw-tool-details-body"]').last().innerText())).toEqual({
    error: "Error: Subagent execution failed",
  })
  const link = wrapper.locator('a.subagent-link')
  await expect(link).toHaveAttribute("href", new RegExp(`/session/${childID}$`))
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/session/${childID}$`))
})

test("exposes raw request and response for generic MCP tools", async ({ page }) => {
  const toolID = "prt_generic_mcp_raw"
  const input = { target: "example", count: 2 }
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([toolPart(toolID, "mcp_probe", "completed", input, { output: "ok" })])],
  })
  const wrapper = page.locator(`[data-timeline-part-id="${toolID}"]`)
  await wrapper.locator('[data-slot="collapsible-trigger"]').first().click()
  const raw = wrapper.locator('[data-component="raw-tool-details"]')
  await raw.getByRole("button", { name: "Request" }).click()
  expect(JSON.parse(await raw.locator('[aria-label="Request"][data-slot="raw-tool-details-body"]').innerText())).toEqual(
    input,
  )
  await raw.getByRole("button", { name: "Response" }).click()
  await expect(raw.locator('[aria-label="Response"][data-slot="raw-tool-details-body"]')).toHaveText("ok")
  await timeline.settle()
})

test("keeps raw details available for WebSearch, Skill, Question, and grouped context tools", async ({ page }) => {
  const searchID = "prt_websearch_raw"
  const skillID = "prt_skill_raw"
  const questionID = "prt_question_raw"
  const contextReadID = "prt_context_read_raw"
  const contextListID = "prt_context_list_raw"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(searchID, "websearch", "completed", { query: "raw detail search" }, { output: "https://example.com/result" }),
        toolPart(skillID, "skill", "completed", { name: "review" }, { output: "Skill loaded" }),
        toolPart(
          questionID,
          "question",
          "completed",
          { questions: [{ header: "Choice", question: "Which option?", options: ["A", "B"] }] },
          { metadata: { answers: [["A"]] } },
        ),
        toolPart(contextReadID, "read", "completed", { filePath: "src/context.ts" }, { output: "Context file" }),
        toolPart(contextListID, "list", "completed", { path: "src" }, { output: "Context directory" }),
      ]),
    ],
  })

  const search = page.locator(`[data-timeline-part-id="${searchID}"]`)
  await search.locator('[data-slot="collapsible-trigger"]').first().click()
  await expect(search.locator('a[href="https://example.com/result"]')).toBeVisible()
  await expect(search.locator('[data-component="raw-tool-details"]')).toBeVisible()

  const skill = page.locator(`[data-timeline-part-id="${skillID}"]`)
  await skill.locator('[data-slot="collapsible-trigger"]').first().click()
  await expect(skill.locator('[data-component="raw-tool-details"]')).toBeVisible()

  const question = page.locator(`[data-timeline-part-id="${questionID}"]`)
  await expect(question.locator('[data-component="question-answers"]')).toContainText("A")
  await expect(question.locator('[data-component="raw-tool-details"]')).toBeVisible()

  await page.locator('[data-component="context-tool-group-trigger"]').click()
  const group = page.locator('[data-component="context-tool-group-list"]')
  const item = group.locator('[data-slot="context-tool-group-item"]').filter({ hasText: "List" })
  await item.locator('[data-slot="collapsible-trigger"]').first().click()
  await expect(item.locator('[data-component="raw-tool-details"]')).toBeVisible()
  const rawRequest = item.locator('[data-component="raw-tool-details"] [data-slot="collapsible-trigger"]').first()
  await rawRequest.click()
  expect(
    JSON.parse(await item.locator('[data-slot="raw-tool-details-body"]').first().innerText()),
  ).toEqual({ path: "src" })
  await timeline.settle()
})
