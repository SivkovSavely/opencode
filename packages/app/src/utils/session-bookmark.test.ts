import { describe, expect, test } from "bun:test"
import { sessionBookmarkRollback, updateSessionBookmark, updateSessionBookmarkPending } from "./session-bookmark"

describe("updateSessionBookmark", () => {
  test("updates only the target using its latest cached session", () => {
    const sessionA = { id: "ses_a", title: "new title", cost: 12, tokens: { input: 8, output: 1 }, bookmarked: false }
    const sessionB = { id: "ses_b", title: "session B", cost: 3, tokens: { input: 2, output: 2 }, bookmarked: false }
    const info = new Map([
      [sessionA.id, sessionA],
      [sessionB.id, sessionB],
    ])

    updateSessionBookmark({
      session: {
        get: (sessionID) => info.get(sessionID),
        remember: (session) => info.set(session.id, session),
      },
      sessionID: sessionB.id,
      bookmarked: true,
    })

    expect(info.get(sessionA.id)).toEqual(sessionA)
    expect(info.get(sessionB.id)).toEqual({ ...sessionB, bookmarked: true })
  })
})

describe("updateSessionBookmarkPending", () => {
  test("keeps another session pending when switching between sessions", () => {
    const first = updateSessionBookmarkPending(new Set(), "ses_a", true)
    expect(first.has("ses_b")).toBe(false)

    const both = updateSessionBookmarkPending(first, "ses_b", true)
    const afterFirstFinishes = updateSessionBookmarkPending(both, "ses_a", false)
    expect(afterFirstFinishes.has("ses_b")).toBe(true)
  })
})

describe("sessionBookmarkRollback", () => {
  test("restores the captured state when PATCH and recovery GET fail", () => {
    let session = { id: "ses_1", bookmarked: false }
    const optimistic = updateSessionBookmark({
      session: {
        get: () => session,
        remember: (next) => (session = next),
      },
      sessionID: session.id,
      bookmarked: true,
    })
    expect(optimistic?.previous).toBe(false)

    expect(
      sessionBookmarkRollback({
        expectedRevision: 2,
        currentRevision: 2,
        persisted: undefined,
        previous: optimistic?.previous,
      }),
    ).toBe(false)
  })

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
