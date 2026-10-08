import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { currentSession, mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/SubagentNavigation"
const projectID = "proj_subagent_navigation"
const rootID = "ses_subagent_root"
const parentID = "ses_subagent_parent"
const childID = "ses_subagent_child"
const modelID = "claude-opus-4-6"
const alternateModelID = "alternative-model"
const defaultModelID = "default-model"
const rootTitle = "Root session"
const parentTitle = "Delegate to a parent subagent (@explore subagent)"
const childTitle = "Subagent child session"
const parentTaskDescription = "Inspect the session cache before delegating"
// Child session pages derive their heading from the task part that spawned them.
const taskDescription = "Inspect child navigation"

type EventPayload = { directory: string; payload: Record<string, unknown> }

test.use({ viewport: { width: 1440, height: 900 } })

test("navigates to a deep subagent session through its root tab and ancestors", async ({ page }) => {
  await setup(page)
  await openChildFromParent(page)

  await expectSessionTitle(page, taskDescription)
  await expect(page.getByRole("heading", { name: parentTitle })).toHaveCount(0)

  const ancestors = page.locator('[data-slot="session-title-parent"]')
  await expect(ancestors).toHaveCount(2)
  await expect(ancestors.nth(0)).toHaveText(rootTitle)
  await expect(ancestors.nth(0)).toHaveAttribute("data-session-id", rootID)
  await expect(ancestors.nth(1)).toHaveText(parentTaskDescription)
  await expect(ancestors.nth(1)).not.toContainText("(@explore subagent)")
  await expect(ancestors.nth(1)).toHaveAttribute("data-session-id", parentID)

  const tabs = page.locator('[data-slot="titlebar-tabs"] a')
  await expect(tabs).toHaveCount(1)
  await expect(tabs).toHaveAttribute("href", sessionHref(rootID))
  const activeTab = page.locator('[data-titlebar-tab-slot][data-active="true"]')
  await expect(activeTab).toHaveCount(1)
  await expect(activeTab).toContainText(rootTitle)
  await ancestors.nth(0).click()
  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${rootID}$`))
  await expectSessionTitle(page, rootTitle)

  const titlebarRight = page.locator("#opencode-titlebar-right")
  await expect(titlebarRight.getByRole("button", { name: "Toggle review" })).toHaveCount(1)
})

test("creates the root tab and cleans uncached ancestor titles when opening a deep child directly", async ({ page }) => {
  await setup(page, { sessionTab: null, rootHistory: false })
  await page.goto(sessionHref(childID))

  await expectSessionTitle(page, childTitle)
  const ancestors = page.locator('[data-slot="session-title-parent"]')
  await expect(ancestors).toHaveCount(2)
  await expect(ancestors.nth(0)).toHaveAttribute("data-session-id", rootID)
  await expect(ancestors.nth(0)).toHaveText(rootTitle)
  await expect(ancestors.nth(1)).toHaveAttribute("data-session-id", parentID)
  await expect(ancestors.nth(1)).toHaveText("Delegate to a parent subagent")
  await expect(ancestors.nth(1)).not.toContainText("(@explore subagent)")

  const tabs = page.locator('[data-slot="titlebar-tabs"] a')
  await expect(tabs).toHaveCount(1)
  await expect(tabs).toHaveAttribute("href", sessionHref(rootID))
  const activeTab = page.locator('[data-titlebar-tab-slot][data-active="true"]')
  await expect(activeTab).toHaveCount(1)
  await expect(activeTab).toContainText(rootTitle)
})

test("sends an immediate prompt to the child session", async ({ page }) => {
  await setup(page)
  await openChildFromParent(page)

  await page.route(
    (url) =>
      url.pathname === `/session/${childID}/prompt_async` &&
      url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) => route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } }),
  )
  const editor = page.locator('[data-component="prompt-input"]')
  await expect(editor).toBeEditable()
  await editor.fill("Send this child prompt now")
  const request = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === `/session/${childID}/prompt_async`,
  )
  await page.locator('[data-action="prompt-submit"]').click()

  const submitted = await request
  expect(submitted.url()).toContain(`/session/${childID}/prompt_async`)
  expect(submitted.postDataJSON()).toMatchObject({
    agent: "explore",
    model: { modelID, providerID: "opencode" },
    variant: "high",
    parts: [{ type: "text", text: "Send this child prompt now" }],
  })
})

test("does not fall back when the child's recorded model is unavailable", async ({ page }) => {
  await setup(page, {
    childModel: { id: "missing-model", providerID: "missing-provider", variant: "high" },
  })
  await openChildFromParent(page)

  let promptRequests = 0
  await page.route(
    (url) =>
      url.pathname === `/session/${childID}/prompt_async` &&
      url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) => {
      promptRequests += 1
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    },
  )
  const editor = page.locator('[data-component="prompt-input"]')
  await expect(editor).toBeEditable()
  await editor.fill("Do not send with an unrelated model")
  await page.locator('[data-action="prompt-submit"]').click()

  await expect(page.getByText("Select an agent and model", { exact: true })).toBeVisible()
  expect(promptRequests).toBe(0)
})

test("preserves the recorded child variant after a local model selection", async ({ page }) => {
  await setup(page)
  await openChildFromParent(page)

  await page.locator('[data-action="prompt-model"]').click()
  const alternateModel = page.getByRole("button", { name: "Alternative Model Free", exact: true })
  await expect(alternateModel).toBeVisible()
  await alternateModel.click()

  await page.route(
    (url) =>
      url.pathname === `/session/${childID}/prompt_async` &&
      url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) => route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } }),
  )
  const editor = page.locator('[data-component="prompt-input"]')
  await expect(editor).toBeEditable()
  await editor.fill("Keep the recorded child variant")
  const request = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === `/session/${childID}/prompt_async`,
  )
  await page.locator('[data-action="prompt-submit"]').click()

  expect((await request).postDataJSON()).toMatchObject({
    agent: "explore",
    model: { modelID: alternateModelID, providerID: "opencode" },
    variant: "high",
  })
})

test("allows explicit child-local model and variant overrides", async ({ page }) => {
  await setup(page)
  await openChildFromParent(page)

  await page.locator('[data-action="prompt-model"]').click()
  const alternateModel = page.getByRole("button", { name: "Alternative Model Free", exact: true })
  await expect(alternateModel).toBeVisible()
  await alternateModel.click()

  const variant = page.getByRole("button", { name: "Choose model variant" })
  await expect(variant).toBeVisible()
  await variant.click()
  const low = page.getByRole("menuitemradio", { name: "low" })
  await expect(low).toBeVisible()
  await low.click()

  await page.route(
    (url) =>
      url.pathname === `/session/${childID}/prompt_async` &&
      url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) => route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } }),
  )
  const editor = page.locator('[data-component="prompt-input"]')
  await expect(editor).toBeEditable()
  await editor.fill("Use the child-local model and variant")
  const request = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === `/session/${childID}/prompt_async`,
  )
  await page.locator('[data-action="prompt-submit"]').click()

  expect((await request).postDataJSON()).toMatchObject({
    agent: "explore",
    model: { modelID: alternateModelID, providerID: "opencode" },
    variant: "low",
  })
})

test("preserves root-session model fallback behavior", async ({ page }) => {
  await setup(page, { rootHistory: false })
  await page.goto(sessionHref(rootID))
  await expectSessionTitle(page, rootTitle)

  await page.route(
    (url) =>
      url.pathname === `/session/${rootID}/prompt_async` &&
      url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) => route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } }),
  )
  const editor = page.locator('[data-component="prompt-input"]')
  await expect(editor).toBeEditable()
  await editor.fill("Use the root model fallback")
  const request = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === `/session/${rootID}/prompt_async`,
  )
  await page.locator('[data-action="prompt-submit"]').click()

  expect((await request).postDataJSON()).toMatchObject({
    agent: "build",
    model: { modelID: defaultModelID, providerID: "opencode" },
  })
})

test("keeps pending child permission and question docks without a disabled composer", async ({ page }) => {
  await setup(page, {
    questions: [
      {
        id: "child-question",
        sessionID: childID,
        questions: [
          {
            header: "Continue",
            question: "Continue the child task?",
            options: [{ label: "Yes", description: "Continue the work" }],
          },
        ],
      },
    ],
    permissions: [
      {
        id: "child-permission",
        sessionID: childID,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      },
    ],
  })
  await openChildFromParent(page)

  await expect(page.locator('[data-component="dock-prompt"][data-kind="question"]')).toBeVisible()
  await expect(page.locator('[data-component="dock-prompt"][data-kind="permission"]')).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]')).toHaveCount(0)
  await expect(page.getByText("Subagent sessions cannot be prompted.", { exact: true })).toHaveCount(0)
})

test("shows the not found fallback when the viewed session is deleted", async ({ page }) => {
  const events: EventPayload[] = []
  await setup(page, { events: () => events.splice(0, 1) })
  await openChildFromParent(page)
  await expectSessionTitle(page, taskDescription)

  events.push({
    directory,
    payload: { type: "session.deleted", properties: { info: childSession() } },
  })

  await expect(page.getByText("This session cannot be found")).toBeVisible()
  await expect(page.getByRole("button", { name: "Close Tab", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: taskDescription })).toHaveCount(0)
})

async function setup(
  page: Page,
  options: {
    events?: () => EventPayload[]
    sessionTab?: string | null
    childModel?: { id: string; providerID: string; variant?: string }
    rootHistory?: boolean
    questions?: unknown[]
    permissions?: unknown[]
  } = {},
) {
  const childModel = options.childModel ?? { id: modelID, providerID: "opencode", variant: "high" }
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "subagent-navigation",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            [modelID]: {
              id: modelID,
              name: "Claude Opus 4.6",
              limit: { context: 200_000 },
              variants: { low: {}, high: {} },
            },
            [alternateModelID]: {
              id: alternateModelID,
              name: "Alternative Model",
              limit: { context: 200_000 },
              variants: { low: {}, high: {} },
            },
            [defaultModelID]: {
              id: defaultModelID,
              name: "Default Model",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { opencode: defaultModelID },
    },
    sessions: [
      session(rootID, rootTitle, 1700000000000),
      session(parentID, parentTitle, 1700000000000, { parentID: rootID }),
      childSession(childModel),
    ],
    pageMessages: (sessionID) => ({
      items:
        sessionID === rootID
          ? options.rootHistory === false
            ? []
            : rootMessages()
          : sessionID === parentID
            ? parentMessages()
            : [],
    }),
    events: options.events,
    eventRetry: options.events ? 16 : undefined,
    questions: options.questions,
    permissions: options.permissions,
  })
  // The child session resolves by ID but is absent from the session list,
  // matching a subagent session that has not been loaded into the list cache yet.
  await page.route(
    (url) => url.pathname === "/api/session" && url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          data: [currentSession(session(rootID, rootTitle, 1700000000000))],
          cursor: {},
        }),
      }),
  )
  await page.route(
    (url) => url.pathname === "/api/agent" && url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          location: { directory, project: { id: projectID, directory } },
          data: [
            { id: "build", name: "Build", mode: "primary", hidden: false, request: { settings: {} }, permissions: [] },
            {
              id: "explore",
              name: "Explore",
              mode: "subagent",
              hidden: false,
              model: { providerID: "opencode", modelID: alternateModelID },
              request: { settings: {} },
              permissions: [],
            },
          ],
        }),
      }),
  )
  await page.route(
    (url) => url.pathname === "/agent" && url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify([
          { name: "build", mode: "primary" },
          { name: "explore", mode: "subagent" },
        ]),
      }),
  )
  await configurePage(page, options.sessionTab === undefined ? rootID : options.sessionTab)
}

async function openChildFromParent(page: Page) {
  await page.goto(sessionHref(rootID))
  await expectSessionTitle(page, rootTitle)

  const parentCard = page.locator(`a[href="${sessionHref(parentID)}"]`)
  await expect(parentCard).toBeVisible()
  await parentCard.click()
  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${parentID}$`), { timeout: 15_000 })
  await expectSessionTitle(page, parentTaskDescription)

  const card = page.locator(`a[href="${sessionHref(childID)}"]`)
  await expect(card).toBeVisible()
  await card.click()

  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${childID}$`), { timeout: 15_000 })
}

function session(id: string, title: string, created: number, extra?: Record<string, unknown>) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
    ...extra,
  }
}

function childSession(model = { id: modelID, providerID: "opencode", variant: "high" }) {
  return session(childID, childTitle, 1700000001000, {
    parentID,
    agent: "explore",
    model,
  })
}

function rootMessages() {
  return taskMessages(rootID, parentID, parentTaskDescription, "root")
}

function parentMessages() {
  return taskMessages(parentID, childID, taskDescription, "parent")
}

function taskMessages(parentSessionID: string, childSessionID: string, description: string, key: string) {
  const userID = `msg_${key}_user_0001`
  const assistantID = `msg_${key}_assistant_0001`
  return [
    {
      info: {
        id: userID,
        sessionID: parentSessionID,
        role: "user",
        time: { created: 1700000000000 },
        agent: "build",
        model: { providerID: "opencode", modelID },
      },
      parts: [
        {
          id: "prt_user_text_0001",
          sessionID: parentSessionID,
          messageID: userID,
          type: "text",
          text: "Delegate work to a subagent",
        },
      ],
    },
    {
      info: {
        id: assistantID,
        sessionID: parentSessionID,
        role: "assistant",
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: userID,
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0.01,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_tool_task_0001",
          sessionID: parentSessionID,
          messageID: assistantID,
          type: "tool",
          callID: "call_task_0001",
          tool: "task",
          state: {
            status: "completed",
            input: { description, subagent_type: "explore" },
            output: "Subagent finished",
            title: description,
            metadata: { sessionId: childSessionID },
            time: { start: 1700000001000, end: 1700000002000 },
          },
        },
      ],
    },
  ]
}

async function configurePage(page: Page, sessionID?: string | null) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, server, sessionId }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(sessionId ? [{ type: "session", server, sessionId }] : []),
      )
    },
    { directory, server, sessionId: sessionID },
  )
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}
