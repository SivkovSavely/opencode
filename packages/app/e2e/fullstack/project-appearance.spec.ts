import { expect, test, type APIRequestContext, type Locator, type Page, type Request } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"

const appearancePath = "/global/project-appearance"
const repoUpdate = /^(?:\/api)?\/project\/[^/]+$/
const pathname = (request: Request) => new URL(request.url()).pathname
const avatar = (row: Locator) => row.locator('[data-slot="project-avatar-surface"]')
const iconFile = {
  name: "appearance.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=",
    "base64",
  ),
}

async function openFolder(page: Page, trigger: Locator, directory: string) {
  await expect(trigger).toBeEnabled()
  await trigger.click()
  const picker = page.getByRole("dialog", { name: "Open project", exact: true })
  const search = picker.getByPlaceholder("Search folders")
  await expect(search).toBeEditable()
  await search.fill(directory)
  const folder = picker.locator(`[data-directory-path="${directory}"]`)
  await expect(folder).toBeVisible()
  await folder.click()
  await expect(picker).toBeHidden()
}

test("keeps project appearance on the exact opened directory, not the shared Git project", async ({
  page,
  browser,
  baseURL,
  request,
}) => {
  const fixture = await mkdtemp(path.join(process.env.OPENCODE_E2E_ROOT!, "appearance-"))
  const root = path.join(fixture, "appearance-repo")
  const left = path.join(root, "left", "app")
  const right = path.join(root, "right", "app")
  const directories = [
    { directory: root, title: "Root session" },
    { directory: right, title: "Right session" },
    { directory: left, title: "Left session" },
  ]
  await Promise.all(
    [left, right].map(async (directory) => {
      await mkdir(directory, { recursive: true })
      // Opening an empty folder from Home can initialize a new Git repo.
      await writeFile(path.join(directory, "fixture.txt"), "Part of the parent repo\n")
    }),
  )
  const git = (args: string[]) => execFileSync(process.env.OPENCODE_E2E_REAL_GIT!, args, { cwd: root, stdio: "pipe" })
  git(["init", "-b", "main"])
  git([
    "-c",
    "user.name=OpenCode E2E",
    "-c",
    "user.email=e2e@opencode.test",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  ])

  const server = (endpoint: string) => new URL(endpoint, process.env.OPENCODE_E2E_SERVER_URL).href
  const current = async (directory: string) => {
    const response = await request.get(server("/project/current"), { params: { directory } })
    await expect(response).toBeOK()
    return response.json()
  }
  const project = await current(root)
  expect(project).toMatchObject({ worktree: root, vcs: "git" })
  expect(project.id).not.toBe("global")
  // Seed inherited appearance through the unchanged repository API.
  const seed = await request.patch(server(`/project/${project.id}`), {
    params: { directory: root },
    data: { icon: { color: "cyan" } },
  })
  await expect(seed).toBeOK()
  const original = await seed.json()
  const repository = async () => {
    const response = await request.get(server("/project"), { params: { directory: root } })
    await expect(response).toBeOK()
    return (await response.json()).find((entry: { id: string }) => entry.id === original.id)
  }
  const sessions = await Promise.all(
    directories.map(async ({ directory, title }) => {
      expect(await current(directory)).toMatchObject({ id: original.id, worktree: root })
      const response = await request.post(server("/session"), { params: { directory }, data: { title } })
      await expect(response).toBeOK()
      const session: { id: string } = await response.json()
      expect(session).toMatchObject({ directory, projectID: original.id, title })
      return { directory, title, href: `/${base64Encode(directory)}/session/${session.id}` }
    }),
  )

  const projectWrites: Request[] = []
  const recordProjectWrites = (request: Request) => {
    if (request.method() === "PATCH" && (pathname(request) === appearancePath || repoUpdate.test(pathname(request)))) {
      projectWrites.push(request)
    }
  }
  const repoWrites = () =>
    projectWrites.filter((request) => repoUpdate.test(pathname(request))).map((request) => request.postDataJSON())
  page.on("request", recordProjectWrites)
  // The old interface otherwise retires on a calendar date, even with its setting enabled.
  await page.clock.setFixedTime(new Date("2026-09-01T12:00:00Z"))
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false } }))
    localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
  })
  await page.goto("/")
  const sidebar = page.locator('[data-component="sidebar-nav-desktop"]')
  const tile = (directory: string) =>
    sidebar.locator(`[data-action="project-switch"][data-project="${base64Encode(directory)}"]`)
  const open = sidebar.getByRole("button", { name: "Open project", exact: true })
  for (const { directory } of directories) {
    await openFolder(page, open, directory)
    await expect(tile(directory)).toBeVisible()
  }

  await page.getByRole("button", { name: "Toggle sidebar", exact: true, expanded: false }).click()
  const leftName = "Left dashboard"
  const rightName = "Right workspace"
  const edit = (page: Page) => page.getByRole("dialog", { name: "Edit project", exact: true })
  const save = (dialog: Locator) => dialog.getByRole("button", { name: "Save", exact: true }).click()
  const openSession = async (session: (typeof sessions)[number]) => {
    const link = sidebar.getByRole("link", { name: session.title, exact: true })
    await expect(link).toHaveAttribute("href", session.href)
    await link.click()
    await expect(page).toHaveURL(session.href)
  }

  await test.step("rename inline and open each directory's own session from the sidebar", async () => {
    await expect(tile(left)).toHaveAccessibleName("app")
    await expect(tile(right)).toHaveAccessibleName("app")
    await openSession(sessions.find((session) => session.directory === left)!)
    const prompt = page.getByRole("main").locator('[data-component="prompt-input"]')
    await expect(prompt).toBeEditable()
    await expect(prompt).toBeFocused()
    const heading = sidebar.getByText("app", { exact: true })
    await expect(heading).toBeVisible()
    await heading.dblclick()
    const input = sidebar.locator('[data-component="inline-input"]')
    await expect(input).toHaveValue("app")
    await expect(input).toBeFocused()
    await input.fill(leftName)
    await input.press("Enter")
    await expect(input).toBeHidden()
    await expect
      .poll(
        () =>
          projectWrites
            .filter((request) => {
              const data = request.postDataJSON()
              return data?.name !== undefined || data?.appearance?.name !== undefined
            })
            .map((request) => ({ path: pathname(request), body: request.postDataJSON() })),
        { message: "inline rename must write the exact directory to project appearance, not the Git project" },
      )
      .toMatchObject([{ path: appearancePath, body: { directory: left, appearance: { name: leftName } } }])
    await expect(tile(left)).toHaveAccessibleName(leftName)
    await expect(tile(right)).toHaveAccessibleName("app")
    await expect(tile(root)).toHaveAccessibleName("appearance-repo")

    for (const session of sessions.toReversed().filter((session) => session.directory !== left)) {
      await tile(session.directory).click()
      await openSession(session)
    }
  })

  await test.step("edit the other child from the legacy dialog without changing repo metadata", async () => {
    await tile(right).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
    const dialog = edit(page)
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(rightName)
    await dialog.getByRole("button", { name: "Select pink color", exact: true }).click()
    await save(dialog)
    await expect(dialog).toBeHidden()
    await expect(tile(right)).toHaveAccessibleName(rightName)
    await expect(tile(left)).toHaveAccessibleName(leftName)
    expect(repoWrites()).toEqual([])
    const project = await repository()
    expect([project.name, project.icon, project.commands]).toEqual([original.name, original.icon, original.commands])
  })

  // Legacy opens are local. Give Home an opened list without copying any appearance or browser state.
  const opened = await request.patch(server("/global/projects"), {
    data: { type: "merge", projects: directories.map(({ directory }) => directory) },
  })
  await expect(opened).toBeOK()
  const homeContext = await browser.newContext({ baseURL, serviceWorkers: "block" })
  try {
    homeContext.on("request", recordProjectWrites)
    await homeContext.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    })
    const home = await homeContext.newPage()
    await home.goto("/")
    const rows = home.locator('[data-component="home-project-row"]')
    const row = (name: string) => rows.filter({ has: home.getByText(name, { exact: true }) })
    const leftRow = row(leftName)
    const rightRow = row(rightName)
    const rootRow = row("appearance-repo")
    const editFromHome = async () => {
      await leftRow.click({ button: "right" })
      await home.getByRole("menuitem", { name: "Edit project", exact: true }).click()
      return edit(home)
    }
    const icon = `data:${iconFile.mimeType};base64,${iconFile.buffer.toString("base64")}`

    await test.step("share icon changes across clients and preserve appearance through reload and reopen", async () => {
      await expect(avatar(rootRow)).toHaveAttribute("data-variant", "cyan")
      await expect(avatar(rightRow)).toHaveAttribute("data-variant", "pink")
      await expect(leftRow).toBeVisible()
      const upload = await editFromHome()
      await upload.locator('input[type="file"]').setInputFiles(iconFile)
      await expect(avatar(upload).locator("img")).toHaveAttribute("src", icon)
      await save(upload)
      await expect(upload).toBeHidden()
      await expect(avatar(leftRow).locator("img")).toHaveAttribute("src", icon)
      await expect(tile(left).locator("img")).toHaveAttribute("src", icon)
      await expect(avatar(rightRow).locator(`img[src="${icon}"]`)).toHaveCount(0)
      await expect(avatar(rootRow).locator(`img[src="${icon}"]`)).toHaveCount(0)

      await home.reload()
      await expect(avatar(leftRow).locator("img")).toHaveAttribute("src", icon)
      await leftRow.click({ button: "right" })
      await home.getByRole("menuitem", { name: "Close", exact: true }).click()
      await expect(leftRow).toHaveCount(0)
      await openFolder(home, home.locator('[data-action="home-add-project"]'), left)
      await expect(avatar(leftRow).locator("img")).toHaveAttribute("src", icon)

      const remove = await editFromHome()
      await remove.getByRole("button", { name: "Project icon", exact: true }).click()
      const variant = (await avatar(leftRow).getAttribute("data-variant")) === "purple" ? "blue" : "purple"
      const color = remove.getByRole("button", { name: `Select ${variant} color`, exact: true })
      await color.click()
      await expect(color).toHaveAttribute("aria-pressed", "true")
      await save(remove)
      await expect(remove).toBeHidden()
      await expect(avatar(leftRow)).toHaveAttribute("data-variant", variant)
      await expect(avatar(leftRow).locator("img")).toHaveCount(0)
      await expect(tile(left).locator(`img[src="${icon}"]`)).toHaveCount(0)
      await expect(avatar(rightRow)).toHaveAttribute("data-variant", "pink")
      await expect(avatar(rootRow)).toHaveAttribute("data-variant", "cyan")

      const leftSession = home.locator('[data-component="home-session-row"]').filter({
        has: home.getByText("Left session", { exact: true }),
      })
      await expect(avatar(leftSession)).toHaveAttribute("data-variant", variant)
      expect(repoWrites(), "appearance-only edits must not call project.update").toEqual([])

      const response = await request.get(server(appearancePath))
      await expect(response).toBeOK()
      expect(await response.json()).toMatchObject({
        revision: expect.any(Number),
        entries: {
          [left]: { name: leftName, icon: null, color: variant },
          [right]: { name: rightName, color: "pink" },
        },
      })
    })

    await test.step("keep the startup command shared without writing appearance to project.update", async () => {
      const dialog = await editFromHome()
      const start = "echo appearance-fixture"
      await dialog.getByPlaceholder("e.g. bun install").fill(start)
      await save(dialog)
      await expect(dialog).toBeHidden()
      expect(repoWrites()).toEqual([{ commands: { start } }])
      expect(await repository()).toMatchObject({ commands: { start } })
      await expect(leftRow).toBeVisible()
      await expect(rightRow).toBeVisible()
    })

    await test.step("inherit shared metadata only for fields without a directory override", async () => {
      const response = await request.patch(server(`/project/${original.id}`), {
        params: { directory: root },
        data: { name: "Shared repo name", icon: { override: icon } },
      })
      await expect(response).toBeOK()
      await expect(row("Shared repo name")).toBeVisible()
      await expect(leftRow).toBeVisible()
      await expect(rightRow).toBeVisible()
      await expect(avatar(leftRow).locator("img")).toHaveCount(0)

      const dialog = await editFromHome()
      await dialog.locator("input[autofocus]").fill("")
      await save(dialog)
      await expect(dialog).toBeHidden()
      await expect(row("app")).toBeVisible()
      await expect(row("Shared repo name")).toBeVisible()
      await expect(rightRow).toBeVisible()

      await row("Shared repo name").click({ button: "right" })
      await home.getByRole("menuitem", { name: "Edit project", exact: true }).click()
      const rootDialog = edit(home)
      await rootDialog.locator("input[autofocus]").fill("Root only")
      await save(rootDialog)
      await expect(row("Root only")).toBeVisible()
      await expect(row("app")).toBeVisible()
      await expect(rightRow).toBeVisible()
      expect(await repository()).toMatchObject({ name: "Shared repo name" })
    })
  } finally {
    await homeContext.close()
  }
})

