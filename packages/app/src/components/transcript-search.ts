import type { TranscriptSearchSearchResponse } from "@opencode-ai/sdk/v2"
import { parseMessageSearch } from "@/pages/session/timeline/message-search"

export type TranscriptHit = TranscriptSearchSearchResponse["hits"][number]
export type TranscriptResult = { server: string; hit: TranscriptHit }
const utf8 = new TextEncoder()

export function transcriptServersToFetch<T extends { key: string }>(
  requests: T[],
  cursors: Record<string, string | null | undefined>,
  failed: Set<string>,
  more: boolean,
) {
  return more
    ? requests.filter((request) => typeof cursors[request.key] === "string" || failed.has(request.key))
    : requests
}

export function transcriptSearchComplete<T extends { key: string }>(
  requests: T[],
  cursors: Record<string, string | null | undefined>,
  failed: Set<string>,
  ready: Record<string, boolean | undefined>,
) {
  return failed.size === 0 && requests.every(({ key }) => ready[key] === true && !cursors[key])
}

export function toggleTranscriptFilter(selected: string[], key: string, limit = 100) {
  if (selected.includes(key)) return selected.filter((value) => value !== key)
  if (selected.length >= limit) return selected
  return [...selected, key]
}

export function transcriptQuery(query: string, caseSensitive: boolean) {
  const parsed = parseMessageSearch(query)
  if (parsed.invalid || parsed.empty) return { invalid: parsed.invalid, short: false }
  const pattern = parsed.pattern!
  if (parsed.regex && /[^gimsu]/.test(pattern.flags)) return { invalid: true, short: false }
  if (parsed.regex && !safeRegex(pattern.source)) return { invalid: true, short: false }
  const literal = (query.startsWith("\\/") ? query.slice(1) : query).trim()
  if (!parsed.regex && Array.from(literal).length < 3) return { invalid: true, short: true }
  return {
    invalid: false,
    short: false,
    parameters: {
      query: parsed.regex ? pattern.source : literal,
      mode: parsed.regex ? ("regex" as const) : ("literal" as const),
      caseSensitive: parsed.regex ? !pattern.ignoreCase : caseSensitive,
      ...(parsed.regex ? { flags: pattern.flags.replace(/g/g, "") } : {}),
    },
  }
}

export function transcriptPreview(hit: Pick<TranscriptHit, "excerpt" | "offset" | "excerptOffset" | "matchLength">) {
  const start = Number(hit.offset) - Number(hit.excerptOffset)
  const length = Number(hit.matchLength)
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

export function appendTranscriptHits(previous: TranscriptResult[], incoming: TranscriptResult[]) {
  const seen = new Set(previous.map((result) => `${result.server}\0${result.hit.documentID}:${result.hit.offset}`))
  return [
    ...previous,
    ...incoming.filter((result) => {
      const key = `${result.server}\0${result.hit.documentID}:${result.hit.offset}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  ]
}

export function sortTranscriptHits<T extends { server: string; hit: TranscriptHit }>(
  results: T[],
  sort: "newest" | "oldest" | "session-title",
) {
  return results.sort((left, right) => {
    if (sort === "session-title") {
      const title = compareText(left.hit.title, right.hit.title)
      if (title) return title
    } else {
      const time = Number(left.hit.timeCreated) - Number(right.hit.timeCreated)
      if (time) return sort === "newest" ? -time : time
    }
    const server = compareText(left.server, right.server)
    if (server) return server
    const direction = sort === "newest" ? -1 : 1
    return (
      direction *
      (compareText(left.hit.messageID, right.hit.messageID) || compareText(left.hit.documentID, right.hit.documentID))
    )
  })
}

function compareText(left: string, right: string) {
  const a = utf8.encode(left)
  const b = utf8.encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}

function safeRegex(source: string) {
  let characterClass = false
  let escaped = false
  let run = ""
  let candidate = false
  const flush = () => {
    if (Array.from(run).length >= 3) candidate = true
    run = ""
  }
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v" }
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (escaped) {
      if (/[1-9kpP]/.test(character)) return false
      if (characterClass) {
        escaped = false
        continue
      }
      if (character === "x" && /^[\da-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
        run += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 3), 16))
        index += 2
        escaped = false
        continue
      }
      if (character === "u" && /^[\da-f]{4}$/i.test(source.slice(index + 1, index + 5))) {
        run += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 5), 16))
        index += 4
        escaped = false
        continue
      }
      if (/[\\/.^$*+?()[\]{}|]/.test(character)) {
        run += character
        escaped = false
        continue
      }
      if (escapes[character]) {
        run += escapes[character]
        escaped = false
        continue
      }
      flush()
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (character === "[" && !characterClass) {
      flush()
      characterClass = true
      continue
    }
    if (character === "]" && characterClass) {
      characterClass = false
      continue
    }
    if (!characterClass && /[()*+?{}|]/.test(character)) return false
    if (!characterClass && /[.^$]/.test(character)) {
      flush()
      continue
    }
    if (!characterClass) run += character
  }
  flush()
  return !escaped && !characterClass && candidate
}
