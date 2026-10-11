import { describe, expect, test } from "bun:test"
import type { Part, UserMessage } from "@opencode-ai/sdk/v2"
import {
  chronologicalUserMessages,
  firstMatch,
  messagePreview,
  normalizePromptText,
  parseMessageSearch,
  searchMessages,
} from "./message-search"

const measure = (text: string) => text.length * 10
const previewText = (segments: ReturnType<typeof messagePreview>) => segments.map((segment) => segment.text).join("")

describe("message search", () => {
  test("normalizes user-authored text and omits synthetic or ignored parts", () => {
    const parts = [
      { type: "text", text: "  first\nline  " },
      { type: "text", text: "generated", synthetic: true },
      { type: "text", text: "ignored", ignored: true },
      { type: "text", text: "second\tline" },
    ] as Part[]

    expect(normalizePromptText(parts)).toBe("first line second line")
    expect(normalizePromptText([{ type: "file" } as Part])).toBe("")
  })

  test("sorts chronologically, preserves ties, and drops duplicate IDs", () => {
    const messages = [
      { id: "late", role: "user", time: { created: 30 } },
      { id: "first", role: "user", time: { created: 10 } },
      { id: "tie", role: "user", time: { created: 30 } },
      { id: "late", role: "user", time: { created: 40 } },
    ] as UserMessage[]

    expect(chronologicalUserMessages(messages).map((message) => message.id)).toEqual(["first", "late", "tie"])
  })

  test("matches ordinary input as a case-insensitive literal", () => {
    const messages = [{ text: "A literal . dot and another . DOT" }, { text: "no match" }]
    const search = parseMessageSearch(".")

    expect(search.regex).toBe(false)
    expect(searchMessages(messages, search).matches.map((result) => result.item)).toEqual([messages[0]])
    expect(firstMatch(messages[0].text, search)).toEqual({ start: 10, end: 11 })
  })

  test("activates regex from a slash prefix with or without a closing delimiter", () => {
    const messages = [{ text: "issue-123" }, { text: "issue-a" }, { text: "ISSUE-44" }]

    expect(searchMessages(messages, parseMessageSearch("/issue-\\d+")).matches.map((result) => result.item)).toEqual([
      messages[0],
    ])
    expect(searchMessages(messages, parseMessageSearch("/issue-\\d+/")).matches.map((result) => result.item)).toEqual([
      messages[0],
    ])
    expect(searchMessages(messages, parseMessageSearch("/issue-\\d+/i")).matches.map((result) => result.item)).toEqual([
      messages[0],
      messages[2],
    ])
    expect(parseMessageSearch("/issue-\\d+").regex).toBe(true)
  })

  test("uses case-sensitive regex by default and honors the explicit case-insensitive flag", () => {
    const messages = [{ text: "Alpha" }, { text: "alpha" }]

    expect(searchMessages(messages, parseMessageSearch("/alpha")).matches.map((result) => result.item)).toEqual([
      messages[1],
    ])
    expect(searchMessages(messages, parseMessageSearch("/alpha/i")).matches.map((result) => result.item)).toEqual(messages)
  })

  test("supports regex flags accepted by the current JavaScript runtime", () => {
    for (const flag of ["d", "g", "i", "m", "s", "u", "v", "y"]) {
      let supported = true
      try {
        new RegExp("a", flag)
      } catch {
        supported = false
      }
      if (!supported) continue
      const result = parseMessageSearch(`/a/${flag}`)
      expect(result.invalid, flag).toBe(false)
      expect(result.regex, flag).toBe(true)
    }
  })

  test("lets RegExp reject duplicate and incompatible flags and invalid expressions", () => {
    expect(parseMessageSearch("/abc/ii")).toMatchObject({ regex: true, invalid: true })
    expect(parseMessageSearch("/abc/uv")).toMatchObject({ regex: true, invalid: true })
    expect(parseMessageSearch("/[")).toMatchObject({ regex: true, invalid: true })
    expect(searchMessages([{ text: "anything" }], parseMessageSearch("/["))).toEqual({ matches: [], invalid: true })

    const unknownFlag = parseMessageSearch("/abc/z")
    expect(unknownFlag).toMatchObject({ regex: true, invalid: false })
    expect(firstMatch("abc/z", unknownFlag)).toEqual({ start: 0, end: 5 })
  })

  test("supports classes, alternation, quantifiers, escapes, and slash delimiters", () => {
    const messages = [
      { text: "issue-12-ab" },
      { text: "model state" },
      { text: "session state" },
      { text: "/" },
    ]

    expect(searchMessages(messages, parseMessageSearch("/issue-\\d+-\\w+/i")).matches.map((result) => result.item)).toEqual([
      messages[0],
    ])
    expect(searchMessages(messages, parseMessageSearch("/model|session/i")).matches.map((result) => result.item)).toEqual([
      messages[1],
      messages[2],
    ])
    expect(firstMatch("issue-123", parseMessageSearch("/issue-[0-9]+/"))).toEqual({ start: 0, end: 9 })
    expect(firstMatch("/", parseMessageSearch("/\\//"))).toEqual({ start: 0, end: 1 })
    expect(searchMessages([{ text: "/api" }, { text: "api" }], parseMessageSearch("\\/api")).matches.map((result) => result.item)).toEqual([
      { text: "/api" },
    ])
    expect(firstMatch("/", parseMessageSearch("\\/"))).toEqual({ start: 0, end: 1 })
  })

  test("preserves meaningful regex whitespace and trims only literal queries", () => {
    const messages = [{ text: "hello world" }, { text: "helloworld" }]

    expect(searchMessages(messages, parseMessageSearch("/hello world")).matches.map((result) => result.item)).toEqual([
      messages[0],
    ])
    expect(searchMessages(messages, parseMessageSearch("  hello  ")).matches.map((result) => result.item)).toEqual(messages)
    expect(parseMessageSearch("   ").empty).toBe(true)
    expect(parseMessageSearch("").empty).toBe(true)
  })

  test("finds the first match at the beginning, middle, or end", () => {
    const search = parseMessageSearch("/needle")

    expect(firstMatch("needle at start", search)).toEqual({ start: 0, end: 6 })
    expect(firstMatch("in the middle needle here", search)).toEqual({ start: 14, end: 20 })
    expect(firstMatch(`${"x".repeat(500)}needle`, search)).toEqual({ start: 500, end: 506 })
  })

  test("returns zero-width matches without iterating over every occurrence", () => {
    const search = parseMessageSearch("/(?=a)/g")

    expect(firstMatch("aaa", search)).toEqual({ start: 0, end: 0 })
    expect(searchMessages([{ text: "aaa" }, { text: "baa" }], search).matches).toHaveLength(2)
  })

  test("resets global and sticky regex state for each message", () => {
    for (const flag of ["g", "y"]) {
      const search = parseMessageSearch(`/a/${flag}`)
      const texts = [{ text: "a" }, { text: "a" }]
      expect(searchMessages(texts, search).matches.map((result) => result.item)).toEqual(texts)
      expect(firstMatch("a", search)).toEqual({ start: 0, end: 1 })
      expect(firstMatch("a", search)).toEqual({ start: 0, end: 1 })
    }
  })

  test("returns all messages for an empty query, including empty attachment text", () => {
    const messages = [{ text: "first" }, { text: "" }, { text: "second" }]

    expect(searchMessages(messages, parseMessageSearch("  ")).matches.map((result) => result.item)).toEqual(messages)
  })
})

