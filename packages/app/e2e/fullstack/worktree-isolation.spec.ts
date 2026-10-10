import { expect, test, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { watch } from "node:fs"
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const required = (key: string) => {
  const value = process.env[key]
  if (!value) throw new Error(`The isolated full-stack runner did not set ${key}`)
  return value
}
const root = required("OPENCODE_E2E_ROOT")
const baseURL = required("OPENCODE_E2E_BASE_URL")
const serverURL = required("OPENCODE_E2E_SERVER_URL")
const controlURL = required("OPENCODE_E2E_FAKE_LLM_CONTROL_URL")
const gitBinary = required("OPENCODE_E2E_REAL_GIT")

const gateArmed = path.join(root, "gate.armed")
const gateEntered = path.join(root, "gate.entered")
const gateFIFO = path.join(root, "gate.fifo")
const failGit = path.join(root, "git.fail")
const failedGit = path.join(root, "git.failed")
const backendOrigin = new URL(serverURL).origin
const frontendOrigin = new URL(baseURL).origin

function withinTestRoot(target: string) {
  const relative = path.relative(root, target)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

type APIMessage = {
  info?: { role?: string }
  role?: string
  parts?: Array<{ type?: string; tool?: string }>
}

async function waitForFile(file: string) {
  const exists = () => access(file).then(() => true, () => false)
  if (await exists()) return
  let resolve!: VoidFunction
  let reject!: (error: Error) => void
  const changed = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  const watcher = watch(path.dirname(file), (_event, filename) => {
    if (filename && filename.toString() !== path.basename(file)) return
    void exists().then((found) => {
      if (found) resolve()
    })
  })
  watcher.once("error", reject)
  try {
    if (await exists()) return
    await changed
  } finally {
    watcher.close()
  }
}

async function releaseBoot() {
  const writer = await open(gateFIFO, "w")
  try {
    await writer.writeFile("continue\n")
  } finally {
    await writer.close()
  }
}

async function control(endpoint: string, value?: unknown) {
  const response = await fetch(`${controlURL}/${endpoint}`, {
    method: value === undefined ? "GET" : "POST",
    headers: value === undefined ? undefined : { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  })
  if (!response.ok) throw new Error(`Fake LLM control ${endpoint} returned ${response.status}`)
  return response.json() as Promise<Record<string, unknown>>
}

async function createProject(name: string) {
  const directory = path.join(root, "home", name)
  await mkdir(directory, { recursive: true })
  execFileSync(gitBinary, ["init", "-b", "main"], { cwd: directory, env: process.env, stdio: "pipe" })
  execFileSync(gitBinary, ["config", "core.fsmonitor", "false"], { cwd: directory, env: process.env, stdio: "pipe" })
  execFileSync(gitBinary, ["config", "commit.gpgsign", "false"], { cwd: directory, env: process.env, stdio: "pipe" })
  execFileSync(gitBinary, ["config", "user.email", "e2e@opencode.test"], { cwd: directory, env: process.env, stdio: "pipe" })
  execFileSync(gitBinary, ["config", "user.name", "OpenCode E2E"], { cwd: directory, env: process.env, stdio: "pipe" })
  await writeFile(path.join(directory, "baseline.txt"), "main-checkout-baseline\n")
  await writeFile(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "test/test-model",
      formatter: false,
      lsp: false,
      agent: { build: { permission: { "*": "allow", bash: "allow", edit: "allow", apply_patch: "allow" } } },
      provider: {
        test: {
          name: "Isolated E2E",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Isolated E2E Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 1, output: 1 },
              options: {},
            },
          },
          options: { apiKey: "isolated-test-key", baseURL: `${controlURL.replace(/\/__test$/, "")}/v1` },
        },
      },
    }),
  )
  execFileSync(gitBinary, ["add", "baseline.txt", "opencode.json"], { cwd: directory, env: process.env, stdio: "pipe" })
  execFileSync(gitBinary, ["commit", "-m", "isolated E2E baseline"], { cwd: directory, env: process.env, stdio: "pipe" })

  const current = new URL("/project/current", serverURL)
  current.searchParams.set("directory", directory)
  const response = await fetch(current)
  expect(response.status).toBe(200)
  const providers = new URL("/provider", serverURL)
  providers.searchParams.set("directory", directory)
  const providerResponse = await fetch(providers)
  const providerData = await providerResponse.json()
  if (!providerResponse.ok || !JSON.stringify(providerData).includes("test-model")) {
    throw new Error(`Temporary project did not expose the scripted provider: ${JSON.stringify(providerData)}`)
  }
  return directory
}