const originalStart = "echo original"
const editedStart = "echo edited"

async function seedRepositoryStartup(request: APIRequestContext, directory: string) {
  const git = (args: string[]) =>
    execFileSync(process.env.OPENCODE_E2E_REAL_GIT!, args, { cwd: directory, stdio: "pipe" })
  git(["init", "-b", "main"])
  git([
    "-c",
    "user.name=OpenCode E2E",
    "-c",
    "user.email=e2e@opencode.test",
    "commit",
    "--allow-empty",
    "-m",
    path.basename(directory),
  ])
  const server = (endpoint: string) => new URL(endpoint, process.env.OPENCODE_E2E_SERVER_URL).href
  const current = await request.get(server("/project/current"), { params: { directory } })
  await expect(current).toBeOK()
  const project: { id: string } = await current.json()
  expect(project).toMatchObject({ worktree: directory, vcs: "git" })
  const repository = async () => {
    const response = await request.get(server("/project"), { params: { directory } })
    await expect(response).toBeOK()
    return (await response.json()).find((entry: { id: string }) => entry.id === project.id)
  }
  const repoPath = `/project/${project.id}`
  const seeded = await request.patch(server(repoPath), {
    params: { directory },
    data: { commands: { start: originalStart } },
  })
  await expect(seeded).toBeOK()
  return { repository, repoPath }
}

