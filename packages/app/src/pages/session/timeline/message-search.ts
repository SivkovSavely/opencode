import type { Part, UserMessage } from "@opencode-ai/sdk/v2"

export type SearchRange = { start: number; end: number }
export type SearchExpression = {
  regex: boolean
  empty: boolean
  invalid: boolean
  pattern?: RegExp
}
export type SearchResult<T> = { item: T; match?: SearchRange }
export type PreviewSegment = { text: string; match: boolean }

export function normalizePromptText(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim()
}

export function chronologicalUserMessages(messages: UserMessage[]) {
  const seen = new Set<string>()
  return messages
    .filter((message) => {
      if (seen.has(message.id)) return false
      seen.add(message.id)
      return true
    })
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const aCreated = a.message.time?.created ?? Number.MAX_SAFE_INTEGER
      const bCreated = b.message.time?.created ?? Number.MAX_SAFE_INTEGER
      return aCreated - bCreated || a.index - b.index
    })
    .map(({ message }) => message)
}

export function parseMessageSearch(query: string): SearchExpression {
  const regex = query.startsWith("/") && !query.startsWith("\\/")
  if (!regex) {
    const term = (query.startsWith("\\/") ? query.slice(1) : query).trim()
    if (!term) return { regex: false, empty: true, invalid: false }
    try {
      return { regex: false, empty: false, invalid: false, pattern: new RegExp(escapeRegex(term), "i") }
    } catch {
      return { regex: false, empty: false, invalid: true }
    }
  }

  const closing = finalDelimiter(query)
  const source = query.slice(1, closing < 0 ? undefined : closing)
  const flags = closing < 0 ? "" : query.slice(closing + 1)
  try {
    return { regex: true, empty: false, invalid: false, pattern: new RegExp(source, flags) }
  } catch {
    return { regex: true, empty: false, invalid: true }
  }
}

export function firstMatch(text: string, search: SearchExpression) {
  if (search.empty || search.invalid || !search.pattern) return undefined
  search.pattern.lastIndex = 0
  const match = search.pattern.exec(text)
  if (!match) return undefined
  return { start: match.index, end: match.index + match[0].length }
}

export function searchMessages<T extends { text: string }>(messages: T[], search: SearchExpression) {
  if (search.empty) {
    const matches: SearchResult<T>[] = messages.map((item) => ({ item }))
    return { matches, invalid: false }
  }
  if (search.invalid || !search.pattern) return { matches: [] as SearchResult<T>[], invalid: true }
  const matches: SearchResult<T>[] = messages.flatMap((item) => {
    const match = firstMatch(item.text, search)
    return match ? [{ item, match }] : []
  })
  return {
    matches,
    invalid: false,
  }
}

