import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionQueueV1 } from "../src/v1/session-queue"
import { EventManifest } from "../src/event-manifest"

const common = { agent: "build", model: { providerID: "test", modelID: "test" } }
const decode = Schema.decodeUnknownSync(SessionQueueV1.Payload)

describe("SessionQueueV1 contracts", () => {
  test("all four payloads require resolved agent and model context", () => {
    for (const fields of [
      { kind: "prompt", parts: [{ type: "text", text: "hello" }] },
      {
        kind: "command",
        command: "review",
        arguments: "HEAD",
        parts: [{ type: "file", mime: "text/plain", url: "file:///tmp/test" }],
      },
      { kind: "shell", command: "pwd" },
      { kind: "compact" },
    ] as const) {
      expect(decode({ ...common, ...fields }).kind).toBe(fields.kind)
      expect(() => decode({ ...fields, agent: "build" })).toThrow()
      expect(() => decode({ ...fields, model: common.model })).toThrow()
    }
  })

  test("prompt accepts legacy text/file/agent/subtask inputs but not runtime-only parts", () => {
    const parts = [
      { type: "text", text: "hello" },
      { type: "file", mime: "text/plain", url: "file:///tmp/test" },
      { type: "agent", name: "build" },
      { type: "subtask", prompt: "look", description: "look", agent: "explore" },
    ]
    expect(decode({ ...common, kind: "prompt", parts, system: "system", tools: { bash: false } }).kind).toBe("prompt")
    expect(() => decode({ ...common, kind: "prompt", parts: [{ type: "reasoning", text: "private" }] })).toThrow()
    expect(() => decode({ ...common, kind: "command", command: "x", arguments: "", parts: [parts[0]] })).toThrow()
  })

  test("optional contract properties omit undefined when encoded", () => {
    const payload: SessionQueueV1.Payload = { ...common, kind: "compact", variant: undefined }
    expect(Schema.encodeSync(SessionQueueV1.Payload)(payload)).toEqual({ ...common, kind: "compact" })
    expect(Schema.encodeSync(SessionQueueV1.Submit)({ id: "stable", payload, front: undefined })).toEqual({
      id: "stable",
      payload: { ...common, kind: "compact" },
    })
  })

  test("changed has one canonical V1-only inventory definition", () => {
    expect(SessionQueueV1.Event.Definitions).toEqual([SessionQueueV1.Event.Changed])
    expect(EventManifest.Latest.get("session.queue.changed")).toBe(SessionQueueV1.Event.Changed)
    expect(EventManifest.ServerDefinitions).not.toContain(SessionQueueV1.Event.Changed)
    expect(SessionQueueV1.Event.Changed.durable).toBeUndefined()
  })
})
