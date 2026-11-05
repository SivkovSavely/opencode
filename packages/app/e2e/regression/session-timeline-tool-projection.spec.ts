import { expect, test, type Page } from "@playwright/test"
import type { JsonValue } from "@opencode/client/promise"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import {
  assistantMessage,
  partUpdated,
  reasoningPart,
  setupTimeline,
  status,
  textPart,
  toolPart,
  userMessage,
} from "../utils/timeline"

test("keeps shell and question failures in their Used group", async ({ page }) => {
  const shellID = "prt_transition_error_shell"
  const questionID = "prt_transition_error_question"

  const timeline = await setupTimeline(page, {
    settings: { timelineDetail: timelinePresets[2].value },
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(shellID, "shell", "streaming", { command: "exit 1" }),
          toolPart(questionID, "question", "streaming", questionInput()),
        ],
        { completed: false },
      ),
    ],
  })

  const group = page.locator('[data-component="collapsed-tool-group"]')
  const used = group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
  await used.click()
  await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
  await timeline.send(partUpdated(toolPart(shellID, "shell", "running", { command: "exit 1" })))
  await expect(page.locator(`[data-timeline-part-id="${shellID}"]`)).toContainText("exit 1")
  await timeline.send(partUpdated(toolPart(questionID, "question", "running", questionInput())))
  await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
  await timeline.send(
    partUpdated(
      toolPart(
        shellID,
        "shell",
        "completed",
        { command: "exit 1" },
        { output: "Command exited 1", metadata: { exit: 1 } },
      ),
    ),
  )
  await timeline.send(
    partUpdated(
      toolPart(questionID, "question", "error", questionInput(), { error: "The user dismissed this question" }),
    ),
  )

  await expect(group).toHaveAttribute("data-timeline-part-ids", `${shellID},${questionID}`)
  await expect(used).toHaveAttribute("aria-expanded", "true")
  const shell = group.locator(`[data-timeline-part-id="${shellID}"]`)
  await expect(shell.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")
  await shell.locator('[data-slot="collapsible-trigger"]').click()
  await expect(shell).toContainText("Command exited 1")
  const question = group.locator(`[data-timeline-part-id="${questionID}"]`)
  await expect(question).toContainText(/dismissed/i)
})

test("keeps rendering when a plugin tool reports progress metadata that is not an object", async ({ page }) => {
  const toolID = "prt_plugin_progress"
  const input = { prompt: "a cat" }

  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([toolPart(toolID, "plugin_imagegen", "running", input)], { completed: false }),
    ],
  })

  await page
    .locator(
      '[data-component="collapsed-tool-group"] > [data-component="collapsible"] > [data-slot="collapsible-trigger"]',
    )
    .click()
  await timeline.waitForPart(toolID)

  const progress = partUpdated(
    toolPart(toolID, "plugin_imagegen", "running", input, { metadata: { status: "x" } }),
  ).find((event) => event.type === "session.tool.progress")!

  // Plugin tools are untyped at runtime, and the server forwards progress metadata as sent, so the
  // frame is written raw to skip the harness's event validation.
  await timeline.transport.writeRaw(
    `data: ${JSON.stringify({ ...progress, data: { ...progress.data, metadata: "polling" } })}\n\n`,
  )
  await timeline.send(partUpdated(textPart("prt_plugin_progress_text", "Still polling the image task.")))

  await expect(page.getByText("Still polling the image task.")).toBeVisible()
  await expect(page.locator(`[data-timeline-part-id="${toolID}"]`)).toBeVisible()
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0)
})

function questionInput() {
  return { questions: [{ header: "Stability", question: "Keep it stable?", options: [] }] }
}