async function loadOpenedHomeProject(page: Page, request: APIRequestContext, directory: string) {
  const opened = await request.patch(new URL("/global/projects", process.env.OPENCODE_E2E_SERVER_URL).href, {
    data: { type: "merge", projects: [directory] },
  })
  await expect(opened).toBeOK()
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  await page.goto("/")
}

async function openHomeProjectEditor(page: Page, name: string) {
  const row = page.locator('[data-component="home-project-row"]').filter({
    has: page.getByText(name, { exact: true }),
  })
  await expect(row).toBeEnabled()
  await row.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Edit project", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Edit project", exact: true })
  const startup = dialog.getByPlaceholder("e.g. bun install")
  const saveButton = dialog.getByRole("button", { name: "Save", exact: true })
  return { row, dialog, startup, saveButton }
}

test("loads, edits, and clears repository startup from fresh Home for a nested folder without sessions", async ({
  page,
  request,
}) => {
  const root = await mkdtemp(path.join(process.env.OPENCODE_E2E_ROOT!, "appearance-startup-"))
  const folder = `${path.basename(root)}-nested`
  const directory = path.join(root, folder)
  await mkdir(directory)
  const { repository, repoPath } = await seedRepositoryStartup(request, root)
  const scopedRequests: Request[] = []
  const repoWrites = () => scopedRequests.filter((request) => request.method() === "PATCH")
  page.on("request", (request) => {
    const scope = new URL(request.url()).searchParams.get("directory") ?? request.headers()["x-opencode-directory"]
    if (scope === directory) scopedRequests.push(request)
  })

  // Seed only the opened list. Don't navigate into the directory or create a session.
  await loadOpenedHomeProject(page, request, directory)
  const appearance = await openHomeProjectEditor(page, folder)
  const renamed = `${folder} renamed`
  await appearance.dialog.getByPlaceholder(folder).fill(renamed)
  await appearance.saveButton.click()
  await expect(appearance.dialog).toBeHidden()
  expect(scopedRequests, "appearance-only save must not boot the nested directory").toEqual([])
  expect(await repository()).toMatchObject({ commands: { start: originalStart } })

  const unchanged = await openHomeProjectEditor(page, renamed)
  await unchanged.startup.click()
  await expect(unchanged.startup).toHaveValue(originalStart)
  await unchanged.saveButton.click()
  await expect(unchanged.dialog).toBeHidden()
  expect(repoWrites()).toEqual([])

  const editor = await openHomeProjectEditor(page, renamed)
  await editor.startup.fill(editedStart)
  await editor.saveButton.click()
  await expect(editor.dialog).toBeHidden()
  expect(await repository()).toMatchObject({ commands: { start: editedStart } })

  const reopened = await openHomeProjectEditor(page, renamed)
  await reopened.startup.click()
  await expect(reopened.startup).toHaveValue(editedStart)
  await reopened.startup.clear()
  await reopened.saveButton.click()
  await expect(reopened.dialog).toBeHidden()
  expect((await repository()).commands?.start ?? "").toBe("")
  expect(repoWrites().map((request) => ({ path: pathname(request), body: request.postDataJSON() }))).toEqual([
    { path: repoPath, body: { commands: { start: editedStart } } },
    { path: repoPath, body: { commands: { start: "" } } },
  ])
})

