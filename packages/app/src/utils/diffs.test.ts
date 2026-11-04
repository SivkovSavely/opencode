import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { diffs, message } from "./diffs"

const item = {
  file: "src/app.ts",
  patch: "@@ -1 +1 @@\n-old\n+new\n",
  additions: 1,
  deletions: 1,
  status: "modified",
} satisfies FileDiffInfo & SnapshotFileDiff

describe("diffs", () => {
  test("keeps valid arrays", () => {
    expect(diffs([item])).toEqual([item])
  })

  test("wraps a single diff object", () => {
    expect(diffs(item)).toEqual([item])
  })

  test("reads keyed diff objects", () => {
    expect(diffs({ a: item })).toEqual([item])
  })

  test("drops invalid entries", () => {
    expect(
      diffs([
        item,
        { file: "src/bad.ts", additions: 1, deletions: 1 },
        { patch: item.patch, additions: 1, deletions: 1 },
      ]),
    ).toEqual([item])
  })

  test("retains named omissions and no-file aggregate statistics", () => {
    const omitted = { ...item, patch: "", omitted: { reason: "patch-budget", files: 1 } }
    const aggregate = { additions: 200, deletions: 100, omitted: { reason: "input-budget", files: 900 } }
    const unknown = { additions: 0, deletions: 0, omitted: { reason: "input-budget" } }

    expect(diffs([omitted, aggregate, unknown])).toEqual([omitted, aggregate, unknown])
    expect(diffs({ first: aggregate })).toEqual([aggregate])
    expect(diffs([{ additions: 1, deletions: 0, omitted: { reason: "bad", files: -1 } }])).toEqual([])
  })
})

describe("message", () => {
  test("normalizes user summaries with object diffs", () => {
    const input = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      summary: {
        title: "Edit",
        diffs: { a: item },
      },
    } as unknown as Message

    expect(message(input)).toMatchObject({
      summary: {
        title: "Edit",
        diffs: [item],
      },
    })
  })

  test("drops invalid user summaries", () => {
    const input = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      summary: true,
    } as unknown as Message

    expect(message(input)).toMatchObject({ summary: undefined })
  })
})
