import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { directory, model, project, session, sessionID } from "../performance/timeline-stability/fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"

for (const protocol of ["v1", "v2"] as const) {
  for (const kind of ["command", "prompt"] as const) {
    for (const design of [false, true]) {
      for (const mobile of [false, true]) {
        test(`prompt controls ${protocol} ${kind} ${design ? "v2" : "legacy"} ${mobile ? "mobile" : "desktop"}`, async ({
          page,
        }) => {
          await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 })
          await page.clock.setFixedTime(new Date("2026-09-01T12:00:00Z"))
          const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
          await installSseTransport(page, { server })
          await mockOpenCodeServer(page, {
            protocol,
            directory,
            project: project(),
            sessions: [session()],
            provider: {
              all: [
                {
                  id: "opencode",
                  name: "OpenCode",
                  models: {
                    [model.modelID]: { id: model.modelID, name: "Claude Opus 4.6", limit: { context: 200000 } },
                    alternate: { id: "alternate", name: "Alternate Model", limit: { context: 200000 } },
                  },
                },
              ],
              connected: ["opencode"],
              default: model,
            },
            pageMessages: () => ({ items: [] }),
            sessionStatus: { [sessionID]: { type: "idle" } },
          })
          if (protocol === "v1")
            await page.route(/\/api\/(health|location|model\/default)(?:\?|$)/, (route) =>
              route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" } }),
            )
          const location = { directory, project: { id: project().id, directory } }
          if (protocol === "v2") {
            await page.route(/\/api\/(location|provider|model(?:\/default)?)(?:\?|$)/, (route) => {
              const path = new URL(route.request().url()).pathname
              const models = [
                { id: model.modelID, name: "Claude Opus 4.6" },
                { id: "alternate", name: "Alternate Model" },
              ].map((item) => ({
                ...item,
                providerID: "opencode",
                modelID: item.id,
                api: { id: item.id, type: "native", settings: {} },
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                request: { headers: {}, body: {} },
                variants: [],
                time: { released: 0 },
                cost: [],
                status: "active",
                enabled: true,
                limit: { context: 200000, output: 4096 },
              }))
              const data =
                path === "/api/location"
                  ? location
                  : path === "/api/provider"
                    ? {
                        data: [
                          {
                            id: "opencode",
                            name: "OpenCode",
                            api: { type: "native", settings: {} },
                            request: { headers: {}, body: {} },
                          },
                        ],
                      }
                    : path === "/api/model/default"
                      ? { data: { providerID: "opencode", id: model.modelID } }
                      : { data: models }
              return route.fulfill({ json: data, headers: { "access-control-allow-origin": "*" } })
            })
          }
          await page.route(/\/(?:api\/)?command(?:\?|$)/, (route) =>
            route.fulfill({
              json:
                protocol === "v1"
                  ? [
                      { name: "review", description: "Review changes", template: "review" },
                      { name: "audit", source: "skill", template: "audit" },
                    ]
                  : {
                      location,
                      data: [
                        { name: "review", description: "Review changes", template: "review" },
                        { name: "audit", source: "skill", template: "audit" },
                      ],
                    },
              headers: { "access-control-allow-origin": "*" },
            }),
          )
          await page.route(/\/(?:api\/)?skill(?:\?|$)/, (route) =>
            route.fulfill({
              json:
                protocol === "v1"
                  ? [{ name: "audit", description: "Audit skill", location: "/tmp/audit/SKILL.md" }]
                  : {
                      location,
                      data: [{ name: "audit", description: "Audit skill", location: "/tmp/audit/SKILL.md" }],
                    },
              headers: { "access-control-allow-origin": "*" },
            }),
          )
          await page.route(/\/session\/[^/]+\/(command|prompt|prompt_async)(?:\?|$)/, (route) =>
            route.fulfill({
              json:
                protocol === "v2"
                  ? {
                      data: {
                        admittedSeq: 1,
                        id: "msg_admitted",
                        sessionID,
                        timeCreated: 1,
                        type: "user",
                        data: { text: "" },
                        delivery: "steer",
                      },
                    }
                  : {},
              headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-headers": "*",
                "access-control-allow-methods": "POST, OPTIONS",
              },
            }),
          )
          await page.addInitScript((design) => {
            localStorage.setItem(
              "settings.v3",
              JSON.stringify({ general: { newLayoutDesigns: design, shouldDisplayTabsToast: false } }),
            )
            if (!design) localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
          }, design)
          await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
          const input = page.locator('[data-component="prompt-input"][contenteditable]')
          await expect(input).toBeEditable()
          await expect(page.locator('[data-component="prompt-input-v2"]')).toHaveCount(design ? 1 : 0)
          await input.click()
          await input.pressSequentially("@")
          for (const name of ["file", "agent", "model", "variant", "reference", "resource"]) {
            await expect(page.getByRole("button", { name: `@${name}:`, exact: true })).toBeVisible()
          }
          await input.press("Escape")
          await expect(page.getByRole("button", { name: "@model:", exact: true })).toHaveCount(0)
          await input.press("ArrowLeft")
          await expect(page.getByRole("button", { name: "@model:", exact: true })).toHaveCount(0)
          await input.press("End")
          await input.pressSequentially("mo")
          await expect(page.getByRole("button", { name: "@model:", exact: true })).toBeVisible()
          await input.press("ArrowDown")
          await input.press("Enter")
          await expect(input).toHaveText("@model:")
          await page.getByRole("button", { name: /Alternate Model/ }).click()
          const chip = input.locator(design ? '[data-mention="model"]' : '[data-type="model"]')
          await expect(chip).toHaveCount(1)
          await expect(chip).toHaveAttribute("contenteditable", "false")
          const saved = page.getByRole("button", {
            name: design ? "Claude Opus 4.6" : "Saved: Claude Opus 4.6",
            exact: true,
          })
          await expect(saved).toBeVisible()
          await input.press("Backspace")
          await expect(chip).toHaveCount(0)
          await expect(input).toHaveText("")
          await input.pressSequentially("/")
          await expect(page.getByText("/review", { exact: true })).toBeVisible()
          await expect(page.getByText("/audit", { exact: true })).toHaveCount(0)
          await input.press("Backspace")
          await input.pressSequentially("$")
          await expect(page.getByText(design ? "$audit" : "audit", { exact: true })).toBeVisible()
          await expect(page.getByText("/review", { exact: true })).toHaveCount(0)
          await input.press("ControlOrMeta+A")
          await input.press("Backspace")
          await input.pressSequentially("@mo")
          await page.getByRole("button", { name: "@model:", exact: true }).click()
          await page.getByRole("button", { name: /Alternate Model/ }).click()
          await expect(chip).toHaveCount(1)
          const text = kind === "command" ? "/review exact  words" : "hello exact  words"
          await input.pressSequentially(text)
          await expect(input).toHaveText(`@model:Alternate Model${text}`)
          const request = page.waitForRequest(
            (request) =>
              request.method() === "POST" &&
              new URL(request.url()).pathname ===
                `${protocol === "v2" ? "/api" : ""}/session/${sessionID}/${kind === "command" ? "command" : protocol === "v2" ? "prompt" : "prompt_async"}`,
          )
          await input.press("Enter")
          const body = (await request).postDataJSON()
          if (kind === "command")
            expect(body).toMatchObject({
              command: "review",
              arguments: "exact  words",
              model: protocol === "v1" ? "opencode/claude-opus-4-6" : { providerID: "opencode", id: model.modelID },
              selection: { model: { providerID: "opencode", modelID: "alternate" } },
            })
          if (kind === "prompt" && protocol === "v2")
            expect(body).toMatchObject({
              prompt: {
                text,
                model: { providerID: "opencode", id: model.modelID },
                selection: { model: { providerID: "opencode", modelID: "alternate" } },
              },
            })
          if (kind === "prompt" && protocol === "v1")
            expect(body).toMatchObject({
              parts: [{ type: "text", text }],
              selection: { model: { providerID: "opencode", modelID: "alternate" } },
            })
          await expect(saved).toBeVisible()
        })
      }
    }
  }
}
