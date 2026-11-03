import { expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { activePromptModel, contemplatedPromptModel, promptVariant } from "../../src/prompt/selection"

const user: UserMessage = {
  id: "user",
  role: "user",
  sessionID: "session",
  agent: "build",
  time: { created: 1 },
  model: { providerID: "provider", modelID: "one-shot", variant: "high" },
}
const assistant: AssistantMessage = {
  id: "assistant",
  role: "assistant",
  sessionID: "session",
  agent: "build",
  mode: "build",
  parentID: "user",
  modelID: "one-shot",
  providerID: "provider",
  time: { created: 2 },
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

test("active selection uses a real primary execution parent, not optimistic busy or subagent messages", () => {
  expect(activePromptModel([user], true, ["build"])).toBeUndefined()
  expect(activePromptModel([user, assistant], false, ["build"])).toBeUndefined()
  expect(activePromptModel([user, { ...assistant, agent: "explore" }], true, ["build"])).toBeUndefined()
  expect(activePromptModel([user, { ...assistant, summary: true }], true, ["build"])).toBeUndefined()
  expect(activePromptModel([user, { ...assistant, finish: "stop" }], true, ["build"])).toBeUndefined()
  expect(activePromptModel([user, assistant], true, ["build"])).toEqual(user.model)
  expect(
    activePromptModel([user, { ...assistant, finish: "tool-calls", time: { created: 2, completed: 3 } }], true, [
      "build",
    ]),
  ).toEqual(user.model)
})

test("unsupported inherited variants fall back to visible default; explicit invalid variants are rejected", () => {
  expect(promptVariant({ variants: { high: {} } }, undefined, "high")).toEqual({ variant: "high", error: undefined })
  expect(promptVariant({ variants: {} }, undefined, "high")).toEqual({ variant: "default", error: undefined })
  expect(promptVariant({ variants: {} }, "high", "default").error).toContain("high")
  expect(promptVariant({ variants: { high: {} } }, "default", "high")).toEqual({ variant: "default", error: undefined })
})

test("an admitted primary steer replaces the running pair before its assistant arrives", () => {
  const steer: UserMessage = {
    ...user,
    id: "steer",
    time: { created: 3 },
    model: { providerID: "provider", modelID: "B", variant: "low" },
  }
  expect(activePromptModel([user, assistant, steer], true, ["build"])).toEqual(steer.model)
  expect(activePromptModel([user, assistant, steer], false, ["build"])).toBeUndefined()
  expect(activePromptModel([user, steer], true, ["build"])).toBeUndefined()
  expect(activePromptModel([user, { ...assistant, finish: "stop" }, steer], true, ["build"])).toEqual(steer.model)
  expect(activePromptModel([user, { ...assistant, finish: "stop" }], true, ["build"])).toBeUndefined()
  expect(activePromptModel([user, { ...assistant, finish: "stop" }, steer], false, ["build"])).toBeUndefined()
  expect(
    activePromptModel([user, { ...assistant, finish: "stop" }, { ...steer, sessionID: "child" }], true, ["build"]),
  ).toBeUndefined()
  expect(activePromptModel([user, assistant, { ...steer, sessionID: "child" }], true, ["build"])).toEqual(user.model)
  expect(activePromptModel([user, assistant, { ...steer, agent: "explore" }], true, ["build"])).toEqual(user.model)
})

test("an accepted steer survives an assistant created from an older parent snapshot", () => {
  const steer: UserMessage = {
    ...user,
    id: "steer",
    time: { created: 3 },
    model: { providerID: "provider", modelID: "B", variant: "low" },
  }
  const continuation = { ...assistant, id: "continuation", time: { created: 4 } }
  expect(activePromptModel([user, assistant, steer, continuation], true, ["build"])).toEqual(steer.model)
  expect(activePromptModel([user, assistant, { ...steer, sessionID: "child" }, continuation], true, ["build"])).toEqual(
    user.model,
  )
  expect(activePromptModel([user, assistant, steer, continuation], false, ["build"])).toBeUndefined()
})

test("contemplated models apply queue bases, command defaults, then explicit controls", () => {
  const persistent = { providerID: "provider", modelID: "B" }
  const active = { providerID: "provider", modelID: "A" }
  const command = { providerID: "provider", modelID: "command/model" }
  const agent = { providerID: "provider", modelID: "agent" }
  const input = {
    persistent,
    active,
    commands: [
      { name: "review", model: "provider/command/model" },
      { name: "check", agent: "build" },
    ],
    agents: [{ name: "build", model: agent }],
  }
  expect(contemplatedPromptModel({ ...input, text: "@variant:" })).toEqual(active)
  expect(contemplatedPromptModel({ ...input, text: " /queue @variant:" })).toEqual(persistent)
  expect(contemplatedPromptModel({ ...input, text: "/queue /review @variant:" })).toEqual(command)
  expect(contemplatedPromptModel({ ...input, text: " /review @variant:" })).toEqual(command)
  expect(contemplatedPromptModel({ ...input, text: "/queue /check @variant:" })).toEqual(agent)
  expect(contemplatedPromptModel({ ...input, text: "/queue /review @variant:", explicit: active })).toEqual(active)
})

test("stop with tool work retains the actual pair until a terminal response or idle", () => {
  const actual = { providerID: "provider", modelID: "actual", variant: "actual-only" }
  const persistent = { providerID: "provider", modelID: "saved", variant: "saved-only" }
  const step = { ...assistant, ...actual, finish: "stop", time: { created: 2, completed: 3 } }
  const tool: Extract<Part, { type: "tool" }> = {
    id: "tool",
    sessionID: user.sessionID,
    messageID: step.id,
    type: "tool",
    tool: "read",
    callID: "call",
    state: { status: "pending", input: {}, raw: "{}" },
  }
  const states = [
    tool.state,
    { status: "running", input: {}, time: { start: 2 } },
    { status: "completed", input: {}, output: "done", title: "Read", metadata: {}, time: { start: 2, end: 3 } },
    { status: "error", input: {}, error: "failed", time: { start: 2, end: 3 } },
  ] satisfies Extract<Part, { type: "tool" }>["state"][]
  for (const state of states) {
    const active = activePromptModel([user, step], true, ["build"], { [step.id]: [{ ...tool, state }] }, "session")
    expect(active).toEqual(actual)
    expect(promptVariant({ variants: { "actual-only": {} } }, "actual-only", active?.variant).error).toBeUndefined()
    expect(promptVariant({ variants: { "saved-only": {} } }, "actual-only", persistent.variant).error).toBeDefined()
    const input = { persistent, active, commands: [], agents: [] }
    expect(contemplatedPromptModel({ ...input, text: "steer" })).toEqual(actual)
    expect(contemplatedPromptModel({ ...input, text: "/queue separate" })).toEqual(persistent)
  }
  const parts = { [step.id]: [tool] }
  expect(activePromptModel([user, step], false, ["build"], parts, "session")).toBeUndefined()
  expect(activePromptModel([user, step, { ...step, id: "done" }], true, ["build"], parts, "session")).toBeUndefined()
  expect(
    activePromptModel(
      [user, { ...step, error: { name: "UnknownError", data: { message: "failed" } } }],
      true,
      ["build"],
      parts,
      "session",
    ),
  ).toBeUndefined()
  expect(
    activePromptModel([user, { ...assistant, time: { created: 2, completed: 3 } }], true, ["build"]),
  ).toBeUndefined()
  const child = { ...step, id: "child", sessionID: "child" }
  expect(activePromptModel([user, step, child], true, ["build"], parts, "session")).toEqual(actual)
  expect(activePromptModel([user, child], true, ["build"], { child: [tool] }, "session")).toBeUndefined()
  expect(activePromptModel([user, child], true, ["build"], { child: [tool] })).toBeUndefined()
  expect(activePromptModel([user], true, ["build"], parts, "session")).toBeUndefined()
  for (const part of [
    { ...tool, metadata: { providerExecuted: true } },
    {
      ...tool,
      state: {
        status: "error",
        input: {},
        error: "interrupted",
        metadata: { interrupted: true },
        time: { start: 2, end: 3 },
      },
    },
    { ...tool, tool: "StructuredOutput" },
  ] satisfies Part[]) {
    expect(
      activePromptModel([user, { ...step, structured: {} }], true, ["build"], { [step.id]: [part] }, "session"),
    ).toBeUndefined()
  }
  expect(
    activePromptModel([user, step], true, ["build"], {
      [step.id]: [
        {
          ...tool,
          state: {
            status: "error",
            input: {},
            error: "interrupted",
            metadata: { interrupted: true, crashInterrupted: true },
            time: { start: 2, end: 3 },
          },
        },
      ],
    }),
  ).toEqual(actual)
})