test.describe("transcript clocks", () => {
  test.use({ timezoneId: "UTC", locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] })

  test("keeps historical clocks with their owners and preserves copy and hover geometry", async ({ page }) => {
    const first = assistantMessage([textPart("prt_clock_first", "Earlier response")], {
      id: "msg_clock_first",
      created: 1700000001000,
    })

    const last = assistantMessage(
      [
        toolPart("prt_clock_shell", "shell", "completed", { command: "echo clock" }),
        toolPart("prt_clock_failed", "webfetch", "error", { url: "https://example.com" }, { error: "Clock failure" }),
        textPart("prt_clock_last", "Final response"),
      ],
      { id: "msg_clock_last", created: 1700000005000 },
    )

    const shell = last.content.find((part) => part.type === "tool" && part.id === "prt_clock_shell")
    const failed = last.content.find((part) => part.type === "tool" && part.id === "prt_clock_failed")

    if (!shell || shell.type !== "tool" || !failed || failed.type !== "tool") throw new Error("missing tools")
    shell.time = { created: 1700000002000, ran: 1700000003000, completed: 1700000009000 }
    failed.time = { created: 1700000004000, completed: 1700000010000 }

    await setupTimeline(page, {
      locale: "en",
      settings: { timelineDetail: timelinePresets[2].value },
      messages: [userMessage(undefined, { created: 1700000000000 }), first, last],
    })
    const user = page.locator('[data-component="user-message"]').filter({ hasText: "Build the timeline" })
    await expect(user.locator('[data-slot="user-message-meta"]')).toContainText("22:13:20")
    const final = page.locator('[data-component="text-part"]').filter({ hasText: "Final response" })
    await expect(final.locator('[data-slot="text-part-meta"]')).toContainText("22:13:25")
    await expect(final.locator('[data-slot="text-part-meta"]')).toContainText(/\d+\s*s/)
    await expect(
      page
        .locator('[data-component="text-part"]')
        .filter({ hasText: "Earlier response" })
        .locator('[data-slot="text-part-copy-wrapper"]'),
    ).toHaveCount(0)
    await final.hover()
    await final.getByRole("button", { name: "Copy response" }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Final response")
    await user.hover()
    await user.getByRole("button", { name: "More actions" }).click()
    await page.getByRole("menuitem", { name: "Copy message" }).click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Build the timeline stability matrix.")

    const group = page.locator('[data-component="collapsed-tool-group"]')
    await group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
    const card = group.locator('[data-timeline-part-id="prt_clock_shell"]')
    const stamp = card.locator('[data-slot="tool-timestamp"]')
    await expect(stamp).toHaveText("22:13:23")
    await expect(stamp).toBeHidden()
    const before = await card.boundingBox()
    await card.hover()
    await expect(stamp).toBeVisible()
    expect(await card.boundingBox()).toEqual(before)
    await card.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
    await card.getByRole("button", { name: "Request", exact: true }).click()
    await expect(card.getByRole("region", { name: "Request", exact: true })).toContainText('"command": "echo clock"')
    await card.hover()
    await expect(stamp).toHaveText("22:13:23")
    await expect(stamp).toBeVisible()
    const expanded = await card.boundingBox()
    const error = group.locator('[data-timeline-part-id="prt_clock_failed"]')
    await expect(error).toContainText("Clock failure")
    await error.hover()
    await expect(error.locator('[data-slot="tool-timestamp"]')).toHaveText("22:13:24")
    await expect(stamp).toBeHidden()
    expect(await card.boundingBox()).toEqual(expanded)
    await page.reload()
    await expect(
      page
        .locator('[data-component="user-message"]')
        .filter({ hasText: "Build the timeline" })
        .locator('[data-slot="user-message-meta"]'),
    ).toContainText("22:13:20")
    const reloaded = page.locator('[data-component="collapsed-tool-group"]')
    await reloaded.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
    await expect(reloaded.locator('[data-timeline-part-id="prt_clock_shell"] [data-slot="tool-timestamp"]')).toHaveText(
      "22:13:23",
    )
  })

  test("reveals a live start only after execution and retains it on failure", async ({ page }) => {
    const timeline = await setupTimeline(page, {
      locale: "en",
      settings: { timelineDetail: timelinePresets[2].value },
      messages: [
        userMessage(),
        assistantMessage(
          [
            toolPart("prt_live_clock", "shell", "streaming", { command: "exit 1" }),
            textPart("prt_live_text", "Working response"),
          ],
          { completed: false },
        ),
      ],
    })

    await expect(page.getByText("Working response")).toBeVisible()
    await expect(page.locator('[data-slot="text-part-copy-wrapper"]')).toHaveCount(0)
    const group = page.locator('[data-component="collapsed-tool-group"]')
    await group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
    const card = group.locator('[data-timeline-part-id="prt_live_clock"]')
    await expect(card.locator('[data-slot="tool-timestamp"]')).toHaveCount(0)
    await timeline.send(partUpdated(toolPart("prt_live_clock", "shell", "running", { command: "exit 1" })))
    await expect(card.locator('[data-slot="tool-timestamp"]')).toHaveText("22:13:22")
    await timeline.send(partUpdated(toolPart("prt_live_clock", "shell", "running", { command: "exit 1" })))
    await expect(card.locator('[data-slot="tool-timestamp"]')).toHaveText("22:13:22")
    const correction = partUpdated(toolPart("prt_clock_correction", "shell", "running", { command: "exit 1" }))
    await timeline.send(
      correction.map((event) =>
        event.type === "session.tool.called"
          ? { ...event, created: 1700000006000, data: { ...event.data, id: "prt_live_clock" } }
          : event,
      ),
    )
    await expect(card.locator('[data-slot="tool-timestamp"]')).toHaveText("22:13:26")
    await timeline.send(
      partUpdated(toolPart("prt_live_clock", "shell", "error", { command: "exit 1" }, { error: "Execution failed" })),
    )
    await expect(card).toContainText("Execution failed")
    await expect(card.locator('[data-slot="tool-timestamp"]')).toHaveText("22:13:26")
    await timeline.send(status("idle"))
  })

  test("keeps distinct clocks on grouped read, file and skill identities", async ({ page }) => {
    const message = assistantMessage([
      toolPart("prt_read_a", "read", "completed", { path: "/src/alpha.ts" }),
      toolPart("prt_read_b", "read", "completed", { path: "/src/beta.ts" }),
      toolPart("prt_write_a", "write", "completed", { path: "/src/one.ts", content: "one\n" }),
      toolPart("prt_write_b", "write", "completed", { path: "/src/two.ts", content: "two\n" }),
      toolPart("prt_skill_a", "skill", "completed", { name: "first-skill" }),
      toolPart("prt_skill_b", "skill", "completed", { name: "second-skill" }),
      textPart("prt_group_finish", "Grouped response"),
    ])

    message.content.forEach((part, index) => {
      if (part.type === "tool") part.time = { created: 1700000000000, ran: 1700000001000 + index * 1000 }
    })
    await setupTimeline(page, {
      locale: "en",
      settings: { timelineDetail: timelinePresets[2].value },
      messages: [userMessage(), message],
    })
    const group = page.locator('[data-component="collapsed-tool-group"]')
    await group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
    const alpha = group.locator('[data-timeline-part-id="prt_read_a"]')
    const beta = group.locator('[data-timeline-part-id="prt_read_b"]')
    await expect(alpha).toContainText("alpha.ts")
    await alpha.hover()
    await expect(alpha.locator('[data-slot="tool-inline-timestamp"]')).toHaveText("22:13:21")
    await expect(alpha.locator('[data-slot="tool-inline-timestamp"]')).toBeVisible()
    await beta.hover()
    await expect(beta.locator('[data-slot="tool-inline-timestamp"]')).toHaveText("22:13:22")
    const one = group.locator('[data-slot="accordion-trigger"]').filter({ hasText: "one.ts" })
    const two = group.locator('[data-slot="accordion-trigger"]').filter({ hasText: "two.ts" })
    await one.hover()
    await expect(one.locator('[data-slot="tool-inline-timestamp"]')).toHaveText("22:13:23")
    await expect(one.locator('[data-slot="tool-inline-timestamp"]')).toBeVisible()
    await two.hover()
    await expect(two.locator('[data-slot="tool-inline-timestamp"]')).toHaveText("22:13:24")
    const first = group.locator('[data-slot="tool-inline-owner"]').filter({ hasText: "first-skill" })
    const second = group.locator('[data-slot="tool-inline-owner"]').filter({ hasText: "second-skill" })
    await first.hover()
    await expect(first.locator('[data-slot="tool-inline-timestamp"]')).toHaveText("22:13:25")
    await expect(first.locator('[data-slot="tool-inline-timestamp"]')).toBeVisible()
    await second.hover()
    await expect(second.locator('[data-slot="tool-inline-timestamp"]')).toHaveText("22:13:26")
    await one.click()
    await expect(one.locator('[data-slot="tool-inline-timestamp"]')).toHaveText("22:13:23")
  })

  test("does not invent an assistant clock footer for a reasoning-only response", async ({ page }) => {
    await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([reasoningPart("prt_reasoning_clock", "Reasoning without a final answer")]),
      ],
    })
    await expect(page.locator('[data-component="collapsed-tool-group"]')).toBeVisible()
    await expect(page.locator('[data-slot="text-part-copy-wrapper"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="text-part-meta"]')).toHaveCount(0)
  })
})

