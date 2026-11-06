import type { TranscriptSearch } from "@opencode/schema/transcript-search"
import { parseMessageSearch } from "@/session/timeline/message-search"

export type TranscriptResult = { server: string; hit: TranscriptSearch.Hit }

const utf8 = new TextEncoder()

export function compareText(left: string, right: string) {
  const a = utf8.encode(left)
  const b = utf8.encode(right)

  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }

  return a.length - b.length
}

export function compareResults(
  left: TranscriptResult,
  right: TranscriptResult,
  sort: NonNullable<TranscriptSearch.Request["sort"]>,
) {
  const primary =
    sort === "session-title"
      ? compareText(left.hit.title, right.hit.title)
      : (left.hit.timeCreated - right.hit.timeCreated) * (sort === "newest" ? -1 : 1)

  return (
    primary ||
    compareText(left.server, right.server) ||
    (sort === "newest" ? -1 : 1) *
      (compareText(left.hit.messageID, right.hit.messageID) || compareText(left.hit.documentID, right.hit.documentID))
  )
}

export function createTranscriptPagination(
  keys: string[],
  sort: NonNullable<TranscriptSearch.Request["sort"]>,
  signal: AbortSignal,
  fetch: (key: string, cursor: string | undefined) => Promise<TranscriptSearch.Response>,
) {
  // SAFETY: these assertions only widen empty initial buffers and absent cursor/error values for later pages.
  const servers = keys.map((key) => ({
    key,
    cursor: undefined as string | undefined,
    exhausted: false,
    buffer: [] as TranscriptResult[],
    cursors: new Set<string>(),
    error: undefined as unknown,
    ready: false,
    started: false,
  }))

  const seen = new Set<string>()
  let busy = false
  let truncatedDocuments = 0
  let scanLimited = false

  return async (limit = 40) => {
    if (busy || signal.aborted) return
    busy = true
    const hits: TranscriptResult[] = []
    const attempts = new Map<string, number>()

    try {
      while (hits.length < limit && !signal.aborted) {
        const missing = servers.filter((server) => !server.exhausted && !server.buffer.length)

        if (missing.length) {
          if (missing.some((server) => (attempts.get(server.key) ?? 0) >= 8)) break

          const pages = await Promise.allSettled(
            missing.map((server) => {
              attempts.set(server.key, (attempts.get(server.key) ?? 0) + 1)

              return Promise.resolve().then(() => fetch(server.key, server.cursor))
            }),
          )

          if (signal.aborted) return
          pages.forEach((page, index) => {
            const server = missing[index]!

            if (page.status === "rejected") {
              server.error = page.reason ?? new Error()

              return
            }

            const data = page.value

            if (data.nextCursor !== undefined && (!data.nextCursor || server.cursors.has(data.nextCursor))) {
              server.error = new Error("Invalid transcript continuation")

              return
            }

            server.error = undefined
            server.started = true
            server.ready = data.status.ready
            server.cursor = data.nextCursor

            if (data.nextCursor) server.cursors.add(data.nextCursor)
            server.exhausted = data.nextCursor === undefined
            server.buffer = data.hits.map((hit) => ({ server: server.key, hit }))
            truncatedDocuments += data.truncatedDocuments
            scanLimited ||= data.scanLimited
          })

          if (missing.some((server) => server.error !== undefined)) break
          continue
        }

        const heads = servers.flatMap((server) => (server.buffer.length ? [server.buffer[0]!] : []))

        if (!heads.length) break
        const next = heads.sort((a, b) => compareResults(a, b, sort))[0]!
        servers.find((server) => server.key === next.server)!.buffer.shift()
        const key = JSON.stringify([next.server, next.hit.documentID, next.hit.offset])

        if (seen.has(key)) continue
        seen.add(key)
        hits.push(next)
      }

      if (signal.aborted) return

      return {
        hits,
        failed: servers.flatMap((server) => (server.error !== undefined ? [server.key] : [])),
        error: servers.find((server) => server.error !== undefined)?.error,
        more: servers.some((server) => !server.exhausted || server.buffer.length > 0),
        complete: servers.every(
          (server) => server.started && server.exhausted && !server.buffer.length && server.ready,
        ),
        truncatedDocuments,
        scanLimited,
      }
    } finally {
      busy = false
    }
  }
}

export function transcriptQuery(
  query: string,
  caseSensitive: boolean,
): Pick<TranscriptSearch.Request, "query" | "mode" | "caseSensitive" | "flags"> | undefined {
  // Leave room for delimiters/flags without compiling an unbounded UI expression.
  if (query.trim().length > 264) return
  const parsed = parseMessageSearch(query)

  if (parsed.invalid || parsed.empty) return undefined
  const trimmed = query.trim()
  const literal = trimmed.startsWith("\\/") ? trimmed.slice(1) : trimmed

  if (!parsed.regex && Array.from(literal).length < 3) return undefined
  const value = parsed.regex ? parsed.pattern!.source : literal

  if (value.length > 256) return

  const request = {
    query: value,
    mode: parsed.regex ? ("regex" as const) : ("literal" as const),
    caseSensitive,
  }

  if (parsed.regex) return { ...request, flags: parsed.pattern!.flags }

  return request
}

export function transcriptPreview(
  hit: Pick<TranscriptSearch.Hit, "excerpt" | "offset" | "excerptOffset" | "matchLength">,
) {
  const start = hit.offset - hit.excerptOffset
  const length = hit.matchLength

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(length) ||
    length <= 0 ||
    start >= hit.excerpt.length ||
    start + length <= 0
  )
    return [{ text: hit.excerpt, match: false }]
  const from = Math.max(0, start)
  const to = Math.min(hit.excerpt.length, start + length)

  return [
    { text: hit.excerpt.slice(0, from), match: false },
    { text: hit.excerpt.slice(from, to), match: true },
    { text: hit.excerpt.slice(to), match: false },
  ].filter((segment) => segment.text)
}

export function rankTranscriptFacets(
  options: { key: string; label: string; configured?: boolean; lastUsed?: number }[],
) {
  const merged = new Map<string, { key: string; label: string; configured: boolean; lastUsed: number }>()
  options.forEach((option) => {
    const previous = merged.get(option.key)
    merged.set(option.key, {
      key: option.key,
      label: !previous
        ? option.label
        : previous.configured !== Boolean(option.configured)
          ? previous.configured
            ? previous.label
            : option.label
          : compareText(previous.label, option.label) <= 0
            ? previous.label
            : option.label,
      configured: Boolean(previous?.configured || option.configured),
      lastUsed: Math.max(previous?.lastUsed ?? 0, option.lastUsed ?? 0),
    })
  })
  const recent = Date.now() - 30 * 86400000

  const rank = (option: { lastUsed: number; configured: boolean }) =>
    option.lastUsed >= recent ? 0 : option.configured ? 1 : 2

  return [...merged.values()].sort(
    (a, b) =>
      rank(a) - rank(b) || b.lastUsed - a.lastUsed || compareText(a.label, b.label) || compareText(a.key, b.key),
  )
}

export function localDateBounds(from: string, to: string) {
  return {
    dateFrom: from ? new Date(`${from}T00:00:00`).getTime() : undefined,
    dateTo: to ? new Date(`${to}T23:59:59.999`).getTime() : undefined,
  }
}