describe("message previews", () => {
  test("truncates an unsearched preview to measured width with an ellipsis", () => {
    const preview = messagePreview("one two three", 70, undefined, measure)

    expect(previewText(preview)).toBe("one tw…")
    expect(measure(previewText(preview))).toBeLessThanOrEqual(70)
  })

  test("shows nearby matches naturally without an unnecessary leading ellipsis", () => {
    const text = "A start with the match nearby and more context"
    const match = { start: 13, end: 18 }
    const preview = messagePreview(text, 200, match, measure)

    expect(preview[0]).toEqual({ text: "A start with ", match: false })
    expect(preview.find((segment) => segment.match)).toEqual({ text: "the m", match: true })
    expect(previewText(preview)).not.toMatch(/^…/)
  })

  test("preserves the message beginning and context around a deep match", () => {
    const prefix = "The opening words make this message recognizable. "
    const middle = "details immediately before the target phrase"
    const suffix = " and useful words after it"
    const text = `${prefix}${middle}TARGET${suffix}`
    const match = { start: prefix.length + middle.length, end: prefix.length + middle.length + 6 }
    const preview = messagePreview(text, 260, match, measure)
    const flattened = previewText(preview)

    expect(flattened.startsWith("The ")).toBe(true)
    expect(flattened).toContain("…")
    expect(preview.find((segment) => segment.match)).toEqual({ text: "TARGET", match: true })
    expect(flattened.indexOf("TARGET")).toBeGreaterThan(flattened.indexOf("…"))
    expect(measure(flattened)).toBeLessThanOrEqual(260)
  })

  test("keeps context for a match at the end of a long message", () => {
    const text = `${"recognizable beginning ".repeat(30)}context before END`
    const match = { start: text.length - 3, end: text.length }
    const preview = messagePreview(text, 240, match, measure)
    const flattened = previewText(preview)

    expect(flattened.startsWith("recog")).toBe(true)
    expect(flattened).toContain("context before")
    expect(preview.find((segment) => segment.match)).toEqual({ text: "END", match: true })
    expect(preview.some((segment) => segment.match && segment.text.includes("…"))).toBe(false)
  })

  test("keeps a suffix match visible and within measured width beside surrogate pairs", () => {
    const text = `${"a".repeat(30)}${"😀".repeat(30)}x`
    const measureUnicode = (value: string) =>
      Array.from(value).reduce((width, character) => {
        const codePoint = character.codePointAt(0) ?? 0
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) return width
        return width + (character === "😀" ? 13 : 5)
      }, 0)
    for (const width of [193, 240, 320]) {
      const preview = messagePreview(text, width, { start: text.length - 1, end: text.length }, measureUnicode)
      const flattened = previewText(preview)

      expect(preview.find((segment) => segment.match), `${width}px match`).toEqual({ text: "x", match: true })
      expect(measureUnicode(flattened), `${width}px width`).toBeLessThanOrEqual(width)
      expect(
        Array.from(flattened).every((character) => {
          const codePoint = character.codePointAt(0) ?? 0
          return codePoint < 0xd800 || codePoint > 0xdfff
        }),
        `${width}px surrogate safety`,
      ).toBe(true)
    }
  })

  test("truncates very long matches safely while highlighting the actual displayed text", () => {
    const text = `before ${"ActualMatch".repeat(40)} after`
    const start = 7
    const preview = messagePreview(text, 100, { start, end: text.length - 6 }, measure)
    const mark = preview.find((segment) => segment.match)
    const flattened = previewText(preview)

    expect(mark).toBeDefined()
    if (!mark) return
    expect(text.slice(start, start + mark.text.length)).toBe(mark.text)
    expect(flattened).toContain("…")
    expect(measure(flattened)).toBeLessThanOrEqual(100)
  })

  test("fits very narrow widths and does not overflow the row", () => {
    const text = `${"beginning ".repeat(20)}needle`
    const start = text.length - 6
    const preview = messagePreview(text, 20, { start, end: text.length }, measure)

    expect(preview.find((segment) => segment.match)?.text).toMatch(/^n/)
    expect(measure(previewText(preview))).toBeLessThanOrEqual(20)
  })

  test("uses newly measured space after resize instead of fixed character limits", () => {
    const text = `${"introductory context ".repeat(8)}near-match-and-suffix`
    const start = text.indexOf("near-match")
    const match = { start, end: start + 10 }
    const narrow = messagePreview(text, 140, match, measure)
    const wide = messagePreview(text, 320, match, measure)

    expect(previewText(wide).length).toBeGreaterThan(previewText(narrow).length)
    expect(measure(previewText(narrow))).toBeLessThanOrEqual(140)
    expect(measure(previewText(wide))).toBeLessThanOrEqual(320)
  })

  test("shows all context without ellipses when the measured width is sufficient", () => {
    const text = "beginning match ending"
    const preview = messagePreview(text, 500, { start: 10, end: 15 }, measure)

    expect(previewText(preview)).toBe(text)
    expect(preview.some((segment) => segment.text === "…")).toBe(false)
  })

  test("shows useful context around a zero-width match without a fake highlight", () => {
    const text = `${"beginning words ".repeat(20)}here`
    const start = text.length - 2
    const preview = messagePreview(text, 180, { start, end: start }, measure)

    expect(preview.some((segment) => segment.match)).toBe(false)
    expect(previewText(preview)).toContain("here")
    expect(measure(previewText(preview))).toBeLessThanOrEqual(180)
  })

  test("keeps user text as text segments instead of interpreting markup", () => {
    const text = "<img src=x onerror=alert(1)>"
    const preview = messagePreview(text, 500, undefined, measure)

    expect(preview).toEqual([{ text, match: false }])
  })
})
