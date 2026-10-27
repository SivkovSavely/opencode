import { describe, expect, test } from "bun:test"
import {
  appendTranscriptHits,
  createTranscriptPagination,
  rankTranscriptFacets,
  sortTranscriptHits,
  transcriptPreview,
  transcriptQuery,
  toggleTranscriptFilter,
  type TranscriptHit,
} from "./transcript-search"
import type { TranscriptSearchSearchResponse } from "@opencode-ai/sdk/v2"

describe("transcript search query", () => {
  test("literal, case-sensitive and escaped slash searches", () => {
    expect(transcriptQuery("  hello  ", false).parameters).toEqual({
      query: "hello",
      mode: "literal",
      caseSensitive: false,
    })
    expect(transcriptQuery("Hello", true).parameters?.caseSensitive).toBe(true)
    expect(transcriptQuery("\\/api", false).parameters?.query).toBe("/api")
    expect(transcriptQuery("x", false)).toMatchObject({ invalid: true, short: true })
    expect(transcriptQuery("😀a", false)).toMatchObject({ invalid: true, short: true })
    expect(transcriptQuery("😀ab", false).parameters?.query).toBe("😀ab")
    expect(transcriptQuery("  ", false).parameters).toBeUndefined()
  })
  test("uses jump-to-message delimiter and flag semantics", () => {
    expect(transcriptQuery("/hello", false).parameters).toEqual({
      query: "hello",
      mode: "regex",
      caseSensitive: true,
      flags: "",
    })
    expect(transcriptQuery("/hello/ig", true).parameters).toEqual({
      query: "hello",
      mode: "regex",
      caseSensitive: false,
      flags: "i",
    })
    expect(transcriptQuery("/\\u0061bc/", false).parameters?.query).toBe("\\u0061bc")
    expect(transcriptQuery("/[/", false).invalid).toBe(true)
    expect(transcriptQuery("/a/ii", false).invalid).toBe(true)
    expect(transcriptQuery("/abc/m", false).parameters?.flags).toBe("m")
    // Like jump-to-message, an unknown flag suffix is part of the pattern.
    expect(transcriptQuery("/a/z", false).parameters).toMatchObject({ query: "a\\/z", mode: "regex", flags: "" })
    expect(transcriptQuery("/(a+)+/", false).invalid).toBe(true)
    expect(transcriptQuery("/foo[+]/", false).parameters?.query).toBe("foo[+]")
    expect(transcriptQuery("/./", false).invalid).toBe(true)
  })
})

describe("transcript preview", () => {
  test("translates source offsets into excerpt offsets without changing whitespace", () => {
    expect(transcriptPreview({ excerpt: "a\nmatch b", offset: 102, excerptOffset: 100, matchLength: 5 })).toEqual([
      { text: "a\n", match: false },
      { text: "match", match: true },
      { text: " b", match: false },
    ])
  })
  test("clamps partial matches and ignores nonfinite or out-of-range offsets", () => {
    expect(transcriptPreview({ excerpt: "abc", offset: 9, excerptOffset: 10, matchLength: 3 })).toEqual([
      { text: "ab", match: true },
      { text: "c", match: false },
    ])
    for (const offset of [20, "NaN", "Infinity"] as const) {
      expect(transcriptPreview({ excerpt: "abc", offset, excerptOffset: 0, matchLength: 2 })).toEqual([
        { text: "abc", match: false },
      ])
    }
  })
  test("preserves UTF-16 offsets", () => {
    expect(transcriptPreview({ excerpt: "\uD83D\uDE00 abc", offset: 3, excerptOffset: 0, matchLength: 3 })[1]).toEqual({
      text: "abc",
      match: true,
    })
  })
})

