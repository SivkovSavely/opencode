import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = process.env.OPENCODE_E2E_ROOT
const baseURL = process.env.OPENCODE_E2E_BASE_URL
if (!root || !baseURL) throw new Error("The isolated full-stack harness must set its root and frontend URL")

const directory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: directory,
  testMatch: "*.spec.ts",
  outputDir: path.join(root, "playwright", "results"),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ["line"],
    ["html", { outputFolder: path.join(root, "playwright", "report"), open: "never" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    serviceWorkers: "block",
    launchOptions: process.env.OPENCODE_E2E_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.OPENCODE_E2E_CHROMIUM_EXECUTABLE }
      : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
})
