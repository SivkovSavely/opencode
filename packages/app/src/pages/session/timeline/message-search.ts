import type { Part, UserMessage } from "@opencode-ai/sdk/v2"

export function normalizePromptText(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim()
}

export function chronologicalUserMessages(messages: UserMessage[]) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const aCreated = a.message.time?.created ?? Number.MAX_SAFE_INTEGER
      const bCreated = b.message.time?.created ?? Number.MAX_SAFE_INTEGER
      return aCreated - bCreated || a.index - b.index
    })
    .map(({ message }) => message)
}

export function searchMessages<T extends { text: string }>(messages: T[], query: string, regex: boolean) {
  const term = query.trim()
  if (!term) return { matches: messages, invalid: false }

  const pattern = createPattern(term, regex)
  if (!pattern) return { matches: [], invalid: regex }
  return { matches: messages.filter((message) => pattern.test(message.text)), invalid: false }
}

export function highlightRanges(text: string, query: string, regex: boolean) {
  const term = query.trim()
  if (!term) return []

  const pattern = createPattern(term, regex, true)
  if (!pattern) return []
  return Array.from(text.matchAll(pattern), (match) => {
    const start = match.index ?? 0
    return match[0].length ? { start, end: start + match[0].length } : undefined
  }).filter((range): range is { start: number; end: number } => !!range)
}

function createPattern(term: string, regex: boolean, global = false) {
  try {
    return new RegExp(regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), global ? "gi" : "i")
  } catch {
    return undefined
  }
}
