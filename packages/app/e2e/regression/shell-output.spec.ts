import { expect, test } from "@playwright/test"

const source = 'git status --short && printf "%s" "$HOME"; echo "Finished"'
const formatted = 'git status --short \\\n  && printf "%s" "$HOME"; \\\necho "Finished"'

for (const layout of ["false", "true"]) {
  for (const theme of ["light", "dark"]) {
    for (const tool of ["bash", "shell"]) {
      test(`${tool} command and output in ${layout === "true" ? "new" : "legacy"} ${theme} layout`, async ({
        page,
        context,
      }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"])
        await page.goto(
          `/e2e/fixtures/shell-output.html?layout=${layout}&theme=${theme}&tool=${tool}&dir=${theme === "dark" ? "rtl" : "ltr"}`,
        )
        if (layout === "true") await expect(page.locator("body")).toHaveAttribute("data-new-layout", "")
        else await expect(page.locator("body")).not.toHaveAttribute("data-new-layout")
        const wrapper = page.getByRole("region", { name: "Shell tool", exact: true })
        const trigger = wrapper.locator('[data-slot="collapsible-trigger"]')
        await expect(trigger).toHaveAttribute("aria-expanded", "false")
        await expect(wrapper.locator('[data-component="bash-output"]')).toHaveCount(0)
        await trigger.click()
        const command = wrapper.locator('[data-slot="bash-command"] code')
        const output = wrapper.locator('[data-slot="bash-result"] code')
        await expect(command.locator("span")).not.toHaveCount(0)
        await expect(command).toHaveJSProperty("textContent", formatted)
        await expect(output).toHaveJSProperty("textContent", "first\n  next\n")
        await expect(output.locator("span")).toHaveCount(0)
        await expect(wrapper.locator('[data-slot="bash-command"] pre')).toHaveCSS(
          "padding-inline-start",
          theme === "dark" ? "44px" : "12px",
        )
        await expect(wrapper.locator('[data-component="bash-output"]')).toHaveCSS("border-radius", "6px")
        // Fractional border widths can round up; their resolved theme colors identify the active layout rule.
        const borders = await page.evaluate(() => {
          const probe = document.createElement("span")
          document.body.append(probe)
          const colors = ["var(--border-weak-base)", "var(--v2-border-border-base)"].map((color) => {
            probe.style.color = color
            return getComputedStyle(probe).color
          })
          probe.remove()
          return colors
        })
        expect(borders[0]).not.toBe(borders[1])
        await expect(wrapper.locator('[data-component="bash-output"]')).toHaveCSS(
          "border-top-color",
          borders[layout === "true" ? 1 : 0]!,
        )
        expect(
          await output.evaluate((node) =>
            Number.parseFloat(getComputedStyle(node.closest('[data-slot="bash-result"]')!).borderBlockStartWidth),
          ),
        ).toBeGreaterThan(0)
        const colors = await command.evaluate((node) =>
          ["git", "--short", "$HOME", "Finished"].map((text) => {
            const span = Array.from(node.querySelectorAll("span")).find((span) => span.textContent?.includes(text))
            return span ? getComputedStyle(span).color : undefined
          }),
        )
        expect(colors.every((color) => color && color !== "rgba(0, 0, 0, 0)")).toBe(true)
        expect(new Set(colors).size).toBeGreaterThan(2)
        const commandNode = await command.elementHandle()
        const originalSpans = await command.locator("span").all()
        await page.getByRole("textbox", { name: "Output", exact: true }).fill("streaming\n  unchanged whitespace\n")
        await page.getByRole("button", { name: "Complete", exact: true }).click()
        await expect(output).toHaveJSProperty("textContent", "streaming\n  unchanged whitespace\n")
        expect(await command.evaluate((node, original) => node === original, commandNode)).toBe(true)
        await expect(command.locator("span")).toHaveCount(originalSpans.length)
        const copyCommand = wrapper.locator('[data-slot="bash-command"] [data-slot="bash-copy"]').getByRole("button")
        await expect(copyCommand).toHaveAttribute("aria-label", "Copy")
        await copyCommand.focus()
        await copyCommand.press("Enter")
        await expect(copyCommand).toHaveAttribute("aria-label", "Copied")
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source)
        await wrapper.locator('[data-slot="bash-result"]').hover()
        await wrapper
          .locator('[data-slot="bash-result"]')
          .getByRole("button", { name: "Copy response", exact: true })
          .click()
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("streaming\n  unchanged whitespace\n")
        expect(
          await command.evaluate((node) => {
            const range = document.createRange()
            range.selectNodeContents(node)
            const selection = window.getSelection()!
            selection.removeAllRanges()
            selection.addRange(range)
            return selection.toString()
          }),
        ).toBe(formatted)
        await trigger.click()
        await expect(wrapper.locator('[data-component="bash-output"]')).toHaveCount(0)
        await trigger.click()
        await expect(command.locator("span")).not.toHaveCount(0)
        await page.getByRole("button", { name: "Toggle mount", exact: true }).click()
        await expect(trigger).toHaveCount(0)
        await page.getByRole("button", { name: "Toggle mount", exact: true }).click()
        await wrapper.locator('[data-slot="collapsible-trigger"]').click()
        await expect(command.locator("span")).not.toHaveCount(0)
        await expect(command).toHaveJSProperty("textContent", formatted)
      })
    }
  }
}

