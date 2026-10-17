import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Schema } from "effect"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"
import {
  directory,
  model,
  project,
  session,
  sessionID,
  userID,
  userMessage,
  assistantMessage,
} from "../performance/timeline-stability/fixture"

const payload = {
  kind: "prompt",
  agent: "build",
  model,
  variant: "max",
  parts: [{ type: "text", text: "Native queued prompt" }],
}
const snapshot = (items: unknown[] = []) =>
  Schema.decodeUnknownSync(SessionQueueV1.Snapshot)({ sessionID, revision: 1, paused: false, blocked: false, items })
const entry = (id: string, delivery = "queue", state = "pending", messageID?: string) => ({
  id,
  delivery,
  state,
  sessionID,
  position: 0,
  created: 1,
  payload,
  ...(messageID ? { messageID } : {}),
})

async function setup(page: Page, design: boolean, initial = snapshot()) {
  // Exercise both composers even after the product's legacy-interface sunset.
  await page.clock.setFixedTime(new Date("2026-09-01T12:00:00Z"))
  const state = {
    snapshot: initial,
    fail: false,
    gate: undefined as Promise<void> | undefined,
    patchGate: undefined as Promise<void> | undefined,
    conflict: false,
    submits: [] as SessionQueueV1.Submit[],
    mutations: [] as SessionQueueV1.Update[],
  }
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  const transport = await installSseTransport<unknown>(page, { server })
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    sessions: [session()],
    provider: {
      all: [
        {
          id: model.providerID,
          name: "OpenCode",
          models: { [model.modelID]: { id: model.modelID, name: "Claude Opus 4.6", limit: { context: 200000 } } },
        },
      ],
      connected: [model.providerID],
      default: model,
    },
    pageMessages: () => ({ items: [userMessage(), assistantMessage()] }),
    sessionStatus: { [sessionID]: { type: "idle" } },
  })
  await page.route(/\/session\/[^/]+\/queue(?:\/flush)?(?:\?|$)/, async (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
          "access-control-allow-headers": "*",
        },
      })
    if (request.method() === "POST") {
      const submission = Schema.decodeUnknownSync(SessionQueueV1.Submit)(request.postDataJSON())
      state.submits.push(submission)
      await state.gate
      if (state.fail)
        return route.fulfill({
          status: 503,
          json: { name: "UnknownError", data: { message: "Queue unavailable" } },
          headers: { "access-control-allow-origin": "*" },
        })
      state.snapshot = Schema.decodeUnknownSync(SessionQueueV1.Snapshot)({
        ...state.snapshot,
        revision: state.snapshot.revision + 1,
        items: [...state.snapshot.items, { ...entry(submission.id), payload: submission.payload }],
      })
    }
    if (request.method() === "PATCH") {
      const update = Schema.decodeUnknownSync(SessionQueueV1.Update)(request.postDataJSON())
      state.mutations.push(update)
      await state.patchGate
      if (state.conflict)
        return route.fulfill({
          status: 409,
          json: { message: "Revision conflict" },
          headers: { "access-control-allow-origin": "*" },
        })
      expect(update.revision).toBe(state.snapshot.revision)
      const mutation = update.mutation
      state.snapshot = Schema.decodeUnknownSync(SessionQueueV1.Snapshot)({
        ...state.snapshot,
        revision: state.snapshot.revision + 1,
        paused: mutation.action === "pause" ? mutation.paused : state.snapshot.paused,
        blocked: mutation.action === "pause" && !mutation.paused ? false : state.snapshot.blocked,
        items:
          mutation.action === "clear"
            ? state.snapshot.items.filter((item) => item.delivery !== "queue" || item.state !== "pending")
            : mutation.action === "delete"
              ? state.snapshot.items.filter((item) => item.id !== mutation.id)
              : mutation.action === "convert"
                ? state.snapshot.items.map((item) =>
                    item.id === mutation.id ? { ...item, delivery: mutation.delivery } : item,
                  )
                : mutation.action === "reorder"
                  ? [
                      ...mutation.ids.map((id) => state.snapshot.items.find((item) => item.id === id)!),
                      ...state.snapshot.items.filter((item) => !mutation.ids.includes(item.id)),
                    ]
                  : state.snapshot.items,
      })
    }
    return route.fulfill({ json: state.snapshot, headers: { "access-control-allow-origin": "*" } })
  })
  await page.addInitScript((design) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: design, followup: "queue", shouldDisplayTabsToast: false } }),
    )
    if (!design) localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
  }, design)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, session().title)
  const input = page.locator('[data-component="prompt-input"][contenteditable]')
  await expect(input).toBeEditable()
  await expect(page.locator('[data-component="prompt-input-v2"]')).toHaveCount(design ? 1 : 0)
  const change = async () => {
    await transport.send({
      directory,
      payload: {
        id: `evt_queue_${state.snapshot.revision}`,
        type: "session.queue.changed",
        properties: { sessionID, revision: state.snapshot.revision },
      },
    })
  }
  const busy = async (type: "idle" | "busy") => {
    await transport.send({
      directory,
      payload: { id: `evt_status_${type}`, type: "session.status", properties: { sessionID, status: { type } } },
    })
  }
  return { state, input, change, busy, transport }
}

