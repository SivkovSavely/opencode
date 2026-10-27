import { describe, expect, test } from "bun:test"
import {
  appendTranscriptHits,
  sortTranscriptHits,
  transcriptPreview,
  transcriptQuery,
  transcriptSearchComplete,
  transcriptServersToFetch,
  toggleTranscriptFilter,
  type TranscriptHit,
} from "./transcript-search"

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

test("cross-server pagination keeps failed servers retryable without restarting completed servers", () => {
  const requests = [{ key: "a" }, { key: "b" }, { key: "c" }]
  const cursors = { a: "next", b: undefined, c: null }
  const failed = new Set(["b"])
  expect(transcriptServersToFetch(requests, cursors, failed, false)).toEqual(requests)
  expect(transcriptServersToFetch(requests, cursors, failed, true)).toEqual([requests[0], requests[1]])
})

test("cross-server completion accounts for exhausted servers while another is backfilling", () => {
  const requests = [{ key: "done" }, { key: "indexing" }]
  expect(
    transcriptSearchComplete(requests, { done: undefined, indexing: "next" }, new Set(), {
      done: true,
      indexing: false,
    }),
  ).toBe(false)
  expect(
    transcriptSearchComplete(requests, { done: undefined, indexing: undefined }, new Set(), {
      done: true,
      indexing: true,
    }),
  ).toBe(true)
  expect(transcriptSearchComplete(requests, {}, new Set(["indexing"]), { done: true, indexing: false })).toBe(false)
})

test("multi-select filter values cannot exceed the API array bound", () => {
  const selected = Array.from({ length: 100 }, (_, index) => String(index))
  expect(toggleTranscriptFilter(selected, "100")).toBe(selected)
  expect(toggleTranscriptFilter(selected, "0")).toEqual(selected.slice(1))
})