function observeRealServer(page: Page) {
  const invalid: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    const api =
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/session/") ||
      url.pathname.startsWith("/experimental/") ||
      url.pathname === "/global/event" ||
      url.pathname === "/event"
    if (api && url.origin !== backendOrigin) invalid.push(url.href)
    if (api && url.port === "4096") invalid.push(url.href)
    if (url.origin !== backendOrigin && url.origin !== frontendOrigin) invalid.push(url.href)
  })
  return () => expect(invalid, "browser requests must stay on the owned Vite and OpenCode listeners").toEqual([])
}

async function openNewSession(page: Page, directory: string) {
  const projectName = path.basename(directory)
  await page.goto(baseURL)
  const addProject = page.locator('[data-action="home-add-project"]')
  await expect(addProject).toBeVisible()
  await addProject.click()
  const folder = page.locator(`[data-directory-path="${directory}"]`)
  await expect(folder).toBeVisible()
  await folder.click()

  const project = page.locator('[data-component="home-project-row"]').filter({ hasText: projectName })
  await expect(project).toBeVisible()
  await project.click()
  const newSession = page.locator('[data-action="home-new-session"]')
  await expect(newSession).toBeVisible()
  await newSession.click()
  await expect(page.locator('[data-component="session-new-design"]')).toBeVisible()
}

async function chooseWorktreeAndModel(page: Page) {
  await page.getByRole("button", { name: "Local", exact: true }).click()
  await page.getByRole("menuitem", { name: /New workspace/i }).click()
  await expect(page.locator('[data-action="prompt-model"]')).toContainText("Isolated E2E Model")
}

async function submit(page: Page, prompt: string) {
  const editor = page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
  await expect(editor).toBeEditable()
  await editor.fill(prompt)
  await page.locator('[data-component="prompt-input-v2"]').getByRole("button", { name: "Send" }).click()
  return editor
}

function sessionID(page: Page) {
  const match = new URL(page.url()).pathname.match(/\/session\/(ses_[^/]+)$/)
  if (!match) throw new Error(`Expected a promoted session route, received ${page.url()}`)
  return match[1]!
}

async function sessionInfo(id: string, directory: string) {
  const response = await fetch(new URL(`/api/session/${id}`, serverURL), {
    headers: { "x-opencode-directory": directory },
  })
  type SessionData = { id?: string; directory?: string; location?: { directory?: string } }
  type SessionResponse = { data?: SessionData } | SessionData
  const value: SessionResponse = response.ok
    ? ((await response.json()) as { data?: SessionData })
    : await fetch(new URL(`/session/${id}?directory=${encodeURIComponent(directory)}`, serverURL)).then(
        (result) => result.json() as Promise<SessionData>,
      )
  const info = ("data" in value ? value.data : undefined) ?? (value as SessionData)
  const sessionDirectory = info.location?.directory ?? info.directory
  if (!info.id || !sessionDirectory) throw new Error(`Session ${id} did not expose its persisted directory`)
  return { data: { id: info.id, location: { directory: sessionDirectory } } }
}

async function sessionMessages(id: string, directory: string) {
  const response = await fetch(new URL(`/api/session/${id}/message`, serverURL), {
    headers: { "x-opencode-directory": directory },
  })
  if (response.ok) {
    const value = (await response.json()) as { data?: APIMessage[] }
    if (value.data?.length) return { data: value.data }
  }
  const legacy = await fetch(
    new URL(`/session/${id}/message?directory=${encodeURIComponent(directory)}`, serverURL),
  )
  if (!legacy.ok) throw new Error(`Session ${id} messages returned ${legacy.status}`)
  const value = (await legacy.json()) as APIMessage[] | { data?: APIMessage[] }
  return { data: Array.isArray(value) ? value : (value.data ?? []) }
}

