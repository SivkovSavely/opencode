import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { PromptInputV2PersistedState } from "./types"
import { createPromptInputV2Store } from "./store"

function createPromptStore() {
  return createPromptInputV2Store(
    createStore<PromptInputV2PersistedState>({
      prompt: [
        { type: "text", content: "old", start: 0, end: 3 },
        {
          type: "image",
          id: "attachment-1",
          filename: "notes.txt",
          mime: "text/plain",
          blob: { id: "a", url: "blob:a" },
        },
      ],
      cursor: 3,
      model: { providerID: "anthropic", modelID: "claude-sonnet", variant: null },
      context: { items: [] },
    }),
  )
}

describe("prompt input v2 store", () => {
  test.each([
    { value: "$rev tail", cursor: 4, expected: "$review tail", end: 7 },
    { value: "before $rev!after", cursor: 11, expected: "before $review!after", end: 14 },
    { value: "before $rev", cursor: 11, expected: "before $review", end: 14 },
  ])("inserts skill without changing adjacent characters: $value", ({ value, cursor, expected, end }) => {
    const prompt = createPromptStore()
    prompt.setPrompt([{ type: "text", content: value, start: 0, end: value.length }], cursor)
    prompt.addMention({ type: "skill", name: "review", content: "$review", start: 0, end: 0 })
    expect(prompt.state.prompt.map((part) => ("content" in part ? part.content : "")).join("")).toBe(expected)
    expect(prompt.state.cursor).toBe(end)
    expect(prompt.state.prompt.find((part) => part.type === "skill")).toEqual({
      type: "skill",
      name: "review",
      content: "$review",
      start: end - 7,
      end,
    })
    expect(prompt.undo()).toBeTrue()
    expect(prompt.state.prompt[0]).toEqual({ type: "text", content: value, start: 0, end: value.length })
    expect(prompt.undo(true)).toBeTrue()
    expect(prompt.state.cursor).toBe(end)
  })

  test("skill completion retains interleaved controls and their offsets", () => {
    const prompt = createPromptStore()
    prompt.setPrompt(
      [
        { type: "text", content: "a $rev", start: 0, end: 6 },
        { type: "variant", variant: "default", content: "@v", start: 6, end: 8 },
        { type: "text", content: "iew!", start: 8, end: 12 },
      ],
      11,
    )
    prompt.addMention({ type: "skill", name: "review", content: "$review", start: 0, end: 0 })
    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "a ", start: 0, end: 2 },
      { type: "skill", name: "review", content: "$review", start: 2, end: 9 },
      { type: "variant", variant: "default", content: "@v", start: 9, end: 11 },
      { type: "text", content: "!", start: 11, end: 12 },
    ])
    expect(prompt.state.cursor).toBe(9)
  })

  test("namespace completion keeps an interleaved control and editable literal at the caret", () => {
    const prompt = createPromptStore()
    prompt.setPrompt(
      [
        { type: "text", content: "x @mo", start: 0, end: 5 },
        { type: "variant", variant: "default", content: "@v", start: 5, end: 7 },
        { type: "text", content: "d tail", start: 7, end: 13 },
      ],
      8,
    )
    prompt.replaceRange(2, 8, "@model:")
    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "x ", start: 0, end: 2 },
      { type: "text", content: "@model:", start: 2, end: 9 },
      { type: "variant", variant: "default", content: "@v", start: 9, end: 11 },
      { type: "text", content: " tail", start: 11, end: 16 },
    ])
    expect(prompt.state.cursor).toBe(9)
  })

  test("variant reselection removes only the old variant and preserves adjacent text", () => {
    const prompt = createPromptStore()
    prompt.setPrompt(
      [
        { type: "variant", variant: "old", content: "@old", start: 0, end: 4 },
        { type: "text", content: "a @variant:def!", start: 4, end: 19 },
      ],
      18,
    )
    prompt.addMention({ type: "variant", variant: "default", content: "@default", start: 0, end: 0 })
    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "a ", start: 0, end: 2 },
      { type: "variant", variant: "default", content: "@default", start: 2, end: 10 },
      { type: "text", content: "!", start: 10, end: 11 },
    ])
    expect(prompt.state.cursor).toBe(10)
  })

  test("inserting pasted-looking literal text preserves a neighboring control and offsets", () => {
    const prompt = createPromptStore()
    prompt.setPrompt(
      [
        { type: "model", providerID: "p", modelID: "m", content: "@m", start: 0, end: 2 },
        { type: "text", content: "ab", start: 2, end: 4 },
      ],
      3,
    )
    prompt.addText("$ARGUMENTS\n@model:x/y")
    expect(prompt.state.prompt).toEqual([
      { type: "model", providerID: "p", modelID: "m", content: "@m", start: 0, end: 2 },
      { type: "text", content: "a$ARGUMENTS\n@model:x/yb", start: 2, end: 25 },
    ])
    expect(prompt.state.cursor).toBe(24)
  })
  test.each([0, 2, 4])("inserts controls at position %s without phantom whitespace", (cursor) => {
    const prompt = createPromptStore()
    prompt.setPrompt([{ type: "text", content: "abcd", start: 0, end: 4 }], cursor)
    prompt.addMention({ type: "model", providerID: "p", modelID: "m", content: "@model:p/m", start: 0, end: 0 })
    expect(
      prompt.state.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join(""),
    ).toBe("abcd")
    expect(prompt.state.cursor).toBe(cursor + 10)
    expect(prompt.state.model?.modelID).toBe("claude-sonnet")
    expect(prompt.undo()).toBeTrue()
    expect(prompt.state.prompt).toEqual([{ type: "text", content: "abcd", start: 0, end: 4 }])
    expect(prompt.undo(true)).toBeTrue()
    expect(prompt.state.prompt.some((part) => part.type === "model")).toBeTrue()
  })

  test("reselects a control while retaining all user text and another control", () => {
    const prompt = createPromptStore()
    prompt.setPrompt(
      [
        { type: "model", providerID: "p", modelID: "old", content: "@old", start: 0, end: 4 },
        { type: "text", content: "keep @model:new tail", start: 4, end: 24 },
        { type: "variant", variant: "default", content: "@default", start: 24, end: 32 },
      ],
      19,
    )
    prompt.addMention({ type: "model", providerID: "p", modelID: "new", content: "@new", start: 0, end: 0 })
    expect(prompt.state.prompt.map((part) => ("content" in part ? part.content : "")).join("")).toBe(
      "keep @new tail@default",
    )
    expect(prompt.state.cursor).toBe(9)
    expect(prompt.state.prompt.filter((part) => part.type === "model")).toHaveLength(1)
  })

  test("command replacement retains interleaved controls and file selection metadata", () => {
    const prompt = createPromptStore()
    prompt.setPrompt(
      [
        { type: "text", content: "/rev", start: 0, end: 4 },
        { type: "model", providerID: "p", modelID: "m", content: "@m", start: 4, end: 6 },
        { type: "text", content: "iew suffix", start: 6, end: 16 },
        {
          type: "file",
          path: "f",
          content: "@f",
          start: 16,
          end: 18,
          selection: { startLine: 1, endLine: 3, startChar: 0, endChar: 0 },
        },
      ],
      9,
    )
    prompt.replaceRange(0, 9, "/review ")
    expect(prompt.state.prompt.map((part) => ("content" in part ? part.content : "")).join("")).toBe(
      "/review @m suffix@f",
    )
    expect(prompt.state.prompt.find((part) => part.type === "file")).toMatchObject({
      selection: { startLine: 1, endLine: 3 },
    })
  })

  test("accepts an accessor for the backing store", () => {
    const [state, setState] = createStore<PromptInputV2PersistedState>({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      cursor: 0,
      context: { items: [] },
    })
    const prompt = createPromptInputV2Store([() => state, setState])

    prompt.setText("accessed")

    expect(prompt.state.prompt).toEqual([{ type: "text", content: "accessed", start: 0, end: 8 }])
    expect(prompt.state.cursor).toBe(8)
  })

  test("updates prompt text and cursor together while preserving attachments", () => {
    const prompt = createPromptStore()

    prompt.setText("updated")

    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "updated", start: 0, end: 7 },
      {
        type: "image",
        id: "attachment-1",
        filename: "notes.txt",
        mime: "text/plain",
        blob: { id: "a", url: "blob:a" },
      },
    ])
    expect(prompt.state.cursor).toBe(7)
  })

  test("inserts text without flattening structured mentions", () => {
    const [state, setState] = createStore<PromptInputV2PersistedState>({
      prompt: [
        { type: "text", content: "A ", start: 0, end: 2 },
        { type: "file", path: "one", content: "@one", start: 2, end: 6 },
        { type: "text", content: " B", start: 6, end: 8 },
      ],
      cursor: 2,
      context: { items: [] },
    })
    const prompt = createPromptInputV2Store([state, setState])

    prompt.addText("X\nY")

    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "A X\nY", start: 0, end: 5 },
      { type: "file", path: "one", content: "@one", start: 5, end: 9 },
      { type: "text", content: " B", start: 9, end: 11 },
    ])
    expect(prompt.state.cursor).toBe(5)
  })

  test("mutates context, attachments, and model through shared actions", () => {
    const prompt = createPromptStore()
    const context = { key: "file:src/index.ts", type: "file" as const, path: "src/index.ts" }

    prompt.addContext(context)
    prompt.addContext(context)
    prompt.addMention({ type: "file", path: "src/app.ts", content: "@src/app.ts", start: 0, end: 0 })
    prompt.removeAttachment("attachment-1")
    prompt.setVariant("thinking")

    expect(prompt.state.context.items).toEqual([context])
    expect(prompt.state.prompt).toEqual([
      { type: "text", content: "old", start: 0, end: 3 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 3, end: 14 },
      { type: "text", content: " ", start: 14, end: 15 },
    ])
    expect(prompt.state.model?.variant).toBe("thinking")

    prompt.removeContext(context.key)
    prompt.setPrompt([{ type: "text", content: "old", start: 0, end: 3 }], 3)
    prompt.setModel(undefined)

    expect(prompt.state.context.items).toEqual([])
    expect(prompt.state.prompt).toEqual([{ type: "text", content: "old", start: 0, end: 3 }])
    expect(prompt.state.model).toBeUndefined()
  })

  test("resets the prompt and cursor", () => {
    const prompt = createPromptStore()

    prompt.reset()

    expect(prompt.state.prompt).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(prompt.state.cursor).toBe(0)
  })
})