test("keeps startup edits for non-Git Home folders in the browser cache", async ({ page, request }) => {
  const directory = await mkdtemp(path.join(process.env.OPENCODE_E2E_ROOT!, "appearance-non-git-"))
  const folder = path.basename(directory)
  const repoWrites: Request[] = []
  page.on("request", (request) => {
    if (request.method() === "PATCH" && repoUpdate.test(pathname(request))) repoWrites.push(request)
  })

  await loadOpenedHomeProject(page, request, directory)
  const editor = await openHomeProjectEditor(page, folder)
  await editor.startup.fill(editedStart)
  await editor.saveButton.click()
  await expect(editor.dialog).toBeHidden()

  await page.reload()
  const reopened = await openHomeProjectEditor(page, folder)
  await expect(reopened.startup).toHaveValue(editedStart)
  expect(repoWrites).toHaveLength(0)
})

async function setupProjectEditor(page: Page, request: APIRequestContext) {
  const directory = await mkdtemp(path.join(process.env.OPENCODE_E2E_ROOT!, "appearance-edit-"))
  const { repository, repoPath } = await seedRepositoryStartup(request, directory)

  const startupWrites: unknown[] = []
  const appearanceWrites: Request[] = []
  page.on("request", (request) => {
    if (request.method() !== "PATCH") return
    if (repoUpdate.test(pathname(request))) startupWrites.push(request.postDataJSON())
    if (pathname(request) === appearancePath) appearanceWrites.push(request)
  })
  await loadOpenedHomeProject(page, request, directory)
  const editor = await openHomeProjectEditor(page, path.basename(directory))
  await editor.startup.click()
  await expect(editor.startup).toHaveValue(originalStart)
  await editor.startup.fill(editedStart)
  const upload = async (file: typeof iconFile) => {
    await editor.dialog.locator('input[type="file"]').setInputFiles(file)
    await expect(avatar(editor.dialog).locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/)
  }
  return { ...editor, upload, repository, repoPath, startupWrites, appearanceWrites }
}