async function worktrees(directory: string) {
  const url = new URL("/experimental/worktree", serverURL)
  url.searchParams.set("directory", directory)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Worktree listing returned ${response.status}`)
  return (await response.json()) as string[]
}

async function sessions(directory: string) {
  const url = new URL("/api/session", serverURL)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, { headers: { "x-opencode-directory": directory } })
  if (response.ok) {
    const value = (await response.json()) as { data?: Array<{ id: string; location: { directory: string } }> }
    if (value.data) return value as { data: Array<{ id: string; location: { directory: string } }> }
  }
  const legacyURL = new URL("/session", serverURL)
  legacyURL.searchParams.set("directory", directory)
  const legacy = await fetch(legacyURL)
  if (!legacy.ok) throw new Error(`Session listing for ${directory} returned ${legacy.status}`)
  const value = (await legacy.json()) as
    | Array<{ id: string; directory?: string; location?: { directory?: string } }>
    | { data?: Array<{ id: string; directory?: string; location?: { directory?: string } }> }
  const rows = Array.isArray(value) ? value : (value.data ?? [])
  return {
    data: rows.map((item) => ({
      id: item.id,
      location: { directory: item.location?.directory ?? item.directory ?? directory },
    })),
  }
}

async function providerCounts() {
  return (await control("state")).counts as Record<string, number>
}

async function assertCompletedSession(input: {
  id: string
  main: string
  worktree: string
  prompt: string
  label: string
}) {
  await expect
    .poll(async () => {
      const info = await sessionInfo(input.id, input.main).catch(() => undefined)
      const messages = await sessionMessages(input.id, input.main).catch(() => undefined)
      return !!info && info.data.location.directory === input.worktree && JSON.stringify(messages).includes("WORKTREE_" + input.label.toUpperCase() + "_COMPLETE")
    })
    .toBe(true)

  const info = await sessionInfo(input.id, input.main)
  expect(info.data.location.directory).toBe(input.worktree)
  expect(path.resolve(info.data.location.directory)).toBe(path.resolve(input.worktree))
  const messages = (await sessionMessages(input.id, input.main)).data
  const serialized = JSON.stringify(messages)
  const userMessages = messages.filter(
    (message) => (message.info?.role ?? message.role) === "user" && JSON.stringify(message).includes(input.prompt),
  )
  const toolCalls = messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "tool")
    .map((part) => part.tool)
  expect(userMessages).toHaveLength(1)
  expect(toolCalls).toEqual(["bash", "edit"])
  expect(serialized).toContain(`WORKTREE_${input.label.toUpperCase()}_COMPLETE`)
  expect(serialized).toContain("bash")
  expect(serialized).toContain("edit")
  expect(serialized).toContain(input.worktree)
}

async function git(cwd: string, ...args: string[]) {
  return execFileSync(gitPath(), args, { cwd, env: process.env, encoding: "utf8" }).trim()
}

function gitPath() {
  return gitBinary
}

async function assertWorktreeFiles(input: { main: string; worktree: string; label: string }) {
  const shell = await readFile(path.join(input.worktree, `${input.label}-shell.txt`), "utf8")
  expect(shell.trim().split("\n")).toEqual([input.worktree, input.worktree, `shell-${input.label}`])
  const edit = path.join(input.worktree, `${input.label}-edit.txt`)
  if (!(await access(edit).then(() => true, () => false))) {
    const mainEdit = await access(path.join(input.main, `${input.label}-edit.txt`)).then(() => true, () => false)
    const provider = await control("state")
    throw new Error(
      `Relative edit missing; main checkout has edit=${mainEdit}, worktree status=${await git(input.worktree, "status", "--porcelain=v1", "--untracked-files=all")}; provider=${JSON.stringify(provider.calls)}`,
    )
  }
  expect(await readFile(edit, "utf8")).toContain(`edit-${input.label}`)
  expect(await git(input.worktree, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
    `?? ${input.label}-edit.txt\n?? ${input.label}-shell.txt`,
  )
  expect(await access(path.join(input.main, `${input.label}-shell.txt`)).then(() => true, () => false)).toBe(false)
  expect(await access(path.join(input.main, `${input.label}-edit.txt`)).then(() => true, () => false)).toBe(false)
}

test.beforeEach(async ({ context }) => {
  await control("reset", {})
  await context.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
})

test("creates concurrent New Workspace sessions and runs relative tools only in their real worktrees", async ({
  page,
  context,
}) => {
  const main = await createProject("concurrent-project")
  const checkA = observeRealServer(page)
  await control("hold", { labels: ["alpha", "beta"] })
  await openNewSession(page, main)
  await chooseWorktreeAndModel(page)
  await rm(gateEntered, { force: true })
  await writeFile(gateArmed, "pause first bootstrap")
  const editorA = await submit(page, "E2E_WORKTREE_ALPHA")
  await waitForFile(gateEntered)
  await expect(page.locator('[data-component="prompt-input-v2"]').getByRole("button", { name: "Stop" })).toBeVisible()
  await expect(editorA).toHaveText("E2E_WORKTREE_ALPHA")
  expect((await sessions(main)).data).toHaveLength(0)
  expect(await providerCounts()).toEqual({})
  await releaseBoot()
  await expect(page).toHaveURL(/\/session\/ses_[^/]+$/)
  const idA = sessionID(page)

  const pageB = await context.newPage()
  const checkB = observeRealServer(pageB)
  await openNewSession(pageB, main)
  await chooseWorktreeAndModel(pageB)
  await submit(pageB, "E2E_WORKTREE_BETA")
  await expect(pageB).toHaveURL(/\/session\/ses_[^/]+$/)
  const idB = sessionID(pageB)
  await expect
    .poll(async () => (await control("state")).firstRequests)
    .toEqual(expect.arrayContaining(["alpha", "beta"]))
  await control("release", {})

  await expect(page.getByText("WORKTREE_ALPHA_COMPLETE", { exact: true })).toBeVisible()
  await expect(pageB.getByText("WORKTREE_BETA_COMPLETE", { exact: true })).toBeVisible()
  await expect(page.locator('[data-component="prompt-input-v2"]').getByRole("button", { name: "Send" })).toBeVisible()
  await expect(pageB.locator('[data-component="prompt-input-v2"]').getByRole("button", { name: "Send" })).toBeVisible()

  const [infoA, infoB] = await Promise.all([sessionInfo(idA, main), sessionInfo(idB, main)])
  const worktreeA = infoA.data.location.directory
  const worktreeB = infoB.data.location.directory
  expect(worktreeA).not.toBe(main)
  expect(worktreeB).not.toBe(main)
  expect(worktreeA).not.toBe(worktreeB)
  expect(withinTestRoot(worktreeA)).toBe(true)
  expect(withinTestRoot(worktreeB)).toBe(true)
  expect(await worktrees(main)).toEqual(expect.arrayContaining([worktreeA, worktreeB]))

  await Promise.all([
    assertCompletedSession({ id: idA, main, worktree: worktreeA, prompt: "E2E_WORKTREE_ALPHA", label: "alpha" }),
    assertCompletedSession({ id: idB, main, worktree: worktreeB, prompt: "E2E_WORKTREE_BETA", label: "beta" }),
    assertWorktreeFiles({ main, worktree: worktreeA, label: "alpha" }),
    assertWorktreeFiles({ main, worktree: worktreeB, label: "beta" }),
  ])
  expect(await git(main, "status", "--porcelain=v1", "--untracked-files=all")).toBe("")
  expect(await providerCounts()).toMatchObject({ alpha: 3, beta: 3 })
  expect((await control("state")).models).toMatchObject({ alpha: "test-model", beta: "test-model" })
  const providerCalls = (await control("state")).calls as Array<{ label: string; history: unknown[] }>
  const alphaCalls = providerCalls.filter((call) => call.label === "alpha")
  const betaCalls = providerCalls.filter((call) => call.label === "beta")
  expect(alphaCalls).toHaveLength(3)
  expect(betaCalls).toHaveLength(3)
  const alphaHistory = JSON.stringify(alphaCalls.map((call) => call.history))
  const betaHistory = JSON.stringify(betaCalls.map((call) => call.history))
  for (const call of alphaCalls) {
    expect(JSON.stringify(call.history)).toContain("E2E_WORKTREE_ALPHA")
    expect(JSON.stringify(call.history)).not.toContain("E2E_WORKTREE_BETA")
  }
  for (const call of betaCalls) {
    expect(JSON.stringify(call.history)).toContain("E2E_WORKTREE_BETA")
    expect(JSON.stringify(call.history)).not.toContain("E2E_WORKTREE_ALPHA")
  }
  expect(alphaHistory).toContain(worktreeA)
  expect(alphaHistory).toContain("shell-alpha")
  expect(alphaHistory).not.toContain(worktreeB)
  expect(alphaHistory).not.toContain("shell-beta")
  expect(betaHistory).toContain(worktreeB)
  expect(betaHistory).toContain("shell-beta")
  expect(betaHistory).not.toContain(worktreeA)
  expect(betaHistory).not.toContain("shell-alpha")

  await Promise.all([page.reload(), pageB.reload()])
  await expect(page.getByText("E2E_WORKTREE_ALPHA", { exact: true })).toBeVisible()
  await expect(page.getByText("WORKTREE_ALPHA_COMPLETE", { exact: true })).toBeVisible()
  await expect(pageB.getByText("E2E_WORKTREE_BETA", { exact: true })).toBeVisible()
  await expect(pageB.getByText("WORKTREE_BETA_COMPLETE", { exact: true })).toBeVisible()
  await Promise.all([
    assertCompletedSession({ id: idA, main, worktree: worktreeA, prompt: "E2E_WORKTREE_ALPHA", label: "alpha" }),
    assertCompletedSession({ id: idB, main, worktree: worktreeB, prompt: "E2E_WORKTREE_BETA", label: "beta" }),
  ])
  checkA()
  checkB()
})

test("keeps the first prompt after a failed worktree bootstrap without creating a session", async ({ page }) => {
  const main = await createProject("bootstrap-failure-project")
  const check = observeRealServer(page)
  await openNewSession(page, main)
  await chooseWorktreeAndModel(page)
  await writeFile(failGit, "fail next checkout")
  const editor = await submit(page, "E2E_WORKTREE_GAMMA")
  await waitForFile(failedGit)
  await expect(editor).toHaveText("E2E_WORKTREE_GAMMA")
  await expect(page.getByText(/controlled worktree bootstrap failure/i)).toBeVisible()
  expect((await sessions(main)).data).toHaveLength(0)
  expect(await worktrees(main)).toHaveLength(0)
  expect(await providerCounts()).not.toHaveProperty("gamma")
  check()
})

test("retries the first prompt through the real backend after its first request fails", async ({ page }) => {
  const main = await createProject("prompt-retry-project")
  const check = observeRealServer(page)
  await openNewSession(page, main)
  await chooseWorktreeAndModel(page)
  const prompt = "E2E_WORKTREE_GAMMA"
  const editor = page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
  await editor.fill(prompt)

  let failures = 0
  await page.route(
    (url) =>
      url.origin === backendOrigin &&
      (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname) ||
        /^\/session\/[^/]+\/prompt_async$/.test(url.pathname)),
    async (route) => {
      failures++
      if (failures === 1) {
        await route.abort("failed")
        return
      }
      await route.continue()
    },
  )
  const failedRequest = page.waitForEvent("requestfailed", (request) => {
    const url = new URL(request.url())
    return (
      url.pathname.match(/^\/api\/session\/[^/]+\/prompt$/) !== null ||
      url.pathname.match(/^\/session\/[^/]+\/prompt_async$/) !== null
    )
  })
  await page.locator('[data-component="prompt-input-v2"]').getByRole("button", { name: "Send" }).click()
  await failedRequest
  await expect(editor).toHaveText(prompt)

  await page.locator('[data-component="prompt-input-v2"]').getByRole("button", { name: "Send" }).click()
  await expect(page).toHaveURL(/\/session\/ses_[^/]+$/)
  const id = sessionID(page)
  await expect(page.getByText("WORKTREE_GAMMA_COMPLETE", { exact: true })).toBeVisible()
  const info = await sessionInfo(id, main)
  await assertCompletedSession({ id, main, worktree: info.data.location.directory, prompt, label: "gamma" })
  expect(await worktrees(main)).toHaveLength(1)
  expect(await providerCounts()).toMatchObject({ gamma: 3 })
  expect((await control("state")).models).toMatchObject({ gamma: "test-model" })
  check()
})

test("does not navigate back to a new session when preparation completes after a remount", async ({ page }) => {
  const main = await createProject("navigation-project")
  const check = observeRealServer(page)
  await openNewSession(page, main)
  await chooseWorktreeAndModel(page)
  await rm(gateEntered, { force: true })
  await writeFile(gateArmed, "pause navigation bootstrap")
  await submit(page, "E2E_WORKTREE_GAMMA")
  await waitForFile(gateEntered)
  await page.getByRole("button", { name: "Home", exact: true }).click()
  await releaseBoot()

  let found: { id: string; location: { directory: string } } | undefined
  await expect
    .poll(async () => {
      const directories = await worktrees(main)
      const rows = await Promise.all(directories.map(async (directory) => (await sessions(directory)).data))
      found = rows.flat().find((session) => session.location.directory !== main)
      return found?.id ?? ""
    })
    .not.toBe("")
  await expect(page).not.toHaveURL(/\/session\/ses_[^/]+$/)
  await assertCompletedSession({
    id: found!.id,
    main,
    worktree: found!.location.directory,
    prompt: "E2E_WORKTREE_GAMMA",
    label: "gamma",
  })
  await expect(page).not.toHaveURL(/\/session\/ses_[^/]+$/)
  expect(await providerCounts()).toMatchObject({ gamma: 3 })
  expect((await control("state")).models).toMatchObject({ gamma: "test-model" })
  check()
})