test("command-only and output-only sections have no divider; missing or unsupported recorded interpreters remain verbatim", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/shell-output.html")
  const wrapper = page.getByRole("region", { name: "Shell tool", exact: true })
  await wrapper.locator('[data-slot="collapsible-trigger"]').click()
  const command = wrapper.locator('[data-slot="bash-command"] code')
  await expect(command.locator("span")).not.toHaveCount(0)
  await page.getByRole("textbox", { name: "Interpreter", exact: true }).fill("")
  await expect(command).toHaveJSProperty("textContent", source)
  await page.getByRole("textbox", { name: "Interpreter", exact: true }).fill("bash")
  await expect(command).toHaveJSProperty("textContent", formatted)
  await page.getByRole("textbox", { name: "Interpreter", exact: true }).fill("pwsh")
  await expect(command).toHaveJSProperty("textContent", source)
  await page.getByRole("textbox", { name: "Output", exact: true }).fill("")
  await expect(wrapper.locator('[data-slot="bash-result"]')).toHaveCount(0)
  await page.getByRole("textbox", { name: "Command", exact: true }).fill("")
  await page.getByRole("textbox", { name: "Output", exact: true }).fill("output only\n")
  await expect(wrapper.locator('[data-slot="bash-command"]')).toHaveCount(0)
  await expect(wrapper.locator('[data-slot="bash-result"]')).toHaveCSS("border-block-start-width", "0px")
})

test("long untrusted commands and output stay selectable, scrollable, and RTL-aware on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/e2e/fixtures/shell-output.html?dir=rtl&lang=ar&theme=dark")
  const wrapper = page.getByRole("region", { name: "Shell tool", exact: true })
  await wrapper.locator('[data-slot="collapsible-trigger"]').click()
  const source = `echo '<img src=x onerror=alert(1)> \u05e9\u05dc\u05d5\u05dd \u0645\u0631\u062d\u0628\u0627 ${"x".repeat(5000)}'`
  const output = Array.from({ length: 500 }, (_, index) => `${index} <script>alert(1)</script>`).join("\n")
  await page.getByRole("textbox", { name: "Command", exact: true }).fill(source)
  await page.getByRole("textbox", { name: "Output", exact: true }).fill(output)
  const command = wrapper.locator('[data-slot="bash-command"] code')
  await expect(command.locator("span")).not.toHaveCount(0)
  await expect(command).toHaveJSProperty("textContent", source)
  await expect(wrapper.locator("img, script")).toHaveCount(0)
  await expect(wrapper.locator('[data-slot="bash-command"] pre')).toHaveCSS("direction", "ltr")
  const scroll = wrapper.locator('[data-slot="bash-scroll"]')
  expect(await scroll.evaluate((node) => node.scrollHeight > node.clientHeight && node.clientHeight <= 240)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await scroll.focus()
  await scroll.press("End")
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  const copy = wrapper.locator('[data-slot="bash-result"] [data-slot="bash-copy"]')
  const result = wrapper.locator('[data-slot="bash-result"]')
  expect(
    await copy.evaluate(
      (node, result) => node.getBoundingClientRect().left < result!.getBoundingClientRect().left + 50,
      await result.elementHandle(),
    ),
  ).toBe(true)
})
