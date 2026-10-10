import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Button } from "@opencode-ai/ui/button"
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

type RawStringFormat = {
  format: "json" | "xml"
  value: string
}

type FormattedRawValue = {
  source: string
  value: string
}

const MAX_JSON_FORMAT_SIZE = 1_000_000
const MAX_JSON_FORMAT_DEPTH = 100

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

export function formatRawToolString(value: string): RawStringFormat | undefined {
  const trimmed = value.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const formatted = formatJSON(value)
    if (formatted && formatted !== value) return { format: "json", value: formatted }
  }

  if (!trimmed.startsWith("<")) return
  const formatted = formatXML(value)
  if (formatted && formatted !== value) return { format: "xml", value: formatted }
}

function formatJSON(value: string) {
  if (value.length > MAX_JSON_FORMAT_SIZE) return

  try {
    JSON.parse(value)
  } catch {
    return
  }

  const output: string[] = []
  const containers: boolean[] = []
  let outputLength = 0
  let depth = 0
  let string = false
  let escaped = false
  const append = (part: string) => {
    if (outputLength + part.length > MAX_JSON_FORMAT_SIZE) return false
    output.push(part)
    outputLength += part.length
    return true
  }

  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (string) {
      if (!append(character)) return
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') string = false
      continue
    }

    if (character === '"') {
      string = true
      if (!append(character)) return
      continue
    }
    if (character === " " || character === "\t" || character === "\n" || character === "\r") continue
    if (character === "{" || character === "[") {
      let next = index + 1
      while (value[next] === " " || value[next] === "\t" || value[next] === "\n" || value[next] === "\r") next++
      const multiline = value[next] !== (character === "{" ? "}" : "]")
      containers.push(multiline)
      if (multiline && ++depth > MAX_JSON_FORMAT_DEPTH) return
      if (!append(character + (multiline ? `\n${"  ".repeat(depth)}` : ""))) return
      continue
    }
    if (character === "}" || character === "]") {
      if (containers.pop() && !append(`\n${"  ".repeat(--depth)}`)) return
      if (!append(character)) return
      continue
    }
    if (character === ",") {
      if (!append(`,\n${"  ".repeat(depth)}`)) return
      continue
    }
    if (character === ":") {
      if (!append(": ")) return
      continue
    }
    if (!append(character)) return
  }

  return output.join("")
}

function formatXML(value: string) {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined" || typeof Node === "undefined") return

  try {
    const document = new DOMParser().parseFromString(value, "application/xml")
    const root = document.documentElement
    if (!root || xmlParseError(root, value) || !safeXML(root)) return

    const serializer = new XMLSerializer()
    const declaration = value.match(/^\uFEFF?<\?xml\s[^?]*\?>/)?.[0]
    const doctype = xmlDoctype(value)
    const formatted = Array.from(document.childNodes)
      .map((node) => formatXMLNode(node, 0, serializer, doctype))
      .filter(Boolean)
      .join("\n")
    const output = declaration ? `${declaration}\n${formatted}` : formatted
    const formattedDocument = new DOMParser().parseFromString(output, "application/xml")
    const formattedRoot = formattedDocument.documentElement
    if (!formattedRoot || xmlParseError(formattedRoot, output)) return
    return output
  } catch {
    return
  }
}

function xmlParseError(root: Element, source: string) {
  const hasSourceParserError = /<((?:[\w.-]+:)?parsererror)(?=[\s/>])[^>]*>[\s\S]*?<\/\1\s*>/.test(
    source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]|<\?[\s\S]*?\?>/g, ""),
  )
  if (
    root.localName === "parsererror" &&
    root.namespaceURI === "http://www.mozilla.org/newlayout/xml/parsererror.xml" &&
    !hasSourceParserError
  ) {
    return true
  }
  const error = root.firstElementChild
  if (error?.localName !== "parsererror" || error.namespaceURI !== "http://www.w3.org/1999/xhtml") return false
  const children = Array.from(error.children)
  return (
    !hasSourceParserError &&
    children.length === 3 &&
    children[0]?.localName === "h3" &&
    children[0]?.textContent === "This page contains the following errors:" &&
    children[1]?.localName === "div" &&
    /^error on line \d+ at column \d+:/.test(children[1]?.textContent ?? "") &&
    children[2]?.localName === "h3" &&
    children[2]?.textContent === "Below is a rendering of the page up to the first error."
  )
}

function safeXML(node: Node, preserve = false): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return true

  const element = node as Element
  const space = element.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space")
  const preserveSpace = space === "preserve" || (space !== "default" && preserve)
  if (preserveSpace) return true

  const children = Array.from(element.childNodes)
  const hasElements = children.some((child) => child.nodeType === Node.ELEMENT_NODE)
  if (
    hasElements &&
    element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    element.localName !== "parsererror"
  ) {
    return false
  }
  if (
    hasElements &&
    element.namespaceURI === "http://www.w3.org/2000/svg" &&
    ["text", "tspan", "textPath"].includes(element.localName)
  ) {
    return false
  }
  if (
    hasElements &&
    children.some(
      (child) =>
        child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE,
    )
  ) {
    return false
  }

  return children.every((child) => safeXML(child, preserveSpace))
}

