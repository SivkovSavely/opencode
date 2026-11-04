import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/snapshot-summary?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><output data-testid="file-read-count">0</output><main id="root"></main><script type="module" src="/e2e/fixtures/snapshot-summary.tsx"></script></body></html>',
    }),
  )
  await page.route("**/snapshot-review-v2?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><output data-testid="file-read-count">0</output><main id="root"></main><script type="module" src="/e2e/fixtures/snapshot-review-v2.tsx"></script></body></html>',
    }),
  )
  // Keep the actual panel, tree model, and preview, but never connect their I/O to a running backend.
  await page.route(
    (url) => url.pathname === "/src/context/sdk.tsx",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `export function useSDK() {
        return () => ({ client: { file: { read: async () => {
          const count = document.querySelector('[data-testid="file-read-count"]')
          count.textContent = String(Number(count.textContent) + 1)
          return { data: undefined }
        } } } })
      }`,
      }),
  )
  await page.route(
    (url) => url.pathname === "/src/context/file.tsx",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: "export function useFile() { return { normalize: (path) => path, tree: { state: () => undefined, children: () => [], list() {}, expand() {}, collapse() {} } } }",
      }),
  )
  await page.route(
    (url) => url.pathname === "/src/context/layout.tsx",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: "export function useLayout() { return { ready: () => true } }",
      }),
  )
})

test("historical summaries bound file rows while showing omitted details and full counts", async ({ page }) => {
  await page.goto("/snapshot-summary?fixture=files")
  const review = page.getByRole("region", { name: "Review", exact: true })
  const turn = page.getByRole("region", { name: "Turn", exact: true })
  await expect(review.getByRole("status")).toContainText("203 Changed files")
  await expect(review.getByRole("status")).toContainText("Some change details were omitted")
  await expect(review.getByRole("heading")).toHaveCount(200)
  await expect(turn.getByText("203 Changed files", { exact: true })).toBeVisible()
  await expect(turn.getByRole("status")).toContainText("Some change details were omitted")
  await expect(turn.locator('[data-slot="session-turn-diff-filename"]')).toHaveCount(10)
  await turn.getByText("Show all", { exact: true }).click()
  await expect(turn.locator('[data-slot="session-turn-diff-filename"]')).toHaveCount(200)
  await expect(page.getByText("src/200.ts", { exact: true })).toHaveCount(0)
})

test("aggregate-only summaries show preserved counts without fake file rows or empty states", async ({ page }) => {
  await page.goto("/snapshot-summary?fixture=aggregate")
  const review = page.getByRole("region", { name: "Review", exact: true })
  const turn = page.getByRole("region", { name: "Turn", exact: true })
  await expect(review.getByRole("status")).toContainText("700 Changed files")
  await expect(review.getByRole("status")).toContainText("+21")
  await expect(review.getByRole("status")).toContainText("-13")
  await expect(turn.getByText("700 Changed files", { exact: true })).toBeVisible()
  await expect(turn.getByRole("status")).toContainText("Some change details were omitted")
  await expect(review.locator("[data-file]")).toHaveCount(0)
  await expect(turn.locator('[data-slot="session-turn-diff-filename"]')).toHaveCount(0)
  await expect(page.getByTestId("diff-widget")).toHaveCount(0)
  await expect(page.getByText("No changes", { exact: true })).toHaveCount(0)
})

test("unknown aggregate totals do not claim there are zero changed files", async ({ page }) => {
  await page.goto("/snapshot-summary?fixture=unknown")
  for (const name of ["Review", "Turn"]) {
    const region = page.getByRole("region", { name, exact: true })
    await expect(region).toContainText("Changed files (total unavailable)")
    await expect(region.getByRole("status")).toBeVisible()
    await expect(region.getByRole("status")).toContainText("Some change details were omitted")
    await expect(region.getByText("0 Changed files", { exact: true })).toHaveCount(0)
  }
})

test("oversized patches remain identifiable but never mount a diff widget", async ({ page }) => {
  await page.goto("/snapshot-summary?fixture=patch")
  const review = page.getByRole("region", { name: "Review", exact: true })
  const turn = page.getByRole("region", { name: "Turn", exact: true })
  await expect(review.getByRole("status")).toContainText("1 Changed file")
  await expect(review.getByText("large.ts", { exact: true })).toBeVisible()
  await expect(review.getByText("Patch omitted", { exact: true })).toBeVisible()
  await expect(turn.getByRole("status")).toContainText("Some change details were omitted")
  await turn.getByRole("button", { name: "large.ts", exact: false }).click()
  await expect(turn.getByText("Patch omitted", { exact: true })).toBeVisible()
  await expect(page.getByTestId("diff-widget")).toHaveCount(0)
})

