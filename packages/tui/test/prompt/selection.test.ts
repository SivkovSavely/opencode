import { expect, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
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
  expect(
    activePromptModel([user, assistant, { ...steer, sessionID: "child" }, continuation], true, ["build"]),
  ).toEqual(user.model)
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