test("pagination deduplicates repeated hits without collapsing different parts or offsets", () => {
  const hit: TranscriptHit = {
    partID: "p1",
    documentID: "p1:text",
    messageID: "m1",
    sessionID: "s1",
    projectID: "project",
    projectPath: "/project",
    title: "title",
    directory: "/project",
    role: "user",
    type: "text",
    category: "text",
    archived: false,
    timeCreated: 1,
    excerpt: "abc",
    offset: 0,
    excerptOffset: 0,
    matchLength: 1,
    truncated: false,
  }
  const first = { server: "server-a", hit }
  const second = { server: "server-a", hit: { ...hit, partID: "p2", documentID: "p2:text" } }
  const sameDocumentOtherServer = { server: "server-b", hit }
  expect(
    appendTranscriptHits([first], [first, second, second, { server: "server-a", hit: { ...hit, offset: 1 } }]),
  ).toEqual([first, second, { server: "server-a", hit: { ...hit, offset: 1 } }])
  expect(appendTranscriptHits([first], [sameDocumentOtherServer])).toEqual([first, sameDocumentOtherServer])
})

test("cross-server results sort deterministically by selected ordering", () => {
  const hit = (title: string, timeCreated: number, documentID: string): TranscriptHit => ({
    partID: documentID,
    documentID,
    messageID: documentID,
    sessionID: documentID,
    projectID: "project",
    projectPath: "/project",
    title,
    directory: "/project",
    role: "assistant",
    type: "text",
    category: "text",
    archived: false,
    timeCreated,
    excerpt: "needle",
    offset: 0,
    excerptOffset: 0,
    matchLength: 6,
    truncated: false,
  })
  const recent = { server: "a", hit: hit("A", 20, "p2") }
  const older = { server: "b", hit: hit("B", 10, "p1") }
  expect(sortTranscriptHits([older, recent], "newest")).toEqual([recent, older])
  expect(sortTranscriptHits([recent, older], "oldest")).toEqual([older, recent])
  expect(sortTranscriptHits([recent, older], "session-title")).toEqual([recent, older])
  const tied = { server: "a", hit: { ...recent.hit, messageID: "m2", documentID: "z", timeCreated: 20 } }
  const tiedBefore = { server: "a", hit: { ...recent.hit, messageID: "m1", documentID: "a", timeCreated: 20 } }
  expect(sortTranscriptHits([tiedBefore, tied], "newest")).toEqual([tied, tiedBefore])
  expect(sortTranscriptHits([tied, tiedBefore], "oldest")).toEqual([tiedBefore, tied])
})

const paginationHit = (id: string, time: number, title = id): TranscriptHit => ({
  documentID: id,
  messageID: id,
  sessionID: id,
  projectID: "p",
  projectPath: "/p",
  title,
  directory: "/p",
  role: "user",
  type: "text",
  category: "text",
  archived: false,
  timeCreated: time,
  excerpt: "abc",
  offset: 0,
  excerptOffset: 0,
  matchLength: 3,
  truncated: false,
})
const page = (hits: TranscriptHit[], nextCursor?: string, ready = true): TranscriptSearchSearchResponse => ({
  hits,
  nextCursor,
  scanned: hits.length,
  complete: ready && !nextCursor,
  scanLimit: 500,
  contentLimit: 65536,
  scanLimited: false,
  truncatedDocuments: 0,
  status: { ready, backfillCursor: "" },
})

test("pagination merges buffered server pages without moving previously emitted hits", async () => {
  for (const sort of ["newest", "oldest", "session-title"] as const) {
    const descending = sort === "newest"
    const items = [1, 2, 3, 4, 5, 6].map((n) => paginationHit(String(n), n))
    const ordered = descending ? items.toReversed() : items
    const calls: string[] = []
    const next = createTranscriptPagination(["a", "b"], sort, new AbortController().signal, async (key, cursor) => {
      calls.push(`${key}:${cursor ?? "start"}`)
      if (key === "a") return cursor ? page([ordered[2]!, ordered[4]!]) : page([ordered[0]!], "a2")
      return cursor ? page([ordered[3]!, ordered[5]!]) : page([ordered[1]!], "b2")
    })
    const first = await next(2)
    const second = await next(2)
    const third = await next(2)
    expect([...(first?.hits ?? []), ...(second?.hits ?? []), ...(third?.hits ?? [])].map((x) => x.hit)).toEqual(ordered)
    expect(first?.more).toBe(true)
    expect(third?.complete).toBe(true)
    expect(calls).toEqual(["a:start", "b:start", "a:a2", "b:b2"])
  }
})