test("content-based V2 review and turn diffs retain the normal rendering path", async ({ page }) => {
  await page.goto("/snapshot-summary?fixture=v2")
  const review = page.getByRole("region", { name: "Review", exact: true })
  const turn = page.getByRole("region", { name: "Turn", exact: true })
  await expect(review.getByRole("heading")).toHaveCount(203)
  await expect(turn.getByText("203 Changed files", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="snapshot-diff-omitted"]')).toHaveCount(0)
  await turn
    .getByRole("button")
    .filter({ has: page.getByText("0.ts", { exact: true }) })
    .click()
  await expect(turn.getByTestId("diff-widget")).toBeVisible()
})

test("known file counts remain visible when summary line statistics are unknown", async ({ page }) => {
  await page.goto("/snapshot-summary?fixture=statistics")
  const review = page.getByRole("region", { name: "Review", exact: true })
  const turn = page.getByRole("region", { name: "Turn", exact: true })
  await expect(review.getByRole("status")).toContainText("1 Changed file")
  await expect(turn.getByText("1 Changed file", { exact: true })).toBeVisible()
  await expect(turn.getByRole("status")).toContainText("Statistics may be incomplete")
  await expect(page.getByText("Changed files (total unavailable)", { exact: true })).toHaveCount(0)
  await expect(page.getByTestId("diff-widget")).toHaveCount(0)
})

for (const layout of ["mobile", "legacy"]) {
  for (const fixture of ["vcs", "files"]) {
    test(`${layout} review tab preserves VCS files but bounds snapshot summaries: ${fixture}`, async ({ page }) => {
      await page.setViewportSize(layout === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 })
      await page.goto(`/snapshot-summary?fixture=${fixture}&layout=${layout}`)
      const review = page.getByRole("region", { name: "Review", exact: true })
      await expect(review.getByRole("heading")).toHaveCount(fixture === "vcs" ? 203 : 200)
      if (fixture === "files") {
        await expect(review.getByRole("status")).toContainText("203 Changed files")
        await expect(review.getByRole("status")).toContainText("Some change details were omitted")
        await expect(review.getByText("200.ts", { exact: true })).toHaveCount(0)
        return
      }
      await expect(review.getByRole("status")).toHaveCount(0)
      const lastFile = review.getByRole("heading").filter({ has: page.getByText("202.ts", { exact: true }) })
      await lastFile.getByRole("button").click()
      await expect(review.getByTestId("diff-widget")).toBeVisible()
    })
  }
}

test("legacy Changes tree scrolls to a named omission without rendering or reading its patch", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/snapshot-summary?fixture=navigation&layout=legacy")
  const review = page.getByRole("region", { name: "Review", exact: true })
  const viewport = review.locator("[data-scrollable]")
  const omissions = review.locator('[data-slot="snapshot-diff-file-omitted"]')
  const target = omissions.filter({ has: page.getByText("omitted-20.png", { exact: true }) })
  await expect(omissions).toHaveCount(40)
  await expect(viewport).toHaveJSProperty("scrollTop", 0)
  await expect(target).not.toBeInViewport()

  await page
    .getByRole("navigation", { name: "Changes", exact: true })
    .getByRole("button", { name: "omitted-20.png", exact: true })
    .click()

  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await expect(target).toBeInViewport({ ratio: 1 })
  await expect
    .poll(() =>
      target.evaluate((el) =>
        Math.abs(el.getBoundingClientRect().top - el.closest("[data-scrollable]")!.getBoundingClientRect().top),
      ),
    )
    .toBeLessThanOrEqual(1)
  await expect(target.getByText("Patch omitted", { exact: true })).toBeVisible()
  await expect(page.getByTestId("diff-widget")).toHaveCount(0)
  await expect(page.getByTestId("file-read-count")).toHaveText("0")
})

test("default review bounds historical summaries before listing files and retains full statistics", async ({
  page,
}) => {
  await page.goto("/snapshot-review-v2?fixture=files")
  const review = page.getByRole("region", { name: "Default Review", exact: true })
  await expect(review.getByText("207 Changed files", { exact: true })).toBeVisible()
  await expect(review.getByRole("status")).toContainText("Some change details were omitted")
  await expect(review.locator('[data-slot="session-review-v2-sidebar-header"]')).toContainText("+207")
  await expect(review.locator('[data-slot="session-review-v2-sidebar-header"]')).toContainText("-207")
  await expect(review.getByTestId("diff-widget")).toBeVisible()
  await review.getByRole("searchbox").fill("200.ts")
  await expect(review.locator('[data-slot="file-tree-v2-row"]')).toHaveCount(0)
  await expect(review.getByText("No file changes", { exact: true })).toHaveCount(0)
})

test("default aggregate-only review preserves totals and does not claim no changes", async ({ page }) => {
  await page.goto("/snapshot-review-v2?fixture=aggregate")
  const review = page.getByRole("region", { name: "Default Review", exact: true })
  await expect(review.getByText("700 Changed files", { exact: true })).toBeVisible()
  await expect(review.getByRole("status")).toContainText("Some change details were omitted")
  await expect(review.locator('[data-slot="session-review-v2-sidebar-header"]')).toContainText("+21")
  await expect(review.locator('[data-slot="session-review-v2-sidebar-header"]')).toContainText("-13")
  await expect(review.locator('[data-slot="file-tree-v2-row"]')).toHaveCount(0)
  await expect(review.getByText("No file changes", { exact: true })).toHaveCount(0)
  await expect(review.getByTestId("diff-widget")).toHaveCount(0)
})

