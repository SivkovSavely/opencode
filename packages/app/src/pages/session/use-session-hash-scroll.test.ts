import { describe, expect, test } from "bun:test"
import { messageIdFromHash, searchMessageTargetFromHash } from "./message-id-from-hash"

describe("messageIdFromHash", () => {
  test("parses hash with leading #", () => {
    expect(messageIdFromHash("#message-abc123")).toBe("abc123")
  })

  test("parses raw hash fragment", () => {
    expect(messageIdFromHash("message-42")).toBe("42")
  })

  test("ignores non-message anchors", () => {
    expect(messageIdFromHash("#review-panel")).toBeUndefined()
  })
})

describe("searchMessageTargetFromHash", () => {
  test("parses stable message and part targets", () => {
    const target = encodeURIComponent(JSON.stringify({ messageID: "assistant:1", partID: "part:2" }))
    expect(searchMessageTargetFromHash(`#search:${target}`)).toEqual({ messageID: "assistant:1", partID: "part:2" })
  })

  test("accepts message-only targets and ignores malformed search anchors", () => {
    expect(
      searchMessageTargetFromHash(`#search:${encodeURIComponent(JSON.stringify({ messageID: "assistant:1" }))}`),
    ).toEqual({
      messageID: "assistant:1",
      partID: undefined,
    })
    expect(searchMessageTargetFromHash("#search:%7Bbad")).toBeUndefined()
    expect(searchMessageTargetFromHash("#message-user")).toBeUndefined()
  })
})