test("pagination pauses on failure and retries the same cursor while retaining other buffers", async () => {
  const calls: string[] = []
  let failed = false
  const next = createTranscriptPagination(["a", "b"], "oldest", new AbortController().signal, async (key, cursor) => {
    calls.push(`${key}:${cursor ?? "start"}`)
    if (key === "a") return cursor ? page([paginationHit("3", 3)]) : page([paginationHit("1", 1)], "next")
    if (!failed) {
      failed = true
      throw new Error("offline")
    }
    return page([paginationHit("2", 2)])
  })
  expect(await next(2)).toMatchObject({ hits: [], failed: ["b"], more: true, complete: false })
  expect((await next(2))?.hits.map((x) => x.hit.documentID)).toEqual(["1", "2"])
  expect((await next(2))?.hits.map((x) => x.hit.documentID)).toEqual(["3"])
  expect(calls).toEqual(["a:start", "b:start", "b:start", "a:next"])
})

test("pagination bounds empty pages, follows cursors and detects cycles without consuming the response", async () => {
  let calls = 0
  const next = createTranscriptPagination(["a"], "oldest", new AbortController().signal, async (_key, cursor) => {
    calls++
    if (calls <= 9) return page([], String(calls))
    if (calls === 10) return page([paginationHit("ignored", 0)], "8")
    expect(cursor).toBe("9")
    return page([paginationHit("final", 1)], undefined, false)
  })
  expect(await next()).toMatchObject({ hits: [], more: true, complete: false })
  expect(calls).toBe(8)
  expect(await next()).toMatchObject({ hits: [], failed: ["a"], more: true })
  expect(await next()).toMatchObject({ hits: [{ hit: { documentID: "final" } }], failed: [], more: false, complete: false })
})

test("pagination clears the scan-limit warning once all results are consumed", async () => {
  const next = createTranscriptPagination(["a"], "oldest", new AbortController().signal, async (_key, cursor) =>
    cursor
      ? page([paginationHit("last", 2)])
      : { ...page([paginationHit("first", 1)], "next"), scanLimited: true },
  )
  expect(await next(1)).toMatchObject({ scanLimited: true, more: true })
  expect(await next(1)).toMatchObject({ scanLimited: false, more: false, complete: true })
})

test("pagination clears the scan warning when only already-fetched hits remain", async () => {
  const next = createTranscriptPagination(["a"], "oldest", new AbortController().signal, async (_key, cursor) =>
    cursor
      ? page([paginationHit("second", 2), paginationHit("third", 3)])
      : { ...page([paginationHit("first", 1)], "next"), scanLimited: true },
  )
  expect(await next(1)).toMatchObject({ scanLimited: true, more: true })
  expect(await next(1)).toMatchObject({ scanLimited: false, more: true })
  expect(await next(1)).toMatchObject({ scanLimited: false, more: false })
})

test("pagination ignores stale in-flight responses after abort", async () => {
  const controller = new AbortController()
  let resolve!: (value: TranscriptSearchSearchResponse) => void
  const next = createTranscriptPagination(["a"], "newest", controller.signal, () =>
    new Promise((done) => {
      resolve = done
    }),
  )
  const pending = next()
  controller.abort()
  resolve(page([paginationHit("stale", 1)]))
  expect(await pending).toBeUndefined()
  expect(await next()).toBeUndefined()
})

test("pagination uses server and document tie breaks and deduplicates repeated hits", async () => {
  const a = paginationHit("a", 1, "same")
  const z = paginationHit("z", 1, "same")
  const next = createTranscriptPagination(["b", "a"], "session-title", new AbortController().signal, async (key, cursor) => {
    if (key === "b") return page([a])
    return cursor ? page([a, z]) : page([a], "next")
  })
  const first = await next(1)
  const rest = await next(3)
  expect(first?.hits.map((x) => `${x.server}:${x.hit.documentID}`)).toEqual(["a:a"])
  expect(rest?.hits.map((x) => `${x.server}:${x.hit.documentID}`)).toEqual(["a:z", "b:a"])
  expect(rest?.complete).toBe(true)
})