async function openTools(page: Page, count = 1) {
  const group = page.locator('[data-component="collapsed-tool-group"]')
  const triggers = group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
  await expect(triggers).toHaveCount(count)
  for (const trigger of await triggers.all()) await trigger.click()
  return group
}

test.describe("raw tool inspection", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"], timezoneId: "UTC" })

  test("keeps shell inspection lazy and independent while a real live result arrives", async ({ page }) => {
    const command = "  printf '%s\\n' 'fixture  value'  "
    const message = assistantMessage([toolPart("prt_raw_shell", "shell", "streaming", { command })], {
      completed: false,
    })
    const tool = message.content.find((part) => part.type === "tool")
    if (!tool || tool.type !== "tool") throw new Error("missing fixture tool")
    tool.state = { status: "streaming", input: JSON.stringify({ command }) }
    const timeline = await setupTimeline(page, {
      settings: { timelineDetail: timelinePresets[2].value },
      messages: [userMessage(), message],
    })
    await expect(page.locator('[data-component="raw-tool-details"]')).toHaveCount(0)
    const group = await openTools(page)
    const card = group.locator('[data-timeline-part-id="prt_raw_shell"]')
    const outer = card.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
    await outer.click()
    const request = card.getByRole("button", { name: "Request", exact: true })
    const response = card.getByRole("button", { name: "Response", exact: true })
    await expect(request).toHaveAttribute("aria-expanded", "false")
    await expect(response).toHaveAttribute("aria-expanded", "false")
    await expect(card.locator('[data-slot="raw-tool-details-body"]')).toHaveCount(0)
    await request.click()
    const input = card.getByRole("region", { name: "Request", exact: true })
    expect(JSON.parse((await input.textContent()) ?? "")).toEqual({ command })
    await expect(response).toHaveAttribute("aria-expanded", "false")
    await expect(card.getByRole("button", { name: /Format/ })).toHaveCount(0)
    await response.click()
    await expect(card.getByText("No response yet", { exact: true })).toBeVisible()
    await timeline.send(
      partUpdated(
        toolPart("prt_raw_shell", "shell", "running", { command }, { output: "progress is not a terminal result" }),
      ),
    )
    await expect(card.getByText("No response yet", { exact: true })).toBeVisible()
    const output = "  first line\n\tsecond line  \n"
    await timeline.send(partUpdated(toolPart("prt_raw_shell", "shell", "completed", { command }, { output })))
    await expect(outer).toHaveAttribute("aria-expanded", "true")
    const result = card.getByRole("region", { name: "Response", exact: true })
    await expect(result).toBeVisible()
    expect(await result.textContent()).toBe(output)
    await expect(result).toHaveAttribute("tabindex", "0")
    await result.focus()
    await expect(result).toBeFocused()
    await card.locator('[data-component="bash-output"]').hover()
    await card.getByRole("button", { name: "Copy output", exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(output)
    await expect(card.locator('[data-slot="tool-timestamp"]')).toHaveText("22:13:22")
  })

  test("retains failed incomplete input through the native projection without losing raw result metadata", async ({
    page,
  }) => {
    const message = assistantMessage([toolPart("prt_raw_partial", "plugin_fixture", "streaming", {})], {
      completed: false,
    })
    const tool = message.content.find((part) => part.type === "tool")
    if (!tool || tool.type !== "tool") throw new Error("missing fixture tool")
    tool.state = { status: "streaming", input: '  {"command":"unfinished ' }
    const timeline = await setupTimeline(page, { messages: [userMessage(), message] })
    const group = await openTools(page)
    const card = group.locator('[data-timeline-part-id="prt_raw_partial"]')
    await card.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
    await card.getByRole("button", { name: "Request", exact: true }).click()
    expect(await card.getByRole("region", { name: "Request", exact: true }).textContent()).toBe(
      '  {"command":"unfinished ',
    )
    await timeline.send(
      partUpdated(
        toolPart(
          "prt_raw_partial",
          "plugin_fixture",
          "error",
          {},
          {
            error: "Denied fixture command",
            metadata: { __opencode_raw_tool_details: { providerExecuted: true, hasResult: true, result: false } },
          },
        ),
      ).filter((event) => event.type === "session.tool.failed"),
    )
    // A failure changes to the native error card, which has its own disclosure lifetime.
    await expect(card.locator('[data-kind="tool-error-card"]')).toBeVisible()
    await card.getByRole("button", { name: "Request", exact: true }).click()
    expect(await card.getByRole("region", { name: "Request", exact: true }).textContent()).toBe(
      '  {"command":"unfinished ',
    )
    await card.getByRole("button", { name: "Response", exact: true }).click()
    await expect(card.getByRole("region", { name: "Response", exact: true })).toContainText('"result": false')
    const order = await card.evaluate((element) => {
      const raw = element.querySelector('[data-component="raw-tool-details"]')!
      const body = element.querySelector('[data-slot="tool-error-card-content"]')
      return body ? !!(raw.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) : false
    })
    expect(order).toBe(true)
    await card.getByRole("button", { name: "Copy error", exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Denied fixture command")
    await expect(card.getByRole("region", { name: "Request", exact: true })).toBeVisible()
  })

  test("keeps original null, scalar, array and object arguments across live called and terminal boundaries", async ({
    page,
  }) => {
    const values: JsonValue[] = [null, false, 0, "", [false, null], { original: { nested: true } }]
    const message = assistantMessage(
      values.map((value, index) => toolPart(`prt_argument_${index}`, "plugin_fixture", "streaming", {})),
      { completed: false },
    )
    message.content.forEach((part, index) => {
      if (part.type === "tool") part.state = { status: "streaming", input: JSON.stringify(values[index]) }
    })
    const timeline = await setupTimeline(page, { messages: [userMessage(), message] })
    const group = await openTools(page)
    for (const [index, value] of values.entries()) {
      const id = `prt_argument_${index}`
      const card = group.locator(`[data-timeline-part-id="${id}"]`)
      await card.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
      await card.getByRole("button", { name: "Request", exact: true }).click()
      const request = card.getByRole("region", { name: "Request", exact: true })
      const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2)
      await expect(request).toHaveText(rendered)
      const normalized = value !== null && typeof value === "object" && !Array.isArray(value) ? value : { value }
      await timeline.send(
        partUpdated(toolPart(id, "plugin_fixture", "running", normalized)).filter(
          (event) => event.type === "session.tool.called" || event.type === "session.tool.progress",
        ),
      )
      await expect(request).toHaveText(rendered)
      const failed = index % 2 === 0
      await timeline.send(
        partUpdated(
          failed
            ? toolPart(id, "plugin_fixture", "error", normalized, { error: "Denied arguments" })
            : toolPart(id, "plugin_fixture", "completed", normalized, { output: "done" }),
        ).filter((event) => event.type === "session.tool.failed" || event.type === "session.tool.success"),
      )
      if (failed) {
        await expect(card.locator('[data-kind="tool-error-card"]')).toBeVisible()
        await card.getByRole("button", { name: "Request", exact: true }).click()
      }
      await expect(request).toHaveText(rendered)
    }
  })

  test("formats complete running requests and independent terminal responses reversibly without stale source", async ({
    page,
  }) => {
    const request = ' {"original":true,"nested":[1,2]} '
    const output =
      '<?xml version="1.0"?><result><!--fixture--><?keep value?><one/><two xml:space="preserve"><a/><b/></two></result>'
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage(
          [
            toolPart(
              "prt_raw_format",
              "plugin_fixture",
              "running",
              { displayAlias: "not original" },
              {
                metadata: { __opencode_raw_tool_details: { input: request } },
              },
            ),
          ],
          { completed: false },
        ),
      ],
    })
    const group = await openTools(page)
    const card = group.locator('[data-timeline-part-id="prt_raw_format"]')
    await card.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
    await card.getByRole("button", { name: "Request", exact: true }).click()
    const input = card.getByRole("region", { name: "Request", exact: true })
    expect(await input.textContent()).toBe(request)
    await card.getByRole("button", { name: "Format JSON", exact: true }).click()
    await expect(card.getByRole("button", { name: "Show raw", exact: true })).toBeFocused()
    await expect(input).toContainText('\n  "original": true,\n')
    await card.getByRole("button", { name: "Request", exact: true }).click()
    await expect(input).toHaveCount(0)
    await card.getByRole("button", { name: "Request", exact: true }).click()
    await expect(card.getByRole("button", { name: "Show raw", exact: true })).toBeVisible()
    const changed = ' {"changed":false} '
    await timeline.send(
      partUpdated(
        toolPart(
          "prt_raw_format",
          "plugin_fixture",
          "running",
          {},
          { metadata: { __opencode_raw_tool_details: { input: changed } } },
        ),
      ),
    )
    await expect(input).toHaveText(changed)
    await expect(card.getByRole("button", { name: "Format JSON", exact: true })).toBeVisible()
    await card.getByRole("button", { name: "Format JSON", exact: true }).click()
    await card.getByRole("button", { name: "Response", exact: true }).click()
    await expect(card.getByText("No response yet", { exact: true })).toBeVisible()
    await timeline.send(
      partUpdated(
        toolPart(
          "prt_raw_format",
          "plugin_fixture",
          "completed",
          {},
          {
            output,
            metadata: { __opencode_raw_tool_details: { input: changed } },
          },
        ),
      ),
    )
    const result = card.getByRole("region", { name: "Response", exact: true })
    await expect(result).toHaveText(output)
    expect(await result.textContent()).toBe(output)
    await card.getByRole("button", { name: "Format XML", exact: true }).click()
    await expect(result).toContainText("\n  <!--fixture-->\n")
    await expect(result).toContainText("<?keep value?>")
    await expect(result).toContainText('<two xml:space="preserve"><a/><b/></two>')
    const responseSection = card
      .locator('[data-component="raw-tool-details"] > [data-component="collapsible"]')
      .filter({ has: page.getByRole("button", { name: "Response", exact: true }) })
    await responseSection.getByRole("button", { name: "Show raw", exact: true }).click()
    expect(await result.textContent()).toBe(output)
    const requestSection = card
      .locator('[data-component="raw-tool-details"] > [data-component="collapsible"]')
      .filter({ has: page.getByRole("button", { name: "Request", exact: true }) })
    await requestSection.getByRole("button", { name: "Show raw", exact: true }).click()
    expect(await input.textContent()).toBe(changed)
    await expect(card.getByText("No response yet", { exact: true })).toHaveCount(0)
  })

  test("shows equivalent loaded and live provider data with descriptors and paths but no attachment retrieval", async ({
    page,
  }) => {
    const raw: Record<string, JsonValue> = {
      input: { path: "/original/file", nested: { untouched: [false, null, ""] } },
      providerExecuted: true,
      hasResult: true,
      result: {
        type: "content",
        value: [
          { type: "text", text: "rich provider data" },
          {
            type: "file",
            name: "fixture.bin",
            mime: "application/octet-stream",
            uri: "https://never-fetch.invalid/blob",
            data: "PRIVATE_BYTES",
          },
        ],
      },
      attachments: [{ name: "fixture.bin", mime: "application/octet-stream", uri: "file:///never-open" }],
      outputPaths: ["/never/read/output", 3],
    }
    const forbidden: string[] = []
    page.on("request", (request) => {
      if (/never-fetch|never-open|never\/read/.test(request.url())) forbidden.push(request.url())
    })
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage(
          [
            toolPart(
              "prt_raw_loaded",
              "plugin_fixture",
              "completed",
              { filePath: "display alias" },
              { output: "reduced output", metadata: { __opencode_raw_tool_details: raw } },
            ),
            toolPart("prt_raw_live", "plugin_fixture", "running", {}),
          ],
          { completed: false },
        ),
      ],
    })
    await timeline.send(
      partUpdated(
        toolPart(
          "prt_raw_live",
          "plugin_fixture",
          "completed",
          { filePath: "display alias" },
          { output: "reduced output", metadata: { __opencode_raw_tool_details: raw } },
        ),
      ),
    )
    const group = await openTools(page)
    const values: string[] = []
    for (const id of ["prt_raw_loaded", "prt_raw_live"]) {
      const card = group.locator(`[data-timeline-part-id="${id}"]`)
      await card.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
      await card.getByRole("button", { name: "Request", exact: true }).click()
      expect(
        JSON.parse((await card.getByRole("region", { name: "Request", exact: true }).textContent()) ?? ""),
      ).toEqual(raw.input)
      await card.getByRole("button", { name: "Response", exact: true }).click()
      const text = (await card.locator('[data-component="raw-tool-details"]').textContent()) ?? ""
      expect(text).toContain("rich provider data")
      expect(text).toContain("/never/read/output")
      expect(text).not.toContain("PRIVATE_BYTES")
      expect(text).not.toContain("https://never-fetch")
      expect(text).not.toContain("file:///never-open")
      expect(text).not.toContain("reduced output")
      values.push(text)
    }
    expect(values[0]).toBe(values[1])
    expect(forbidden).toEqual([])
  })

  test("retains each grouped call beside specialized read, file, skill and search summaries", async ({ page }) => {
    await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([
          toolPart("prt_raw_read_a", "read", "completed", { path: "/src/alpha.ts", offset: 7 }),
          toolPart("prt_raw_read_b", "read", "completed", { path: "/src/beta.ts", offset: 9 }),
          toolPart("prt_raw_write", "write", "completed", { path: "/src/out.ts", content: "retained-file-text" }),
          toolPart("prt_raw_skill_a", "skill", "completed", { name: "skill-a", argument: "first" }),
          toolPart("prt_raw_skill_b", "skill", "completed", { name: "skill-b", argument: "second" }),
          toolPart("prt_raw_glob", "glob", "completed", { pattern: "*.ts", hiddenField: "original-glob" }),
        ]),
      ],
    })
    const group = await openTools(page)
    await expect(group.locator('[data-slot="accordion-trigger"]').filter({ hasText: "out.ts" })).toBeVisible()
    await group.getByRole("button", { name: /Read.*alpha.ts.*beta.ts/ }).click()
    for (const [name, value] of [
      ["alpha.ts", '"offset": 7'],
      ["beta.ts", '"offset": 9'],
      ["out.ts", "retained-file-text"],
      ["skill-a", '"argument": "first"'],
      ["skill-b", '"argument": "second"'],
      ["*.ts", "original-glob"],
    ]) {
      const entry = group.locator('[data-component="raw-tool-entry"]').filter({ hasText: name })
      await entry.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
      await entry.getByRole("button", { name: "Request", exact: true }).click()
      await expect(entry.getByRole("region", { name: "Request", exact: true })).toContainText(value!)
    }
  })

  test("inspects a singleton Skill from loaded and live history and then its failure", async ({ page }) => {
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage(
          [
            toolPart(
              "prt_loaded_skill",
              "skill",
              "completed",
              { name: "loaded-skill" },
              { output: "loaded instructions" },
            ),
            toolPart("prt_skill_separator", "plugin_fixture", "completed", {}),
            toolPart("prt_single_skill", "skill", "running", { name: "single-skill", argument: "original" }),
            toolPart("prt_skill_separator_error", "plugin_fixture", "completed", {}),
            toolPart("prt_failed_skill", "skill", "error", { name: "failed-skill" }, { error: "Skill denied" }),
          ],
          { completed: false },
        ),
      ],
    })
    const group = await openTools(page)
    const loaded = group.locator('[data-timeline-part-id="prt_loaded_skill"]')
    await loaded.getByRole("button", { name: /skill/i }).click()
    await loaded.getByRole("button", { name: "Response", exact: true }).click()
    await expect(loaded.getByRole("region", { name: "Response", exact: true })).toHaveText("loaded instructions")
    const card = group.locator('[data-timeline-part-id="prt_single_skill"]')
    await expect(card.getByLabel("Loaded single-skill skill")).toBeVisible()
    await card.getByRole("button", { name: /skill/i }).click()
    await card.getByRole("button", { name: "Request", exact: true }).click()
    await expect(card.getByRole("region", { name: "Request", exact: true })).toContainText('"argument": "original"')
    await card.getByRole("button", { name: "Response", exact: true }).click()
    await timeline.send(
      partUpdated(
        toolPart(
          "prt_single_skill",
          "skill",
          "completed",
          { name: "single-skill", argument: "original" },
          { output: "retained skill instructions" },
        ),
      ),
    )
    await expect(card.getByRole("region", { name: "Response", exact: true })).toHaveText("retained skill instructions")
    const failed = group.locator('[data-timeline-part-id="prt_failed_skill"]')
    await failed
      .locator('[data-kind="tool-error-card"] > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
      .click()
    await failed.getByRole("button", { name: "Request", exact: true }).click()
    await expect(failed.getByRole("region", { name: "Request", exact: true })).toContainText("failed-skill")
    await failed.getByRole("button", { name: "Response", exact: true }).click()
    await expect(failed.getByRole("region", { name: "Response", exact: true })).toContainText("Skill denied")
  })

  test("bounds expanded read batches within a narrow timeline", async ({ page }) => {
    await setupTimeline(page, {
      viewport: { width: 540, height: 900 },
      messages: [
        userMessage(),
        assistantMessage(
          Array.from({ length: 8 }, (_, index) =>
            toolPart(`prt_read_narrow_${index}`, "read", "completed", {
              path: `/src/long-directory/long-file-${index}.ts`,
            }),
          ),
        ),
      ],
    })
    const group = await openTools(page)
    const reads = group.locator('[data-component="read-tool-group"]')
    await reads.getByRole("button", { name: /Read/ }).click()
    await expect(reads.locator('[data-component="raw-tool-entry"]')).toHaveCount(8)
    await expect
      .poll(() =>
        reads.evaluate((element) => ({
          overflow: element.scrollWidth - element.clientWidth,
          outside: element.getBoundingClientRect().right > document.documentElement.clientWidth,
        })),
      )
      .toEqual({ overflow: 0, outside: false })
    const entry = reads.locator('[data-component="raw-tool-entry"]').filter({ hasText: "long-file-7.ts" })
    await entry.getByRole("button", { name: /Read/ }).click()
    await entry.getByRole("button", { name: "Request", exact: true }).click()
    await expect(entry.getByRole("region", { name: "Request", exact: true })).toContainText("long-file-7.ts")
  })

  test("shows each original clock for multiple writes with no diff", async ({ page }) => {
    const message = assistantMessage([
      toolPart("prt_empty_write_a", "write", "completed", { path: "/src/empty-a.ts", content: "" }),
      toolPart("prt_empty_write_b", "write", "completed", { path: "/src/empty-b.ts", content: "" }),
    ])
    for (const [index, part] of message.content.entries())
      if (part.type === "tool") part.time.ran = Date.UTC(2026, 0, 1, 12, 0, index + 1)
    await setupTimeline(page, { messages: [userMessage(), message] })
    const group = await openTools(page)
    for (const [name, clock] of [
      ["empty-a.ts", "12:00:01"],
      ["empty-b.ts", "12:00:02"],
    ]) {
      const entry = group.locator('[data-component="raw-tool-entry"]').filter({ hasText: name })
      await entry.hover()
      await expect(entry.locator('[data-slot="tool-timestamp"]')).toHaveText(clock!)
      await expect(entry.locator('[data-slot="tool-timestamp"]')).toHaveCSS("visibility", "visible")
    }
  })

  test("keeps hidden Todo and pending or dismissed Question policies while completed answers remain inspectable", async ({
    page,
  }) => {
    await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([
          toolPart("prt_raw_todo", "todowrite", "completed", { todos: [] }),
          toolPart("prt_raw_question_pending", "question", "running", questionInput()),
          toolPart("prt_raw_question_dismissed", "question", "error", questionInput(), {
            error: "The user dismissed this question",
          }),
          toolPart("prt_raw_question_done", "question", "completed", questionInput(), {
            metadata: { answers: [["Keep it"]] },
          }),
          toolPart(
            "prt_raw_web",
            "websearch",
            "completed",
            { query: "fixture" },
            { output: "https://example.test/fixture" },
          ),
        ]),
      ],
    })
    const group = await openTools(page, 2)
    await expect(group.locator('[data-timeline-part-id="prt_raw_todo"]')).toHaveCount(0)
    await expect(group.locator('[data-timeline-part-id="prt_raw_question_pending"]')).toHaveCount(0)
    const dismissed = group.locator('[data-timeline-part-id="prt_raw_question_dismissed"]')
    await expect(dismissed).toContainText(/dismissed/i)
    await expect(dismissed.getByRole("button", { name: "Request", exact: true })).toHaveCount(0)
    const answered = page.locator('[data-timeline-part-id="prt_raw_question_done"]')
    await answered.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
    await expect(answered).toContainText("Keep it")
    await answered.getByRole("button", { name: "Response", exact: true }).click()
    await expect(answered.getByRole("region", { name: "Response", exact: true })).toBeVisible()
    const web = group.locator('[data-timeline-part-id="prt_raw_web"]')
    await web.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
    await expect(web.getByRole("link", { name: /example.test/ })).toHaveAttribute(
      "href",
      "https://example.test/fixture",
    )
    await web.getByRole("button", { name: "Request", exact: true }).click()
    await expect(web.getByRole("region", { name: "Request", exact: true })).toContainText('"query": "fixture"')
  })

  for (const [groupName, cases] of [
    [
      "element-only XML",
      [
        ["<!DOCTYPE result [<!ELEMENT result ANY>]><result><!--keep--><?fixture keep?><one/><two/></result>", true],
        ['<result><one xml:space="preserve"><a/><b/></one><two/></result>', true],
      ],
    ],
    [
      "unsafe XML text layouts",
      [
        ["<p>before<b>bold</b>after</p>", false],
        ["<root> <a/> <b/> </root>", false],
        ['<div xmlns="http://www.w3.org/1999/xhtml"><span/><span/></div>', false],
        ['<svg xmlns="http://www.w3.org/2000/svg"><text><tspan/><tspan/></text></svg>', false],
      ],
    ],
    [
      "authored parsererror collisions",
      [
        ["<parsererror><one/><two/></parsererror>", true],
        [
          '<root><parsererror xmlns="http://www.w3.org/1999/xhtml">This page contains the following errors:</parsererror><ok/></root>',
          true,
        ],
        ['<parsererror xmlns="http://www.mozilla.org/newlayout/xml/parsererror.xml"><one/><two/></parsererror>', true],
        ["<root><parsererror/><broken></root>", false],
        ["<!--This page contains the following errors:--><root><a></root>", false],
      ],
    ],
  ] as const) {
    test(`keeps optional formatting conservative for ${groupName}`, async ({ page }) => {
      await setupTimeline(page, {
        messages: [
          userMessage(),
          assistantMessage(
            cases.map(([output], index) => toolPart(`prt_xml_${index}`, "plugin_fixture", "completed", {}, { output })),
          ),
        ],
      })
      const group = await openTools(page)
      for (const [index, [source, accepted]] of cases.entries()) {
        const card = group.locator(`[data-timeline-part-id="prt_xml_${index}"]`)
        await card.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
        await card.getByRole("button", { name: "Response", exact: true }).click()
        const body = card.getByRole("region", { name: "Response", exact: true })
        expect(await body.textContent()).toBe(source)
        const format = card.getByRole("button", { name: "Format XML", exact: true })
        if (!accepted) {
          await expect(format).toHaveCount(0)
          continue
        }
        await format.click()
        await expect(body).toContainText("\n")
        expect(await body.textContent()).not.toBe(source)
        expect(
          await body.evaluate((element) => {
            const document = new DOMParser().parseFromString(element.textContent!, "application/xml")
            return !!document.documentElement && !document.querySelector("opencode-parsererror")
          }),
        ).toBe(true)
        await card.getByRole("button", { name: "Show raw", exact: true }).click()
        expect(await body.textContent()).toBe(source)
      }
    })
  }

  test("renders retained markup as inert full-length scrollable text and distinguishes empty terminal output", async ({
    page,
  }) => {
    const source = `  <script>throw new Error('must remain text')</script>\n${"line with spaces  \n".repeat(500)}`
    await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([
          toolPart("prt_raw_long", "plugin_fixture", "completed", {}, { output: source }),
          toolPart("prt_raw_empty", "plugin_fixture", "completed", {}, { output: "" }),
        ]),
      ],
    })
    const group = await openTools(page)
    for (const [id, output] of [
      ["prt_raw_long", source],
      ["prt_raw_empty", ""],
    ]) {
      const card = group.locator(`[data-timeline-part-id="${id}"]`)
      await card.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]').click()
      await card.getByRole("button", { name: "Response", exact: true }).click()
      const body = card.getByRole("region", { name: "Response", exact: true })
      expect(await body.textContent()).toBe(output)
      await expect(body.locator("script")).toHaveCount(0)
      await expect(card.getByText("No response yet", { exact: true })).toHaveCount(0)
      if (id !== "prt_raw_long") continue
      expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    }
  })
})
