import { describe, expect, test } from "bun:test"
import type { ModelPart, Prompt, VariantPart } from "@/context/prompt"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  activePromptSelection,
  commandBody,
  materializePrompt,
  promptTrigger,
  resolvePromptSelection,
  replacePromptTrigger,
  parseQueueCommand,
  contemplatedPromptSelection,
} from "./controls"
import { buildRequestParts } from "./build-request-parts"
import { queuePayload } from "./queue-payload"
import { clonePromptParts, normalizePromptHistoryEntry } from "./history"

const model: ModelPart = { type: "model", providerID: "p", modelID: "m", content: "@model:p/m", start: 0, end: 10 }
const variant: VariantPart = { type: "variant", variant: "high", content: "@variant:high", start: 0, end: 13 }
const text = (content: string) => ({ type: "text" as const, content, start: 0, end: content.length })
const draft = {
  sessionID: "ses_test",
  sessionDirectory: "/repo",
  agent: "build",
  model: { providerID: "base", modelID: "base" },
  context: [],
}

describe("prompt controls", () => {
  test("accepted steers update the current running parent pair without trusting optimistic or child messages", () => {
    const parent = {
      id: "a",
      sessionID: "root",
      role: "user",
      model: { providerID: "p", modelID: "a", variant: "low" },
    } as Extract<Message, { role: "user" }>
    const assistant = {
      id: "assistant-a",
      sessionID: "root",
      role: "assistant",
      parentID: "a",
      providerID: "p",
      modelID: "a",
      time: { created: 2 },
    } as Extract<Message, { role: "assistant" }>
    const steer = { ...parent, id: "b", model: { providerID: "q", modelID: "b", variant: "high" } }
    const optimistic = { ...parent, id: "optimistic", model: { providerID: "wrong", modelID: "wrong" } }
    const child = { ...steer, id: "child", sessionID: "child" }
    const messages = [parent, assistant, steer, optimistic, child]
    const admitted = [
      { id: "a", type: "user" },
      { id: "b", type: "user" },
      { id: "child", type: "user" },
    ]
    expect(activePromptSelection(messages, true, "root", admitted)).toEqual(steer.model)
    expect(activePromptSelection(messages, true, "root", [{ id: "a", type: "user" }])).toEqual(parent.model)
    expect(activePromptSelection(messages, false, "root", admitted)).toBeUndefined()
    expect(
      activePromptSelection(
        [
          ...messages,
          {
            ...assistant,
            id: "assistant-b",
            parentID: "b",
            providerID: "q",
            modelID: "b",
            finish: "stop",
            time: { created: 4, completed: 5 },
          },
        ],
        true,
        "root",
        admitted,
      ),
    ).toBeUndefined()
    expect(
      activePromptSelection(
        [parent, { ...assistant, finish: "stop", time: { created: 2, completed: 3 } }, steer],
        true,
        "root",
        admitted,
      ),
    ).toEqual(steer.model)
  })

  test("contemplated selection respects explicit chips, command defaults, queue fallback, and running steers", () => {
    const base = { providerID: "saved", modelID: "saved", variant: "saved-variant" }
    const active = { providerID: "running", modelID: "running", variant: "running-variant" }
    const commands = [
      { name: "review", model: { providerID: "cmd", id: "cmd" } },
      { name: "skill", source: "skill", model: { providerID: "wrong", id: "wrong" } },
    ]
    const input = { base, active, commands, selection: {} }
    expect(contemplatedPromptSelection({ ...input, text: "hello" })).toEqual(active)
    expect(contemplatedPromptSelection({ ...input, text: " /queue hello" })).toEqual(base)
    expect(contemplatedPromptSelection({ ...input, text: "hello", queue: true })).toEqual(base)
    expect(contemplatedPromptSelection({ ...input, text: "/review args" })).toEqual({
      providerID: "cmd",
      modelID: "cmd",
      variant: "running-variant",
    })
    expect(contemplatedPromptSelection({ ...input, text: "/queue /review args" })).toEqual({
      providerID: "cmd",
      modelID: "cmd",
      variant: "saved-variant",
    })
    expect(
      contemplatedPromptSelection({
        ...input,
        text: "/review args",
        selection: { model: { providerID: "chip", modelID: "chip" }, variant: "explicit" },
      }),
    ).toEqual({ providerID: "chip", modelID: "chip", variant: "explicit" })
    expect(contemplatedPromptSelection({ ...input, text: "/skill args" })).toEqual(active)
  })

  test("contemplated command-agent model defaults do not leak child task models into parent selection", () => {
    const input = {
      base: { providerID: "p", modelID: "saved" },
      active: { providerID: "p", modelID: "running" },
      selection: {},
      agents: [{ name: "reviewer", mode: "primary", model: { providerID: "agent", modelID: "agent" } }],
      commands: [{ name: "review", agent: "reviewer" }],
    }
    expect(contemplatedPromptSelection({ ...input, text: "/review args" })).toMatchObject({
      providerID: "agent",
      modelID: "agent",
    })
    expect(
      contemplatedPromptSelection({
        ...input,
        text: "/review args",
        commands: [{ name: "review", agent: "reviewer", subtask: true }],
      }),
    ).toMatchObject(input.active)
  })
  test("history clones preserve all controls and multiple skills without sharing part objects", () => {
    const prompt: Prompt = [
      model,
      variant,
      { type: "skill", name: "one", content: "$one", start: 23, end: 27 },
      { type: "skill", name: "two", content: "$two", start: 27, end: 31 },
    ]
    const cloned = clonePromptParts(prompt)
    expect(normalizePromptHistoryEntry(cloned).prompt).toEqual(prompt)
    expect(cloned[0]).not.toBe(prompt[0])
    expect(cloned[2]).not.toBe(prompt[2])
  })
  test("elides only structured controls and concatenates surviving bytes exactly", () => {
    const clean = materializePrompt([text("/rev"), model, text("iew  a"), variant, text("\n b @model:literal ")])
    expect(clean.text).toBe("/review  a\n b @model:literal ")
    expect(commandBody(clean.text)).toEqual({ name: "review", arguments: " a\n b @model:literal " })
    expect(clean.selection).toEqual({ model: { providerID: "p", modelID: "m" }, variant: "high" })
    expect(materializePrompt([model, variant]).text).toBe("")
  })

  test("last duplicate controls win without changing surrounding text", () => {
    const clean = materializePrompt([
      model,
      text("a"),
      { ...model, modelID: "new" },
      variant,
      { ...variant, variant: "default" },
      text("b"),
    ])
    expect(clean.text).toBe("ab")
    expect(clean.selection).toEqual({ model: { providerID: "p", modelID: "new" }, variant: "default" })
  })

  test("rebases file and agent offsets into exact control-free text", () => {
    const clean = materializePrompt([
      model,
      text("x"),
      { type: "file", path: "a", content: "@a", start: 11, end: 13 },
      variant,
      { type: "agent", name: "a", content: "@a", start: 26, end: 28 },
    ])
    expect(clean.prompt).toMatchObject([
      { start: 0, end: 1 },
      { start: 1, end: 3 },
      { start: 3, end: 5 },
    ])
  })

  test.each(["/rev", "$rev", "@mo"])("finds %s after and across controls at the caret", (value) => {
    const prompt: Prompt = [model, text(value.slice(0, 2)), variant, text(value.slice(2))]
    expect(promptTrigger(prompt, 23 + value.length)?.query).toBe(value.slice(1))
    expect(promptTrigger(prompt, 23 + value.length - 1)?.query).toBe(value.slice(1, -1))
  })

  test.each([
    "prose /rev",
    "email@host",
    "email$thing",
    "$123",
    "$ARGUMENTS",
    "$VAR_1",
    "\\$skill",
    "\\@model",
    "\\/review",
  ])("ignores non-trigger %s", (value) => {
    expect(promptTrigger([text(value)], value.length)).toBeUndefined()
  })

  test("template placeholders remain literal even when a discovered skill has the same name", () => {
    const clean = materializePrompt([text("$ARGUMENTS $VAR_1")], ["ARGUMENTS", "VAR_1"])
    expect(clean.prompt).toEqual([text("$ARGUMENTS $VAR_1")])
    const selected = { type: "skill" as const, name: "ARGUMENTS", content: "$ARGUMENTS", start: 0, end: 10 }
    expect(materializePrompt([selected], ["ARGUMENTS"]).prompt).toEqual([selected])
  })

  test("only discovered standalone dollar skills become actual local skill parts", () => {
    const clean = materializePrompt([text("$one $two $unknown \\$one user$one $100")], ["one", "two"])
    expect(clean.prompt.filter((part) => part.type === "skill").map((part) => part.name)).toEqual(["one", "two"])
    expect(clean.text).toBe("$one $two $unknown \\$one user$one $100")
    const parts = buildRequestParts({
      prompt: clean.prompt,
      text: clean.text,
      context: [],
      images: [],
      messageID: "msg_test",
      sessionID: "ses_test",
      sessionDirectory: "/repo",
    })
    expect(parts.requestParts.filter((part) => part.type === "file")).toMatchObject([
      { mime: "application/x-opencode-skill", filename: "one", url: "skill:one" },
      { mime: "application/x-opencode-skill", filename: "two", url: "skill:two" },
    ])
  })

  test.each([
    ["Please $review.", ["review"]],
    ["Please ($review).", ["review"]],
    ["$review! $review? $review, $review; $review:", ["review", "review", "review", "review", "review"]],
    ["Please $review.tool.", ["review.tool"]],
    ["$review.tool $review", ["review.tool", "review"]],
    ["$review.other $review-tools $reviewer", []],
    ["\\$review. user$review. $100", []],
    ["$révision.", ["révision"]],
  ])("matches discovered skill names and preserves punctuation in %s", (content, expected) => {
    const clean = materializePrompt([text(content)], ["review", "review.tool", "révision"])
    expect(clean.text).toBe(content)
    expect(clean.prompt.filter((part) => part.type === "skill").map((part) => part.name)).toEqual(expected)
    expect(clean.prompt.map((part) => ("content" in part ? part.content : "")).join("")).toBe(content)
  })

  test("model-only fallback drops unsupported base variant but explicit invalid variant rejects", () => {
    const models = [{ providerID: "p", modelID: "m", variants: ["low"] }]
    const base = { providerID: "base", modelID: "base", variant: "high" }
    expect(resolvePromptSelection(base, { model: { providerID: "p", modelID: "m" } }, models)).toEqual({
      model: { providerID: "p", modelID: "m" },
      variant: undefined,
    })
    expect(resolvePromptSelection(base, { model: { providerID: "p", modelID: "m" }, variant: "high" }, models)).toEqual(
      { error: "prompt.controls.variantUnavailable" },
    )
    expect(
      resolvePromptSelection(base, { model: { providerID: "p", modelID: "m" }, variant: "default" }, models),
    ).toMatchObject({ variant: "default" })
    expect(resolvePromptSelection(base, {}, models)).toEqual({ error: "prompt.controls.modelUnavailable" })
  })

  test("queue captures command defaults then explicit overrides, never active inheritance", async () => {
    const payload = await queuePayload(
      {
        ...draft,
        prompt: [
          text("/rev"),
          model,
          text("iew  a"),
          variant,
          text("\n b"),
          { type: "skill", name: "one/two", content: "$one/two", start: 0, end: 8 },
        ],
      },
      {
        custom: true,
        commands: [{ name: "review", model: { providerID: "cmd", id: "cmd", variant: "low" } }],
      },
    )
    expect(payload).toMatchObject({
      kind: "command",
      command: "review",
      arguments: " a\n b$one/two",
      model: { providerID: "p", modelID: "m" },
      variant: "high",
      selection: { model: { providerID: "p", modelID: "m" }, variant: "high" },
      parts: [{ mime: "application/x-opencode-skill", url: "skill:one%2Ftwo" }],
    })
    expect(await queuePayload({ ...draft, prompt: [text("hi")] })).toMatchObject({ selection: {} })
  })

  test("visible active pair requires a real unfinished assistant and parent, not optimistic busy", () => {
    const parent = { id: "user", role: "user", model: { providerID: "p", modelID: "m", variant: "low" } } as Message
    const assistant = {
      id: "assistant",
      role: "assistant",
      parentID: "user",
      providerID: "p",
      modelID: "m",
      time: { created: 1 },
    } as Extract<Message, { role: "assistant" }>
    expect(activePromptSelection([parent])).toBeUndefined()
    expect(activePromptSelection([assistant])).toBeUndefined()
    expect(activePromptSelection([parent, assistant], true)).toEqual({ providerID: "p", modelID: "m", variant: "low" })
    expect(activePromptSelection([parent, { ...assistant, time: { created: 1, completed: 2 } }])).toBeUndefined()
  })

  test("leading whitespace routes logical commands without changing body bytes or argument delimiters", async () => {
    const clean = materializePrompt([model, text(" \n /rev"), variant, text("iew  a\n b ")])
    expect(clean.text).toBe(" \n /review  a\n b ")
    expect(commandBody(clean.text)).toEqual({ name: "review", arguments: " a\n b " })
    expect(promptTrigger([model, text(" \n /rev")], model.content.length + 7)?.query).toBe("rev")
    const queued = parseQueueCommand(" \n /queue /review   a\n b ")
    expect(queued).toMatchObject({ type: "enqueue", kind: "command", command: "review", arguments: "a\n b" })
    expect(parseQueueCommand("  hello  /queue")).toMatchObject({ type: "enqueue", kind: "prompt", body: "  hello" })
    expect(
      await queuePayload({ ...draft, prompt: [model, text("  /review  a\n b ")] }, { custom: true }),
    ).toMatchObject({ kind: "command", command: "review", arguments: " a\n b " })
  })

  test("discovered skill parsing rejoins text across controls without mutating the input", () => {
    const prompt: Prompt = [text("$my"), model, text("-skill"), variant, text("  $other")]
    const clean = materializePrompt(prompt, ["my-skill", "other"])
    expect(clean.text).toBe("$my-skill  $other")
    expect(clean.prompt.filter((part) => part.type === "skill")).toMatchObject([
      { name: "my-skill", start: 0, end: 9 },
      { name: "other", start: 11, end: 17 },
    ])
    expect(prompt[0]).toMatchObject({ content: "$my" })
  })

  test("skill selection replaces only trigger text and preserves interleaved controls and authored whitespace", () => {
    const prompt: Prompt = [
      text("hello "),
      { type: "file", content: "@file:a", path: "a", start: 6, end: 13 },
      text(" $my"),
      model,
      text("-ski"),
      variant,
      text("ll rest"),
    ]
    const caret =
      prompt.slice(0, -1).reduce((total, part) => total + ("content" in part ? part.content.length : 0), 0) + 2
    const next = replacePromptTrigger(prompt, caret, {
      type: "skill",
      name: "my-skill",
      content: "$my-skill",
      start: 0,
      end: 0,
    })!
    expect(materializePrompt(next.prompt).text).toBe("hello @file:a $my-skill rest")
    expect(
      next.prompt.filter((part) => part.type === "model" || part.type === "variant" || part.type === "file"),
    ).toMatchObject([{ type: "file", path: "a" }, model, variant].map((part) => ({ type: part.type })))
    expect(
      next.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join(""),
    ).toBe("hello   rest")
    expect(next.cursor).toBe("hello @file:a $my-skill".length + model.content.length + variant.content.length)
  })

  test("namespace and slash selection preserve whitespace, attachments, controls, and text after the caret", () => {
    const input: Prompt = [text(" \n @mo"), model, text("del:query tail")]
    const caret = " \n @model:query".length + model.content.length
    const next = replacePromptTrigger(input, caret, { type: "text", content: "@model:", start: 0, end: 0 })!
    expect(materializePrompt(next.prompt).text).toBe(" \n @model: tail")
    expect(next.prompt.some((part) => part.type === "model")).toBe(true)
    const slash = replacePromptTrigger(
      [text("  /rev"), model, text("iew suffix")],
      9 + model.content.length,
      text("/inspect "),
    )!
    expect(materializePrompt(slash.prompt).text).toBe("  /inspect  suffix")
    expect(slash.prompt.some((part) => part.type === "model")).toBe(true)
    expect(
      promptTrigger([{ type: "file", path: "a", content: "@file:a", start: 0, end: 7 }, text("$my")], 10),
    ).toBeUndefined()
  })

  test("selecting another override replaces the old chip and retains canonical identity separately from its display name", () => {
    const next = replacePromptTrigger([model, text(" @model:new")], model.content.length + 11, {
      ...model,
      providerID: "other",
      modelID: "canonical",
      content: "@model:Friendly Name",
    })!
    expect(next.prompt.filter((part) => part.type === "model")).toEqual([
      { ...model, providerID: "other", modelID: "canonical", content: "@model:Friendly Name", start: 1, end: 21 },
    ])
    expect(materializePrompt(next.prompt).selection.model).toEqual({ providerID: "other", modelID: "canonical" })
  })

  test("real active parent selection survives tool continuations, ignores child assistants, and clears on terminal completion or idle", () => {
    const parent = {
      id: "user",
      sessionID: "root",
      role: "user",
      model: { providerID: "p", modelID: "m", variant: "low" },
    } as Message
    const assistant = {
      id: "a",
      sessionID: "root",
      role: "assistant",
      parentID: "user",
      providerID: "p",
      modelID: "m",
      finish: "tool-calls",
      time: { created: 1, completed: 2 },
    } as Extract<Message, { role: "assistant" }>
    const child = { ...assistant, id: "child", sessionID: "child", providerID: "wrong", finish: "stop" }
    expect(activePromptSelection([parent, assistant, child], true, "root")).toEqual({
      providerID: "p",
      modelID: "m",
      variant: "low",
    })
    expect(activePromptSelection([parent, assistant], false, "root")).toBeUndefined()
    expect(
      activePromptSelection([parent, assistant, { ...assistant, id: "done", finish: "stop" }], true, "root"),
    ).toBeUndefined()
    expect(
      activePromptSelection(
        [parent, { ...assistant, error: { name: "UnknownError", data: { message: "failed" } } }],
        true,
        "root",
      ),
    ).toBeUndefined()
    expect(activePromptSelection([parent, child], true, "root")).toBeUndefined()
  })

  describe("stop-finished tool selection lifecycle", () => {
    const base = { providerID: "saved", modelID: "saved-model", variant: "saved-only" }
    const actual = { providerID: "actual", modelID: "actual-model", variant: "actual-only" }
    const parent = {
      id: "user",
      sessionID: "root",
      role: "user",
      model: { providerID: "requested", modelID: "requested-model", variant: "requested-only" },
    } as Extract<Message, { role: "user" }>
    const assistant = {
      id: "assistant",
      sessionID: "root",
      role: "assistant",
      parentID: parent.id,
      ...actual,
      finish: "stop",
      time: { created: 1, completed: 2 },
    } as Extract<Message, { role: "assistant" }>
    const child = { ...assistant, id: "child-assistant", sessionID: "child", providerID: "wrong" }
    const optimistic = { ...parent, id: "optimistic", model: { providerID: "wrong", modelID: "wrong" } }
    const admitted = [{ id: parent.id, type: "user" }]
    const models = [
      { ...base, variants: [base.variant] },
      { ...actual, variants: [actual.variant] },
    ]
    const input = { text: "continue", base, selection: {}, commands: [] }
    const states = [
      { status: "pending", input: {}, raw: "{}" },
      { status: "running", input: {}, time: { start: 2 } },
      { status: "completed", input: {}, output: "done", title: "Read", metadata: {}, time: { start: 2, end: 3 } },
      { status: "error", input: {}, error: "failed", time: { start: 2, end: 3 } },
    ] satisfies Extract<Part, { type: "tool" }>["state"][]
    const tool = {
      id: "tool",
      sessionID: "root",
      messageID: assistant.id,
      type: "tool",
      callID: "call",
      tool: "read",
      state: states[2],
    } satisfies Extract<Part, { type: "tool" }>

    test.each(states)("inherits the actual model and validates its variant with a $status tool", (state) => {
      const parts: Record<string, Part[]> = {
        [assistant.id]: [{ ...tool, state }],
        [child.id]: [{ ...tool, messageID: child.id, sessionID: child.sessionID }],
      }
      const active = activePromptSelection([parent, assistant, optimistic, child], true, "root", admitted, parts)
      expect(active).toEqual(actual)
      expect(contemplatedPromptSelection({ ...input, active })).toEqual(actual)

      const clean = materializePrompt([text("continue"), { ...variant, variant: actual.variant }])
      const execution = contemplatedPromptSelection({ ...input, text: clean.text, selection: clean.selection, active })
      expect(resolvePromptSelection(execution, clean.selection, models)).toEqual({
        model: { providerID: actual.providerID, modelID: actual.modelID },
        variant: actual.variant,
      })
      expect(resolvePromptSelection(base, clean.selection, models)).toEqual({
        error: "prompt.controls.variantUnavailable",
      })
    })

    test.each([
      {
        name: "a provider-executed hosted tool",
        state: states[2],
        metadata: { providerExecuted: true },
      },
      {
        name: "an interrupted orphan tool",
        state: { ...states[3], metadata: { interrupted: true } },
      },
      {
        name: "a StructuredOutput finalizer",
        state: states[2],
        tool: "StructuredOutput",
        structured: {},
      },
    ])("returns persistent selection for $name", ({ state, tool: toolName, metadata, structured }) => {
      const finalized = { ...assistant, ...(structured === undefined ? {} : { structured }) }
      const part = { ...tool, ...(toolName === undefined ? {} : { tool: toolName }), metadata, state }
      const active = activePromptSelection([parent, finalized], true, "root", admitted, { [assistant.id]: [part] })
      expect(active).toBeUndefined()
      expect(contemplatedPromptSelection({ ...input, active })).toEqual(base)
    })

    test("a crash-interrupted tool remains active continuation", () => {
      const state = { ...states[3], metadata: { interrupted: true, crashInterrupted: true } }
      const active = activePromptSelection([parent, assistant], true, "root", admitted, {
        [assistant.id]: [{ ...tool, state }],
      })
      expect(active).toEqual(actual)
    })

    test("an admitted steer wins during the tool boundary while queued prompts retain persistent selection", () => {
      const steer = {
        ...parent,
        id: "steer",
        model: { providerID: "steer", modelID: "steer-model", variant: "steer-only" },
      }
      const childSteer = { ...steer, id: "child-steer", sessionID: "child", model: optimistic.model }
      const active = activePromptSelection(
        [parent, assistant, steer, optimistic, childSteer, child],
        true,
        "root",
        [...admitted, { id: steer.id, type: "user" }, { id: childSteer.id, type: "user" }],
        { [assistant.id]: [tool] },
      )
      expect(active).toEqual(steer.model)
      expect(contemplatedPromptSelection({ ...input, active })).toEqual(steer.model)
      expect(contemplatedPromptSelection({ ...input, active, text: "/queue continue" })).toEqual(base)
      expect(contemplatedPromptSelection({ ...input, active, queue: true })).toEqual(base)
    })

    test.each([
      {
        name: "a later terminal assistant despite old tool parts",
        messages: [parent, assistant, { ...assistant, id: "done" }],
        running: true,
        parts: { [assistant.id]: [tool] },
      },
      {
        name: "a completed assistant without finish or tools",
        messages: [parent, { ...assistant, finish: undefined }],
        running: true,
        parts: {},
      },
      {
        name: "an errored assistant even with tool parts",
        messages: [parent, { ...assistant, error: { name: "UnknownError", data: { message: "failed" } } }],
        running: true,
        parts: { [assistant.id]: [tool] },
      },
      {
        name: "an idle session even with tool parts",
        messages: [parent, assistant],
        running: false,
        parts: { [assistant.id]: [tool] },
      },
      {
        name: "tool parts belonging only to a child assistant",
        messages: [parent, assistant, child],
        running: true,
        parts: { [child.id]: [{ ...tool, messageID: child.id, sessionID: child.sessionID }] },
      },
      {
        name: "tool parts belonging only to an older assistant",
        messages: [parent, { ...assistant, id: "old" }, assistant],
        running: true,
        parts: { old: [{ ...tool, messageID: "old" }] },
      },
      {
        name: "a busy optimistic draft without a real assistant",
        messages: [parent, optimistic],
        running: true,
        parts: { [assistant.id]: [tool] },
      },
    ] satisfies { name: string; messages: Message[]; running: boolean; parts: Record<string, Part[]> }[])(
      "returns persistent selection for $name",
      ({ messages, running, parts }) => {
        const active = activePromptSelection(messages, running, "root", admitted, parts)
        expect(active).toBeUndefined()
        const execution = contemplatedPromptSelection({ ...input, active })
        expect(execution).toEqual(base)
        expect(resolvePromptSelection(execution, input.selection, models)).toEqual({
          model: { providerID: base.providerID, modelID: base.modelID },
          variant: base.variant,
        })
      },
    )
  })
})
