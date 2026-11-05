import { expect, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { formatRawToolValue, rawToolRequest, rawToolResponse } from "./raw-tool-value"
import { formatRawToolString } from "./raw-tool-format"

function tool(
  metadata: Extract<SessionMessageAssistantTool["state"], { status: "completed" }>["metadata"] = {},
): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: "call_raw",
    name: "mcp_fixture",
    time: { created: 1 },
    state: {
      status: "completed",
      input: { path: "original", nested: { keep: [false, null, ""] } },
      content: [{ type: "text", text: "  exact\n output\t " }],
      metadata,
    },
  }
}

test("requests retain original fields and explicit falsey imported inputs", () => {
  expect(rawToolRequest(tool())).toEqual({ path: "original", nested: { keep: [false, null, ""] } })
  for (const input of [null, false, "", 0]) {
    expect(rawToolRequest(tool({ __opencode_raw_tool_details: { input } }))).toBe(input)
  }
})

test("streaming input is parsed when complete and otherwise remains exact text", () => {
  const value = tool()
  value.state = { status: "streaming", input: '  {"command":"line\\nnext"}' }
  expect(rawToolRequest(value)).toEqual({ command: "line\nnext" })
  value.state.input = '  {"command":"unterminated '
  expect(rawToolRequest(value)).toBe('  {"command":"unterminated ')
  expect(rawToolResponse(value)).toBeUndefined()
  value.state = {
    status: "running",
    input: {},
    metadata: { __opencode_raw_tool_details: { output: "cached progress" } },
  }
  expect(rawToolResponse(value)).toBeUndefined()
})

test("terminal text, structured/content combinations and explicit empty content remain distinct", () => {
  expect(rawToolResponse(tool())?.value).toBe("  exact\n output\t ")
  expect(rawToolResponse(tool({ __opencode_raw_tool_details: { hasStructured: true, structured: {} } }))?.value).toBe(
    "  exact\n output\t ",
  )
  for (const structured of [null, false, [], { value: 3 }]) {
    expect(rawToolResponse(tool({ __opencode_raw_tool_details: { hasStructured: true, structured } }))?.value).toEqual({
      structured,
      content: [{ type: "text", text: "  exact\n output\t " }],
    })
  }
  expect(
    rawToolResponse(
      tool({ __opencode_raw_tool_details: { hasContent: true, content: [], hasStructured: true, structured: null } }),
    )?.value,
  ).toBeNull()
  expect(
    rawToolResponse(tool({ __opencode_raw_tool_details: { hasContent: true, content: [] } }))?.value,
  ).toBeUndefined()
  expect(rawToolResponse(tool({ __opencode_raw_tool_details: { hasContent: false, output: "" } }))?.value).toBe("")
})

test("provider result presence wins over ordinary output even for falsey values", () => {
  for (const result of [false, null, "", 0, [], {}]) {
    expect(
      rawToolResponse(tool({ __opencode_raw_tool_details: { providerExecuted: true, hasResult: true, result } }))
        ?.value,
    ).toEqual(result)
  }
  expect(
    rawToolResponse(
      tool({ __opencode_raw_tool_details: { providerExecuted: true, hasResult: false, result: "not present" } }),
    )?.value,
  ).toBe("  exact\n output\t ")
})

test("recognized file payloads are descriptive; ordinary JSON is not a secret scrubber", () => {
  const file = {
    type: "file",
    name: "demo.png",
    mime: "image/png",
    uri: "data:secret",
    data: "bytes",
    description: "fixture",
  }
  const value = tool({
    __opencode_raw_tool_details: {
      providerExecuted: true,
      hasResult: true,
      result: { type: "content", value: [file] },
      hasContent: true,
      content: [file],
      attachments: [file, file],
      outputPaths: ["/never/read", 3, null],
    },
  })
  expect(rawToolResponse(value)).toEqual({
    value: { type: "content", value: [{ type: "file", name: "demo.png", mime: "image/png", description: "fixture" }] },
    attachments: [{ name: "demo.png", mime: "image/png", description: "fixture" }],
    outputPaths: ["/never/read"],
  })
  expect(
    rawToolResponse(
      tool({
        __opencode_raw_tool_details: { providerExecuted: true, hasResult: true, result: { token: "synthetic" } },
      }),
    )?.value,
  ).toEqual({ token: "synthetic" })
})

test("failed tools combine preserved request, structured error, provider result and safe content", () => {
  const value = tool()
  value.executed = true
  value.state = {
    status: "error",
    input: {},
    error: { type: "tool.execution", message: "friendly" },
    metadata: { __opencode_raw_tool_details: { input: '{"partial":', error: null, hasResult: true, result: false } },
  }
  expect(rawToolRequest(value)).toBe('{"partial":')
  expect(rawToolResponse(value)?.value).toEqual({ error: null, result: false })
  value.executed = false
  value.state.metadata = {
    __opencode_raw_tool_details: {
      error: { kind: "denied", detail: "  exact " },
      hasContent: true,
      content: [{ type: "file", mime: "image/png", uri: "file:///never" }],
      hasStructured: true,
      structured: false,
    },
  }
  expect(rawToolResponse(value)?.value).toEqual({
    error: { kind: "denied", detail: "  exact " },
    structured: false,
    content: [{ type: "file", mime: "image/png" }],
  })
})

test("raw value rendering is exact for strings and honest for undefined and unserializable objects", () => {
  expect(formatRawToolValue(" \n\t<script>fixture</script> ")).toBe(" \n\t<script>fixture</script> ")
  expect(formatRawToolValue(undefined)).toBe("undefined")
  expect(formatRawToolValue(null)).toBe("null")
  expect(formatRawToolValue({ a: [false] })).toBe('{\n  "a": [\n    false\n  ]\n}')
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  expect(formatRawToolValue(cyclic)).toBeUndefined()
})

test("JSON formatting changes only whitespace outside lexical tokens", () => {
  const source = ' {"key":9007199254740993,"key":1e400,"escape":"\\u0061\\/\\\"","array":[{},[],true,null]} '
  expect(formatRawToolString(source)).toEqual({
    format: "json",
    value:
      '{\n  "key": 9007199254740993,\n  "key": 1e400,\n  "escape": "\\u0061\\/\\\"",\n  "array": [\n    {},\n    [],\n    true,\n    null\n  ]\n}',
  })
  for (const source of ["prose", '"scalar"', "false", "[invalid]", '{"a":1} trailing', '{\n  "a": 1\n}'])
    expect(formatRawToolString(source)).toBeUndefined()
})

test("JSON budgets reject oversized input, expansion and excessive depth without partial documents", () => {
  expect(formatRawToolString(`["${"a".repeat(1_000_000)}"]`)).toBeUndefined()
  expect(formatRawToolString(`[${"0,".repeat(210_000)}0]`)).toBeUndefined()
  expect(formatRawToolString("[".repeat(101) + "0" + "]".repeat(101))).toBeUndefined()
  expect(formatRawToolString("[".repeat(100) + "0" + "]".repeat(100))?.format).toBe("json")
  expect(formatRawToolString("<root><child/></root>")).toBeUndefined()
})
