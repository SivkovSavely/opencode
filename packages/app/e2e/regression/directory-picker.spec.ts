import { expect, test } from "@playwright/test"
import { fileNode, mockWorkspace, openSettings } from "../utils/workspace"

test.use({ viewport: { width: 1440, height: 900 } })

test("F017 sibling discovery searches explicit parents without adding until selection and bypasses explicit paths", async ({
  page,
}) => {
  const queries: Array<{ directory?: string; query: string }> = []
  await mockWorkspace(page, {
    name: "Main",
    directory: "/work/spaces/main",
    sessions: [],
    seed: { tabs: [] },
    findFiles: ({ directory, query }) => {
      queries.push({ directory, query })

      return directory === "/work/spaces" && query === "sibling" ? ["/work/spaces/sibling"] : []
    },
    fileList: () => [],
  })
  await page.goto("/")
  const rows = page.locator('[data-component="home-project-row"] [data-slot="home-row-label"]')
  await expect(rows).toHaveText(["Main"])
  await page.getByRole("button", { name: "Add project", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Open project", exact: true })
  const search = picker.getByRole("combobox")
  await search.fill("sibling")
  const sibling = picker.getByRole("option").filter({ hasText: "sibling" })
  await expect(sibling).toBeVisible()
  expect(queries.filter((query) => query.directory === "/work/spaces" && query.query === "sibling")).toHaveLength(1)
  await expect(rows).toHaveText(["Main"])
  queries.splice(0)
  await search.fill("/absolute/unrelated")
  await expect(sibling).toBeHidden()
  expect(queries.filter((query) => query.directory === "/work/spaces")).toEqual([])
  await search.fill("sibling")
  await expect(sibling).toBeVisible()
  await sibling.click()
  await picker.getByRole("button", { name: "Select folder", exact: true }).click()
  await expect(rows).toHaveText(["sibling", "Main"])
})

test("the folder picker's tree scrolls with the mouse wheel inside the modal", async ({ page }) => {
  const directory = "/projects/big"
  let listing = false

  await openSettings(page, {
    name: "Picker",
    directory,
    fileList: () =>
      listing
        ? Array.from({ length: 500 }, (_, index) =>
            fileNode(directory, `dir-${String(index).padStart(3, "0")}`, "directory"),
          )
        : [],
    seed: { tabs: [] },
  })
  await page.getByTestId("settings-screen").getByRole("tab", { name: "Projects", exact: true }).click()
  listing = true
  await page.getByRole("button", { name: "Add project", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Open project", exact: true })

  const scrollTop = () =>
    page.evaluate(
      () =>
        document
          .querySelector(".directory-picker-tree")
          ?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")?.scrollTop,
    )

  await expect.poll(scrollTop).toBe(0)
  const browser = await picker.locator(".directory-picker-browser").boundingBox()
  await page.mouse.move(browser!.x + browser!.width / 2, browser!.y + browser!.height / 2)
  await page.mouse.wheel(0, 300)
  await expect.poll(scrollTop).toBeGreaterThan(0)
})
