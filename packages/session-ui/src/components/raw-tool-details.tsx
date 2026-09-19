import { createMemo, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { RAW_TOOL_DETAILS_KEY } from "./raw-tool-details-key"

type RawRecord = Record<string, unknown>

type AttachmentInfo = {
  name?: string
  mime?: string
  description?: string
}

export type RawToolResponse = {
  value: unknown
  attachments?: AttachmentInfo[]
  outputPaths?: string[]
}

function record(value: unknown): value is RawRecord {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function has(value: RawRecord, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function parseJSON(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function attachment(value: unknown): AttachmentInfo | undefined {
  if (!record(value)) return undefined
  const result: AttachmentInfo = {}
  if (typeof value.name === "string") result.name = value.name
  if (typeof value.filename === "string") result.name = value.filename
  if (typeof value.mime === "string") result.mime = value.mime
  if (typeof value.description === "string") result.description = value.description
  return Object.keys(result).length > 0 ? result : undefined
}

function attachments(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const info = attachment(item)
    return info ? [info] : []
  })
}

function safeContent(value: unknown) {
  if (!Array.isArray(value)) return value
  return value.map((item) => {
    if (!record(item) || item.type !== "file") return item
    return {
      type: "file",
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.mime === "string" ? { mime: item.mime } : {}),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
    }
  })
}

function safeResult(value: unknown): unknown {
  if (!record(value)) return value
  if (value.type !== "content" || !Array.isArray(value.value)) return value
  return { ...value, value: safeContent(value.value) }
}

function contentResult(structured: unknown, content: unknown) {
  const items = Array.isArray(content) ? safeContent(content) : undefined
  if (!Array.isArray(items)) return structured
  if (items.length === 1 && record(items[0]) && items[0].type === "text" && typeof items[0].text === "string") {
    if (structured === undefined || (record(structured) && Object.keys(structured).length === 0)) return items[0].text
  }
  if (items.length) {
    if (structured !== undefined && (!record(structured) || Object.keys(structured).length > 0)) {
      return { structured, content: items }
    }
    return { content: items }
  }
  return structured
}

function responseMetadata(part: ToolPart) {
  const state = part.state as unknown as RawRecord
  const metadata = record(state.metadata) ? state.metadata : undefined
  const storedValue = metadata?.[RAW_TOOL_DETAILS_KEY]
  const stored: RawRecord | undefined = record(storedValue) ? storedValue : undefined
  const partMetadataValue = (part as unknown as RawRecord).metadata
  const partMetadata: RawRecord | undefined = record(partMetadataValue) ? partMetadataValue : undefined
  const providerValue = (part as unknown as RawRecord).provider
  const provider = record(providerValue) ? providerValue : undefined
  const providerExecuted =
    typeof stored?.providerExecuted === "boolean"
      ? stored.providerExecuted
      : typeof provider?.executed === "boolean"
        ? provider.executed
        : partMetadata?.providerExecuted === true || (part as unknown as RawRecord).executed === true

  return { state, stored, providerExecuted }
}

export function rawToolRequest(part: ToolPart) {
  const { state, stored } = responseMetadata(part)
  const input = stored?.input ?? state.input
  if (part.state.status !== "pending" || typeof state.raw !== "string" || state.raw.trim() === "") return input
  if (record(input) && Object.keys(input).length > 0) return input
  return parseJSON(state.raw)
}

export function rawToolResponse(part: ToolPart): RawToolResponse | undefined {
  if (part.state.status === "pending" || part.state.status === "running") return undefined

  const { state, stored, providerExecuted } = responseMetadata(part)
  const hasResult = stored ? stored.hasResult === true : has(state, "result")
  const result = stored ? stored.result : state.result
  const hasStructured = stored ? stored.hasStructured === true : has(state, "structured")
  const structured = stored ? stored.structured : state.structured
  const hasContent = stored ? stored.hasContent === true : has(state, "content")
  const content = stored ? stored.content : state.content
  const storedAttachments = stored?.attachments ?? state.attachments
  const outputPaths = stored?.outputPaths ?? state.outputPaths
  const attachmentInfo = attachments(storedAttachments)
  const contentAttachments = attachments(content)
  const allAttachments = [...attachmentInfo, ...contentAttachments].filter(
    (item, index, list) => list.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index,
  )
  const paths = Array.isArray(outputPaths) ? outputPaths.filter((item): item is string => typeof item === "string") : []

  if (part.state.status === "error") {
    const error = stored?.error ?? state.error
    const value =
      providerExecuted && hasResult
        ? { ...(error === undefined ? {} : { error }), result: safeResult(result) }
        : {
            ...(error === undefined ? {} : { error }),
            ...(hasStructured ? { structured } : {}),
            ...(hasContent ? { content: safeContent(content) } : {}),
            ...(error === undefined && !hasStructured && !hasContent && state.output !== undefined
              ? { output: state.output }
              : {}),
          }
    return {
      value,
      attachments: allAttachments.length ? allAttachments : undefined,
      outputPaths: paths.length ? paths : undefined,
    }
  }

  const value =
    providerExecuted && hasResult
      ? safeResult(result)
      : hasStructured || hasContent
        ? contentResult(hasStructured ? structured : undefined, hasContent ? content : undefined)
        : state.output
  return {
    value,
    attachments: allAttachments.length ? allAttachments : undefined,
    outputPaths: paths.length ? paths : undefined,
  }
}

export function formatRawToolValue(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined) return "undefined"
  try {
    const formatted = JSON.stringify(value, null, 2)
    if (formatted !== undefined) return formatted
    if (value === null) return "null"
    if (typeof value === "object") return "[Unserializable value]"
    return String(value)
  } catch {
    if (value === null) return "null"
    if (typeof value === "object") return "[Unserializable value]"
    return String(value)
  }
}

