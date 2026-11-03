import { describe, expect, test } from "bun:test"
import type { PromptInputV2PersistedState, PromptInputV2Suggestion } from "./types"
import { createPromptInputV2InteractionState, transitionPromptInputV2 } from "./machine"

const command: PromptInputV2Suggestion = {
  id: "review",
  kind: "command",
  label: "/review",
}

function persisted(value = ""): PromptInputV2PersistedState {
  return {
    prompt: [{ type: "text", content: value, start: 0, end: value.length }],
    cursor: value.length,
    context: { items: [] },
  }
}

describe("prompt input v2 interaction machine", () => {
  test("ArrowDown keydown and unchanged-caret keyup retain the active namespace", () => {
    const input = persisted("@")
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "@", persist: false },
      input,
    )
    const results = transitionPromptInputV2(
      open.state,
      { type: "popover.results", ids: ["file", "agent", "model"] },
      input,
    )
    const down = transitionPromptInputV2(
      results.state,
      { type: "key.down", key: "ArrowDown", ctrl: false, composing: false, ids: ["file", "agent", "model"] },
      input,
    )
    expect(down.state.popover).toMatchObject({ type: "context", activeID: "agent" })
    const keyup = transitionPromptInputV2(down.state, { type: "cursor.changed", cursor: 1 }, input)
    expect(keyup.state).toBe(down.state)
    expect(keyup.commands).toEqual([])
  })

  test("Escape keydown and unchanged-caret keyup leave the popup closed", () => {
    const input = persisted("@")
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "@", persist: false },
      input,
    )
    const escape = transitionPromptInputV2(
      open.state,
      { type: "key.down", key: "Escape", ctrl: false, composing: false, ids: ["file"] },
      input,
    )
    expect(escape.state.popover).toEqual({ type: "closed" })
    const keyup = transitionPromptInputV2(escape.state, { type: "cursor.changed", cursor: 1 }, input)
    expect(keyup.state.popover).toEqual({ type: "closed" })
    expect(keyup.commands).toEqual([])
  })

  test("actual caret movement redetects a trigger, but the following keyup does not reset it", () => {
    const input = persisted("@mo tail")
    const move = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "cursor.changed", cursor: 3 },
      input,
    )
    expect(move.state.popover).toEqual({ type: "context", query: "mo" })
    input.cursor = 3
    expect(transitionPromptInputV2(move.state, { type: "cursor.changed", cursor: 3 }, input).commands).toEqual([])
    const leave = transitionPromptInputV2(move.state, { type: "cursor.changed", cursor: 8 }, input)
    expect(leave.state.popover).toEqual({ type: "closed" })
  })

  test("text committed after dismissal still updates suggestions with an unchanged caret", () => {
    const input = persisted("@model:")
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "@model:", persist: false },
      input,
    )
    expect(result.state.popover).toEqual({ type: "context", query: "model:" })
    expect(result.commands).toContainEqual({ type: "popover.filter", popover: "context", query: "model:" })
  })
  test("completes a whitespace-prefixed command after and across controls using source offsets", () => {
    const input: PromptInputV2PersistedState = {
      prompt: [
        { type: "model", providerID: "p", modelID: "m", content: "@m", start: 0, end: 2 },
        { type: "text", content: "  /rev", start: 2, end: 8 },
        { type: "variant", variant: "default", content: "@v", start: 8, end: 10 },
        { type: "text", content: "iew suffix", start: 10, end: 20 },
      ],
      cursor: 13,
      context: { items: [] },
    }
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "", persist: false },
      input,
    )
    expect(open.state.popover).toEqual({ type: "command-inline", query: "review" })
    const selected = transitionPromptInputV2(open.state, { type: "popover.select", item: command }, input)
    expect(selected.commands[0]).toEqual({ type: "draft.replace", start: 4, end: 13, value: "/review " })
  })

  test("skill and namespace popovers use the logical query across controls", () => {
    const model = { type: "model" as const, providerID: "p", modelID: "m", content: "@m", start: 3, end: 5 }
    const input: PromptInputV2PersistedState = {
      prompt: [
        { type: "text", content: "$re", start: 0, end: 3 },
        model,
        { type: "text", content: "v", start: 5, end: 6 },
      ],
      cursor: 6,
      context: { items: [] },
    }
    const state = createPromptInputV2InteractionState()
    expect(
      transitionPromptInputV2(state, { type: "input.changed", value: "", persist: false }, input).state.popover,
    ).toEqual({ type: "context", query: "$rev" })
    input.prompt = [
      { type: "text", content: "@mo", start: 0, end: 3 },
      model,
      { type: "text", content: "d", start: 5, end: 6 },
    ]
    const open = transitionPromptInputV2(state, { type: "input.changed", value: "", persist: false }, input)
    expect(open.state.popover).toEqual({ type: "context", query: "mod" })
    const selected = transitionPromptInputV2(
      open.state,
      { type: "popover.select", item: { id: "namespace:model", kind: "namespace", label: "@model:" } },
      input,
    )
    expect(selected.commands[0]).toEqual({ type: "draft.replace", start: 0, end: 6, value: "@model:" })
  })
  test("opens inline commands only when slash is the entire prompt", () => {
    const state = createPromptInputV2InteractionState()
    const open = transitionPromptInputV2(state, { type: "input.changed", value: "/re" }, persisted())
    const closed = transitionPromptInputV2(state, { type: "input.changed", value: "explain /re" }, persisted())

    expect(open.state.popover).toEqual({ type: "command-inline", query: "re" })
    expect(closed.state.popover).toEqual({ type: "closed" })
  })

  test("completes nested slash command names", () => {
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "/review/" },
      persisted(),
    )
    const item = { ...command, label: "/review/nested" }
    const selected = transitionPromptInputV2(open.state, { type: "popover.select", item }, persisted("/review/"))

    expect(open.state.popover).toEqual({ type: "command-inline", query: "review/" })
    expect(selected.commands).toContainEqual({ type: "draft.replace", start: 0, end: 8, value: "/review/nested " })
  })

  test("opens context completion at the cursor", () => {
    const value = "alpha @sr omega"
    const input = persisted(value)
    input.cursor = 9

    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value, persist: false },
      input,
    )

    expect(result.state.popover).toEqual({ type: "context", query: "sr" })
  })

  test("enters shell mode from an initial exclamation mark", () => {
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "!", persist: false },
      persisted("!"),
    )

    expect(result.state.mode).toBe("shell")
    expect(result.commands).toContainEqual({ type: "draft.setText", value: "" })
  })

  test("leaves shell mode with escape", () => {
    const state = { ...createPromptInputV2InteractionState(), mode: "shell" as const }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Escape", ctrl: false, composing: false, ids: [] },
      persisted(),
    )

    expect(result.state.mode).toBe("normal")
    expect(result.handled).toBeTrue()
  })

  test("leaves shell mode with backspace when empty", () => {
    const state = { ...createPromptInputV2InteractionState(), mode: "shell" as const }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Backspace", ctrl: false, composing: false, ids: [], empty: true },
      persisted(),
    )

    expect(result.state.mode).toBe("normal")
    expect(result.handled).toBeTrue()
  })

  test("closes a popover with ctrl-g before stopping a run", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "", activeID: "first" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "g", ctrl: true, composing: false, ids: ["first"] },
      persisted(),
    )

    expect(result.state.popover).toEqual({ type: "closed" })
    expect(result.handled).toBeTrue()
  })

  test("opens the searchable command menu for a populated draft", () => {
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "commands.open" },
      persisted("existing text"),
    )

    expect(result.state.popover).toEqual({ type: "command-menu", query: "" })
    expect(result.state.focus).toBe("command-search")
  })

  test("prepends a menu command and preserves existing text as arguments", () => {
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "commands.open" },
      persisted("existing text"),
    )
    const selected = transitionPromptInputV2(
      open.state,
      { type: "popover.select", item: command },
      persisted("existing text"),
    )

    expect(selected.commands).toContainEqual({ type: "draft.replace", start: 0, end: 0, value: "/review " })
    expect(selected.state.popover).toEqual({ type: "closed" })
  })

  test("stores selected context files as prompt file parts", () => {
    const item: PromptInputV2Suggestion = {
      id: "src/index.ts",
      kind: "file",
      label: "index.ts",
      path: "src/index.ts",
    }
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "index" },
    }

    const selected = transitionPromptInputV2(state, { type: "popover.select", item }, persisted("@index"))

    expect(selected.commands).toContainEqual({ type: "mention.add", item })
  })

  test("loops active popover items with arrow keys", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "", activeID: "second" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "ArrowDown", ctrl: false, composing: false, ids: ["first", "second"] },
      persisted(),
    )

    expect(result.state.popover).toEqual({ type: "context", query: "", activeID: "first" })
    expect(result.handled).toBeTrue()
  })
})
