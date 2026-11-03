import { expect, test } from "bun:test"
import { QueueCommand } from "@opencode-ai/schema/queue-command"
import type { PromptInfo } from "../../src/prompt/history"
import { parsePromptHistory } from "../../src/prompt/history"
import { promptOffsetWidth } from "../../src/prompt/display"
import { materializePrompt } from "../../src/prompt/materialize"
import { mentionNamespaces, promptTrigger } from "../../src/prompt/trigger"
import { queuePayload, queueSubmissionKey } from "../../src/queue/payload"

const model = { providerID: "provider", modelID: "family/model" }

function control(
  input: string,
  value: string,
): Extract<PromptInfo["parts"][number], { type: "control"; kind: "model" }> {
  const start = promptOffsetWidth(input.slice(0, input.indexOf(value)))
  return { type: "control", kind: "model", model, source: { start, end: start + promptOffsetWidth(value), value } }
}

test("namespaces expose only the supported explicit mention scopes", () => {
  expect(mentionNamespaces).toEqual(["file", "agent", "model", "variant", "reference", "resource"])
  expect(promptTrigger({ input: "@", parts: [] }, 1)).toEqual({ mode: "@", index: 0 })
  expect(promptTrigger({ input: "@mod", parts: [] }, 4)).toEqual({ mode: "@", index: 0 })
})

test.each(["/rev[model]iew args", "[model]/review args", "/review[model] args", "/review args[model]"])(
  "elides exact controls without phantom spaces: %s",
  (input) => {
    const part = control(input, "[model]")
    const prompt = { input, parts: [part] }
    expect(materializePrompt(prompt).input).toBe("/review args")
    expect(materializePrompt(prompt).selection).toEqual({ model })
    expect(parsePromptHistory(JSON.stringify(prompt))[0]).toEqual(prompt)
    expect(prompt).toEqual({ input, parts: [part] })
  },
)

test("raw controls and stale spans remain literal", () => {
  const input = "@model:provider/family/model @variant:high"
  expect(materializePrompt({ input, parts: [] })).toMatchObject({ input, selection: {} })
  expect(materializePrompt({ input: "literal", parts: [control("[model]", "[model]")] })).toMatchObject({
    input: "literal",
    selection: {},
  })
})

test.each(["[model]/rev", "/re[model]v", "/rev[model]"])(
  "command completion follows the logical caret: %s",
  (input) => {
    const prompt = { input, parts: [control(input, "[model]")] }
    const caret = promptOffsetWidth(input)
    const trigger = promptTrigger(prompt, caret)
    expect(trigger?.mode).toBe("/")
    expect(materializePrompt(prompt, trigger!.index).caret).toBe(0)
  },
)

test.each([
  "$100",
  "$ARGUMENTS",
  "echo $ARGUMENTS",
  "price $100",
  "user@example.com",
  "\\@file",
  "\\$skill",
  "\\/review",
  "prose /review",
  "/tmp/file",
])("does not trigger accidental completion: %s", (input) => {
  expect(promptTrigger({ input, parts: [] }, promptOffsetWidth(input))).toBeUndefined()
})

test("skill completion supports multiple skills, and controls before or inside its query", () => {
  for (const input of ["[model]$ski", "$s[model]ki", "$one $ski"]) {
    const parts = input.includes("[model]") ? [control(input, "[model]")] : []
    expect(promptTrigger({ input, parts }, promptOffsetWidth(input))?.mode).toBe("$")
  }
})

test("skill chips materialize as standard markers; old unnamespaced mentions remain readable", () => {
  const prompt: PromptInfo = {
    input: "$日本 @old",
    parts: [
      { type: "skill", name: "日本", source: { start: 0, end: 5, value: "$日本" } },
      { type: "agent", name: "old", source: { start: 6, end: 10, value: "@old" } },
    ],
  }
  expect(materializePrompt(prompt)).toMatchObject({
    input: "$日本 @old",
    parts: [
      { type: "file", mime: "application/x-opencode-skill", filename: "日本", url: "skill:%E6%97%A5%E6%9C%AC" },
      { type: "agent", name: "old", source: { start: 4, end: 8, value: "@old" } },
    ],
  })
})

test("Unicode, paste expansion and control elision rebase protocol offsets before queue fingerprinting", () => {
  const input = "/queue 中文🙂[model][paste] @file:a.ts @agent:explore"
  const start = (value: string) => promptOffsetWidth(input.slice(0, input.indexOf(value)))
  const prompt: PromptInfo = {
    input,
    parts: [
      control(input, "[model]"),
      {
        type: "text",
        text: "展开\ntext",
        source: { text: { start: start("[paste]"), end: start("[paste]") + 7, value: "[paste]" } },
      },
      {
        type: "file",
        mime: "text/plain",
        url: "file:///a.ts",
        source: {
          type: "file",
          path: "a.ts",
          text: { start: start("@file:a.ts"), end: start("@file:a.ts") + 10, value: "@file:a.ts" },
        },
      },
      {
        type: "agent",
        name: "explore",
        source: { start: start("@agent:explore"), end: start("@agent:explore") + 14, value: "@agent:explore" },
      },
    ],
  }
  const result = materializePrompt(prompt)
  expect(result.input).toBe("/queue 中文🙂展开\ntext @file:a.ts @agent:explore")
  const parsed = QueueCommand.parse(result.input, true)
  if (parsed?.type !== "enqueue") throw new Error("Expected enqueue")
  const payload = queuePayload(
    parsed,
    { agent: "build", model, selection: result.selection },
    result.parts,
    result.input,
  )
  if (payload.kind !== "prompt") throw new Error("Expected prompt")
  const text = "中文🙂展开\ntext @file:a.ts @agent:explore"
  expect(payload.parts[0]).toEqual({ type: "text", text })
  expect(payload.parts[1]).toMatchObject({
    source: { text: { start: text.indexOf("@file"), end: text.indexOf("@file") + 10 } },
  })
  expect(payload.parts[2]).toMatchObject({
    source: { start: text.indexOf("@agent"), end: text.indexOf("@agent") + 14 },
  })
  const key = queueSubmissionKey({ payload, front: false })
  expect(queueSubmissionKey({ payload: structuredClone(payload), front: false })).toBe(key)
  expect(queueSubmissionKey({ payload: { ...payload, selection: {} }, front: false })).not.toBe(key)
})
