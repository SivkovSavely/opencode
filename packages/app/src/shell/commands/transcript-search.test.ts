import { expect, test } from "bun:test"
import type { TranscriptSearch } from "@opencode/schema/transcript-search"
import {
  compareResults,
  createTranscriptPagination,
  localDateBounds,
  rankTranscriptFacets,
  transcriptPreview,
  transcriptQuery,
} from "./transcript-search"

const hit = (id: string, timeCreated: number, title = id): TranscriptSearch.Hit => ({
  documentID: id,
  messageID: id,
  partID: `${id}:text:0`,
  sessionID: "session",
  projectID: "project",
  projectPath: "/closed",
  directory: "/closed",
  title,
  role: "user",
  category: "text",
  archived: false,
  timeCreated,
  excerpt: "needle",
  excerptOffset: 0,
  offset: 0,
  matchLength: 6,
  truncated: false,
})

const page = (hits: TranscriptSearch.Hit[], nextCursor?: string, ready = true): TranscriptSearch.Response => ({
  hits,
  nextCursor,
  status: { ready, generation: "one", backfillCursor: "part:" },
  scanned: hits.length,
  complete: ready && !nextCursor,
  contentLimit: 65536,
  scanLimit: 500,
  scanLimited: false,
  truncatedDocuments: 0,
})

test("slash grammar, Unicode minimum, literal case and safe excerpt ranges", () => {
  expect(transcriptQuery("  \\/abc  ", true)).toEqual({ query: "/abc", caseSensitive: true, mode: "literal" })
  expect(transcriptQuery("😀😀", false)).toBeUndefined()
  expect(transcriptQuery("😀😀x", false)?.query).toBe("😀😀x")
  expect(transcriptQuery("a".repeat(257), false)).toBeUndefined()
  expect(transcriptQuery("/" + "a".repeat(256) + "/i", false)?.query).toBe("a".repeat(256))
  expect(transcriptQuery("\\/" + "a".repeat(255), false)?.query).toBe("/" + "a".repeat(255))
  expect(transcriptQuery("/hello", false)).toMatchObject({ mode: "regex", query: "hello" })
  expect(transcriptQuery("/hello/ig", false)?.flags).toContain("i")
  expect(transcriptQuery("/a/z", false)?.query).toBe("a\\/z")
  expect(transcriptPreview({ ...hit("a", 0), excerpt: "😀 needle\n<script>", offset: 3 })).toEqual([
    { text: "😀 ", match: false },
    { text: "needle", match: true },
    { text: "\n<script>", match: false },
  ])
  expect(transcriptPreview({ ...hit("a", 0), offset: -2, matchLength: 5 })).toEqual([
    { text: "nee", match: true },
    { text: "dle", match: false },
  ])
  expect(transcriptPreview({ ...hit("a", 0), offset: Infinity })).toEqual([{ text: "needle", match: false }])
})

test("interleaved server pages compare every required head before emitting", async () => {
  const calls: string[] = []

  const next = createTranscriptPagination(
    ["a", "b"],
    "newest",
    new AbortController().signal,
    async (server, cursor) => {
      calls.push(`${server}:${cursor ?? "start"}`)

      return server === "a"
        ? cursor
          ? page([hit("a2", 2)])
          : page([hit("a9", 9), hit("a4", 4)], "a-next")
        : cursor
          ? page([hit("b1", 1)])
          : page([hit("b8", 8), hit("b6", 6)], "b-next")
    },
  )

  expect((await next(3))?.hits.map((item) => item.hit.documentID)).toEqual(["a9", "b8", "b6"])
  const last = await next(3)
  expect(last?.hits.map((item) => item.hit.documentID)).toEqual(["a4", "a2", "b1"])
  expect(last?.complete).toBe(true)
  expect(calls).toEqual(["a:start", "b:start", "b:b-next", "a:a-next"])

  const ties = createTranscriptPagination(["é", "Z"], "session-title", new AbortController().signal, async () =>
    page([hit("same", 1, "é")]),
  )

  expect((await ties())?.hits.map((item) => item.server)).toEqual(["Z", "é"])
})

test("failure preserves successful buffers and safe prefix, retry uses the same failed cursor", async () => {
  let failed = true
  const calls: string[] = []

  const next = createTranscriptPagination(
    ["a", "b"],
    "newest",
    new AbortController().signal,
    async (server, cursor) => {
      calls.push(`${server}:${cursor ?? "start"}`)

      if (server === "a") return page([hit("a8", 8), hit("a3", 3)])

      if (!cursor) return page([hit("b9", 9)], "failed-cursor")

      if (failed) throw new Error("offline")

      return page([hit("b5", 5)])
    },
  )

  expect((await next())?.hits.map((item) => item.hit.documentID)).toEqual(["b9"])
  failed = false
  expect((await next())?.hits.map((item) => item.hit.documentID)).toEqual(["a8", "b5", "a3"])
  expect(calls.filter((call) => call === "a:start")).toHaveLength(1)
  expect(calls.filter((call) => call === "b:failed-cursor")).toHaveLength(2)
})

test("eight empty pages yield continuation; cycles fail without consuming the cursor", async () => {
  let calls = 0
  let cycle = true
  const cursors: (string | undefined)[] = []

  const next = createTranscriptPagination(["a"], "oldest", new AbortController().signal, async (_, cursor) => {
    cursors.push(cursor)
    calls++

    return calls <= 8 ? page([], String(calls)) : cycle ? page([], "8") : page([hit("found", 1)])
  })

  expect(await next()).toMatchObject({ hits: [], more: true, failed: [] })
  expect(calls).toBe(8)
  expect(await next()).toMatchObject({ hits: [], more: true, failed: ["a"] })
  cycle = false
  expect((await next())?.hits[0]?.hit.documentID).toBe("found")
  expect(cursors.slice(-2)).toEqual(["8", "8"])
})

test("aborted and overlapping generations never publish stale results; incomplete exhaustion is not complete", async () => {
  const controller = new AbortController()
  const held = Promise.withResolvers<TranscriptSearch.Response>()
  const next = createTranscriptPagination(["a"], "newest", controller.signal, () => held.promise)
  const first = next()
  expect(await next()).toBeUndefined()
  controller.abort()
  held.resolve(page([hit("stale", 1)]))
  expect(await first).toBeUndefined()

  const partial = createTranscriptPagination(["a"], "newest", new AbortController().signal, async () =>
    page([hit("partial", 1)], undefined, false),
  )

  expect(await partial()).toMatchObject({ complete: false, more: false })
})

test("UTF-8 ties preserve distinct origins and historical/configured facet ranking is deterministic", () => {
  expect(
    compareResults(
      { server: "z", hit: hit("same", 1, "😀") },
      { server: "a", hit: hit("same", 1, "\ue000") },
      "session-title",
    ),
  ).toBeGreaterThan(0)

  const options = [
    { key: "old", label: "Old", lastUsed: 1 },
    { key: "new", label: "New", lastUsed: Date.now() },
    { key: "configured", label: "Z", configured: true },
    { key: "configured", label: "Historical", lastUsed: 2 },
  ]

  expect(rankTranscriptFacets(options)).toEqual(rankTranscriptFacets(options.toReversed()))
  expect(rankTranscriptFacets(options).map((item) => item.key)).toEqual(["new", "configured", "old"])
  const bounds = localDateBounds("2026-11-06", "2026-11-06")
  expect(new Date(bounds.dateFrom!).getHours()).toBe(0)
  expect(new Date(bounds.dateTo!).getHours()).toBe(23)
  expect(new Date(bounds.dateTo!).getMilliseconds()).toBe(999)
})