test("pagination keeps a safe prefix when a later cursor fails", async () => {
  let fail = true
  const next = createTranscriptPagination(["a", "b"], "oldest", new AbortController().signal, async (key, cursor) => {
    if (key === "b") return page([paginationHit("b", 2)])
    if (!cursor) return page([paginationHit("a", 1)], "next")
    if (fail) {
      fail = false
      throw new Error("offline")
    }
    return page([paginationHit("c", 3)])
  })
  const first = await next(3)
  expect(first?.hits.map((x) => x.hit.documentID)).toEqual(["a"])
  expect(first?.failed).toEqual(["a"])
  const second = await next(3)
  expect(second?.hits.map((x) => x.hit.documentID)).toEqual(["b", "c"])
  expect(second?.complete).toBe(true)
})

test("multi-select filter values cannot exceed the API array bound", () => {
  const selected = Array.from({ length: 100 }, (_, index) => String(index))
  expect(toggleTranscriptFilter(selected, "100")).toBe(selected)
  expect(toggleTranscriptFilter(selected, "0")).toEqual(selected.slice(1))
})

test("facet options merge configured and historical identities and rank by last use", () => {
  const now = 100 * 24 * 60 * 60 * 1000
  const cutoff = now - 30 * 24 * 60 * 60 * 1000
  const options = [
    { key: "a\0old", label: "Server A · old", lastUsed: cutoff - 1 },
    { key: "b\0shared", label: "Server B · shared", lastUsed: cutoff },
    { key: "a\0shared", label: "Server A · historical", lastUsed: cutoff - 10 },
    { key: "a\0shared", label: "Server A · older", lastUsed: cutoff - 20 },
    { key: "a\0shared", label: "Server A · configured", configured: true },
    { key: "b\0configured", label: "Server B · configured", configured: true },
    { key: "a\0recent", label: "Server A · recent", lastUsed: cutoff + 1, configured: true },
    { key: "c\0invalid", label: "Server C · invalid", lastUsed: NaN },
  ]
  const ranked = rankTranscriptFacets(options, now)
  expect(ranked.map((option) => option.key)).toEqual([
    "a\0recent",
    "b\0shared",
    "a\0shared",
    "b\0configured",
    "a\0old",
    "c\0invalid",
  ])
  expect(ranked[2]).toEqual({
    key: "a\0shared",
    label: "Server A · configured",
    lastUsed: cutoff - 10,
    configured: true,
  })
  expect(ranked[5]?.lastUsed).toBeUndefined()
  expect(rankTranscriptFacets(options.toReversed(), now)).toEqual(ranked)
})

test("facet ties sort deterministically by server-qualified label and identity", () => {
  const options = [
    { key: "b\0same", label: "Server B · same", lastUsed: 10 },
    { key: "a\0z", label: "Server A · same", lastUsed: 10 },
    { key: "a\0a", label: "Server A · same", lastUsed: 10 },
    { key: "b\0new", label: "Server B · new", configured: true },
    { key: "a\0new", label: "Server A · new", configured: true },
  ]
  const keys = ["a\0a", "a\0z", "b\0same", "a\0new", "b\0new"]
  expect(rankTranscriptFacets(options, 10).map((option) => option.key)).toEqual(keys)
  expect(rankTranscriptFacets(options.toReversed(), 10).map((option) => option.key)).toEqual(keys)
})

test("facet duplicate labels are deterministic within configured and historical sources", () => {
  const options = [
    { key: "a\0one", label: "Server A · z", lastUsed: 5 },
    { key: "a\0one", label: "Server A · a", lastUsed: 10 },
    { key: "b\0two", label: "Server B · historical", lastUsed: 10 },
    { key: "b\0two", label: "Server B · z", configured: true },
    { key: "b\0two", label: "Server B · a", configured: true },
  ]
  const ranked = rankTranscriptFacets(options, 10)
  expect(ranked.map((option) => option.label)).toEqual(["Server A · a", "Server B · a"])
  expect(rankTranscriptFacets(options.toReversed(), 10)).toEqual(ranked)
})
