import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { formatRawToolValue, rawToolRequest, rawToolResponse } from "./raw-tool-details"

function part(state: unknown, tool = "custom") {
  return {
    id: "call_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool,
    state,
  } as ToolPart
}

describe("raw tool details", () => {
  test("formats complete objects without reducing their fields", () => {
    expect(formatRawToolValue({ path: "/repo", pattern: "*.ts", include: "src/**" })).toBe(
      '{\n  "path": "/repo",\n  "pattern": "*.ts",\n  "include": "src/**"\n}',
    )
  })

  test("preserves strings verbatim and handles pending calls", () => {
    const pending = part({ status: "pending", input: {}, raw: '{"patterns":["**/*.ts"]}' })
    expect(rawToolRequest(pending)).toEqual({ patterns: ["**/*.ts"] })
    expect(rawToolResponse(pending)).toBeUndefined()
    expect(formatRawToolValue("  raw\ntext  ")).toBe("  raw\ntext  ")
  })

  test("prefers a provider result and keeps structured local results", () => {
    const provider = part({
      status: "completed",
      input: { query: "foo" },
      output: "ignored",
      metadata: {
        __opencode_raw_tool_details: {
          providerExecuted: true,
          hasResult: true,
          result: { type: "json", value: { matches: 2 } },
        },
      },
    })
    expect(rawToolResponse(provider)?.value).toEqual({ type: "json", value: { matches: 2 } })

    const local = part({
      status: "completed",
      input: { pattern: "foo" },
      output: "match",
      metadata: {
        __opencode_raw_tool_details: {
          providerExecuted: false,
          hasStructured: true,
          structured: { count: 1 },
          hasContent: true,
          content: [{ type: "text", text: "match" }],
        },
      },
    })
    expect(rawToolResponse(local)?.value).toEqual({
      structured: { count: 1 },
      content: [{ type: "text", text: "match" }],
    })
  })

  test("keeps error and attachment metadata inspectable", () => {
    const failed = part({
      status: "error",
      input: { path: "/repo" },
      error: "failed",
      metadata: {
        __opencode_raw_tool_details: {
          providerExecuted: false,
          hasError: true,
          error: { type: "unknown", message: "failed" },
          hasContent: true,
          content: [{ type: "file", name: "result.txt", mime: "text/plain", uri: "data:huge" }],
          attachments: [{ name: "result.txt", mime: "text/plain" }],
        },
      },
    })
    expect(rawToolResponse(failed)).toEqual({
      value: {
        error: { type: "unknown", message: "failed" },
        content: [{ type: "file", name: "result.txt", mime: "text/plain" }],
      },
      attachments: [{ name: "result.txt", mime: "text/plain" }],
    })
  })
})
