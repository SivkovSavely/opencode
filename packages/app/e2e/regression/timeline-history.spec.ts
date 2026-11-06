import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client/promise"
import { expect, test, type Page } from "@playwright/test"
import { REMOTE_SERVER, session, sessionHref } from "../utils/app"
import { trackPageErrors } from "../utils/errors"
import { fixture, installTimelineSettings, mockStressTimeline } from "../utils/session-fixture"
import {
  assistantMessage,
  historyMessages,
  inboxDelivered,
  inboxEnqueued,
  interruptNextMessagePage,
  messageUpdated,
  partUpdated,
  sessionID,
  setupTimeline,
  status,
  textPart,
  userMessage,
  validateTimelineMessages,
} from "../utils/timeline"
import { expectSessionTitle } from "../utils/waits"
import { mockRemoteServer, mockWorkspace, openSession } from "../utils/workspace"

test.use({ serviceWorkers: "block" })

test.describe("jump to message", () => {
  test("closes on server switch with colliding session IDs and absorbs the old page's late rejection", async ({
    page,
  }) => {
    const held = Promise.withResolvers<void>()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const id = "ses_jump_collision"
    await mockRemoteServer(page, {
      sessions: [session({ id, directory: "C:/OpenCode/Remote", title: "Remote collision" })],
      pageMessages: () => ({ items: [userMessage([textPart("prt_remote_collision", "Remote-only prompt")])] }),
    })
    await openSession(page, {
      name: "JumpCollision",
      sessions: [{ id }],
      seed: { servers: [REMOTE_SERVER], tabs: [id, { session: id, server: REMOTE_SERVER }] },
      pageMessages: () => ({
        items: Array.from({ length: 30 }, (_, index) =>
          userMessage([textPart(`prt_collision_${index}`, `Local collision ${index} ${"words ".repeat(30)}`)], {
            id: `msg_collision_${index}`,
            created: index + 1,
          }),
        ),
        cursor: "held",
      }),
    })
    const transport = await interruptNextMessagePage(page, "failure", held.promise)

    try {
      await openJump(page)
      await transport.arrived
      await page.getByRole("combobox").fill("Local")
      await page
        .locator(`[data-slot="titlebar-tabs"] a[href="${sessionHref(id, REMOTE_SERVER)}"]`)
        .evaluate((element: HTMLAnchorElement) => element.click())
      await expect(page).toHaveURL(sessionHref(id, REMOTE_SERVER))
      await expect(page.getByRole("dialog", { name: "Jump to message" })).toHaveCount(0)
      await expect(page.getByText("Remote-only prompt", { exact: true })).toBeVisible()
      const rejected = page.waitForResponse((response) => response.status() === 503)
      held.resolve()
      await rejected
      await openJump(page)
      await expect(page.getByRole("combobox")).toHaveValue("")
      await expect(page.getByRole("option")).toHaveCount(1)
      await expect(page.getByRole("option")).toContainText("Remote-only prompt")
      expect(errors).toEqual([])
    } finally {
      held.resolve()
    }
  })

  test("reveals an unloaded existing hash and returns to latest through native navigation", async ({ page }) => {
    const id = "ses_jump_hash"

    const messages = Array.from({ length: 50 }, (_, index) =>
      userMessage([textPart(`prt_hash_${index}`, `Hash prompt ${index} ${"words ".repeat(30)}`)], {
        id: `msg_hash_${String(index).padStart(4, "0")}`,
        created: index + 1,
      }),
    )

    await mockWorkspace(page, {
      name: "JumpHash",
      sessions: [{ id }],
      pageMessages: (_id, _limit, before) =>
        before ? { items: messages.slice(0, 20) } : { items: messages.slice(20), cursor: "older" },
    })
    await page.goto(sessionHref(id) + "#message-msg_hash_0001")
    await expect(page.locator("#message-msg_hash_0001")).toBeInViewport()
    await page.getByRole("button", { name: "Jump to latest", exact: true }).click()
    await expect(page).toHaveURL(sessionHref(id))
    await expect(page.locator("#message-msg_hash_0049")).toBeInViewport()
  })

  test("does not reveal a reverted tail even while its boundary is unloaded", async ({ page }) => {
    const held = Promise.withResolvers<void>()
    const arrived = Promise.withResolvers<void>()
    const id = "ses_jump_revert"
    await openSession(page, {
      name: "JumpRevert",
      sessions: [{ id, revert: { messageID: "msg_revert_0020" } }],
      beforeMessagesResponse: ({ before }) => {
        if (before) {
          arrived.resolve()

          return held.promise
        }

        return Promise.resolve()
      },
      pageMessages: (_id, _limit, before) =>
        before
          ? {
              items: [
                userMessage([textPart("prt_revert_before", "Before revert")], { id: "msg_revert_0001", created: 1 }),
                userMessage([textPart("prt_revert_boundary", "Boundary excluded")], {
                  id: "msg_revert_0020",
                  created: 20,
                }),
              ],
            }
          : {
              items: [
                userMessage([textPart("prt_revert_hidden", "Hidden tail")], { id: "msg_revert_0030", created: 30 }),
              ],
              cursor: "boundary",
            },
    })

    try {
      await openJump(page)
      await arrived.promise
      await expect(page.getByRole("option")).toHaveCount(0)
      held.resolve()
      await expect(page.getByRole("option")).toHaveCount(1)
      await expect(page.getByRole("option")).toContainText("Before revert")
      await page.getByRole("combobox").press("Enter")
      await expect(page.locator("#message-msg_revert_0001")).toBeInViewport()
      await openJump(page)
      await expect(page.getByRole("option")).toHaveCount(1)
    } finally {
      held.resolve()
    }
  })

  for (const mode of ["failure", "stalled"] as const) {
    test(`retains partial query and explicitly retries ${mode} discovery`, async ({ page }) => {
      const messages = Array.from({ length: 40 }, (_, index) =>
        userMessage([textPart(`prt_retry_${index}`, `Retry needle ${index} ${"words ".repeat(20)}`)], {
          id: `msg_retry_${String(index).padStart(4, "0")}`,
          created: index + 1,
        }),
      )

      await openSession(page, {
        name: "JumpRetry",
        sessions: [{ id: "ses_jump_retry" }],
        pageMessages: (_id, _limit, before) =>
          before ? { items: messages.slice(0, 10) } : { items: messages.slice(10), cursor: "older" },
      })
      await interruptNextMessagePage(page, mode)
      await openJump(page)
      const dialog = page.getByRole("dialog")
      const input = dialog.getByRole("combobox")
      await input.fill("needle")
      await expect(dialog.getByRole("alert")).toContainText(
        mode === "failure" ? "Could not load older messages" : "History stopped making progress",
      )
      await expect(dialog.getByRole("status")).toContainText("30 matches in 30 loaded messages (partial)")
      await dialog.getByRole("button", { name: "Try again", exact: true }).click()
      await expect(dialog.getByRole("status")).toHaveText("40 matches (40 total)")
      await expect(dialog.getByRole("alert")).toHaveCount(0)
      await expect(input).toHaveValue("needle")
      await input.fill("/^Retry needle 1 /")
      await expect(dialog.getByRole("option")).toHaveCount(1)
      await input.press("Enter")
      await expect(page.locator("#message-msg_retry_0001")).toBeInViewport()
    })
  }

  for (const width of [1280, 390, 900]) {
    test(`browses eligible prompts, searches safely, resets and handles IME at ${width}px`, async ({ page }) => {
      const height = width === 900 ? 390 : 900
      await page.setViewportSize({ width, height })

      if (width === 390) await page.emulateMedia({ reducedMotion: "reduce" })
      const writes: string[] = []
      page.on("request", (request) => {
        // Native location refresh and goal/get RPC use POST for reads; mutations remain forbidden.
        if (
          request.url().includes("/api/") &&
          !/\/api\/(worktree\/refresh|rpc\/opencode.goal\/get)(\?|$)/.test(request.url()) &&
          ["POST", "PATCH", "PUT", "DELETE"].includes(request.method())
        )
          writes.push(request.url())
      })
      await openSession(page, {
        name: "JumpBrowse",
        sessions: [{ id: "ses_jump_browse" }],
        pageMessages: () => ({
          items: [
            userMessage([textPart("prt_jump_a", "  <b>Needle</b>\n\tissue-123  ")], {
              id: "msg_jump_a",
              created: 1_700_000_000_000,
            }),
            assistantMessage([textPart("prt_jump_secret", "assistant secret")], {
              id: "msg_jump_b",
              created: 1_700_000_000_001,
            }),
            userMessage(
              [
                {
                  id: "prt_jump_file",
                  type: "file",
                  mime: "text/plain",
                  url: "file:///notes.txt",
                  filename: "notes.txt",
                },
              ],
              { id: "msg_jump_c", created: 1_700_000_000_002 },
            ),
            userMessage([], { id: "msg_jump_d", created: 1_700_000_000_003 }),
          ],
        }),
      })
      const composer = page.locator('[data-component="composer-editor"]')
      await composer.fill("Unsubmitted draft stays here")
      const before = [...writes]
      await openJump(page)
      const dialog = page.getByRole("dialog", { name: "Jump to message" })
      const input = dialog.getByRole("combobox")
      await expect(input).toBeFocused()
      await expect(input).toHaveAttribute("placeholder", "Search user messages...")
      const container = dialog.locator("..")
      await expect
        .poll(() =>
          container.evaluate((element) => {
            const box = element.getBoundingClientRect()

            return {
              top: box.top >= 0,
              left: box.left >= 0,
              right: box.right <= innerWidth,
              bottom: box.bottom <= innerHeight,
            }
          }),
        )
        .toEqual({ top: true, left: true, right: true, bottom: true })
      await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport()
      await expect(dialog.getByRole("heading", { name: "Jump to message", exact: true })).toBeInViewport()
      await expect(input).toBeInViewport()
      await expect(dialog.getByRole("option")).toHaveCount(3)
      await expect(input).not.toHaveAttribute("aria-activedescendant")
      await expect(dialog.getByText("↑ ↓ Navigate · Enter Jump", { exact: true })).toBeInViewport()
      await expect(dialog.getByText("Esc Clear / Close", { exact: true })).toBeInViewport()
      await input.press("ArrowDown")
      await expect(dialog.getByRole("option", { selected: true })).toContainText("Needle")
      await input.fill(" ")
      await expect(input).not.toHaveAttribute("aria-activedescendant")
      await input.press("ArrowUp")
      await expect(dialog.getByRole("option", { selected: true })).toContainText("Empty prompt")
      await expect(dialog.getByRole("option").first()).toContainText("<b>Needle</b> issue-123")
      await expect(dialog.locator("time").first()).toHaveAttribute("datetime", "2023-11-14T22:13:20.000Z")
      await expect(dialog.locator("time").first()).toHaveText(/\d{2}:\d{2}:\d{2}/)
      await expect(dialog.locator("time").first()).toHaveAttribute("title", /2023/)
      expect(await dialog.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(width)

      for (const query of ["assistant secret", "notes.txt", "Attachment"]) {
        await input.fill(query)
        await expect(dialog.getByRole("option")).toHaveCount(0)
        await input.press("Enter")
        await expect(dialog).toBeVisible()
      }

      await input.fill("/[")
      await expect(dialog.getByRole("alert")).toBeVisible()
      await input.fill("/ISSUE-\\d+/i")
      await expect(dialog.getByRole("option")).toHaveCount(1)
      await expect(dialog.getByRole("status")).toHaveText("1 match (3 total)")
      await expect(input).not.toHaveAttribute("aria-activedescendant")
      await expect(dialog.getByText("Regex", { exact: true })).toBeVisible()
      await expect(dialog.getByRole("alert")).toHaveCount(0)

      for (const key of ["ArrowDown", "Enter", "Escape"]) {
        expect(
          await input.evaluate((element, key) => {
            const event = new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true })
            element.dispatchEvent(event)

            return event.defaultPrevented
          }, key),
        ).toBe(false)
        await expect(input).toHaveValue("/ISSUE-\\d+/i")
        await expect(input).not.toHaveAttribute("aria-activedescendant")
        await expect(dialog).toBeVisible()
      }

      await dialog.getByRole("button", { name: "Close" }).focus()
      expect(
        await dialog.getByRole("button", { name: "Close" }).evaluate((element) => {
          const event = new KeyboardEvent("keydown", {
            key: "Escape",
            isComposing: true,
            bubbles: true,
            cancelable: true,
          })

          element.dispatchEvent(event)

          return event.defaultPrevented
        }),
      ).toBe(false)
      await expect(input).toHaveValue("/ISSUE-\\d+/i")
      await page.keyboard.press("Escape")
      await expect(input).toHaveValue("")
      await expect(input).not.toHaveAttribute("aria-activedescendant")
      await expect(input).toBeFocused()
      await dialog.getByRole("button", { name: "Close" }).focus()
      expect(
        await dialog.getByRole("button", { name: "Close" }).evaluate((element) => {
          const event = new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true, cancelable: true })
          element.dispatchEvent(event)

          return event.defaultPrevented
        }),
      ).toBe(false)
      await expect(dialog).toBeVisible()
      await input.press("Escape")
      await expect(dialog).toHaveCount(0)
      await openJump(page)
      await expect(page.getByRole("combobox")).toHaveValue("")
      await expect(page.getByRole("option")).toHaveCount(3)
      await expect(page.getByRole("combobox")).not.toHaveAttribute("aria-activedescendant")
      await page.getByRole("combobox").press("Enter")
      await expect(page.locator("#message-msg_jump_a")).toBeInViewport()
      await openJump(page)
      await page.getByRole("option", { name: /Attachment/ }).click()
      await expect(page.locator("#message-msg_jump_c")).toBeInViewport()
      await expect(page).toHaveURL(/#message-msg_jump_c$/)
      await openJump(page)
      await page.getByRole("combobox").fill("Needle")
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(composer).toHaveText("Unsubmitted draft stays here")
      expect(writes).toEqual(before)
    })
  }

  test("queued raw prompts become searchable only after native delivery", async ({ page }) => {
    const id = "ses_jump_queue"

    const workspace = await openSession(page, {
      name: "JumpQueue",
      sessions: [{ id }],
      pageMessages: () => ({
        items: [
          userMessage([textPart("prt_queue_visible", "Visible baseline")], { id: "msg_queue_0001", created: 1 }),
          userMessage([textPart("prt_queue_hidden", "Queued secret")], { id: "msg_queue_0002", created: 2 }),
        ],
      }),
      inbox: [
        {
          id: "msg_queue_0002",
          sessionID: id,
          type: "user",
          delivery: "queue",
          payload: { text: "Queued secret" },
          time: { created: 2 },
        },
      ],
    })

    await openJump(page)
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByRole("option")).toHaveCount(1)
    await expect(dialog.getByRole("status")).toHaveText("1 match (1 total)")
    await dialog.getByRole("combobox").fill("Queued secret")
    await expect(dialog.getByRole("option")).toHaveCount(0)
    await dialog.getByRole("combobox").press("Enter")
    await expect(dialog).toBeVisible()
    await workspace.push([inboxDelivered({ sessionID: id, inboxID: "msg_queue_0002" })])
    await expect(dialog.getByRole("status")).toHaveText("1 match (2 total)")
    await dialog.getByRole("combobox").press("Enter")
    await expect(page.locator("#message-msg_queue_0002")).toBeInViewport()
  })

  test("a reopened picker invalidates the previous dismissal's queued restoration frame", async ({ page }) => {
    await page.clock.install()
    const held = Promise.withResolvers<void>()
    const arrived = Promise.withResolvers<void>()

    const messages = Array.from({ length: 60 }, (_, index) =>
      userMessage([textPart(`prt_reopen_phase_${index}`, `Reopen prompt ${index} ${"context ".repeat(40)}`)], {
        id: `msg_reopen_phase_${String(index).padStart(4, "0")}`,
        created: index + 1,
      }),
    )

    const output = assistantMessage([textPart("prt_reopen_initial", "Initial live response.")], {
      id: "msg_reopen_output",
      parentID: "msg_reopen_phase_0059",
      created: 61,
      completed: false,
    })

    const workspace = await openSession(page, {
      name: "JumpReopenFrame",
      sessions: [{ id: sessionID }],
      pageMessages: (_id, _limit, before) =>
        before ? { items: messages.slice(0, 10) } : { items: [...messages.slice(10), output], cursor: "older" },
      beforeMessagesResponse: ({ before }) => {
        if (!before) return Promise.resolve()
        arrived.resolve()

        return held.promise
      },
    })

    const fromEnd = () =>
      timelineScroller(page).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)

    try {
      await expect.poll(fromEnd).toBeLessThanOrEqual(1)
      await openJump(page)
      await arrived.promise
      await workspace.push(
        partUpdated({
          ...textPart(
            "prt_reopen_growth",
            Array.from({ length: 40 }, (_, index) => `Live reopen paragraph ${index}.`).join("\n\n"),
          ),
          messageID: output.id,
        }),
      )
      await expect(page.getByText("Live reopen paragraph 39.", { exact: true })).toBeAttached()
      await expect.poll(fromEnd).toBeGreaterThan(600)
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.getByRole("button", { name: "More options", exact: true }).click()
      const reopen = page.getByRole("menuitem", { name: "Jump to message...", exact: true })
      await expect(reopen).toBeVisible()
      const content = page.locator("[data-timeline-virtual-content]")
      const height = await content.evaluate((element: HTMLElement) => element.style.height)
      await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000))

      const published = page.waitForResponse(
        (response) =>
          response.url().includes("/message?") &&
          new URL(response.url()).searchParams.has("cursor") &&
          response.status() === 200,
      )

      held.resolve()
      await published
      await expect.poll(() => content.evaluate((element: HTMLElement) => element.style.height)).not.toBe(height)
      // The menu is ready; real mouse input reopens it without advancing the deliberately paused animation frame.
      const box = (await reopen.boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      const dialog = page.getByRole("dialog", { name: "Jump to message" })
      await expect(dialog).toBeVisible()
      const top = await timelineScroller(page).evaluate((element) => element.scrollTop)
      await expect.poll(fromEnd).toBeGreaterThan(600)
      await page.clock.runFor(16)
      await expect.poll(() => timelineScroller(page).evaluate((element) => element.scrollTop)).toBe(top)
      await expect(dialog).toBeVisible()

      await page.clock.resume()
      await dialog.getByRole("button", { name: "Close" }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(fromEnd).toBeLessThanOrEqual(1)
      await workspace.push(
        partUpdated({
          ...textPart("prt_reopen_final", "Following restored after the final dismissal.\n\n".repeat(20)),
          messageID: output.id,
        }),
      )
      await expect(page.getByText("Following restored after the final dismissal.", { exact: true })).toHaveCount(20)
      await expect.poll(fromEnd).toBeLessThanOrEqual(1)
    } finally {
      held.resolve()
    }
  })

  test("an upward gesture after dismissal settlement wins over the queued restoration frame", async ({ page }) => {
    await page.clock.install()
    const held = Promise.withResolvers<void>()
    const arrived = Promise.withResolvers<void>()

    const messages = Array.from({ length: 60 }, (_, index) =>
      userMessage([textPart(`prt_phase_${index}`, `Phase prompt ${index} ${"context ".repeat(40)}`)], {
        id: `msg_phase_${String(index).padStart(4, "0")}`,
        created: index + 1,
      }),
    )

    await openSession(page, {
      name: "JumpFrame",
      sessions: [{ id: "ses_jump_frame" }],
      pageMessages: (_id, _limit, before) =>
        before ? { items: messages.slice(0, 10) } : { items: messages.slice(10), cursor: "older" },
      beforeMessagesResponse: ({ before }) => {
        if (!before) return Promise.resolve()
        arrived.resolve()

        return held.promise
      },
    })

    try {
      await expect(page.locator("#message-msg_phase_0059")).toBeInViewport()
      await openJump(page)
      await arrived.promise
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      const content = page.locator("[data-timeline-virtual-content]")
      const height = await content.evaluate((element: HTMLElement) => element.style.height)
      // Freeze native animation frames before publication; network and Solid publication still run.
      await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000))

      const published = page.waitForResponse(
        (response) =>
          response.url().includes("/message?") &&
          new URL(response.url()).searchParams.has("cursor") &&
          response.status() === 200,
      )

      held.resolve()
      await published
      await expect.poll(() => content.evaluate((element: HTMLElement) => element.style.height)).not.toBe(height)
      await timelineScroller(page).evaluate((element) => {
        element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
        element.scrollTop = Math.max(
          0,
          Math.min(element.scrollTop - 500, element.scrollHeight - element.clientHeight - 1200),
        )
      })
      // Run the next scheduled native frame only after the newer upward intent.
      await page.clock.runFor(16)
      await expect
        .poll(() =>
          timelineScroller(page).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
        )
        .toBeGreaterThan(600)
      await expect(page.locator("#message-msg_phase_0059")).not.toBeInViewport()
    } finally {
      held.resolve()
    }
  })

  for (const intent of ["return", "next", "find", "thumb", "scroll", "reopen", "reopen-scroll"] as const) {
    test(`pending picker settlement preserves ${intent} intent`, async ({ page }) => {
      const held = Promise.withResolvers<void>()
      const id = `ses_jump_intent_${intent}`
      const other = `ses_jump_intent_other_${intent}`
      const requests: (string | undefined)[] = []

      const workspace = await openSession(page, {
        name: "JumpIntent",
        sessions: [{ id }, { id: other }],
        pageMessages: (sessionID, _limit, before) => {
          if (sessionID === other)
            return { items: [userMessage([textPart("prt_intent_other", "Other loaded session")])] }

          return {
            items: Array.from({ length: 50 }, (_, index) =>
              userMessage([textPart(`prt_intent_${index}`, `Intent prompt ${index} ${"context ".repeat(40)}`)], {
                id: `msg_intent_${String(index).padStart(4, "0")}`,
                created: index + 1,
              }),
            ),
            cursor: before ? undefined : "older",
          }
        },
        onMessages: ({ sessionID, before, phase }) => {
          if (sessionID === id && phase === "start") requests.push(before)
        },
      })

      // Preload B through its real tab before opening the picker in A.
      await page.locator(`[data-slot="titlebar-tabs"] a[href="${sessionHref(other)}"]`).click()
      await expect(page.getByText("Other loaded session", { exact: true })).toBeVisible()
      await page.locator(`[data-slot="titlebar-tabs"] a[href="${sessionHref(id)}"]`).click()
      await expect(page.locator("#message-msg_intent_0049")).toBeInViewport()
      const failure = await interruptNextMessagePage(page, "failure", held.promise)

      const added = Array.from({ length: 10 }, (_, index) => [
        inboxEnqueued({
          sessionID: id,
          inboxID: `msg_intent_999${index}`,
          item: {
            type: "user",
            payload: { text: `Newest intent sentinel ${index} ${"context ".repeat(40)}` },
            delivery: "steer",
          },
        }),
        inboxDelivered({ sessionID: id, inboxID: `msg_intent_999${index}` }),
      ]).flat()

      try {
        await openJump(page)
        await failure.arrived

        if (intent === "next" || intent === "find" || intent === "thumb" || intent === "scroll") {
          await page.getByRole("combobox").fill("/^Intent prompt 20 /")
          await expect(page.getByRole("option")).toHaveCount(1)
          await page.getByRole("combobox").press("Enter")
          await expect(page.locator("#message-msg_intent_0020")).toBeInViewport()

          if (intent === "next") {
            await page.keyboard.press("Control+Alt+]")
            await expect(page).toHaveURL(/#message-msg_intent_0021$/)
          }

          if (intent === "find") {
            await page.keyboard.press("Control+f")
            const search = page.locator('[data-component="timeline-search-bar"] input')
            await expect(search).toBeFocused()
            await search.fill("Intent prompt 18 ")
            await expect(page.locator("#message-msg_intent_0018")).toBeInViewport()
            await expect
              .poll(() => page.evaluate(() => CSS.highlights.get("timeline-search-hit-active")?.size ?? 0))
              .toBe(1)
          }

          if (intent === "thumb") {
            await timelineScroller(page).hover()

            const thumb = page.locator(
              '[data-slot="session-timeline-visible"] .scroll-view__thumb[data-orientation="vertical"]',
            )

            await expect(thumb).toHaveAttribute("data-visible", "true")
            expect(
              await thumb.evaluate((element) => ({
                outsideScrollView: !element.closest(".scroll-view"),
                commonView: element
                  .closest('[data-slot="session-timeline-visible"]')
                  ?.parentElement?.contains(document.querySelector('[data-slot="session-timeline-scroll"]')),
              })),
            ).toEqual({ outsideScrollView: true, commonView: true })
            const box = (await thumb.boundingBox())!
            const track = (await page.locator('[data-slot="session-timeline-visible"]').boundingBox())!
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.down()
            await page.mouse.move(box.x + box.width / 2, track.y + box.height / 2 + 60)
            await page.mouse.up()
            await expect.poll(() => timelineScroller(page).evaluate((element) => element.scrollTop)).toBeLessThan(1500)
            await expect(page.locator("#message-msg_intent_0020")).not.toBeInViewport()
          }
        } else {
          if (intent !== "return") await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()

          if (intent.startsWith("reopen")) {
            await openJump(page)
            await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
          }

          if (intent === "return") {
            await page
              .locator(`[data-slot="titlebar-tabs"] a[href="${sessionHref(other)}"]`)
              .evaluate((element: HTMLAnchorElement) => element.click())
            await expect(page.getByRole("dialog", { name: "Jump to message" })).toHaveCount(0)
            await expect(page.getByText("Other loaded session", { exact: true })).toBeVisible()
            await page.locator(`[data-slot="titlebar-tabs"] a[href="${sessionHref(id)}"]`).click()
            await expect(page.locator("#message-msg_intent_0049")).toBeInViewport()
            await workspace.push(added)
            await expect(page.locator("#message-msg_intent_9999")).toBeInViewport()
          }
        }

        if (intent === "scroll" || intent === "reopen-scroll") {
          const target =
            intent === "reopen-scroll"
              ? page.getByRole("button", { name: "More options", exact: true })
              : timelineScroller(page)

          await target.dispatchEvent("wheel", { bubbles: true, deltaY: -1 })
          await timelineScroller(page).evaluate((element) => {
            element.scrollTop = 600
          })
          await expect.poll(() => timelineScroller(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(400)
          await expect.poll(() => timelineScroller(page).evaluate((element) => element.scrollTop)).toBeLessThan(1000)
        }

        const response = page.waitForResponse(
          (response) => response.url().includes("/message?") && response.status() === 503,
        )

        held.resolve()
        await response

        if (intent === "return") {
          await expect(page.locator("#message-msg_intent_9999")).toBeInViewport()
          await timelineScroller(page).evaluate((element) => {
            element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
            element.scrollTop = 0
          })
          await expect.poll(() => requests.includes("older")).toBe(true)
        } else if (intent === "scroll" || intent === "find" || intent === "thumb") {
          // Isolate pending-page replay from native hash reconciliation on newly delivered prompts.
          await expect(page).toHaveURL(/#message-msg_intent_0020$/)

          if (intent === "find") await expect(page.locator("#message-msg_intent_0018")).toBeInViewport()

          if (intent === "scroll") {
            await expect
              .poll(() => timelineScroller(page).evaluate((element) => element.scrollTop))
              .toBeGreaterThan(400)
            await expect.poll(() => timelineScroller(page).evaluate((element) => element.scrollTop)).toBeLessThan(1000)
          }

          if (intent === "thumb") {
            await expect.poll(() => timelineScroller(page).evaluate((element) => element.scrollTop)).toBeLessThan(1500)
            await expect(page.locator("#message-msg_intent_0020")).not.toBeInViewport()
          }
        } else {
          await workspace.push(added)

          if (intent === "reopen") await expect(page.locator("#message-msg_intent_9999")).toBeInViewport()

          if (intent === "next") {
            await expect(page).toHaveURL(/#message-msg_intent_0021$/)
            await expect(page.locator("#message-msg_intent_0021")).toBeInViewport()
          }

          if (intent === "reopen-scroll") {
            await expect(page.locator("#message-msg_intent_9999")).not.toBeInViewport()
            await expect
              .poll(() => timelineScroller(page).evaluate((element) => element.scrollTop))
              .toBeGreaterThan(400)
            await expect.poll(() => timelineScroller(page).evaluate((element) => element.scrollTop)).toBeLessThan(1000)
          }
        }
      } finally {
        held.resolve()
      }
    })
  }

  test("virtualizes 1003 prompts, retains active identity, wraps keys and reveals the same target again", async ({
    page,
  }) => {
    await openSession(page, {
      name: "JumpVirtual",
      sessions: [{ id: "ses_jump_virtual" }],
      pageMessages: () => ({
        items: Array.from({ length: 1003 }, (_, index) =>
          userMessage([textPart(`prt_jump_${index}`, `Prompt ${index} ${"context ".repeat(20)} END-${index}😀`)], {
            id: `msg_jump_${String(index).padStart(4, "0")}`,
            created: index + 1,
          }),
        ),
      }),
    })
    await openJump(page)
    const dialog = page.getByRole("dialog", { name: "Jump to message" })
    const input = dialog.getByRole("combobox")
    await expect(dialog.getByText("1003 matches (1003 total)", { exact: true })).toBeVisible()
    expect(await dialog.getByRole("option").count()).toBeLessThan(30)
    await expect(input).not.toHaveAttribute("aria-activedescendant")
    await input.press("ArrowDown")
    const active = await input.getAttribute("aria-activedescendant")
    await dialog.getByRole("listbox").evaluate((element) => {
      element.scrollTop = 20_000
    })
    await expect(page.locator(`[id="${active}"]`)).toHaveCount(1)
    await input.press("ArrowUp")
    await expect(dialog.getByRole("option", { selected: true })).toContainText("Prompt 1002")
    await input.press("ArrowDown")
    await expect(dialog.getByRole("option", { selected: true })).toContainText("Prompt 0")
    await input.fill("Prompt")
    await input.press("ArrowUp")
    await expect(dialog.getByRole("option", { selected: true })).toContainText("Prompt 1002")
    await input.fill("prompt")
    await expect(input).not.toHaveAttribute("aria-activedescendant")
    await expect.poll(() => dialog.getByRole("listbox").evaluate((element) => element.scrollTop)).toBe(0)
    await input.fill("END-500")
    await expect(dialog.getByRole("option")).toHaveCount(1)
    await expect(dialog.getByRole("status")).toHaveText("1 match (1003 total)")
    await expect(dialog.getByRole("option").locator("mark")).toHaveText("END-500")
    await page.setViewportSize({ width: 390, height: 900 })
    await expect(dialog.getByRole("option").locator("mark")).toHaveText("END-500")
    expect(
      await dialog.getByRole("option").evaluate((element) => element.getBoundingClientRect().right),
    ).toBeLessThanOrEqual(390)
    await page.setViewportSize({ width: 1280, height: 900 })
    await input.press("Enter")
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/#message-msg_jump_0500$/)
    const target = page.locator("#message-msg_jump_0500")
    await expect(target).toBeInViewport()
    await timelineScroller(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await openJump(page)
    await page.getByRole("combobox").fill("END-500")
    await page.getByRole("combobox").press("Enter")
    await expect(target).toBeInViewport()
  })

  test("discovers advancing empty and overlapping history while invalid, and keeps a selected target after a held page", async ({
    page,
  }) => {
    const held = Promise.withResolvers<void>()
    const arrived = Promise.withResolvers<void>()
    const requests: string[] = []
    const recent = userMessage([textPart("prt_jump_recent", "Recent target")], { id: "msg_jump_0900", created: 900 })
    const ancient = userMessage([textPart("prt_jump_ancient", "Ancient target")], { id: "msg_jump_0001", created: 1 })
    await openSession(page, {
      name: "JumpPages",
      sessions: [{ id: "ses_jump_pages" }],
      beforeMessagesResponse: ({ before }) => {
        if (before === "held") {
          arrived.resolve()

          return held.promise
        }

        return Promise.resolve()
      },
      pageMessages: (_session, _limit, before) => {
        requests.push(before ?? "initial")

        if (!before) return { items: [recent], cursor: "held" }

        if (before === "held") return { items: [], cursor: "overlap" }

        if (before === "overlap") return { items: [recent], cursor: "metadata" }

        if (before === "metadata")
          return {
            items: [{ id: "msg_jump_meta", type: "synthetic", text: "Excluded metadata", time: { created: 50 } }],
            cursor: "ancient",
          }

        return { items: [ancient] }
      },
    })

    try {
      await openJump(page)
      await arrived.promise
      await page.getByRole("combobox").fill("/[")
      await expect(page.getByRole("alert")).toBeVisible()
      held.resolve()
      await expect(page.getByText("0 matches (2 total)", { exact: true })).toBeVisible()
      expect(requests).toEqual(["initial", "held", "overlap", "metadata", "ancient"])
      await page.getByRole("combobox").fill("Ancient")
      await expect(page.getByRole("option")).toHaveCount(1)
      await page.getByRole("combobox").press("Enter")
      await expect(page.locator("#message-msg_jump_0001")).toBeInViewport()
    } finally {
      held.resolve()
    }
  })

  test("loaded matches remain selectable during discovery and late pages cannot steal the selected anchor", async ({
    page,
  }) => {
    const held = Promise.withResolvers<void>()
    const arrived = Promise.withResolvers<void>()
    const ended = Promise.withResolvers<void>()

    const messages = Array.from({ length: 50 }, (_, index) =>
      userMessage([textPart(`prt_held_${index}`, `Held target ${index} ${"words ".repeat(30)}`)], {
        id: `msg_held_${String(index).padStart(4, "0")}`,
        created: index + 1,
      }),
    )

    await openSession(page, {
      name: "JumpHeld",
      sessions: [{ id: "ses_jump_held" }],
      beforeMessagesResponse: ({ before }) => {
        if (before) {
          arrived.resolve()

          return held.promise
        }

        return Promise.resolve()
      },
      onMessages: ({ before, phase }) => {
        if (before && phase === "end") ended.resolve()
      },
      pageMessages: (_id, _limit, before) =>
        before ? { items: messages.slice(0, 20) } : { items: messages.slice(20), cursor: "older" },
    })

    try {
      await openJump(page)
      await arrived.promise
      await expect(page.getByRole("dialog").getByRole("status")).toContainText(
        "30 matches in 30 loaded messages (partial)",
      )
      await page.getByRole("combobox").fill("Held target 25 ")
      await page.getByRole("combobox").press("Enter")
      const target = page.locator("#message-msg_held_0025")
      await expect(target).toBeInViewport()
      held.resolve()
      await ended.promise
      await expect(target).toBeInViewport()
      await expect(page).toHaveURL(/#message-msg_held_0025$/)
    } finally {
      held.resolve()
    }
  })

  test("preserves scrolled active identity on prepend and reacts to native user/synthetic replacement", async ({
    page,
  }) => {
    const held = Promise.withResolvers<void>()
    const arrived = Promise.withResolvers<void>()
    const id = "ses_jump_live"

    const messages = Array.from({ length: 100 }, (_, index) =>
      userMessage([textPart(`prt_live_${index}`, `Live needle ${index}`)], {
        id: `msg_live_${String(index).padStart(4, "0")}`,
        created: index + 1,
      }),
    )

    const workspace = await openSession(page, {
      name: "JumpLive",
      sessions: [{ id }],
      beforeMessagesResponse: ({ before }) => {
        if (before) {
          arrived.resolve()

          return held.promise
        }

        return Promise.resolve()
      },
      pageMessages: (_id, _limit, before) =>
        before ? { items: messages.slice(0, 20) } : { items: messages.slice(20), cursor: "older" },
    })

    try {
      await openJump(page)
      await arrived.promise
      const dialog = page.getByRole("dialog")
      const input = dialog.getByRole("combobox")
      await input.fill("needle")
      await input.press("ArrowDown")
      await input.press("ArrowDown")
      const active = await input.getAttribute("aria-activedescendant")
      await dialog.getByRole("listbox").evaluate((element) => {
        element.scrollTop = 1200
      })
      const offset = await dialog.getByRole("listbox").evaluate((element) => element.scrollTop)

      const position = () =>
        dialog.getByRole("listbox").evaluate((element) => {
          const top = element.getBoundingClientRect().top

          const row = [...element.querySelectorAll('[role="option"]')].find(
            (item) => item.getBoundingClientRect().bottom > top,
          )

          return row ? { id: row.id, offset: row.getBoundingClientRect().top - top } : undefined
        })

      const before = await position()
      held.resolve()
      await expect(dialog.getByRole("status")).toHaveText("100 matches (100 total)")
      await expect(input).toHaveAttribute("aria-activedescendant", active!)
      expect(await dialog.getByRole("listbox").evaluate((element) => element.scrollTop)).toBe(offset)
      await test.info().attach("F003-D02-prepend-position", {
        body: JSON.stringify({ before, after: await position() }),
        contentType: "application/json",
      })
      await workspace.push([
        inboxEnqueued({
          sessionID: id,
          inboxID: "msg_live_0021",
          item: { type: "user", payload: { text: "Updated needle value" }, delivery: "steer" },
        }),
        inboxDelivered({ sessionID: id, inboxID: "msg_live_0021" }),
      ])
      await expect(dialog.getByRole("option", { selected: true })).toContainText("Updated needle value")
      await workspace.push([
        inboxEnqueued({
          sessionID: id,
          inboxID: "msg_live_0021",
          item: { type: "synthetic", payload: { text: "Updated needle value" }, delivery: "steer" },
        }),
        inboxDelivered({ sessionID: id, inboxID: "msg_live_0021" }),
      ])
      await expect(input).not.toHaveAttribute("aria-activedescendant")
      await expect(dialog.getByRole("status")).toHaveText("99 matches (99 total)")
      await input.fill("LIVE")
      await expect.poll(() => dialog.getByRole("listbox").evaluate((element) => element.scrollTop)).toBe(0)
      await dialog.getByRole("button", { name: "Clear", exact: true }).click()
      await expect(input).toBeFocused()
      await expect(input).toHaveValue("")
      await expect(input).not.toHaveAttribute("aria-activedescendant")
      await input.dispatchEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })
      await expect(dialog).toBeVisible()
    } finally {
      held.resolve()
    }
  })

  for (const mode of ["following", "reading", "switch", "reopen"] as const) {
    test(`closing held discovery respects ${mode} ownership`, async ({ page }) => {
      const held = Promise.withResolvers<void>()
      const arrived = Promise.withResolvers<void>()
      const ended = Promise.withResolvers<void>()
      const errors = trackPageErrors(page)
      const id = `ses_jump_close_${mode}`
      const other = `ses_jump_other_${mode}`

      const messages = Array.from({ length: 50 }, (_, index) =>
        userMessage([textPart(`prt_close_${index}`, `Close prompt ${index} ${"words ".repeat(30)}`)], {
          id: `msg_close_${String(index).padStart(4, "0")}`,
          created: index + 1,
        }),
      )

      const workspace = await openSession(page, {
        name: "JumpClose",
        sessions: [{ id }, { id: other }],
        beforeMessagesResponse: ({ sessionID, before }) => {
          if (sessionID === id && before) {
            arrived.resolve()

            return held.promise
          }

          return Promise.resolve()
        },
        onMessages: ({ sessionID, before, phase }) => {
          if (sessionID === id && before && phase === "end") ended.resolve()
        },
        pageMessages: (sessionID, _limit, before) =>
          sessionID === other
            ? { items: [userMessage([textPart("prt_other_jump", "Other scope prompt")])] }
            : before
              ? { items: messages.slice(0, 10) }
              : { items: messages.slice(10), cursor: "older" },
      })

      try {
        if (mode === "reading") {
          await timelineScroller(page).evaluate((element) => {
            element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
            element.scrollTop = 100
          })
        }

        await openJump(page)
        await arrived.promise

        if (mode === "switch") {
          // Native route link activation during an outstanding modal, without replacing the document.
          await page
            .locator(`[data-slot="titlebar-tabs"] a[href="${sessionHref(other)}"]`)
            .evaluate((element: HTMLAnchorElement) => element.click())
          await expect(page.getByRole("dialog", { name: "Jump to message" })).toHaveCount(0)
          await expect(page.getByText("Other scope prompt", { exact: true })).toBeVisible()
        } else {
          await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
          await expect(page.getByRole("dialog", { name: "Jump to message" })).toHaveCount(0)

          if (mode === "reopen") {
            await openJump(page)
            await page.getByRole("combobox").fill("Close prompt 25")
          }
        }

        held.resolve()
        await ended.promise

        if (mode === "reopen") {
          await expect(page.getByRole("combobox")).toHaveValue("Close prompt 25")
          await expect(page.getByRole("option")).toHaveCount(1)
          await page.getByRole("combobox").press("Enter")
          await expect(page.locator("#message-msg_close_0025")).toBeInViewport()
        }

        if (mode === "following" || mode === "reading") {
          await workspace.push([
            inboxEnqueued({
              sessionID: id,
              inboxID: "msg_close_9999",
              item: { type: "user", payload: { text: "Newest after dismissal" }, delivery: "steer" },
            }),
            inboxDelivered({ sessionID: id, inboxID: "msg_close_9999" }),
          ])

          if (mode === "following") await expect(page.locator("#message-msg_close_9999")).toBeInViewport()

          if (mode === "reading") await expect(page.locator("#message-msg_close_9999")).not.toBeInViewport()
        }

        if (mode === "switch") await expect(page.getByText("Other scope prompt", { exact: true })).toBeInViewport()
        expect(errors).toEqual([])
      } finally {
        held.resolve()
      }
    })
  }
})

async function openJump(page: Page) {
  await page.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Jump to message...", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Jump to message" })).toBeVisible()
}

