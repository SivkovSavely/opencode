import { describe, expect, test } from "bun:test"
import { QueueCommand } from "@opencode-ai/schema/queue-command"
import type { FollowupDraft } from "./submit"
import { queuePayload } from "./queue-payload"
import { migrateFollowups } from "./queue-migration"

const draft: FollowupDraft = {
  sessionID: "ses_queue",
  sessionDirectory: "/repo",
  agent: "build",
  model: { providerID: "test", modelID: "captured" },
  variant: "high",
  prompt: [
    { type: "text", content: "Review @src/a.ts @explore", start: 0, end: 25 },
    { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 7, end: 16 },
    { type: "agent", name: "explore", content: "@explore", start: 17, end: 25 },
  ],
  context: [
    {
      key: "comment",
      type: "file",
      path: "src/b.ts",
      comment: "Keep this detail",
      selection: { startLine: 2, endLine: 4, startChar: 0, endChar: 0 },
    },
  ],
}

describe("native queue payload", () => {
  test("captures the same normalized files, mentions, comments, model and variant as prompts", async () => {
    const payload = await queuePayload(draft)
    expect(payload).toMatchObject({ kind: "prompt", agent: "build", model: draft.model, variant: "high" })
    if (payload.kind !== "prompt") throw new Error("Expected prompt")
    expect(payload.parts).toContainEqual(expect.objectContaining({ type: "file", url: "file:///repo/src/a.ts" }))
    expect(payload.parts).toContainEqual(
      expect.objectContaining({ type: "file", url: "file:///repo/src/b.ts?start=2&end=4" }),
    )
    expect(payload.parts).toContainEqual(expect.objectContaining({ type: "agent", name: "explore" }))
    expect(payload.parts).toContainEqual(
      expect.objectContaining({ type: "text", synthetic: true, text: expect.stringContaining("Keep this detail") }),
    )
    expect(payload.parts.every((part) => !("id" in part))).toBe(true)
    expect(await queuePayload(draft)).toEqual(payload)
  })
  test("strips parser syntax and rebases mention offsets", async () => {
    const text = "/queue front hello @src/a.ts"
    const command = QueueCommand.parse(text)
    if (command?.type !== "enqueue") throw new Error("Expected enqueue")
    const payload = await queuePayload(
      {
        ...draft,
        context: [],
        prompt: [
          { type: "text", content: text, start: 0, end: text.length },
          { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 19, end: 28 },
        ],
      },
      { command },
    )
    expect(payload).toMatchObject({
      kind: "prompt",
      parts: [
        { type: "text", text: "hello @src/a.ts" },
        { type: "file", source: { text: { start: 6, end: 15 } } },
      ],
    })
  })
  test.each(["/queue !git status", "/queue /compact", "/queue /review all"])(
    "captures %s without converting it into a fake prompt",
    async (text) => {
      const command = QueueCommand.parse(text)
      if (command?.type !== "enqueue") throw new Error("Expected enqueue")
      const payload = await queuePayload({ ...draft, prompt: [], context: [] }, { command })
      expect(payload.kind).toBe(command.kind)
      expect(payload.model).toEqual(draft.model)
      expect(payload.variant).toBe("high")
    },
  )
  test("captures shell mode and command files", async () => {
    expect(
      await queuePayload(
        { ...draft, context: [], prompt: [{ type: "text", content: "pwd", start: 0, end: 3 }] },
        { mode: "shell" },
      ),
    ).toMatchObject({ kind: "shell", command: "pwd" })
    const payload = await queuePayload(
      { ...draft, prompt: [{ type: "text", content: "/review all", start: 0, end: 11 }] },
      { custom: true },
    )
    if (payload.kind !== "command") throw new Error("Expected command")
    expect(payload.arguments).toStartWith("all\n\n")
    expect(payload).toMatchObject({
      kind: "command",
      command: "review",
      arguments: expect.stringContaining("Keep this detail"),
      parts: [{ type: "file", filename: "b.ts" }],
    })
  })
  test("ordinary text cannot become a custom command by dropping its first character", async () => {
    const payload = await queuePayload(
      { ...draft, context: [], prompt: [{ type: "text", content: "preview the change", start: 0, end: 18 }] },
      { custom: true },
    )
    expect(payload).toMatchObject({ kind: "prompt", parts: [{ type: "text", text: "preview the change" }] })
  })
  test("never silently discards attachments from shell or compact inputs", async () => {
    await expect(queuePayload(draft, { mode: "shell" })).rejects.toThrow()
    await expect(
      queuePayload({ ...draft, prompt: [{ type: "text", content: "/compact", start: 0, end: 8 }] }),
    ).rejects.toThrow()
  })
})

