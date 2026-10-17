import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { Schema } from "effect"
import { QueueCommand } from "@opencode-ai/schema/queue-command"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { SessionV1 } from "@opencode-ai/schema/v1/session"
import { SessionID } from "@opencode-ai/schema/session-id"
import { createQueueController, queuePreview, queueRows, type QueueAPI } from "../src/queue/controller"
import { createQueueDialog } from "../src/queue/dialog"
import { queuePayload, queueSubmissionKey } from "../src/queue/payload"
import { expandTrackedPastedText } from "../src/prompt/part"

const sessionID = SessionID.make("ses_queue")
const captured = { agent: "build", model: { providerID: "provider", modelID: "model" }, variant: "high" }

test("Home queue retries distinguish destination directories, copies and workspaces", () => {
  const input = {
    payload: { ...captured, kind: "prompt" as const, parts: [{ type: "text" as const, text: "same input" }] },
    front: false,
    location: { directory: "/repo/a", workspaceID: "workspace-a", newCopy: false },
  }
  const key = queueSubmissionKey(input)
  expect(queueSubmissionKey(structuredClone(input))).toBe(key)
  for (const location of [
    { ...input.location, directory: "/repo/b" },
    { ...input.location, workspaceID: "workspace-b" },
    { ...input.location, newCopy: true },
  ]) {
    expect(queueSubmissionKey({ ...input, location })).not.toBe(key)
  }
})

function entry(id: string, options: Partial<SessionQueueV1.Entry> = {}): SessionQueueV1.Entry {
  return {
    id,
    sessionID,
    delivery: "queue",
    state: "pending",
    position: 0,
    created: 0,
    payload: { ...captured, kind: "prompt", parts: [{ type: "text", text: id }] },
    ...options,
  }
}

function snapshot(items: SessionQueueV1.Entry[] = [], revision = 1): SessionQueueV1.Snapshot {
  return { sessionID, revision, paused: false, blocked: false, items }
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}

function harness(initial = snapshot(), overrides: Partial<QueueAPI> = {}) {
  let server = initial
  const mutations: SessionQueueV1.Update[] = []
  const submissions: SessionQueueV1.Submit[] = []
  const queue = createQueueController({
    list: async () => server,
    submit: async (_, input) => {
      submissions.push(input)
      return server
    },
    update: async (_, input) => {
      mutations.push(input)
      return server
    },
    flush: async () => server,
    ...overrides,
  })
  return {
    queue,
    mutations,
    submissions,
    server(value: SessionQueueV1.Snapshot) {
      server = value
    },
  }
}

