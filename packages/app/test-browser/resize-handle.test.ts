import { afterEach, describe, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createComponent, render } from "solid-js/web"
import type { ResizeHandleProps } from "@opencode-ai/ui/resize-handle"

// Use Solid's DOM compiler so these tests exercise the actual component lifecycle.
const require = createRequire(import.meta.resolve("vite-plugin-solid"))
const babel = require("@babel/core")
plugin({
  name: "resize-handle-solid-dom",
  setup(build) {
    build.onLoad({ filter: /\/resize-handle\.tsx$/ }, async ({ path }) => ({
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

const { ResizeHandle } = await import("@opencode-ai/ui/resize-handle")

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))

function setup(props: Partial<ResizeHandleProps> = {}) {
  const [state, setState] = createStore({ visible: true })
  const events: { sizes: number[]; changes: boolean[]; collapses: number } = {
    sizes: [],
    changes: [],
    collapses: 0,
  }
  const userSelect = document.body.style.userSelect
  const overflow = document.body.style.overflow
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(Show, {
        get when() {
          return state.visible
        },
        get children() {
          return createComponent(ResizeHandle, {
            direction: "horizontal",
            size: 240,
            min: 100,
            max: 400,
            onResize: (size) => events.sizes.push(size),
            onCollapseChange: (collapsed) => events.changes.push(collapsed),
            onCollapse: () => events.collapses++,
            ...props,
          })
        },
      }),
    host,
  )
  cleanup.push(() => {
    // Also release listeners from the unfixed implementation after a RED assertion.
    document.dispatchEvent(new MouseEvent("mouseup"))
    dispose()
    host.remove()
    document.body.style.userSelect = userSelect
    document.body.style.overflow = overflow
  })
  const handle = host.querySelector<HTMLElement>('[data-component="resize-handle"]')!
  expect(handle).not.toBeNull()
  return { host, handle, events, hide: () => setState("visible", false), dispose }
}

describe("ResizeHandle drag lifecycle", () => {
  test.each([
    ["", ""],
    ["text", "scroll"],
  ])("unmount restores previous body styles (%j, %j)", (userSelect, overflow) => {
    const { host, handle, hide } = setup()
    document.body.style.userSelect = userSelect
    document.body.style.overflow = overflow
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 }))
    expect(document.body.style.userSelect).toBe("none")
    expect(document.body.style.overflow).toBe("hidden")

    hide()

    expect(host.querySelector('[data-component="resize-handle"]')).toBeNull()
    expect(document.body.style.userSelect).toBe(userSelect)
    expect(document.body.style.overflow).toBe(overflow)
  })

  test("unmount stops resize and collapse-change callbacks on later mousemove", () => {
    const { handle, events, hide } = setup({ collapseThreshold: 150 })
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 }))
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 140 }))
    expect(events).toEqual({ sizes: [280], changes: [], collapses: 0 })

    hide()
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: -100 }))

    expect(events).toEqual({ sizes: [280], changes: [], collapses: 0 })
  })

  test("unmount cancels collapse without committing it on a later mouseup", () => {
    const { handle, events, hide } = setup({ collapseThreshold: 150 })
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 }))
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: -100 }))
    expect(events).toEqual({ sizes: [100], changes: [true], collapses: 0 })

    hide()
    document.dispatchEvent(new MouseEvent("mouseup"))

    expect(events).toEqual({ sizes: [100], changes: [true], collapses: 0 })
  })

  test.each([
    [140, 280, false],
    [-100, 100, true],
  ] as const)("mouseup finishes a drag once (clientX %i)", (clientX, size, collapsed) => {
    const { handle, events, hide, dispose } = setup({ collapseThreshold: 150 })
    document.body.style.userSelect = "text"
    document.body.style.overflow = "scroll"
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 }))
    document.dispatchEvent(new MouseEvent("mousemove", { clientX }))
    document.dispatchEvent(new MouseEvent("mouseup"))

    expect(document.body.style.userSelect).toBe("text")
    expect(document.body.style.overflow).toBe("scroll")
    expect(events).toEqual({ sizes: [size], changes: [collapsed], collapses: collapsed ? 1 : 0 })

    document.body.style.userSelect = "all"
    document.body.style.overflow = "auto"
    document.dispatchEvent(new MouseEvent("mouseup"))
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300 }))
    hide()
    dispose()

    expect(document.body.style.userSelect).toBe("all")
    expect(document.body.style.overflow).toBe("auto")
    expect(events).toEqual({ sizes: [size], changes: [collapsed], collapses: collapsed ? 1 : 0 })
  })

  test("a new drag cancels the previous listeners without losing original body styles", () => {
    const { handle, events } = setup()
    document.body.style.userSelect = "text"
    document.body.style.overflow = "scroll"
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 }))
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 120 }))
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 140 }))
    document.dispatchEvent(new MouseEvent("mouseup"))

    expect(events).toEqual({ sizes: [260], changes: [false], collapses: 0 })
    expect(document.body.style.userSelect).toBe("text")
    expect(document.body.style.overflow).toBe("scroll")
  })

  test.each([1, 2])("button %i does not start a drag", (button) => {
    const { handle, events } = setup()
    document.body.style.userSelect = "text"
    document.body.style.overflow = "scroll"
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button, clientX: 100 }))
    expect(document.body.style.userSelect).toBe("text")
    expect(document.body.style.overflow).toBe("scroll")

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 140 }))
    document.dispatchEvent(new MouseEvent("mouseup"))

    expect(events).toEqual({ sizes: [], changes: [], collapses: 0 })
  })
})
