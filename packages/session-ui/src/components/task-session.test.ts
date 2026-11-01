import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { taskSession } from "./task-session"

const sessions = [
  {
    id: "reused",
    parentID: "parent",
    title: "old task @Agent",
    time: { created: 1 },
    metadata: { task: { parentCallID: "historical-call" } },
  },
  { id: "newer", parentID: "parent", title: "work @Agent", time: { created: 2 } },
  { id: "other", parentID: "other-parent", title: "work @Agent", time: { created: 3 } },
  { id: "archived", parentID: "parent", title: "work @Agent", time: { created: 4, archived: 5 } },
] as Session[]

const base = { task: { description: "work" }, metadata: {}, parentID: "parent", currentID: "parent", sessions }

describe("taskSession", () => {
  test.each([false, true])("resolves a reused child for error and normal cards (fallback: %s)", (titleFallback) => {
    expect(taskSession({ ...base, task: { ...base.task, task_id: "reused" }, titleFallback })).toBe("reused")
  })

  test.each([false, true])(
    "uses uncached and archived explicit children but rejects mismatched cached parents (fallback: %s)",
    (titleFallback) => {
      expect(taskSession({ ...base, task: { ...base.task, task_id: "missing" }, titleFallback })).toBe("missing")
      expect(taskSession({ ...base, task: { ...base.task, task_id: "other" }, titleFallback })).toBeUndefined()
      expect(taskSession({ ...base, task: { ...base.task, task_id: "reused" }, sessions: [], titleFallback })).toBe(
        "reused",
      )
      expect(taskSession({ ...base, task: { ...base.task, task_id: "archived" }, titleFallback })).toBe("archived")
    },
  )

  test.each([false, true])("fails closed for malformed explicit linkage (fallback: %s)", (titleFallback) => {
    for (const value of [
      undefined,
      null,
      "",
      "  ",
      "bad id",
      "../other",
      "ses_a/../../s/other",
      "ses_a?x",
      "ses_a#x",
      "ses_a%2f",
      42,
    ]) {
      expect(
        taskSession({
          ...base,
          metadata: { sessionId: value },
          task: { ...base.task, task_id: "reused" },
          titleFallback,
        }),
      ).toBeUndefined()
      expect(taskSession({ ...base, task: { ...base.task, task_id: value }, titleFallback })).toBeUndefined()
    }
  })

  test.each([false, true])(
    "keeps explicit metadata authoritative on conflicting linkage (fallback: %s)",
    (titleFallback) => {
      expect(
        taskSession({ ...base, task: { task_id: "reused" }, metadata: { sessionId: "other" }, titleFallback }),
      ).toBe("other")
    },
  )

  test("preserves the normal card title fallback without adding it to errors", () => {
    expect(taskSession({ ...base, agent: "Agent", titleFallback: true })).toBe("newer")
    expect(taskSession({ ...base, agent: "Agent" })).toBeUndefined()
  })

  test("does not navigate using a different or unknown provider session", () => {
    for (const currentID of ["other-parent", undefined]) {
      expect(taskSession({ ...base, currentID, metadata: { sessionId: "reused" } })).toBeUndefined()
      expect(taskSession({ ...base, currentID, task: { task_id: "reused" } })).toBeUndefined()
      expect(taskSession({ ...base, currentID, titleFallback: true })).toBeUndefined()
    }
  })
})