function formatXMLNode(node: Node, depth: number, serializer: XMLSerializer, doctype?: string): string {
  const indent = "  ".repeat(depth)
  if (node.nodeType === Node.DOCUMENT_TYPE_NODE) return indent + (doctype ?? serializer.serializeToString(node))
  if (node.nodeType !== Node.ELEMENT_NODE) {
    if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) return ""
    return indent + serializer.serializeToString(node)
  }

  const element = node as Element
  const space = element.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space")
  if (space === "preserve") return indent + serializer.serializeToString(element)

  const children = Array.from(element.childNodes)
  if (!children.some((child) => child.nodeType === Node.ELEMENT_NODE)) {
    return indent + serializer.serializeToString(element)
  }

  const serialized = serializer.serializeToString(element.cloneNode(false) as Element)
  const end = serialized.indexOf(">")
  const opening = `${serialized.slice(0, end).replace(/\/$/, "")}>`
  const content = children
    .map((child) => formatXMLNode(child, depth + 1, serializer))
    .filter(Boolean)
    .join("\n")
  return `${indent}${opening}\n${content}\n${indent}</${element.tagName}>`
}

function xmlDoctype(value: string) {
  let index = value.charCodeAt(0) === 0xfeff ? 1 : 0
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index++
    if (value.startsWith("<?", index)) {
      const end = value.indexOf("?>", index + 2)
      if (end < 0) return
      index = end + 2
      continue
    }
    if (value.startsWith("<!--", index)) {
      const end = value.indexOf("-->", index + 4)
      if (end < 0) return
      index = end + 3
      continue
    }
    if (!value.startsWith("<!DOCTYPE", index)) return

    const start = index
    let brackets = 0
    let quote = ""
    index += "<!DOCTYPE".length
    while (index < value.length) {
      if (!quote && value.startsWith("<!--", index)) {
        const end = value.indexOf("-->", index + 4)
        if (end < 0) return
        index = end + 3
        continue
      }
      if (!quote && value.startsWith("<?", index)) {
        const end = value.indexOf("?>", index + 2)
        if (end < 0) return
        index = end + 2
        continue
      }

      const character = value[index]
      if (quote) {
        if (character === quote) quote = ""
      } else if (character === "'" || character === '"') quote = character
      else if (character === "[") brackets++
      else if (character === "]") brackets--
      else if (character === ">" && brackets === 0) return value.slice(start, index + 1)
      index++
    }
    return
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

function RawValue(props: {
  value: () => unknown
  label: string
  incomplete?: () => boolean
  formatted: () => FormattedRawValue | undefined
  onFormat: (value: FormattedRawValue) => void
  onRaw: () => void
}) {
  const i18n = useI18n()
  const value = createMemo(props.value)
  const format = createMemo(() => {
    const current = value()
    return !props.incomplete?.() && typeof current === "string" ? formatRawToolString(current) : undefined
  })
  const formatted = () => {
    const current = value()
    const stored = props.formatted()
    return typeof current === "string" && stored?.source === current ? stored.value : undefined
  }
  const action = createMemo(() => formatted() ?? format())
  const label = () => {
    const current = action()
    if (typeof current === "string") return i18n.t("ui.tool.rawDetails.showRaw")
    if (!current) return ""
    return i18n.t(current.format === "json" ? "ui.tool.rawDetails.formatJSON" : "ui.tool.rawDetails.formatXML")
  }

  return (
    <div data-slot="raw-tool-details-value">
      <Show when={action()}>
        {(action) => (
          <div data-slot="raw-tool-details-format">
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                const current = action()
                if (typeof current === "string") {
                  props.onRaw()
                  return
                }
                const source = value()
                if (typeof source === "string") props.onFormat({ source, value: current.value })
              }}
            >
              {label()}
            </Button>
          </div>
        )}
      </Show>
      <pre
        data-slot="raw-tool-details-body"
        tabIndex={0}
        role="region"
        aria-label={props.label}
      >
        {formatted() ?? formatRawToolValue(value())}
      </pre>
    </div>
  )
}

export function RawToolDetails(props: {
  request: () => unknown
  response: () => RawToolResponse | undefined
  requestIncomplete: () => boolean
}) {
  const i18n = useI18n()
  const [formattedRequest, setFormattedRequest] = createSignal<FormattedRawValue>()
  const [formattedResponse, setFormattedResponse] = createSignal<FormattedRawValue>()

  return (
    <div data-component="raw-tool-details">
      <RawSection
        label={i18n.t("ui.tool.rawDetails.request")}
        ariaLabel={i18n.t("ui.tool.rawDetails.request")}
        content={() => {
          const request = createMemo(props.request)
          return (
            <RawValue
              value={request}
              label={i18n.t("ui.tool.rawDetails.request")}
              incomplete={props.requestIncomplete}
              formatted={formattedRequest}
              onFormat={setFormattedRequest}
              onRaw={() => setFormattedRequest(undefined)}
            />
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
                  <RawValue
                    value={() => value().value}
                    label={i18n.t("ui.tool.rawDetails.response")}
                    formatted={formattedResponse}
                    onFormat={setFormattedResponse}
                    onRaw={() => setFormattedResponse(undefined)}
                  />
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
