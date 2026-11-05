import type { SessionMessageAssistantTool } from "@opencode/client/promise"

type RawRecord = Record<string, unknown>

function record(value: unknown): value is RawRecord {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function has(value: RawRecord, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function stored(tool: SessionMessageAssistantTool) {
  if (!("metadata" in tool.state)) return {}
  const value = tool.state.metadata?.__opencode_raw_tool_details
  return record(value) ? value : {}
}

export function rawToolRequest(tool: SessionMessageAssistantTool): unknown {
  const raw = stored(tool)
  if (has(raw, "input")) return raw.input
  if (tool.state.status !== "streaming") return tool.state.input
  try {
    return JSON.parse(tool.state.input) as unknown
  } catch {
    return tool.state.input
  }
}

function attachment(value: unknown) {
  if (!record(value)) return
  const info = {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.filename === "string" ? { name: value.filename } : {}),
    ...(typeof value.mime === "string" ? { mime: value.mime } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  }
  return Object.keys(info).length ? info : undefined
}

function safeContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((item: unknown) =>
    record(item) && item.type === "file" ? { type: "file", ...attachment(item) } : item,
  )
}

function safeResult(value: unknown): unknown {
  if (!record(value) || value.type !== "content") return value
  return { ...value, value: safeContent(value.value) }
}

function contentResult(structured: unknown, content: unknown): unknown {
  const items = safeContent(content)
  if (!Array.isArray(items) || !items.length) return structured
  if (items.length === 1 && record(items[0]) && items[0].type === "text" && typeof items[0].text === "string") {
    if (structured === undefined || (record(structured) && !Object.keys(structured).length)) return items[0].text
  }
  if (structured !== undefined && (!record(structured) || Object.keys(structured).length)) {
    return { structured, content: items }
  }
  return { content: items }
}

export function rawToolResponse(tool: SessionMessageAssistantTool) {
  if (tool.state.status === "streaming" || tool.state.status === "running") return
  const raw = stored(tool)
  // Imported V1 presence flags are authoritative only for the fields they describe.
  const content = has(raw, "hasContent") ? (raw.hasContent ? raw.content : undefined) : tool.state.content
  const structured = raw.hasStructured === true ? raw.structured : undefined
  const error = has(raw, "error") ? raw.error : tool.state.status === "error" ? tool.state.error : undefined
  const provider =
    (has(raw, "providerExecuted") ? raw.providerExecuted : tool.executed) === true && raw.hasResult === true
  const value =
    tool.state.status === "error"
      ? provider
        ? { ...(error === undefined ? {} : { error }), result: safeResult(raw.result) }
        : {
            ...(error === undefined ? {} : { error }),
            ...(raw.hasStructured === true ? { structured } : {}),
            ...(content === undefined ? {} : { content: safeContent(content) }),
            ...(error === undefined && content === undefined && raw.hasStructured !== true && has(raw, "output")
              ? { output: raw.output }
              : {}),
          }
      : provider
        ? safeResult(raw.result)
        : raw.hasStructured === true || content !== undefined
          ? contentResult(structured, content)
          : raw.output
  const attachments = [
    ...(Array.isArray(raw.attachments) ? raw.attachments : []),
    ...(Array.isArray(content) ? content.filter((item: unknown) => record(item) && item.type === "file") : []),
  ]
    .flatMap((item: unknown) => {
      const info = attachment(item)
      return info ? [info] : []
    })
    .filter((item, index, list) => list.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)) === index)
  const outputPaths = Array.isArray(raw.outputPaths)
    ? raw.outputPaths.filter((item): item is string => typeof item === "string")
    : []
  return { value, ...(attachments.length ? { attachments } : {}), ...(outputPaths.length ? { outputPaths } : {}) }
}

export function formatRawToolValue(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return undefined
  }
}
