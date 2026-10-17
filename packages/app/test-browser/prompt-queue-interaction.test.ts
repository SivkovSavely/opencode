import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createPromptInputV2Controller } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
import type { PromptInputV2PersistedState } from "@opencode-ai/session-ui/v2/prompt-input/types"

describe("v2 native queue interaction", () => {
  test("context-only drafts are meaningful and queue and steer have distinct actions", () => {
    createRoot((dispose) => {
      const calls: string[] = []
      const store = createStore<PromptInputV2PersistedState>({
        prompt: [],
        cursor: 0,
        context: { items: [{ key: "file", path: "a.ts" }] },
      })
      const controller = createPromptInputV2Controller({
        store,
        commands: () => [],
        context: () => [],
        searchContextFiles: () => [],
        view: {
          submit: {
            stopping: () => false,
            working: () => true,
            onSubmit: () => {
              calls.push("steer")
            },
            onQueue: () => {
              calls.push("queue")
            },
            onStop: () => {
              calls.push("stop")
            },
          },
        },
      })
      expect(controller.canSubmit()).toBe(true)
      controller.queue()
      controller.submit()
      controller.stop()
      expect(calls).toEqual(["queue", "steer", "stop"])
      expect(store[0].context.items).toHaveLength(1)
      dispose()
    })
  })
  test("reserved queue input is intercepted before custom slash selection", () => {
    createRoot((dispose) => {
      const calls: string[] = []
      const store = createStore<PromptInputV2PersistedState>({
        prompt: [{ type: "text", content: "/queue", start: 0, end: 6 }],
        cursor: 6,
        context: { items: [] },
      })
      const controller = createPromptInputV2Controller({
        store,
        commands: () => [{ id: "custom.queue", kind: "command", label: "/queue" }],
        context: () => [],
        searchContextFiles: () => [],
        onSuggestionSelect: () => {
          calls.push("custom")
        },
        view: {
          submit: { stopping: () => false, onSubmit: () => {}, onStop: () => {} },
          onKeyDown: (event) => {
            if (event.key === "Enter") {
              calls.push("native")
              event.preventDefault()
            }
          },
        },
      })
      controller.onInput("/queue")
      expect(controller.onKeyDown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }))).toBe(true)
      expect(calls).toEqual(["native"])
      expect(store[0].prompt[0]).toMatchObject({ content: "/queue" })
      dispose()
    })
  })
})
