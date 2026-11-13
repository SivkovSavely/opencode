import { afterEach, describe, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"

const require = createRequire(import.meta.resolve("vite-plugin-solid"))
const babel = require("@babel/core")
plugin({
  name: "settings-appearance-solid-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (
        await babel.transformAsync(await Bun.file(path).text(), {
          filename: path,
          presets: [[require.resolve("babel-preset-solid"), { generate: "dom" }]],
          parserOpts: { plugins: ["typescript", "jsx"] },
        })
      ).code,
      loader: "tsx",
    }))
  },
})

const { PlatformProvider } = await import("../src/context/platform")
const { SettingsProvider, useSettings } = await import("../src/context/settings")

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))

async function setup(raw?: string, storage = new Map<string, string>()) {
  if (raw !== undefined) storage.set("default.dat:settings.v3", raw)
  const state: { settings?: ReturnType<typeof useSettings> } = {}
  const host = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: {
          platform: "desktop",
          openExternal() {},
          async openDirectoryPickerDialog() {
            return null
          },
          async restart() {},
          async notify() {},
          storage: (name = "default.dat") => ({
            getItem: async (key) => storage.get(`${name}:${key}`) ?? null,
            setItem: async (key, value) => void storage.set(`${name}:${key}`, value),
            removeItem: async (key) => void storage.delete(`${name}:${key}`),
          }),
        },
        get children() {
          return createComponent(SettingsProvider, {
            get children() {
              state.settings = useSettings()
              return null
            },
          })
        },
      }),
    host,
  )
  cleanup.push(dispose)
  await state.settings!.ready.promise
  return { settings: state.settings!, storage }
}

describe("tab appearance settings", () => {
  test.each([undefined, "{}", '{"appearance":null}'])("defaults missing preferences: %s", async (raw) => {
    const { settings } = await setup(raw)
    expect(settings.appearance.tabPosition()).toBe("top")
    expect(settings.appearance.tabContent()).toBe("one-line")
    expect(settings.appearance.tabSidebarWidth()).toBe(276)
  })

  test.each([
    ["top", "one-line"],
    ["top", "two-line"],
    ["left", "one-line"],
    ["left", "two-line"],
  ])("restores position %s independently of content %s", async (tabPosition, tabContent) => {
    const { settings } = await setup(JSON.stringify({ appearance: { tabPosition, tabContent } }))
    expect(settings.appearance.tabPosition()).toBe(tabPosition)
    expect(settings.appearance.tabContent()).toBe(tabContent)
  })

  test.each([null, false, 2, "", "bottom", [], {}].map((value) => [value]))(
    "defaults invalid tab preferences: %j",
    async (value) => {
      const { settings } = await setup(JSON.stringify({ appearance: { tabPosition: value, tabContent: value } }))
      expect(settings.appearance.tabPosition()).toBe("top")
      expect(settings.appearance.tabContent()).toBe("one-line")
    },
  )

  test.each([
    "null",
    "false",
    '"320"',
    "[]",
    "{}",
    "195",
    "641",
    "-1",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e400",
    "-1e400",
  ])("defaults invalid persisted sidebar width: %s", async (value) => {
    const { settings } = await setup(`{"appearance":{"tabSidebarWidth":${value}}}`)
    expect(settings.appearance.tabSidebarWidth()).toBe(276)
  })

  test.each([196, 276, 412.5, 640])("restores valid sidebar width: %s", async (tabSidebarWidth) => {
    const { settings } = await setup(JSON.stringify({ appearance: { tabSidebarWidth } }))
    expect(settings.appearance.tabSidebarWidth()).toBe(tabSidebarWidth)
  })

  test("can update preferences after restoring a null appearance object", async () => {
    const { settings } = await setup('{"appearance":null}')
    settings.appearance.setTabPosition("left")
    settings.appearance.setTabContent("two-line")
    settings.appearance.setTabSidebarWidth(420)
    expect(settings.appearance.tabPosition()).toBe("left")
    expect(settings.appearance.tabContent()).toBe("two-line")
    expect(settings.appearance.tabSidebarWidth()).toBe(420)
  })

  test("updates position and content independently without resetting the global width", async () => {
    const { settings, storage } = await setup()
    settings.appearance.setTabSidebarWidth(420)
    settings.appearance.setTabContent("two-line")
    expect(settings.appearance.tabPosition()).toBe("top")
    expect(settings.appearance.tabContent()).toBe("two-line")
    settings.appearance.setTabPosition("left")
    expect(settings.appearance.tabPosition()).toBe("left")
    expect(settings.appearance.tabContent()).toBe("two-line")
    settings.appearance.setTabPosition("top")
    expect(settings.appearance.tabContent()).toBe("two-line")
    expect(settings.appearance.tabSidebarWidth()).toBe(420)
    settings.appearance.setTabContent("one-line")
    expect(settings.appearance.tabPosition()).toBe("top")

    const saved = JSON.parse(storage.get("default.dat:settings.v3")!)
    expect(saved.appearance).toMatchObject({ tabPosition: "top", tabContent: "one-line", tabSidebarWidth: 420 })
    const restored = await setup(undefined, storage)
    expect(restored.settings.appearance.tabPosition()).toBe("top")
    expect(restored.settings.appearance.tabContent()).toBe("one-line")
    expect(restored.settings.appearance.tabSidebarWidth()).toBe(420)
  })

  test.each([NaN, Infinity, -Infinity, 195, 641])(
    "never exposes or persists an invalid width write: %s",
    async (value) => {
      const { settings, storage } = await setup()
      settings.appearance.setTabSidebarWidth(400)
      settings.appearance.setTabSidebarWidth(value)
      expect(settings.appearance.tabSidebarWidth()).toBe(276)
      expect(JSON.parse(storage.get("default.dat:settings.v3")!).appearance.tabSidebarWidth).toBe(276)
    },
  )
})