describe("local follow-up migration", () => {
  test("preserves ordinary prompt text even when its suffix names a custom command", async () => {
    const submitted: unknown[] = []
    const acknowledged: string[] = []
    await migrateFollowups(
      [
        {
          ...draft,
          id: "plain",
          context: [],
          prompt: [{ type: "text", content: "preview the change", start: 0, end: 18 }],
        },
      ],
      {
        commands: async () => ["review"],
        submit: async (_, input) => {
          submitted.push(input)
          return { sessionID: draft.sessionID, revision: 1, paused: true, blocked: false, items: [] }
        },
        acknowledge: (_, id) => {
          acknowledged.push(id)
        },
      },
    )
    expect(submitted[0]).toMatchObject({
      payload: { kind: "prompt", parts: [{ type: "text", text: "preview the change" }] },
    })
    expect(acknowledged).toEqual(["plain"])
  })
  test("waits for command hydration before classifying or acknowledging a persisted slash command", async () => {
    const commands = Promise.withResolvers<readonly string[]>()
    const submitted: unknown[] = []
    const acknowledged: string[] = []
    const migrating = migrateFollowups(
      [{ ...draft, id: "cold-command", prompt: [{ type: "text", content: "/review detail", start: 0, end: 14 }] }],
      {
        commands: () => commands.promise,
        submit: async (_, input) => {
          submitted.push(input)
          return { sessionID: draft.sessionID, revision: 1, paused: true, blocked: false, items: [] }
        },
        acknowledge: (_, id) => {
          acknowledged.push(id)
        },
      },
    )
    await Promise.resolve()
    expect(submitted).toEqual([])
    expect(acknowledged).toEqual([])
    commands.resolve(["review"])
    await migrating
    expect(submitted[0]).toMatchObject({
      payload: { kind: "command", command: "review", arguments: expect.stringContaining("detail") },
    })
    expect(acknowledged).toEqual(["cold-command"])
  })

  test("preserves unacknowledged drafts and retries with exactly the same ID and payload", async () => {
    const items = [
      { ...draft, id: "old-a" },
      { ...draft, id: "old-b" },
    ]
    const requests: unknown[] = []
    const acknowledged: string[] = []
    const input = {
      commands: async () => [],
      submit: async (_draft: FollowupDraft, submission: unknown) => {
        requests.push(submission)
        throw new Error("lost acknowledgement")
      },
      acknowledge: (_sessionID: string, id: string) => {
        acknowledged.push(id)
      },
    }
    await expect(migrateFollowups(items, input)).rejects.toThrow("lost acknowledgement")
    expect(acknowledged).toEqual([])
    await migrateFollowups(items, {
      ...input,
      submit: async (_draft, submission) => {
        requests.push(submission)
        return { sessionID: draft.sessionID, revision: 2, paused: false, blocked: false, items: [] }
      },
    })
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({ id: "web-followup-old-a" })
    expect(acknowledged).toEqual(["old-a", "old-b"])
  })
  test("does not remove a draft on a malformed success response", async () => {
    const acknowledged: string[] = []
    await expect(
      migrateFollowups([{ ...draft, id: "old" }], {
        commands: async () => [],
        submit: async () => undefined,
        acknowledge: (_sessionID, id) => {
          acknowledged.push(id)
        },
      }),
    ).rejects.toThrow()
    expect(acknowledged).toEqual([])
  })
})