test("default review distinguishes unknown file totals from known counts", async ({ page }) => {
  await page.goto("/snapshot-review-v2?fixture=unknown")
  const review = page.getByRole("region", { name: "Default Review", exact: true })
  await expect(review.getByText("Changed files (total unavailable)", { exact: true })).toBeVisible()
  await expect(review.getByRole("status")).toContainText("Statistics may be incomplete")
  await expect(review.getByText("No file changes", { exact: true })).toHaveCount(0)
})

for (const fixture of ["statistics", "patch"]) {
  test(`default review and direct preview never normalize or read omitted ${fixture} contents`, async ({ page }) => {
    await page.goto(`/snapshot-review-v2?fixture=${fixture}`)
    const review = page.getByRole("region", { name: "Default Review", exact: true })
    const preview = page.getByRole("region", { name: "Direct Preview", exact: true })
    await expect(review.getByText("1 Changed file", { exact: true })).toBeVisible()
    await expect(review.getByText("Patch omitted", { exact: true })).toBeVisible()
    await expect(preview.getByRole("status")).toContainText("Patch omitted")
    await expect(preview.getByRole("status")).toContainText("Statistics may be incomplete")
    await expect(page.getByTestId("diff-widget")).toHaveCount(0)
    await expect(page.getByTestId("detail-load-count")).toHaveText("0")
    await expect(page.getByTestId("file-read-count")).toHaveText("0")
    await expect(page.getByTestId("preview-read-count")).toHaveText("0")
    await expect(review.getByText("No file changes", { exact: true })).toHaveCount(0)
    if (fixture === "statistics") {
      await expect(
        review.locator('[data-slot="session-review-v2-sidebar-header"] [data-component="diff-changes"]'),
      ).toHaveCount(0)
    }
  })
}

for (const fixture of ["v2", "vcs"]) {
  test(`default review preserves ordinary ${fixture} diff rendering and file lists`, async ({ page }) => {
    await page.goto(`/snapshot-review-v2?fixture=${fixture}`)
    const review = page.getByRole("region", { name: "Default Review", exact: true })
    await expect(review.getByTestId("diff-widget")).toBeVisible()
    await expect(review.getByRole("status")).toHaveCount(0)
    await review.getByRole("searchbox").fill("206.ts")
    await expect(review.locator('[data-slot="file-tree-v2-row"]')).toHaveCount(1)
    await review.getByText("206.ts", { exact: true }).click()
    await expect(review.locator('[data-slot="session-review-v2-file-name"]')).toHaveText("206.ts")
    await expect(review.getByTestId("diff-widget")).toBeVisible()
  })
}

test("omitted comment focus releases the default review for tree and next-file navigation without I/O", async ({
  page,
}) => {
  await page.goto("/snapshot-review-v2?fixture=focus")
  const review = page.getByRole("region", { name: "Default Review", exact: true })
  const filename = review.locator('[data-slot="session-review-v2-file-name"]')
  await expect(filename).toHaveText("next.ts")
  await expect(review.getByTestId("diff-widget")).toBeVisible()

  await page.getByRole("button", { name: "Focus omitted comment", exact: true }).click()
  await expect(filename).toHaveText("omitted.png")
  await expect(review.getByText("Patch omitted", { exact: true })).toBeVisible()
  await expect(page.getByTestId("focused-comment")).toHaveText("none")
  const header = review.locator('[data-slot="session-review-v2-file-header"]')
  await expect(header.locator('[data-slot="session-review-v2-file-path"]')).toHaveText("src/")
  await expect(header.locator('[data-slot="session-review-v2-file-status"]')).toHaveAttribute("data-type", "modified")
  await expect(header).toContainText("+8")
  await expect(header).toContainText("-4")
  await expect(review.getByTestId("diff-widget")).toHaveCount(0)
  await review
    .locator('[data-slot="file-tree-v2-row"]')
    .filter({ has: page.getByText("next.ts", { exact: true }) })
    .click()
  await expect(filename).toHaveText("next.ts")
  await expect(review.getByTestId("diff-widget")).toBeVisible()

  await page.getByRole("button", { name: "Focus omitted comment", exact: true }).click()
  await expect(filename).toHaveText("omitted.png")
  await expect(page.getByTestId("focused-comment")).toHaveText("none")
  await review.getByRole("button", { name: "Next file", exact: true }).click()
  await expect(filename).toHaveText("next.ts")
  await expect(review.getByTestId("diff-widget")).toBeVisible()
  await expect(page.getByTestId("detail-load-count")).toHaveText("0")
  await expect(page.getByTestId("file-read-count")).toHaveText("0")
  await expect(page.getByTestId("preview-read-count")).toHaveText("0")
})