export function messagePreview(
  text: string,
  width: number,
  match: SearchRange | undefined,
  measure: (text: string) => number,
): PreviewSegment[] {
  if (width <= 0 || !text) return []
  if (!match) return appendText(takePrefix(text, width, measure, true))

  const start = Math.max(0, Math.min(match.start, text.length))
  const end = Math.max(start, Math.min(match.end, text.length))
  const prefix = text.slice(0, start)
  const matched = text.slice(start, end)
  const suffix = text.slice(end)
  const matchedWidth = measure(matched)
  const ellipsisWidth = measure("…")

  if (matched && matchedWidth + ellipsisWidth > width) {
    if (matchedWidth <= width) return [{ text: matched, match: true }]
    return appendMatch(takePrefix(matched, width, measure, true))
  }

  if (measure(prefix) + matchedWidth <= width) {
    const before = prefix ? [{ text: prefix, match: false }] : []
    const highlighted = matched ? [{ text: matched, match: true }] : []
    return [...before, ...highlighted, ...appendText(takePrefix(suffix, width - measure(prefix) - matchedWidth, measure, true))]
  }

  const available = Math.max(0, width - matchedWidth - ellipsisWidth)
  const prefixWidth = measure(prefix)
  const suffixWidth = measure(suffix)
  let beginningBudget = Math.min(prefixWidth, available * 0.25)
  let contextBudget = Math.min(Math.max(0, prefixWidth - beginningBudget), available * 0.5)
  let afterBudget = Math.min(suffixWidth, Math.max(0, available - beginningBudget - contextBudget))
  let beginning = takePrefix(prefix, beginningBudget, measure)
  let contextSource = text.slice(beginning.count, start)
  let context = takeSuffix(contextSource, contextBudget, measure)
  let after = takePrefix(suffix, afterBudget, measure, true)
  let spare = Math.max(0, available - measure(beginning.text) - measure(context.text) - measure(after.text) - (after.omitted ? ellipsisWidth : 0))

  afterBudget = measure(after.text) + Math.min(spare, Math.max(0, suffixWidth - measure(after.text)))
  after = takePrefix(suffix, afterBudget, measure, true)
  spare = Math.max(0, available - measure(beginning.text) - measure(context.text) - measure(after.text) - (after.omitted ? ellipsisWidth : 0))

  contextBudget = measure(context.text) + Math.min(spare, Math.max(0, measure(contextSource) - measure(context.text)))
  context = takeSuffix(contextSource, contextBudget, measure)
  spare = Math.max(0, available - measure(beginning.text) - measure(context.text) - measure(after.text) - (after.omitted ? ellipsisWidth : 0))

  beginningBudget = measure(beginning.text) + Math.min(spare, Math.max(0, prefixWidth - measure(beginning.text)))
  beginning = takePrefix(prefix, beginningBudget, measure)
  contextSource = text.slice(beginning.count, start)
  context = takeSuffix(contextSource, contextBudget, measure)

  const omittedBefore = beginning.count + context.count < start
  return [
    ...(beginning.text ? [{ text: beginning.text, match: false }] : []),
    ...(omittedBefore ? [{ text: "…", match: false }] : []),
    ...(context.text ? [{ text: context.text, match: false }] : []),
    ...(matched ? [{ text: matched, match: true }] : []),
    ...appendText(after),
  ]
}

function finalDelimiter(query: string) {
  let delimiter = -1
  for (let index = 1; index < query.length; index++) {
    if (query[index] !== "/" || escapedAt(query, index)) continue
    if (!/^[dgimsuvy]*$/.test(query.slice(index + 1))) continue
    delimiter = index
  }
  return delimiter
}

function escapedAt(value: string, index: number) {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) backslashes++
  return backslashes % 2 === 1
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function takePrefix(text: string, width: number, measure: (text: string) => number, ellipsis = false) {
  if (!text || width <= 0) return { text: "", count: 0, omitted: !!text, marker: false }
  if (measure(text) <= width) return { text, count: text.length, omitted: false, marker: false }

  const markerWidth = ellipsis ? measure("…") : 0
  const available = width - markerWidth
  if (available <= 0) return { text: "", count: 0, omitted: true, marker: false }
  const count = prefixLength(text, available, measure)
  return { text: text.slice(0, count), count, omitted: count < text.length, marker: ellipsis && count < text.length }
}

function takeSuffix(text: string, width: number, measure: (text: string) => number) {
  if (!text || width <= 0) return { text: "", count: 0 }
  if (measure(text) <= width) return { text, count: text.length }
  const start = suffixStart(text, width, measure)
  return { text: text.slice(start), count: text.length - start }
}

function prefixLength(text: string, width: number, measure: (text: string) => number) {
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measure(text.slice(0, middle)) <= width) low = middle
    else high = middle - 1
  }
  return safeBoundary(text, low)
}

function suffixStart(text: string, width: number, measure: (text: string) => number) {
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (measure(text.slice(middle)) <= width) high = middle
    else low = middle + 1
  }
  return safeSuffixBoundary(text, low)
}

function safeBoundary(text: string, index: number) {
  if (index <= 0 || index >= text.length) return index
  const previous = text.charCodeAt(index - 1)
  const current = text.charCodeAt(index)
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return index - 1
  return index
}

function safeSuffixBoundary(text: string, index: number) {
  if (index <= 0 || index >= text.length) return index
  const previous = text.charCodeAt(index - 1)
  const current = text.charCodeAt(index)
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return index + 1
  return index
}

function appendText(value: { text: string; omitted: boolean; marker?: boolean }): PreviewSegment[] {
  if (!value.text) return []
  return [{ text: value.text + (value.marker ? "…" : ""), match: false }]
}

function appendMatch(value: { text: string; count: number; omitted: boolean; marker?: boolean }): PreviewSegment[] {
  if (!value.text) return []
  return [
    { text: value.text, match: true },
    ...(value.marker ? [{ text: "…", match: false }] : []),
  ].filter((segment) => segment.text)
}
