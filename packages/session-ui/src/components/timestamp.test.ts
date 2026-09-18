import { describe, expect, test } from "bun:test"
import type { ToolState } from "@opencode-ai/sdk/v2"
import { formatTimestamp, formatToolTimestamp } from "./timestamp"

const time = new Date(2026, 0, 2, 19, 44, 37).getTime()

describe("formatTimestamp", () => {
  test("formats local time with seconds and a 24-hour clock", () => {
    expect(formatTimestamp(time, "en-US")).toBe("19:44:37")
  })

  test("does not format a missing timestamp", () => {
    expect(formatTimestamp(undefined, "en-US")).toBe("")
  })
})

describe("formatToolTimestamp", () => {
  test.each(["running", "completed", "error"] as const)("uses the %s tool start time", (status) => {
    const state = {
      status,
      time: { start: time },
    } as ToolState
    expect(formatToolTimestamp(state, "en-US")).toBe("19:44:37")
  })

  test("does not fabricate a timestamp when the tool has no start time", () => {
    expect(formatToolTimestamp({ status: "pending" } as ToolState, "en-US")).toBe("")
    expect(formatToolTimestamp({ status: "running", time: {} } as ToolState, "en-US")).toBe("")
  })
})