describe("native queue submission", () => {
  test("captured model does not change while admission is awaiting the server", () => {
    const selection = { ...captured, model: { ...captured.model } }
    const parsed = QueueCommand.parse("/queue hello")
    if (parsed?.type !== "enqueue") throw new Error("expected enqueue")
    const payload = queuePayload(parsed, selection, [])
    selection.model.modelID = "different-model"
    expect(payload.model.modelID).toBe("model")
  })

  test.each([
    ["/queue abc", "prompt", false],
    ["abc /queue front", "prompt", true],
    ["/queue front /review first\nsecond", "command", true],
    ["/queue !echo hello", "shell", false],
    ["/compact /queue", "compact", false],
  ] as const)("%s captures its mode and selection", (text, kind, front) => {
    const parsed = QueueCommand.parse(text)
    if (parsed?.type !== "enqueue") throw new Error("expected enqueue")
    const payload = queuePayload(parsed, captured, [])
    expect(parsed.front).toBe(front)
    expect(payload).toMatchObject({ ...captured, kind })
    expect(Schema.is(SessionQueueV1.Payload)(payload)).toBe(true)
    if (payload.kind === "compact") expect(payload).not.toHaveProperty("body")
    if (payload.kind === "command")
      expect(payload).toMatchObject({ command: "review", arguments: "first\nsecond", parts: [] })
  })

  test("expanded pasted content, context, and attachments survive parsing without queue syntax", () => {
    const text = expandTrackedPastedText("/queue front [paste] @file", [
      { start: 13, end: 20, text: "line one\nline two" },
    ])
    const parsed = QueueCommand.parse(text, true)
    if (parsed?.type !== "enqueue") throw new Error("expected enqueue")
    const file = { type: "file" as const, mime: "text/plain", filename: "note.txt", url: "file:///note.txt" }
    const agent = { type: "agent" as const, name: "review" }
    const context = { type: "text" as const, text: "editor selection", synthetic: true }
    const payload = queuePayload(parsed, captured, [context, file, agent])
    expect(payload).toMatchObject({
      kind: "prompt",
      parts: [context, { type: "text", text: "line one\nline two @file" }, file, agent],
    })
    expect(queuePreview(payload)).toContain("[note.txt]")
    expect(queuePreview(payload)).not.toContain("editor selection")
    const command = QueueCommand.parse("/queue /review args", true)
    if (command?.type !== "enqueue") throw new Error("expected enqueue")
    expect(queuePayload(command, captured, [context, file, agent])).toMatchObject({ kind: "command", parts: [file] })
  })

  test.each([
    "/queue fix @a.ts @explore later",
    "/queue front fix @a.ts @explore later",
    "fix @a.ts @explore later /queue",
  ])("%s rebases file and agent offsets without mutating the captured parts", (text) => {
    const parsed = QueueCommand.parse(text, true)
    if (parsed?.type !== "enqueue") throw new Error("expected enqueue")
    const fileStart = text.indexOf("@a.ts")
    const agentStart = text.indexOf("@explore")
    const parts = [
      {
        type: "file" as const,
        mime: "text/plain",
        url: "file:///a.ts",
        source: { type: "file" as const, path: "a.ts", text: { value: "@a.ts", start: fileStart, end: fileStart + 5 } },
      },
      {
        type: "agent" as const,
        name: "explore",
        source: { value: "@explore", start: agentStart, end: agentStart + 8 },
      },
    ]
    expect(queuePayload(parsed, captured, parts, text)).toMatchObject({
      kind: "prompt",
      parts: [
        { type: "text", text: "fix @a.ts @explore later" },
        { type: "file", source: { text: { start: 4, end: 9 } } },
        { type: "agent", source: { start: 10, end: 18 } },
      ],
    })
    expect(parts[0].source.text?.start).toBe(fileStart)
    expect(parts[1].source.start).toBe(agentStart)
  })

  test.each([
    "/queue",
    "/queue list",
    "/queues",
    "/queue start",
    "/queue stop",
    "/queue flush",
    "/queue clear 1 2",
    "/queues bad",
    "/queue !",
  ])("%s never produces a payload", (text) => {
    expect(QueueCommand.parse(text)?.type).not.toBe("enqueue")
  })

  test("submission waits for acknowledgement and reports failure without an optimistic item", async () => {
    const ack = deferred<unknown>()
    const h = harness(snapshot(), { submit: () => ack.promise })
    const submit = h.queue.submit(sessionID, { id: "retry-id", payload: { ...captured, kind: "compact" } })
    expect(h.queue.data.busy[sessionID]).toBe(true)
    expect(h.queue.data.snapshots[sessionID]).toBeUndefined()
    expect(await h.queue.submit(sessionID, { id: "other", payload: { ...captured, kind: "compact" } })).toBe(false)
    ack.reject(new Error("offline"))
    expect(await submit).toBe(false)
    expect(h.queue.data.errors[sessionID]).toContain("offline")
    expect(h.queue.pending(sessionID)).toHaveLength(0)
    expect(h.queue.data.busy[sessionID]).toBe(false)
  })
})