for (const design of [false, true]) {
  test(`native queue contextual composer and acknowledgement safety (${design ? "v2" : "legacy"})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const fixture = await setup(page, design)
    const submit = page.locator('[data-action="prompt-submit"]')
    const queue = page.getByRole("button", { name: "Queue", exact: true })
    await expect(submit).toHaveCount(0)
    await fixture.input.fill("First draft")
    await expect(submit).toHaveAccessibleName("Send")
    await expect(queue).toHaveCount(0)
    await fixture.busy("busy")
    await expect(submit).toHaveAccessibleName("Steer")
    await expect(queue).toBeEnabled()
    await fixture.input.fill("")
    await expect(submit).toHaveAccessibleName("Stop")
    await expect(queue).toHaveCount(0)
    await fixture.input.fill("Queue this exact draft")
    const admission = Promise.withResolvers<void>()
    fixture.state.gate = admission.promise
    const request = page.waitForRequest(
      (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/queue"),
    )
    await queue.click()
    await request
    await expect(fixture.input).toHaveText("Queue this exact draft")
    await expect(submit).toHaveAccessibleName("Steer")
    admission.resolve()
    await expect(fixture.input).toHaveText("")
    expect(fixture.state.submits).toHaveLength(1)
    expect(fixture.state.submits[0]?.payload).toMatchObject({
      kind: "prompt",
      model: { providerID: model.providerID, modelID: model.modelID },
      parts: [{ type: "text", text: "Queue this exact draft" }],
    })
    await expect(
      page.locator('[data-component="user-message"]').filter({ hasText: "Queue this exact draft" }),
    ).toHaveCount(0)
    fixture.state.fail = true
    await fixture.input.fill("Preserve on failure")
    await queue.click()
    await expect(page.getByText("Queue unavailable", { exact: true })).toBeVisible()
    await expect(fixture.input).toHaveText("Preserve on failure")
    fixture.state.fail = false
    await fixture.input.fill("/queue abc")
    await fixture.input.press("Enter")
    await expect(fixture.input).toHaveText("")
    expect(fixture.state.submits.at(-1)?.payload).toMatchObject({
      kind: "prompt",
      parts: [{ type: "text", text: "abc" }],
    })
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await fixture.change()
    await fixture.input.fill("/queue")
    await fixture.input.press("Enter")
    await expect(fixture.input).toHaveText("")
    await expect(
      page.getByText("2 queued items. Open Queued from the session menu to manage them.", { exact: true }),
    ).toBeVisible()
    await fixture.input.fill("/queues")
    await fixture.input.press("Enter")
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
    const steerAdmission = Promise.withResolvers<void>()
    await page.route(/\/session\/[^/]+\/prompt_async(?:\?|$)/, async (route) => {
      if (route.request().method() === "POST") await steerAdmission.promise
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      })
    })
    const steer = page.waitForRequest(
      (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/prompt_async"),
    )
    await fixture.input.fill("Default Enter steers")
    await fixture.input.press("Enter")
    await steer
    await expect(fixture.input).toHaveText("Default Enter steers")
    steerAdmission.resolve()
    await expect(fixture.input).toHaveText("")
    expect(fixture.state.submits).toHaveLength(3)
  })

  test(`native queue management and authoritative pending steers (${design ? "v2" : "legacy"})`, async ({ page }) => {
    const fixture = await setup(
      page,
      design,
      snapshot([
        entry("steering", "steer", "pending", userID),
        entry("queued-a"),
        entry("queued-b"),
        entry("claimed", "queue", "claimed"),
        entry("uncertain", "queue", "uncertain"),
      ]),
    )
    const bubble = page.locator(`[data-message-id="${userID}"][data-timeline-row="UserMessage"] [data-pending-steer]`)
    await expect(bubble).toHaveCount(1)
    await expect(bubble.locator('[data-slot="user-message-text"]')).toHaveCSS("outline-style", "dashed")
    await page.getByRole("button", { name: "More options", exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "Queued (2)...", exact: true })).toBeVisible()
    await page.getByRole("menuitem", { name: "Queued (2)...", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.locator('[data-slot="dialog-title"]')).toHaveText("Queued")
    await expect(dialog.getByRole("region", { name: "Steering", exact: true }).getByRole("listitem")).toHaveCount(1)
    const queued = dialog.getByRole("region", { name: "Queued", exact: true })
    await expect(queued.getByRole("listitem")).toHaveCount(4)
    for (const id of ["claimed", "uncertain"]) {
      const item = dialog.locator(`[data-queue-id="${id}"]`)
      await expect(item.getByRole("button", { name: "Delete", exact: true })).toBeDisabled()
      await expect(item.getByRole("button", { name: "Convert to steering", exact: true })).toBeDisabled()
    }
    const move = dialog.locator('[data-queue-id="queued-b"]').getByRole("button", { name: "Move up", exact: true })
    await move.focus()
    await move.press("Enter")
    await expect
      .poll(() =>
        queued.getByRole("listitem").evaluateAll((items) => items.map((item) => item.getAttribute("data-queue-id"))),
      )
      .toEqual(["queued-b", "queued-a", "claimed", "uncertain"])
    await expect
      .poll(() => fixture.state.mutations.at(-1)?.mutation)
      .toEqual({ action: "reorder", delivery: "queue", ids: ["queued-b", "queued-a"] })
    await expect(move).toBeFocused()
    await dialog.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(dialog.getByRole("status")).toHaveText("Queue paused")
    await dialog.getByRole("button", { name: "Resume", exact: true }).click()
    await expect(dialog.getByRole("status")).toHaveText("Queue active")
    fixture.state.snapshot = { ...fixture.state.snapshot, revision: fixture.state.snapshot.revision + 1, blocked: true }
    await fixture.change()
    await expect(dialog.getByRole("status")).toHaveText("Queue blocked")
    await dialog.getByRole("button", { name: "Resume", exact: true }).click()
    await expect(dialog.getByRole("status")).toHaveText("Queue active")
    expect(fixture.state.mutations.at(-1)?.mutation).toEqual({ action: "pause", paused: false })
    await dialog.locator('[data-queue-id="queued-a"]').getByRole("button", { name: "Delete", exact: true }).click()
    await expect(dialog.locator('[data-queue-id="queued-a"]')).toHaveCount(0)
    fixture.state.conflict = true
    const mutationsBefore = fixture.state.mutations.length
    await dialog.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(dialog.getByRole("alert")).toHaveText("Revision conflict")
    expect(fixture.state.mutations).toHaveLength(mutationsBefore + 1)
    fixture.state.conflict = false
    await dialog.getByRole("button", { name: "Clear queued", exact: true }).click()
    await expect(
      dialog.getByText("Clear pending queued items? Steering and claimed items will be kept.", { exact: true }),
    ).toBeVisible()
    const cleared = Promise.withResolvers<void>()
    fixture.state.patchGate = cleared.promise
    await dialog.getByRole("button", { name: "Confirm clear", exact: true }).click()
    await expect(dialog.locator('[aria-busy="true"]')).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Confirm clear", exact: true })).toBeDisabled()
    cleared.resolve()
    await expect(queued.getByRole("listitem")).toHaveCount(2)
    await expect(dialog.locator('[data-queue-id="steering"]')).toBeVisible()
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    fixture.state.snapshot = {
      ...fixture.state.snapshot,
      revision: fixture.state.snapshot.revision + 1,
      items: fixture.state.snapshot.items.map((item) =>
        item.id === "steering" ? { ...item, state: "claimed" } : item,
      ),
    }
    await fixture.change()
    await expect(bubble).toHaveCount(0)
    await expect(page.locator(`[data-message-id="${userID}"][data-timeline-row="UserMessage"]`)).toContainText(
      "Build the timeline stability matrix.",
    )
    const previous = (await fixture.transport.connections()).at(-1)!
    fixture.state.snapshot = {
      ...fixture.state.snapshot,
      revision: fixture.state.snapshot.revision + 1,
      items: fixture.state.snapshot.items.map((item) =>
        item.id === "steering" ? { ...item, state: "pending" } : item,
      ),
    }
    const refreshed = page.waitForResponse(
      (response) => response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/queue"),
    )
    await fixture.transport.close()
    await fixture.transport.waitForConnection({ after: previous.id })
    await refreshed
    await expect(bubble).toHaveCount(1)
  })

  test(`steer conversion leaves bubble removal to native events (${design ? "v2" : "legacy"})`, async ({ page }) => {
    const fixture = await setup(page, design, snapshot([entry("steering", "steer", "pending", userID)]))
    const message = page.locator(`[data-message-id="${userID}"][data-timeline-row="UserMessage"]`)
    await expect(message.locator("[data-pending-steer]")).toHaveCount(1)
    await page.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Queued...", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog
      .locator('[data-queue-id="steering"]')
      .getByRole("button", { name: "Convert to queued", exact: true })
      .click()
    await expect(dialog.getByRole("region", { name: "Steering", exact: true }).getByRole("listitem")).toHaveCount(0)
    await expect(dialog.getByRole("region", { name: "Queued", exact: true }).getByRole("listitem")).toHaveCount(1)
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await expect(message).toHaveCount(1)
    await expect(message.locator("[data-pending-steer]")).toHaveCount(0)
    await fixture.transport.send({
      directory,
      payload: { id: "evt_native_removed", type: "message.removed", properties: { sessionID, messageID: userID } },
    })
    await expect(message).toHaveCount(0)
  })
}