function DeferredRawDetails(props: { render: () => JSX.Element }) {
  return props.render()
}

function RawSection(props: { label: string; ariaLabel: string; content: () => JSX.Element }) {
  const [state, setState] = createStore({ open: false })
  return (
    <Collapsible
      variant="ghost"
      class="raw-tool-details-section"
      open={state.open}
      onOpenChange={(open) => setState("open", open)}
    >
      <Collapsible.Trigger aria-label={props.ariaLabel}>
        <div data-slot="raw-tool-details-trigger">
          <span data-slot="raw-tool-details-label">{props.label}</span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Show when={state.open}>
          <DeferredRawDetails render={props.content} />
        </Show>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function RawToolDetails(props: { request: () => unknown; response: () => RawToolResponse | undefined }) {
  const i18n = useI18n()

  return (
    <div data-component="raw-tool-details">
      <RawSection
        label={i18n.t("ui.tool.rawDetails.request")}
        ariaLabel={i18n.t("ui.tool.rawDetails.request")}
        content={() => {
          const request = createMemo(props.request)
          return (
            <pre
              data-slot="raw-tool-details-body"
              tabIndex={0}
              role="region"
              aria-label={i18n.t("ui.tool.rawDetails.request")}
            >
              {formatRawToolValue(request())}
            </pre>
          )
        }}
      />
      <RawSection
        label={i18n.t("ui.tool.rawDetails.response")}
        ariaLabel={i18n.t("ui.tool.rawDetails.response")}
        content={() => {
          const response = createMemo(props.response)
          return (
            <Show
              when={response()}
              fallback={<div data-slot="raw-tool-details-empty">{i18n.t("ui.tool.rawDetails.noResponse")}</div>}
            >
              {(value) => (
                <>
                  <pre
                    data-slot="raw-tool-details-body"
                    tabIndex={0}
                    role="region"
                    aria-label={i18n.t("ui.tool.rawDetails.response")}
                  >
                    {formatRawToolValue(value().value)}
                  </pre>
                  <Show when={value().attachments?.length || value().outputPaths?.length}>
                    <pre
                      data-slot="raw-tool-details-body"
                      tabIndex={0}
                      role="region"
                      aria-label={i18n.t("ui.tool.rawDetails.response")}
                    >
                      {formatRawToolValue({
                        ...(value().attachments?.length ? { attachments: value().attachments } : {}),
                        ...(value().outputPaths?.length ? { outputPaths: value().outputPaths } : {}),
                      })}
                    </pre>
                  </Show>
                </>
              )}
            </Show>
          )
        }}
      />
    </div>
  )
}