describe("queue synchronization", () => {
  test("indexed deletions wait for an event refresh between acknowledgements", async () => {
    const refresh = deferred<unknown>()
    const started = deferred<void>()
    const mutations: SessionQueueV1.Update[] = []
    const h = harness(snapshot(), {
      list: async () => (mutations.length ? refresh.promise : snapshot([entry("one"), entry("two")])),
      update: async (_, input) => {
        mutations.push(input)
        if (mutations.length === 1) {
          h.queue.changed(sessionID, 2)
          started.resolve()
          return snapshot([entry("two")], 2)
        }
        return snapshot([], 3)
      },
    })
    await h.queue.refresh(sessionID)
    expect(await h.queue.update(sessionID, { action: "delete", id: "one" })).toBe(true)
    await started.promise
    const second = h.queue.update(sessionID, { action: "delete", id: "two" })
    await Promise.resolve()
    expect(mutations).toHaveLength(1)
    refresh.resolve(snapshot([entry("two")], 2))
    expect(await second).toBe(true)
    expect(mutations.map((input) => [input.revision, input.mutation])).toEqual([
      [1, { action: "delete", id: "one" }],
      [2, { action: "delete", id: "two" }],
    ])
    expect(h.queue.pending(sessionID)).toEqual([])
  })

  test("pending counts and steering badges use authoritative state, not transcript position", async () => {
    const h = harness(
      snapshot([
        entry("queued"),
        entry("steer", { delivery: "steer", messageID: SessionV1.MessageID.make("msg_message") }),
        entry("claim", { state: "claimed" }),
        entry("uncertain", { state: "uncertain" }),
      ]),
    )
    await h.queue.refresh(sessionID)
    expect(h.queue.pending(sessionID, "queue")).toHaveLength(1)
    expect(h.queue.steering(sessionID, "msg_message")).toBe(true)
    expect(h.queue.steering(sessionID, "unrelated-user-message")).toBe(false)
    h.server(snapshot([], 2))
    await h.queue.refresh(sessionID)
    expect(h.queue.steering(sessionID, "msg_message")).toBe(false)
  })

  test("event invalidation during an in-flight fetch refetches and ignores stale responses", async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    let calls = 0
    const h = harness(snapshot(), { list: () => (++calls === 1 ? first.promise : second.promise) })
    const refresh = h.queue.refresh(sessionID)
    h.queue.changed(sessionID, 3)
    first.resolve(snapshot([], 1))
    await Promise.resolve()
    second.resolve(snapshot([entry("new")], 3))
    await refresh
    expect(calls).toBe(2)
    expect(h.queue.data.snapshots[sessionID]?.revision).toBe(3)
    h.queue.changed(sessionID, 2)
    expect(calls).toBe(2)
  })

  test("reopen and reconnect refresh without polling; old list cannot overwrite mutation ack", async () => {
    const stale = deferred<unknown>()
    let calls = 0
    const h = harness(snapshot(), {
      list: async () => {
        calls++
        return calls === 2 ? stale.promise : snapshot([], 4)
      },
      update: async () => snapshot([], 5),
    })
    await h.queue.refresh(sessionID)
    const refresh = h.queue.refresh(sessionID)
    expect(await h.queue.submit(sessionID, { id: "id", payload: { ...captured, kind: "compact" } })).toBe(true)
    stale.resolve(snapshot([], 2))
    await refresh
    expect(h.queue.data.snapshots[sessionID]?.revision).toBe(4)
    await h.queue.update(sessionID, { action: "pause", paused: false })
    h.queue.reconnect()
    await Promise.resolve()
    expect(calls).toBe(3)
    expect(h.queue.data.snapshots[sessionID]?.revision).toBe(5)
  })

  test("revision conflicts refresh authoritative state and keep the error visible", async () => {
    const h = harness(snapshot([entry("old")]), {
      update: async () => {
        throw new Error("revision conflict")
      },
    })
    await h.queue.refresh(sessionID)
    h.server(snapshot([entry("remote")], 2))
    expect(await h.queue.update(sessionID, { action: "delete", id: "old" })).toBe(false)
    expect(h.queue.data.snapshots[sessionID]?.items[0].id).toBe("remote")
    expect(h.queue.data.errors[sessionID]).toContain("revision conflict")
  })
})

