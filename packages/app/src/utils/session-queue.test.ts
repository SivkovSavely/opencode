import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { pendingSteers, queueCount, queueOrder } from "./session-queue"

const snapshot = Schema.decodeUnknownSync(SessionQueueV1.Snapshot)({
  sessionID: "ses_queue",
  revision: 4,
  paused: true,
  blocked: false,
  items: [
    ["first", "queue", "pending"],
    ["claimed", "queue", "claimed"],
    ["steer", "steer", "pending"],
    ["second", "queue", "pending"],
    ["uncertain", "queue", "uncertain"],
    ["delivered", "steer", "delivered"],
  ].map(([id, delivery, state], position) => ({
    id,
    delivery,
    state,
    position,
    sessionID: "ses_queue",
    created: 1,
    messageID: `msg_${id}`,
    payload: { kind: "prompt", agent: "build", model: { providerID: "test", modelID: "model" }, parts: [] },
  })),
})

describe("native queue projection", () => {
  test("counts only pending queued items, even while paused", () => {
    expect(queueCount(snapshot)).toBe(2)
    expect(queueCount()).toBe(0)
  })
  test("borders only authoritative pending steer message IDs", () => {
    expect([...pendingSteers(snapshot)]).toEqual(["msg_steer"])
    expect([
      ...pendingSteers({ ...snapshot, items: snapshot.items.map((item) => ({ ...item, state: "claimed" })) }),
    ]).toEqual([])
    expect([...pendingSteers()]).toEqual([])
  })
  test("reorders the exact complete pending delivery group", () => {
    expect(queueOrder(snapshot.items, "second", -1)).toEqual({
      action: "reorder",
      delivery: "queue",
      ids: ["second", "first"],
    })
    expect(queueOrder(snapshot.items, "first", 1)).toEqual({
      action: "reorder",
      delivery: "queue",
      ids: ["second", "first"],
    })
    expect(queueOrder([...snapshot.items].reverse(), "second", -1)).toEqual({
      action: "reorder",
      delivery: "queue",
      ids: ["second", "first"],
    })
  })
  test("never reorders claimed, uncertain, missing, or out-of-bounds entries", () => {
    expect(queueOrder(snapshot.items, "claimed", 1)).toBeUndefined()
    expect(queueOrder(snapshot.items, "uncertain", -1)).toBeUndefined()
    expect(queueOrder(snapshot.items, "missing", -1)).toBeUndefined()
    expect(queueOrder(snapshot.items, "first", -1)).toBeUndefined()
    expect(queueOrder(snapshot.items, "steer", 1)).toBeUndefined()
  })
})
