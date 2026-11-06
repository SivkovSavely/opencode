export type SearchRange = { start: number; end: number }

export type SearchExpression = { regex: boolean; empty: boolean; invalid: boolean; pattern?: RegExp }

export type PreviewSegment = { text: string; match: boolean }

export function normalizePromptText(text: string) {
  return text.replace(/\s+/gu, " ").trim()
}

export function chronologicalUserMessages<T extends { id: string; time?: { created?: number } }>(messages: T[]) {
  const seen = new Set<string>()

  return messages
    .flatMap((message, index) => {
      if (seen.has(message.id)) return []
      seen.add(message.id)

      return [{ message, index }]
    })
    .sort((a, b) => (a.message.time?.created ?? Infinity) - (b.message.time?.created ?? Infinity) || a.index - b.index)
    .map((item) => item.message)
}

export function promptSearchItems(
  messages: { id: string; text: string; time?: { created?: number }; files?: readonly unknown[] }[],
) {
  return chronologicalUserMessages(messages).map((message) => ({
    id: message.id,
    text: normalizePromptText(message.text),
    created: message.time?.created,
    attachment: !!message.files?.length,
  }))
}

export function parseMessageSearch(query: string): SearchExpression {
  try {
    if (!query.startsWith("/")) {
      const term = (query.startsWith("\\/") ? query.slice(1) : query).trim()

      return term
        ? {
            regex: false,
            empty: false,
            invalid: false,
            pattern: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
          }
        : { regex: false, empty: true, invalid: false }
    }

    let closing = -1

    for (let index = 1; index < query.length; index++) {
      if (query[index] !== "/" || !/^[dgimsuvy]*$/.test(query.slice(index + 1))) continue
      let escapes = 0

      for (let cursor = index - 1; cursor >= 0 && query[cursor] === "\\"; cursor--) escapes++

      if (escapes % 2 === 0) closing = index
    }

    return {
      regex: true,
      empty: false,
      invalid: false,
      pattern: new RegExp(
        query.slice(1, closing < 0 ? undefined : closing),
        closing < 0 ? "" : query.slice(closing + 1),
      ),
    }
  } catch {
    return { regex: query.startsWith("/"), empty: false, invalid: true }
  }
}

export function searchMessages<T extends { id: string; text: string }>(messages: T[], search: SearchExpression) {
  if (search.invalid) return []

  return messages.flatMap<{ id: string; match: SearchRange | undefined }>((item) => {
    if (search.empty) return [{ id: item.id, match: undefined }]

    if (!search.pattern) return []
    search.pattern.lastIndex = 0
    const match = search.pattern.exec(item.text)

    return match ? [{ id: item.id, match: { start: match.index, end: match.index + match[0].length } }] : []
  })
}

/** Stops on cycles, not on an overlap or a metadata-only page with an advancing cursor. */
export function createHistoryProgress() {
  const attempts = new Map<string, { records: number; visits: number }>()

  return {
    clear: () => attempts.clear(),
    accept(page: {
      status: "shared" | "skipped" | "loaded"
      before: { cursor: string | undefined; records: number }
      after: { cursor: string | undefined; records: number }
    }) {
      if (page.status !== "loaded" || page.after.cursor === undefined) return true
      const cursor = page.before.cursor

      if (cursor === undefined) return true
      const previous = attempts.get(cursor)
      attempts.set(cursor, { records: page.before.records, visits: (previous?.visits ?? 0) + 1 })

      return !(
        (page.after.cursor === cursor && page.after.records <= page.before.records) ||
        (previous && (previous.visits >= 2 || page.before.records <= previous.records)) ||
        attempts.has(page.after.cursor)
      )
    },
  }
}

export function messagePreview(
  text: string,
  width: number,
  match: SearchRange | undefined,
  measure: (text: string) => number,
): PreviewSegment[] {
  if (!text || width <= 0) return []

  const clip = (value: string, budget: number, suffix = false) => {
    const points = Array.from(value)
    let low = 0
    let high = points.length

    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const part = (suffix ? points.slice(points.length - mid) : points.slice(0, mid)).join("")

      if (measure(part) <= budget) low = mid
      else high = mid - 1
    }

    return (suffix ? points.slice(points.length - low) : points.slice(0, low)).join("")
  }

  const marker = "…"
  const markerWidth = measure(marker)

  if (!match) {
    if (measure(text) <= width) return [{ text, match: false }]
    const prefix = clip(text, width - markerWidth)

    return prefix ? [{ text: prefix + marker, match: false }] : []
  }

  const boundary = (index: number) =>
    index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index])

  const rawStart = Math.max(0, Math.min(text.length, match.start))
  const rawEnd = Math.max(rawStart, Math.min(text.length, match.end))
  // Non-Unicode JS regexes can match half a surrogate pair; presentation must keep the code point intact.
  const start = boundary(rawStart) ? rawStart - 1 : rawStart
  const end = rawStart === rawEnd ? start : boundary(rawEnd) ? rawEnd + 1 : rawEnd
  const before = text.slice(0, start)
  const matched = text.slice(start, end)
  const after = text.slice(end)
  const highlighted = matched ? [{ text: matched, match: true }] : []

  if (measure(text) <= width)
    return [
      ...(before ? [{ text: before, match: false }] : []),
      ...highlighted,
      ...(after ? [{ text: after, match: false }] : []),
    ]

  if (measure(matched) + (before ? markerWidth : 0) + (after ? markerWidth : 0) > width) {
    const shown = clip(matched, width - markerWidth - (before ? markerWidth : 0))

    return shown
      ? [
          ...(before ? [{ text: marker, match: false }] : []),
          { text: shown, match: true },
          { text: marker, match: false },
        ]
      : []
  }

  if (measure(before + matched) <= width) {
    const remaining = width - measure(before + matched)
    const tail = measure(after) <= remaining ? after : clip(after, remaining - markerWidth) + marker

    return [
      ...(before ? [{ text: before, match: false }] : []),
      ...highlighted,
      ...(tail && measure(tail) <= remaining ? [{ text: tail, match: false }] : []),
    ]
  }

  const available = Math.max(0, width - measure(matched) - markerWidth)
  const beginning = clip(before, available * 0.25)
  const tailBudget = Math.min(measure(after), available * 0.25)
  const context = clip(before.slice(beginning.length), available - measure(beginning) - tailBudget, true)
  const tail = measure(after) <= tailBudget ? after : clip(after, tailBudget - markerWidth) + marker

  return [
    ...(beginning ? [{ text: beginning, match: false }] : []),
    { text: marker, match: false },
    ...(context ? [{ text: context, match: false }] : []),
    ...highlighted,
    ...(tail && measure(tail) <= tailBudget ? [{ text: tail, match: false }] : []),
  ]
}
