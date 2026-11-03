import { describe, expect, test } from "bun:test"
import { promptInputV2Logical, promptInputV2Trigger } from "./logical"
import { createPromptInputV2InteractionState, transitionPromptInputV2 } from "./machine"
import type { PromptInputV2Prompt } from "./types"

const model = { type: "model" as const, content: "@model:p/m", providerID: "p", modelID: "m", start: 0, end: 10 }
const text = (content: string) => ({ type: "text" as const, content, start: 0, end: content.length })

describe("prompt input v2 logical stream", () => {
  test.each(["/review", "$skill", "@model:m"])("finds %s after controls", (value) => {
    const trigger = promptInputV2Trigger([model, text(value)], model.content.length + value.length)
    expect(trigger).toMatchObject({ trigger: value[0], query: value.slice(1), start: model.content.length })
  })

  test("maps interleaved command source spans and preserves literal controls", () => {
    const prompt = [text("/rev"), model, text("iew")]
    expect(promptInputV2Trigger(prompt, 17)).toEqual({ trigger: "/", query: "review", start: 0, end: 17 })
    expect(promptInputV2Logical([text("@model:p/m"), model]).value).toBe("@model:p/m")
  })

  test.each([
    "a@b",
    "\\@model:",
    "\\$skill",
    "$12",
    "pay $2.00",
    "$ARGUMENTS",
    "$SOMETHING",
    "$FOO_42",
    "explain /review",
    "x/$skill",
  ])("ignores %s", (value) => {
    expect(promptInputV2Trigger([text(value)])).toBeUndefined()
  })

  test("mixed-case skill names remain eligible while uppercase placeholders do not", () => {
    expect(promptInputV2Trigger([text("$Review")])).toMatchObject({ trigger: "$", query: "Review" })
    expect(promptInputV2Trigger([text("$rev"), model, text("iew")])).toEqual({
      trigger: "$",
      query: "review",
      start: 0,
      end: 17,
    })
    expect(promptInputV2Trigger([text("$ARG"), model, text("UMENTS")])).toBeUndefined()
  })

  test("maps a namespace and a whitespace-prefixed command through interleaved controls", () => {
    expect(promptInputV2Trigger([text("x @mo"), model, text("del:so")])).toEqual({
      trigger: "@",
      query: "model:so",
      start: 2,
      end: 21,
    })
    expect(promptInputV2Trigger([model, text("  /rev"), model, text("iew")])).toEqual({
      trigger: "/",
      query: "review",
      start: 12,
      end: 29,
    })
  })

  test("ordinary semantic chips are barriers rather than executable text", () => {
    expect(
      promptInputV2Trigger([{ type: "skill", name: "review", content: "$review", start: 0, end: 7 }]),
    ).toBeUndefined()
  })

  test("selecting a namespace keeps an editable scoped popup at the same caret", () => {
    const prompt: PromptInputV2Prompt = [text("before @mo after")]
    const result = transitionPromptInputV2(
      { ...createPromptInputV2InteractionState(), popover: { type: "context", query: "mo" } },
      { type: "popover.select", item: { id: "namespace:model", kind: "namespace", label: "@model:" } },
      { prompt, cursor: 10, context: { items: [] } },
    )
    expect(result.state.popover).toEqual({ type: "context", query: "model:" })
    expect(result.commands[0]).toEqual({ type: "draft.replace", start: 7, end: 10, value: "@model:" })
  })

  test("shell mode and composition do not activate suggestions", () => {
    const shell = { ...createPromptInputV2InteractionState(), mode: "shell" as const }
    expect(
      transitionPromptInputV2(shell, { type: "input.changed", value: "$skill" }, { prompt: [], context: { items: [] } })
        .state.popover.type,
    ).toBe("closed")
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "model:", activeID: "m" },
    }
    expect(
      transitionPromptInputV2(
        state,
        { type: "key.down", key: "Enter", ctrl: false, composing: true, ids: ["m"] },
        { prompt: [], context: { items: [] } },
      ).handled,
    ).toBeFalse()
  })
})
