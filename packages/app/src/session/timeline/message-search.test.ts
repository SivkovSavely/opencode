import { describe, expect, test } from "bun:test"
import {
  chronologicalUserMessages,
  createHistoryProgress,
  messagePreview,
  normalizePromptText,
  parseMessageSearch,
  promptSearchItems,
  searchMessages,
} from "./message-search"
import { selectSessionUserMessages, selectVisibleSessionUserMessages } from "../session-domain"
import type { SessionMessageInfo } from "@opencode/client/promise"

describe("jump message search", () => {
  test("native eligible users, Unicode whitespace, attachments and unloaded revert boundaries", () => {
    const messages: SessionMessageInfo[] = [
      { id: "msg_a", type: "user", text: "  first\npart\t second\u00a0part\u2003third  ", time: { created: 1 } },
      { id: "msg_b", type: "synthetic", text: "excluded", time: { created: 2 } },
      {
        id: "msg_c",
        type: "user",
        text: "",
        files: [{ mime: "text/plain", data: "", source: { type: "uri", uri: "file:///notes.txt" }, name: "notes.txt" }],
        time: { created: 3 },
      },
      { id: "msg_d", type: "user", text: "", time: { created: 4 } },
    ]

    const items = promptSearchItems(selectSessionUserMessages(messages))
    expect(items.map((item) => item.text)).toEqual(["first part second part third", "", ""])
    expect(searchMessages(items, parseMessageSearch("")).map((item) => item.id)).toEqual(["msg_a", "msg_c", "msg_d"])

    for (const query of ["excluded", "notes.txt", "Attachment"])
      expect(searchMessages(items, parseMessageSearch(query))).toEqual([])
    expect(
      selectVisibleSessionUserMessages(selectSessionUserMessages(messages), "msg_bb").map((item) => item.id),
    ).toEqual(["msg_a"])
    expect(normalizePromptText("\u2028a\r\n b\u2029")).toBe("a b")
  })

  test("first duplicate wins, chronology stable and missing dates last", () => {
    const messages = [
      { id: "z", time: { created: 2 } },
      { id: "a", time: { created: 1 } },
      { id: "a", time: { created: 0 } },
      { id: "y", time: { created: 2 } },
      { id: "b" },
    ]

    expect(chronologicalUserMessages(messages).map((item) => item.id)).toEqual(["a", "z", "y", "b"])
  })

  test.each([
    [" .[] ", ".[]", true],
    ["a", "A", true],
    [" ", "", true],
    ["\\/abc", "/ABC", true],
    [" /abc", "/ABC", true],
    ["/issue-\\d+", "issue-123", true],
    ["/issue-\\d+/", "ISSUE-123", false],
    ["/(issue|bug)-(\\d+)/i", "BUG-123", true],
    ["/abc/z", "abc/z", true],
    ["/a\\/b/i", "A/B", true],
    ["/ abc /", " abc ", true],
    ["/abc/ii", "abc", false],
    ["/[", "abc", false],
    ["/a/uv", "a", false],
    ["/(?=abc)/g", "abc", true],
    ["//", "", true],
  ])("grammar %s over %s", (query, text, matches) => {
    expect(searchMessages([{ id: "one", text }], parseMessageSearch(query)).length > 0).toBe(matches)
  })

  test("one exec per prompt; global/sticky state reset; zero-width does not fabricate text", () => {
    const messages = ["abc abc", "abc", "zabc"].map((text, index) => ({ id: String(index), text }))
    expect(searchMessages(messages, parseMessageSearch("/abc/g")).map((item) => item.id)).toEqual(["0", "1", "2"])
    expect(searchMessages(messages, parseMessageSearch("/abc/y")).map((item) => item.id)).toEqual(["0", "1"])
    expect(searchMessages(messages, parseMessageSearch("/(?=abc)/")).map((item) => item.match)).toEqual([
      { start: 0, end: 0 },
      { start: 0, end: 0 },
      { start: 1, end: 1 },
    ])
    expect(messagePreview("abc", 10, { start: 0, end: 0 }, (text) => text.length).some((item) => item.match)).toBe(
      false,
    )
  })

  test("measured preview keeps deep and end hits, inert markup and code-point boundaries", () => {
    const measure = (text: string) => Array.from(text).reduce((sum, point) => sum + (point === "W" ? 3 : 1), 0)

    for (const text of ["prefix ".repeat(30) + "😀needle", "prefix ".repeat(30) + "😀needle tail"]) {
      const start = text.indexOf("needle")

      for (const width of [10, 20, 60, 400]) {
        const segments = messagePreview(text, width, { start, end: start + 6 }, measure)
        const rendered = segments.map((item) => item.text).join("")
        expect(measure(rendered)).toBeLessThanOrEqual(width)
        expect(
          segments
            .filter((item) => item.match)
            .map((item) => item.text)
            .join(""),
        ).toBe("needle")
        expect(rendered.isWellFormed()).toBe(true)

        if (width < 60) expect(rendered).toContain("…")
      }
    }

    expect(messagePreview("needle tail", 20, { start: 0, end: 6 }, measure)[0]).toEqual({ text: "needle", match: true })
    expect(messagePreview("<script>alert(1)</script>", 60, undefined, measure)).toEqual([
      { text: "<script>alert(1)</script>", match: false },
    ])
    const clipped = messagePreview("😀".repeat(30), 8, { start: 0, end: 60 }, measure)
    expect(clipped.map((item) => item.text).join("")).toBe("😀".repeat(7) + "…")

    for (const match of [
      { start: 1, end: 2 },
      { start: 0, end: 1 },
      { start: 1, end: 1 },
    ]) {
      const segments = messagePreview("😀 tail", 5, match, measure)
      expect(segments.every((segment) => segment.text.isWellFormed())).toBe(true)

      if (match.start === match.end) expect(segments.some((segment) => segment.match)).toBe(false)
    }
  })

  test("paging accepts shared/skipped and advancing empty/overlap pages, stops no-progress/cycles, resets on retry", () => {
    const progress = createHistoryProgress()

    const page = (before: string, after: string | undefined, records = 0) => ({
      status: "loaded" as const,
      before: { cursor: before, records },
      after: { cursor: after, records },
    })

    expect(progress.accept({ ...page("a", "a"), status: "shared" })).toBe(true)
    expect(progress.accept({ ...page("a", "a"), status: "skipped" })).toBe(true)
    expect(progress.accept(page("a", "b"))).toBe(true)
    expect(progress.accept(page("b", "c"))).toBe(true)
    expect(progress.accept(page("c", undefined))).toBe(true)
    progress.clear()
    expect(progress.accept(page("a", "a"))).toBe(false)
    progress.clear()
    expect(progress.accept(page("a", "b"))).toBe(true)
    expect(progress.accept(page("b", "a"))).toBe(false)
    progress.clear()
    expect(progress.accept(page("a", undefined))).toBe(true)
  })

  test("a full fitting preview is not clipped to make room for wider omission markers", () => {
    const text = "l" + "i".repeat(10)
    const measure = (value: string) => Array.from(value).reduce((sum, point) => sum + (point === "…" ? 3 : 1), 0)
    expect(messagePreview(text, 11, { start: 1, end: 11 }, measure)).toEqual([
      { text: "l", match: false },
      { text: "i".repeat(10), match: true },
    ])
  })

  test("tiny deep-match previews budget every omission marker and retain Unicode boundaries", () => {
    const measure = (text: string) => Array.from(text).length

    for (const value of ["abc", "😀😀😀"]) {
      const text = "long prefix " + value + " tail"
      const match = { start: 12, end: 12 + value.length }

      for (let width = 0; width <= 8; width++) {
        const segments = messagePreview(text, width, match, measure)
        const rendered = segments.map((segment) => segment.text).join("")
        expect(measure(rendered)).toBeLessThanOrEqual(width)
        expect(rendered.isWellFormed()).toBe(true)

        const highlighted = segments
          .filter((segment) => segment.match)
          .map((segment) => segment.text)
          .join("")

        expect(value.startsWith(highlighted)).toBe(true)

        if (highlighted && highlighted !== value) expect(segments.at(-1)).toEqual({ text: "…", match: false })
      }

      expect(messagePreview(text, 3, match, measure)).toEqual([
        { text: "…", match: false },
        { text: Array.from(value)[0], match: true },
        { text: "…", match: false },
      ])
    }
  })
})
