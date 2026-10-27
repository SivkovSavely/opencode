import { describe, expect, test } from "bun:test"
import { sessionBookmarkRollback } from "./session-bookmark"

describe("sessionBookmarkRollback", () => {
  test("uses the server value when no newer bookmark event arrived", () => {
    expect(sessionBookmarkRollback({ expectedRevision: 2, currentRevision: 2, persisted: false, previous: true })).toBe(
      false,
    )
  })

  test("ignores a stale recovery response after a newer event", () => {
    expect(
      sessionBookmarkRollback({ expectedRevision: 2, currentRevision: 3, persisted: false, previous: false }),
    ).toBeUndefined()
  })
})
