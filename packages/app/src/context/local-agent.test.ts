import { describe, expect, test } from "bun:test"
import { hasCustomAgent, resolveAgent, resolveChildAgent, resolveChildModel } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
    expect(resolveAgent(agents, "missing")?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})

describe("child session selection", () => {
  const agents = [{ name: "build", mode: "primary" }, { name: "explore", mode: "subagent" }]

  test("resolves the child agent exactly without the root-picker fallback", () => {
    expect(resolveChildAgent(agents, "explore")).toBe(agents[1])
    expect(resolveChildAgent(agents, "missing")).toBeUndefined()
    expect(resolveAgent(agents.filter((item) => item.mode !== "subagent"), "explore")?.name).toBe("build")
  })

  test("uses the model recorded on the child session", () => {
    expect(resolveChildModel({ id: "claude-opus-4-6", providerID: "opencode", variant: "high" })).toEqual({
      modelID: "claude-opus-4-6",
      providerID: "opencode",
      variant: "high",
    })
    expect(resolveChildModel()).toBeUndefined()
  })
})