test.describe("timeline history", () => {
  test("restoring a paged transcript waits for another upward scroll before loading history", async ({ page }) => {
    const id = "ses_history_restore"
    const other = "ses_history_other"
    const text = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}.`).join("\n\n")

    const messages = [
      userMessage([textPart("prt_restore_0", "Original prompt")], { id: "msg_restore_0", created: 1 }),
      assistantMessage([textPart("prt_restore_1", text)], { id: "msg_restore_1", created: 2 }),
      userMessage([textPart("prt_restore_2", "Middle prompt")], { id: "msg_restore_2", created: 3 }),
      assistantMessage([textPart("prt_restore_3", text)], { id: "msg_restore_3", created: 4 }),
      userMessage([textPart("prt_restore_4", "Another prompt")], { id: "msg_restore_4", created: 5 }),
      assistantMessage([textPart("prt_restore_5", text)], { id: "msg_restore_5", created: 6 }),
      userMessage([textPart("prt_restore_6", "Latest prompt")], { id: "msg_restore_6", created: 7 }),
      assistantMessage([textPart("prt_restore_7", text)], { id: "msg_restore_7", created: 8 }),
    ]

    const requests: (string | undefined)[] = []
    await page.clock.install()
    await openSession(page, {
      name: "HistoryRestore",
      sessions: [{ id }, { id: other, directory: "C:/OpenCode/HistoryOther" }],
      pageMessages: (session, _limit, before) => {
        if (session === other)
          return { items: [userMessage([textPart("prt_other", "Other session")], { id: "msg_other" })] }
        requests.push(before)

        if (before === "oldest") return { items: messages.slice(0, 1) }

        if (before === "older") return { items: messages.slice(1, -2), cursor: "oldest" }

        return { items: messages.slice(-2), cursor: "older" }
      },
    })
    const scroller = timelineScroller(page)
    await expect(page.locator("[data-timeline-virtual-content]")).toHaveCSS("visibility", "visible")
    // The virtual container can be visible before Markdown expands and initial bottom restoration finishes.
    await expect(page.getByText("Paragraph 39.", { exact: true })).toBeAttached()
    await expect(scroller.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) =>
            new Promise<{ overflow: boolean; atEnd: boolean }>((resolve) => {
              // Observe after the browser's initial scroll/resize delivery, not mid-restoration.
              requestAnimationFrame(() =>
                resolve({
                  overflow: element.scrollHeight - element.clientHeight > 200,
                  atEnd: Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1,
                }),
              )
            }),
        ),
      )
      .toEqual({ overflow: true, atEnd: true })
    // One upward gesture, without wheel momentum carrying across the page prepend.
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
      element.scrollTop = 0
    })
    await expect.poll(() => requests).toEqual([undefined, "older"])
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(200)

    await page.locator(`[data-slot="titlebar-tabs"] a[href="${sessionHref(other)}"]`).click()
    await expect(page.getByText("Other session", { exact: true })).toBeVisible()
    await page.locator(`[data-slot="titlebar-tabs"] a[href="${sessionHref(id)}"]`).click()
    await expect(page.locator("[data-timeline-virtual-content]")).toHaveCSS("visibility", "visible")
    // Exhaust the delayed leading-turn enrichment without a real-time sleep.
    await page.clock.runFor(1_000)
    expect(requests).toEqual([undefined, "older"])

    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
      element.scrollTop = 0
    })
    await expect(page.getByText("Original prompt", { exact: true })).toBeInViewport()
    expect(requests).toEqual([undefined, "older", "oldest"])
  })

  test("keeps visible rows fixed while an older page prepends", async ({ page }) => {
    const older = Promise.withResolvers<void>()
    const requests: { before?: string; phase: "start" | "end" }[] = []
    await openStressTarget(page, {
      beforeMessagesResponse: ({ before }) => (before ? older.promise : Promise.resolve()),
      onMessages: (request) => requests.push(request),
    })
    const scroller = timelineScroller(page)
    await scroller.hover()
    await page.mouse.wheel(0, -100_000)
    await expect.poll(() => requests.some((request) => request.before && request.phase === "start")).toBe(true)
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1)

    const keys = await scroller.evaluate((element) => {
      const view = element.getBoundingClientRect()

      return [...element.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
        .filter((row) => {
          const rect = row.getBoundingClientRect()

          return rect.bottom > view.top && rect.top < view.bottom
        })
        .flatMap((row) => (row.dataset.timelinePartId ? [row.dataset.timelinePartId] : []))
        .slice(0, 3)
    })

    expect(keys).toHaveLength(3)

    const positions = () =>
      scroller.evaluate((element, keys) => {
        const top = element.getBoundingClientRect().top

        return keys.map((key) => {
          const row = element.querySelector<HTMLElement>(`[data-timeline-part-id="${key}"]`)

          if (!row) return undefined

          return Math.round((row.getBoundingClientRect().top - top) * devicePixelRatio) / devicePixelRatio
        })
      }, keys)

    const before = await positions()
    const height = await scroller.evaluate((element) => element.scrollHeight)
    expect(requests.some((request) => request.before && request.phase === "end")).toBe(false)

    older.resolve()
    await expect.poll(() => requests.some((request) => request.before && request.phase === "end")).toBe(true)
    // The older page has landed above the visible rows.
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight)).toBeGreaterThan(height)
    await expect.poll(positions).toEqual(before)
  })

  test("mounts every part once and in order while paging to the start", async ({ page }) => {
    test.setTimeout(240_000)
    const errors = trackPageErrors(page)
    const held: (() => void)[] = []
    const loads = { started: 0, ended: 0 }
    await page.setViewportSize({ width: 1280, height: 1400 })
    await openStressTarget(page, {
      // Older pages land only between scroll steps, so a step never races the prepend.
      beforeMessagesResponse: ({ before }) =>
        before ? new Promise<void>((resolve) => held.push(resolve)) : Promise.resolve(),
      onMessages: (request) => {
        if (request.before && request.phase === "start") loads.started++

        if (request.before && request.phase === "end") loads.ended++
      },
    })
    const expectedParts = fixture.messages[fixture.targetID]!.flatMap(partIDs)
    const expectedMessages = fixture.expected.targetMessageIDs
    const seenParts = new Set<string>()
    const seenMessages = new Set<string>()

    for (;;) {
      const state = await visibleTimeline(page)
      expectOrdered(expectedParts, state.parts, "mounted parts")
      expectOrdered(expectedParts, state.visibleParts, "visible parts")
      expectOrdered(expectedMessages, state.messages, "mounted messages")
      expectOrdered(expectedMessages, state.visibleMessages, "visible messages")
      expect(state.errorToasts).toBe(0)
      state.parts.forEach((id) => seenParts.add(id))
      state.messages.forEach((id) => seenMessages.add(id))

      if (state.scrollTop <= 1 && seenParts.size === expectedParts.length) break

      if (held.length) {
        held.splice(0).forEach((release) => release())
        await expect.poll(() => loads.ended).toBe(loads.started)
        let previous = ""
        await expect
          .poll(async () => {
            const next = (await visibleTimeline(page)).signature
            const stable = next === previous
            previous = next

            return stable
          })
          .toBe(true)
        continue
      }

      // Scroll instantly and only as far as rows the virtualizer has measured, so neither a smooth wheel
      // animation nor estimated row heights can carry a step past an unmounted row.
      await timelineScroller(page).evaluate((element, delta) => {
        element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -delta }))
        element.scrollTop -= delta
      }, state.mountedAbove)
      await expect
        .poll(async () => {
          const next = await visibleTimeline(page)

          return held.length > 0 || (next.signature !== state.signature && next.covered)
        })
        .toBe(true)
    }

    expect(expectedParts.filter((id) => !seenParts.has(id))).toEqual([])
    expect(expectedMessages.filter((id) => !seenMessages.has(id))).toEqual([])
    expect(errors).toEqual([])
  })

  for (const scenario of [
    { name: "completion", error: undefined, idleFirst: false },
    { name: "interruption", error: { type: "MessageAbortedError", message: "Stopped" }, idleFirst: true },
  ] as const) {
    test(`keeps visible content through ${scenario.name}`, async ({ page }) => {
      const history = Promise.withResolvers<void>()
      const requests: { before?: string; phase: "start" | "end" }[] = []
      const pages: { before?: string; limit: number }[] = []
      const roots: { sessionID: string; messageID: string }[] = []
      const sequence: string[] = []
      const messages = rootHistory()
      // SAFETY: rootHistory ends each generated turn with an assistant message.
      const last = messages.at(-1) as SessionMessageAssistant
      await page.addInitScript(installVisibilityProbe)

      const timeline = await setupTimeline(page, {
        sessionMessages: messages,
        sessionStatus: { [sessionID]: { type: "busy" } },
        viewport: { width: 646, height: 1385 },
        beforeMessagesResponse: (request) => (request.before ? history.promise : Promise.resolve()),
        onMessages: (request) => {
          requests.push(request)
          sequence.push(`messages:${request.phase}:${request.before ?? "latest"}`)
        },
        onMessage: (request) => roots.push(request),
        message: (requested, messageID) =>
          requested === sessionID ? messages.find((item) => item.id === messageID) : undefined,
        pageMessages: (_, limit, before) => {
          pages.push({ before, limit })
          const end = before ? messages.findIndex((message) => message.id === before) : messages.length
          const start = Math.max(0, end - limit)

          return { items: messages.slice(start, end), cursor: start > 0 ? messages[start]!.id : undefined }
        },
      })

      await expect(page.locator(`[data-timeline-part-id="${last.id}:text:0"]`)).toBeVisible()
      await expect(page.locator(`[data-timeline-part-id="${messages.at(-2)!.id}:text:0"]`)).toBeVisible()
      await timelineScroller(page).hover()
      await page.mouse.wheel(0, -100_000)
      await expect.poll(() => requests.filter((request) => request.phase === "start").length).toBe(2)
      expect(sequence).toEqual(["messages:start:latest", "messages:end:latest", `messages:start:${messages[2]!.id}`])

      // The probe samples every painted frame from here on; the steps below wait for projected state, not samples.
      expect(await page.evaluate(() => window.__historyRootProbe!.arm())).not.toEqual([])
      expect(await page.evaluate(() => window.__historyRootProbe!.hidden)).toBe(false)
      history.resolve()
      await expect.poll(() => requests.filter((request) => request.phase === "end").length).toBe(2)
      await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()
      // The older page is projected above the kept rows.
      await expect(
        page.locator(`[data-timeline-row="UserMessage"][data-message-id="${messages[0]!.id}"]`),
      ).toBeAttached()
      expect(pages).toEqual([
        { before: undefined, limit: 40 },
        { before: messages[2]!.id, limit: 20 },
      ])
      expect(roots).toEqual([])

      const completed = {
        ...last,
        time: { ...last.time, completed: last.time.created + 15_000 },
      }

      if (scenario.error) completed.error = scenario.error

      const message = messageUpdated(completed)
      const idle = status("idle")
      // Idle ends the working turn, so its last text part shows the response actions. A completed step changes
      // nothing visible while the session is still busy; the idle that follows it proves both were projected.
      const actionsSelector = `[data-timeline-part-id="${last.id}:text:0"] [data-slot="text-part-copy-wrapper"]`
      const actions = page.locator(actionsSelector)
      // The final state: the response actions after a completion, the Interrupted notice after an interruption.
      const spacer = { selector: '[data-timeline-row="bottom-spacer"]' }
      await page.evaluate(
        (final) => window.__historyRootProbe!.settle(final),
        scenario.error
          ? {
              attached: [],
              visible: [spacer, { selector: '[data-slot="session-timeline-notice-label"]', text: "Interrupted" }],
            }
          : { attached: [actionsSelector], visible: [spacer] },
      )

      for (const event of scenario.idleFirst ? [idle, message] : [message, idle]) {
        await timeline.send(event)

        if (event === idle) {
          await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0)
          await expect(actions).toBeAttached()
        }

        if (event === message && scenario.error)
          await expect(page.getByText("Interrupted", { exact: true })).toBeVisible()
        await expect(page.locator("[data-timeline-virtual-content]")).toHaveCount(1)
        await expect(page.locator("[data-timeline-key]")).not.toHaveCount(0)
      }

      await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0)
      await expect(page.locator('[data-timeline-row="bottom-spacer"]')).toBeVisible()

      if (scenario.error) await expect(page.getByText("Interrupted", { exact: true })).toBeVisible()
      // The DOM can settle before the sampler's next frame; `hidden` is complete once a sample has shown the final state.
      await expect.poll(() => page.evaluate(() => window.__historyRootProbe!.settled)).toBe(true)
      expect(await page.evaluate(() => window.__historyRootProbe!.hidden)).toBe(false)
    })
  }

  for (const composition of ["assistant-only", "mixed"] as const) {
    test(`renders the ${composition} tail before parent hydration and preserves it afterward`, async ({ page }) => {
      const session = { ...fixture.sessions[0]!, id: `ses_hydration_${composition}` }

      // Compact's initial 40 and the next 20 begin with an assistant; page three supplies its parent.
      const messages = Array.from({ length: 61 }, (_, index): SessionMessageInfo => {
        const id = `msg_hydration_${index}`
        const time = { created: 1700000000000 + index * 1_000 }

        if (index === 0 || (composition === "mixed" && index === 59))
          return { id, type: "user", time, text: `Prompt ${index}` }

        return {
          id,
          type: "assistant",
          time: { ...time, completed: time.created + 500 },
          model: { id: "claude-opus-4-6", providerID: "opencode" },
          agent: "build",
          content: [{ type: "text", text: index === 60 ? "## Hydrated tail\n\n**Ready.**" : `Answer ${index}` }],
        }
      })

      const gates = [21, 1].map((index) => ({
        before: messages[index]!.id,
        parent: messages[index === 21 ? 1 : 0]!.id,
        requested: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      }))

      const requests: (string | undefined)[] = []
      await page.setViewportSize({ width: 1440, height: 900 })
      await mockStressTimeline(page, {
        sessions: [session],
        beforeMessagesResponse: async ({ before }) => {
          requests.push(before)

          if (!before) return
          const gate = gates.find((gate) => gate.before === before)

          if (!gate) throw new Error(`Unexpected older-page boundary: ${before}`)
          gate.requested.resolve()
          await gate.release.promise
        },
        pageMessages: (_, limit, before) => {
          expect(limit).toBe(before ? 20 : 40)
          const end = before ? messages.findIndex((message) => message.id === before) : messages.length
          const start = Math.max(0, end - limit)

          return { items: messages.slice(start, end), cursor: start > 0 ? messages[start]!.id : undefined }
        },
      })
      const tail = page.locator('[data-timeline-part-id="msg_hydration_60:text:0"]')
      const markdown = tail.locator('[data-component="markdown"]')
      const content = page.locator("[data-timeline-virtual-content]", { has: tail })
      const viewport = page.locator(".scroll-view__viewport", { has: tail })

      const orphan = page.locator('[data-timeline-row="AssistantPart"]', {
        has: page.locator('[data-timeline-part-id="msg_hydration_58:text:0"]'),
      })

      const expectReadyTail = async () => {
        await expect(content).toHaveCSS("visibility", "visible")
        await expect(markdown).toHaveAttribute("data-markdown-ready", "")
        await expect(markdown.getByRole("heading", { name: "Hydrated tail", exact: true })).toBeInViewport({
          ratio: 1,
        })
        await expect
          .poll(() =>
            viewport.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)),
          )
          .toBeLessThanOrEqual(1)
      }

      try {
        await page.goto(sessionHref(session.id))
        await gates[0]!.requested.promise
        // This must pass while the first older response is still held.
        await expectReadyTail()
        await expect(orphan).toHaveAttribute("data-message-id", "msg_hydration_21")

        if (composition === "mixed")
          await expect(
            page.locator('[data-timeline-row="UserMessage"][data-message-id="msg_hydration_59"]'),
          ).toBeInViewport()
        const original = await markdown.elementHandle()

        for (const gate of gates) {
          await gate.requested.promise
          gate.release.resolve()
          // Parent ownership proves the page reached the projection, not just the network.
          await expect(orphan).toHaveAttribute("data-message-id", gate.parent)
          await expectReadyTail()
          expect(await markdown.evaluate((element, original) => element === original, original)).toBe(true)
        }

        expect(requests).toEqual([undefined, ...gates.map((gate) => gate.before)])

        const ids = await content
          .locator("[data-timeline-part-id]")
          .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-timeline-part-id")))

        expect(new Set(ids).size).toBe(ids.length)
      } finally {
        gates.forEach((gate) => gate.release.resolve())
      }
    })
  }

  test("pages the timeline from the composer, resuming follow at the end and loading history at the top", async ({
    page,
  }) => {
    const messages = validateTimelineMessages([
      ...historyMessages(30),
      userMessage(),
      assistantMessage([textPart("prt_page_keys_text", "Paging from the composer")], { completed: false }),
    ])

    const older: string[] = []

    const timeline = await setupTimeline(page, {
      reducedMotion: true,
      message: (_, id) => messages.find((message) => message.id === id),
      pageMessages: (_, limit, before) => {
        const end = before ? messages.findIndex((message) => message.id === before) : messages.length
        const start = Math.max(0, end - limit)

        return { items: messages.slice(start, end), cursor: start > 0 ? messages[start]!.id : undefined }
      },
      onMessages: (request) => {
        if (request.before && request.phase === "start") older.push(request.before)
      },
    })

    const scroller = timelineScroller(page)
    const editor = page.locator('[data-component="composer-editor"]')
    const suggestions = page.locator('[data-component="composer-suggestions"]')
    const top = () => scroller.evaluate((element) => element.scrollTop)

    const fromEnd = () =>
      scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)

    const caret = () =>
      editor.evaluate((element) => {
        const selection = window.getSelection()!
        const range = document.createRange()
        range.setStart(element, 0)
        range.setEnd(selection.anchorNode!, selection.anchorOffset)

        return range.toString().length
      })

    await expect(page.locator("[data-timeline-virtual-content]")).toHaveCSS("visibility", "visible")
    await expect.poll(fromEnd).toBeLessThanOrEqual(1)
    await editor.click()

    // An open popup keeps the page keys: the timeline stays put and the query stays open.
    await page.keyboard.type("/")
    await expect(suggestions).toBeVisible()
    const resting = await top()
    await editor.press("PageUp")
    expect(await top()).toBe(resting)
    await expect(suggestions).toBeVisible()
    await expect(editor).toHaveText("/")
    await editor.press("Escape")
    await expect(suggestions).toBeHidden()
    await editor.press("Backspace")

    await page.keyboard.type("keep this draft")

    const pageHeight = await page
      .locator('[data-slot="session-timeline-visible"]')
      .evaluate((element) => element.clientHeight)

    await editor.press("PageUp")
    await expect.poll(top).toBeLessThan(resting - pageHeight * 0.6)
    expect(resting - (await top())).toBeLessThan(pageHeight)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveText("keep this draft")
    expect(await caret()).toBe("keep this draft".length)

    // Paging back to the end follows new content again, as a wheel scroll there does.
    for (let index = 0; index < 10 && (await fromEnd()) > 1; index++) await editor.press("PageDown")
    await expect.poll(fromEnd).toBeLessThanOrEqual(1)
    await timeline.send(partUpdated(textPart("prt_page_keys_tail", "Arrived after paging down.\n\n".repeat(20))))
    await timeline.waitForPart("prt_page_keys_tail")
    await expect.poll(fromEnd).toBeLessThanOrEqual(1)

    // Paging to the top loads the older page, as scrolling there does.
    for (let index = 0; index < 30 && (await top()) > 1; index++) await editor.press("PageUp")
    await expect.poll(() => older[0]).toBe(messages[messages.length - 40]!.id)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveText("keep this draft")
  })
})

declare global {
  interface Window {
    __historyRootProbe?: { arm(): string[]; hidden: boolean; settle(final: ProbeFinal): void; settled: boolean }
  }
}

async function openStressTarget(page: Page, input: Parameters<typeof mockStressTimeline>[1] = {}) {
  await mockStressTimeline(page, input)
  await installTimelineSettings(page)
  await page.goto(sessionHref(fixture.targetID))
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await expect(page.locator("[data-timeline-virtual-content]")).toHaveCSS("visibility", "visible")
}

function timelineScroller(page: Page) {
  return page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
}

function visibleTimeline(page: Page) {
  return timelineScroller(page).evaluate((scroller) => {
    const view = scroller.getBoundingClientRect()

    const inView = (element: Element) => {
      const rect = element.getBoundingClientRect()

      return rect.bottom >= view.top && rect.top <= view.bottom
    }

    const parts = [...scroller.querySelectorAll<HTMLElement>("[data-timeline-part-id], [data-timeline-part-ids]")]

    const partIDs = (element: HTMLElement) =>
      [element.dataset.timelinePartId, ...(element.dataset.timelinePartIds?.split(",") ?? [])].filter(
        (id): id is string => !!id,
      )

    const messages = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")]
    const messageIDs = (elements: HTMLElement[]) => [...new Set(elements.map((element) => element.dataset.messageId!))]

    const firstRowTop = Math.min(
      ...[...scroller.querySelectorAll("[data-timeline-key]")].map((row) => row.getBoundingClientRect().top),
    )

    return {
      parts: parts.flatMap(partIDs),
      visibleParts: parts.filter(inView).flatMap(partIDs),
      messages: messageIDs(messages),
      visibleMessages: messageIDs(messages.filter(inView)),
      scrollTop: Math.round(scroller.scrollTop),
      // Mounted rows reach the top edge, so the virtualizer has rendered this position. Below 200px the
      // timeline requests the next older page instead.
      covered: scroller.scrollTop < 200 || firstRowTop <= view.top + 1,
      mountedAbove: Math.max(80, Math.floor(view.top - firstRowTop)),
      errorToasts: document.querySelectorAll(".toast-v2--error").length,
      signature: JSON.stringify([
        Math.round(scroller.scrollTop),
        Math.round(scroller.scrollHeight),
        parts.flatMap(partIDs),
      ]),
    }
  })
}

function expectOrdered(expected: string[], actual: string[], label: string) {
  expect(actual.length, `${label} should not be empty`).toBeGreaterThan(0)
  const present = new Set(actual)
  expect(actual, label).toEqual(expected.filter((id) => present.has(id)))
}

function partIDs(message: SessionMessageInfo) {
  if (message.type === "user") return [`${message.id}:text:0`]

  if (message.type !== "assistant") return []
  const ordinals = { text: 0, reasoning: 0 }

  return message.content.flatMap((part) => {
    if (part.type === "text" || part.type === "reasoning")
      return [`${message.id}:${part.type}:${ordinals[part.type]++}`]

    if (part.type === "tool") return [part.id]

    return []
  })
}

// 21 turns: the latest 40-message page starts at the second turn, so one older page of 20 reaches the first.
function rootHistory() {
  return Array.from({ length: 21 }, (_, index) => {
    const id = `msg_${String(index + 1001).padStart(4, "0")}_history_root_user`

    return [
      userMessage(undefined, { id, created: 1700000000000 + index * 2_000 }),
      assistantMessage([textPart(`prt_history_root_${index}`, `Assistant response ${index}`)], {
        id: `msg_${String(index + 1001).padStart(4, "0")}_history_root_assistant`,
        parentID: id,
        created: 1700000001000 + index * 2_000,
        completed: index < 20,
      }),
    ]
  }).flat()
}

// A state the probe waits to see painted: every `attached` selector matches, and every `visible` entry matches a
// visible element (with exactly `text`, when set).
type ProbeFinal = { attached: string[]; visible: { selector: string; text?: string }[] }

// Samples every painted frame and records whether any part that was visible when armed disappeared. After `settle`,
// it also records (`settled`) the first sample that shows the final state, so `hidden` then covers that frame.
function installVisibilityProbe() {
  const shown = (element: Element) => {
    const rect = element.getBoundingClientRect()

    return rect.width > 0 && rect.height > 0 && element.checkVisibility({ visibilityProperty: true })
  }

  const shows = (final: ProbeFinal) =>
    final.attached.every((selector) => document.querySelector(selector)) &&
    final.visible.every((entry) =>
      [...document.querySelectorAll(entry.selector)].some(
        (element) => shown(element) && (entry.text === undefined || element.textContent?.trim() === entry.text),
      ),
    )

  const visibleParts = () => {
    const viewport = document.querySelector("[data-timeline-virtual-content]")?.closest(".scroll-view__viewport")
    const view = viewport?.getBoundingClientRect()

    if (!viewport || !view) return []

    return [...viewport.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
      .filter((part) => {
        const rect = part.getBoundingClientRect()

        return rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
      })
      .flatMap((part) => (part.dataset.timelinePartId ? [part.dataset.timelinePartId] : []))
  }

  // SAFETY: arm populates parts with visible part IDs; settle supplies the optional final state.
  const state = {
    armed: false,
    hidden: false,
    parts: [] as string[],
    final: undefined as ProbeFinal | undefined,
    settled: false,
    // Returns the parts that must stay visible.
    arm() {
      state.parts = visibleParts()
      state.armed = true

      return state.parts
    },
    settle(final: ProbeFinal) {
      state.final = final
      state.settled = false
    },
  }

  window.__historyRootProbe = state

  const sample = () => {
    if (state.armed) {
      const visible = new Set(visibleParts())

      if (state.parts.length === 0 || state.parts.some((partID) => !visible.has(partID))) state.hidden = true

      if (state.final && !state.settled) state.settled = shows(state.final)
    }

    requestAnimationFrame(() => setTimeout(sample, 0))
  }

  requestAnimationFrame(() => setTimeout(sample, 0))
}