test("rejects an oversized project icon before writing appearance or startup", async ({ page, request }) => {
  const editor = await setupProjectEditor(page, request)
  // Six MiB encodes to eight MiB before adding the data URL prefix.
  const buffer = Buffer.alloc(6 * 1024 * 1024)
  iconFile.buffer.copy(buffer)
  await editor.upload({ ...iconFile, buffer })
  await editor.saveButton.click()
  const validation = page.getByText("Project icon is invalid. Try a smaller image.", { exact: true })
  // Wait for either the validation or the legacy remote error before inspecting writes.
  await expect(validation.or(page.getByText(/^Project appearance: HTTP/))).toBeVisible()
  expect(editor.startupWrites).toEqual([])
  expect(editor.appearanceWrites).toHaveLength(0)
  await expect(validation).toBeVisible()
  await expect(editor.dialog).toBeVisible()
  expect(await editor.repository()).toMatchObject({ commands: { start: originalStart } })
})

test("retries a failed appearance save without rewriting startup unless it was reverted", async ({ page, request }) => {
  const editor = await setupProjectEditor(page, request)
  await editor.upload(iconFile)
  let failAppearance = true
  await page.route(`**${appearancePath}`, (route) => {
    if (route.request().method() === "PATCH" && failAppearance) return route.fulfill({ status: 503 })
    return route.continue()
  })

  for (const attempt of [1, 2]) {
    const [failure] = await Promise.all([
      page.waitForResponse((response) => pathname(response.request()) === appearancePath && response.status() === 503),
      editor.saveButton.click(),
    ])
    expect(failure.request().method()).toBe("PATCH")
    await expect(editor.saveButton).toBeEnabled()
    expect
      .soft(editor.startupWrites, `startup write count after appearance attempt ${attempt}`)
      .toEqual([{ commands: { start: editedStart } }])
    expect(await editor.repository()).toMatchObject({ commands: { start: editedStart } })
  }
  await expect.soft(page.getByText("Startup script saved, but project appearance could not be saved.")).toBeVisible()

  failAppearance = false
  await editor.startup.fill(originalStart)
  await editor.saveButton.click()
  await expect(editor.dialog).toBeHidden()
  expect(editor.startupWrites.at(-1)).toEqual({ commands: { start: originalStart } })
  expect(await editor.repository()).toMatchObject({ commands: { start: originalStart } })
  await expect(avatar(editor.row).locator("img")).toHaveAttribute(
    "src",
    `data:${iconFile.mimeType};base64,${iconFile.buffer.toString("base64")}`,
  )
})

test("does not treat an empty startup API response as a successful save", async ({ page, request }) => {
  const editor = await setupProjectEditor(page, request)
  await editor.upload(iconFile)
  await page.route(
    (url) => url.pathname === editor.repoPath || url.pathname === `/api${editor.repoPath}`,
    (route) => {
      if (route.request().method() === "PATCH") return route.fulfill({ status: 204 })
      return route.continue()
    },
  )
  await editor.saveButton.click()
  await expect(page.getByText("Project startup script could not be saved.", { exact: true })).toBeVisible()
  expect(editor.startupWrites).toEqual([{ commands: { start: editedStart } }])
  expect(editor.appearanceWrites).toHaveLength(0)
  await expect(editor.dialog).toBeVisible()
  expect(await editor.repository()).toMatchObject({ commands: { start: originalStart } })
})