describe("queue dialog controller", () => {
  test("groups steering first, preserves selected ID, and reorders only the selected delivery", async () => {
    const h = harness(
      snapshot([entry("q1", { position: 1 }), entry("s1", { delivery: "steer" }), entry("q2", { position: 2 })]),
    )
    await h.queue.refresh(sessionID)
    const ui = createRoot(() => createQueueDialog(h.queue, sessionID))
    expect(queueRows(h.queue.data.snapshots[sessionID]).map((item) => item.id)).toEqual(["s1", "q1", "q2"])
    ui.select("q1")
    ui.key({ name: "up", shift: true })
    expect(h.mutations).toHaveLength(0)
    ui.key({ name: "down", shift: true })
    expect(h.mutations).toEqual([
      { revision: 1, mutation: { action: "reorder", delivery: "queue", ids: ["q2", "q1"] } },
    ])
    await Promise.resolve()
    h.server(
      snapshot(
        [entry("new", { delivery: "steer", position: -1 }), entry("q1", { position: 2 }), entry("q2", { position: 1 })],
        2,
      ),
    )
    await h.queue.refresh(sessionID)
    expect(ui.current()?.id).toBe("q1")
  })

  test.each(["escape", "down", "p", "s", "delete", "c", "return"])(
    "delete cancellation with %s consumes the key without executing it",
    async (name) => {
      const h = harness(snapshot([entry("q1"), entry("q2", { position: 1 })]))
      await h.queue.refresh(sessionID)
      const ui = createRoot(() => createQueueDialog(h.queue, sessionID))
      ui.key({ name: "delete" })
      expect(ui.confirmation()).toEqual({ action: "delete", id: "q1" })
      expect(ui.key({ name })).toBe(true)
      expect(ui.confirmation()).toBeUndefined()
      expect(ui.current()?.id).toBe("q1")
      expect(h.mutations).toHaveLength(0)
    },
  )

  test("Y confirms delete; clear all has its own confirmation; blocked resume sends pause false", async () => {
    const h = harness({ ...snapshot([entry("q1")]), paused: false, blocked: true })
    await h.queue.refresh(sessionID)
    const ui = createRoot(() => createQueueDialog(h.queue, sessionID))
    ui.key({ name: "delete" })
    ui.key({ name: "y", shift: true })
    expect(h.mutations[0].mutation).toEqual({ action: "delete", id: "q1" })
    await Promise.resolve()
    await Promise.resolve()
    ui.key({ name: "c" })
    expect(ui.confirmation()).toEqual({ action: "clear" })
    ui.key({ name: "y" })
    expect(h.mutations[1].mutation).toEqual({ action: "clear" })
    await Promise.resolve()
    await Promise.resolve()
    ui.key({ name: "p" })
    expect(h.mutations[2].mutation).toEqual({ action: "pause", paused: false })
  })

  test("claims cannot be converted, deleted, or reordered and mutations disable controls", async () => {
    const ack = deferred<unknown>()
    const h = harness(
      snapshot([
        entry("claimed", { state: "claimed" }),
        entry("uncertain", { state: "uncertain", position: 1 }),
        entry("pending", { position: 2 }),
      ]),
      {
        update: (_, input) => {
          h.mutations.push(input)
          return ack.promise
        },
      },
    )
    await h.queue.refresh(sessionID)
    const ui = createRoot(() => createQueueDialog(h.queue, sessionID))
    for (const id of ["claimed", "uncertain"]) {
      ui.select(id)
      ui.key({ name: "s" })
      ui.key({ name: "delete" })
      ui.key({ name: "down", shift: true })
      expect(ui.confirmation()).toBeUndefined()
    }
    expect(h.mutations).toHaveLength(0)
    ui.select("pending")
    ui.key({ name: "s" })
    expect(h.mutations[0].mutation).toEqual({ action: "convert", id: "pending", delivery: "steer" })
    ui.key({ name: "p" })
    ui.key({ name: "delete" })
    expect(ui.confirmation()).toBeUndefined()
    expect(h.mutations).toHaveLength(1)
    ack.resolve(snapshot([], 2))
  })
})
