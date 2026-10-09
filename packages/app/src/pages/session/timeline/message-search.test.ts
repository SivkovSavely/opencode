import { describe, expect, test } from "bun:test"
import type { Part, UserMessage } from "@opencode-ai/sdk/v2"
import { chronologicalUserMessages, highlightRanges, normalizePromptText, searchMessages } from "./message-search"

describe("message search", () => {
  test("normalizes all user-authored text and omits synthetic or ignored parts", () => {
    const parts = [
      { type: "text", text: "  first\nline  " },
      { type: "text", text: "generated", synthetic: true },
      { type: "text", text: "ignored", ignored: true },
      { type: "text", text: "second\tline" },
    ] as Part[]

    expect(normalizePromptText(parts)).toBe("first line second line")
  })

  test("sorts user messages by creation time and preserves input order for ties", () => {
    const messages = [
      { id: "late", role: "user", time: { created: 30 } },
      { id: "first", role: "user", time: { created: 10 } },
      { id: "tie", role: "user", time: { created: 30 } },
    ] as UserMessage[]

    expect(chronologicalUserMessages(messages).map((message) => message.id)).toEqual(["first", "late", "tie"])
  })

  test("matches literal text case-insensitively and highlights every match", () => {
    const messages = [{ text: "A literal . dot and another . DOT" }, { text: "no match" }]

    expect(searchMessages(messages, ".", false).matches).toEqual([messages[0]])
    expect(highlightRanges(messages[0].text, ".", false)).toEqual([
      { start: 10, end: 11 },
      { start: 28, end: 29 },
    ])
  })

  test("supports regex matches and reports invalid patterns", () => {
    const messages = [{ text: "issue-123" }, { text: "issue-a" }]

    expect(searchMessages(messages, "issue-\\d+", true).matches).toEqual([messages[0]])
    expect(highlightRanges("issue-123 and issue-45", "\\d+", true)).toEqual([
      { start: 6, end: 9 },
      { start: 20, end: 22 },
    ])
    expect(searchMessages(messages, "[", true)).toEqual({ matches: [], invalid: true })
    expect(highlightRanges("issue-123", "[", true)).toEqual([])
  })

  test("matches literal text without interpreting regex metacharacters", () => {
    const messages = [{ text: "a+b A+B" }, { text: "ab" }]

    expect(searchMessages(messages, "a+b", false).matches).toEqual([messages[0]])
    expect(highlightRanges(messages[0].text, "a+b", false)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ])
  })

  test("returns all messages for a blank query", () => {
    const messages = [{ text: "first" }, { text: "second" }]

    expect(searchMessages(messages, "  ", true)).toEqual({ matches: messages, invalid: false })
  })
})
