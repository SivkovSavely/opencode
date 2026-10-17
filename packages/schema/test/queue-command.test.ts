import { describe, expect, test } from "bun:test"
import { QueueCommand } from "../src/queue-command"

describe("queue command", () => {
  test.each([
    "",
    "plain prompt",
    "/review",
    "!pwd",
    "/queueing hello",
    "/queues-extra",
    "/QUEUE hello",
    "hello /queues",
    "hello /queue later",
    "hello /queue frontier",
    "hello /queue front later",
    "a/queue",
    "hello /queue\nmore text",
  ])("ignores nonqueue input %j with or without attachments", (text) => {
    expect(QueueCommand.parse(text)).toBeUndefined()
    expect(QueueCommand.parse(text, true)).toBeUndefined()
  })

  test.each(["/queues", " /queues \n", "/queues\t\n"])("opens management for %j", (text) => {
    expect(QueueCommand.parse(text)).toEqual({ type: "manage" })
  })

  test.each(["list", "front", "start", "clear 1", "/review", "\nstop"])("rejects management arguments %j", (args) => {
    expect(QueueCommand.parse(`/queues ${args}`)).toEqual({
      type: "error",
      message: "Queues does not accept arguments",
    })
  })

  test("rejects management attachments", () => {
    expect(QueueCommand.parse("/queues", true)).toEqual({
      type: "error",
      message: "Queues does not support attachments",
    })
  })

  test.each(["/queue", " /queue \n", "/queue \t\n", "/queue list", "list /queue"])("lists the queue for %j", (text) => {
    expect(QueueCommand.parse(text)).toEqual({ type: "list" })
  })

  test.each(["start", "stop", "flush"] as const)("recognizes %s in either position", (type) => {
    expect(QueueCommand.parse(`/queue ${type}`)).toEqual({ type })
    expect(QueueCommand.parse(`${type} /queue`)).toEqual({ type })
  })

  test.each(["/queue clear", "clear /queue", "/queue clear \t\n"])("clears all for %j", (text) => {
    expect(QueueCommand.parse(text)).toEqual({ type: "clear", indices: [] })
  })

  test.each(["/queue clear 3 1 3\n2 1", "clear 3 1 3\n2 1 /queue"])(
    "deduplicates positive one-based indices in first-seen order for %j",
    (text) => {
      expect(QueueCommand.parse(text)).toEqual({ type: "clear", indices: [3, 1, 2] })
    },
  )

  test("accepts the largest safe positive index without resolving queue state", () => {
    expect(QueueCommand.parse("/queue clear 9007199254740991")).toEqual({
      type: "clear",
      indices: [Number.MAX_SAFE_INTEGER],
    })
  })

  test.each(["0", "-1", "+1", "01", "1.0", "1.5", "1e2", "0x10", "NaN", "Infinity", "1,2", "1x", "9007199254740992"])(
    "rejects invalid clear index %j rather than ignoring the queue command",
    (index) => {
      expect(QueueCommand.parse(`/queue clear 2 ${index}`)).toEqual({
        type: "error",
        message: "Queue clear expects positive item numbers",
      })
      expect(QueueCommand.parse(`clear ${index} /queue`)).toEqual({
        type: "error",
        message: "Queue clear expects positive item numbers",
      })
    },
  )

  test.each(["list", "start", "stop", "flush", "clear", "clear 0"])(
    "treats %j as prompt content with attachments or front priority",
    (body) => {
      expect(QueueCommand.parse(`/queue ${body}`, true)).toEqual({
        type: "enqueue",
        front: false,
        kind: "prompt",
        body,
      })
      expect(QueueCommand.parse(`${body} /queue`, true)).toEqual({
        type: "enqueue",
        front: false,
        kind: "prompt",
        body,
      })
      expect(QueueCommand.parse(`/queue front ${body}`)).toEqual({
        type: "enqueue",
        front: true,
        kind: "prompt",
        body,
      })
      expect(QueueCommand.parse(`${body} /queue front`)).toEqual({
        type: "enqueue",
        front: true,
        kind: "prompt",
        body,
      })
    },
  )

  test.each([
    ["/queue", false],
    ["/queue front", true],
    [" /queue ", false],
    [" /queue front ", true],
  ] as const)("accepts attachment-only input %j", (text, front) => {
    expect(QueueCommand.parse(text, true)).toEqual({ type: "enqueue", front, kind: "prompt", body: "" })
  })

  test.each(["/queue front", "/queue front \t\n", " /queue front "])("rejects empty front input %j", (text) => {
    expect(QueueCommand.parse(text)).toEqual({ type: "error", message: "Queue front input is empty" })
  })

  test.each([
    ["/queue first\nsecond", "first\nsecond", false],
    ["first\nsecond /queue", "first\nsecond", false],
    ["/queue front first\nsecond", "first\nsecond", true],
    ["first\nsecond /queue front", "first\nsecond", true],
    ["/queue\nfirst\nsecond", "first\nsecond", false],
    ["first\nsecond\n/queue\nfront\n", "first\nsecond", true],
    ["/queue first \n  ", "first \n  ", false],
    ["  first \nsecond /queue  ", "  first \nsecond", false],
    ["/queue frontier", "frontier", false],
    ["front hello /queue", "front hello", false],
    ["/queue hello /queue front", "hello /queue front", false],
    ["/queue front hello /queue", "hello /queue", true],
    ["/queue list more", "list more", false],
  ] as const)("preserves prompt content and wrapper precedence for %j", (text, body, front) => {
    expect(QueueCommand.parse(text)).toEqual({ type: "enqueue", front, kind: "prompt", body })
  })

  test.each([
    ["/queue /review", false],
    ["/review /queue", false],
    ["/queue front /review", true],
    ["/review /queue front", true],
  ] as const)("parses a slash command without arguments for %j", (text, front) => {
    expect(QueueCommand.parse(text)).toEqual({
      type: "enqueue",
      front,
      kind: "command",
      body: "/review",
      command: "review",
      arguments: "",
    })
  })

  test.each(["/queue /review first\nsecond", "/review first\nsecond /queue"])(
    "parses multiline slash arguments and allows attachments for %j",
    (text) => {
      expect(QueueCommand.parse(text, true)).toEqual({
        type: "enqueue",
        front: false,
        kind: "command",
        body: "/review first\nsecond",
        command: "review",
        arguments: "first\nsecond",
      })
    },
  )

  test.each([
    ["/queue /compact", false],
    ["/compact /queue", false],
    ["/queue front /compact", true],
    ["/compact /queue front", true],
  ] as const)("recognizes compaction for %j", (text, front) => {
    expect(QueueCommand.parse(text)).toEqual({ type: "enqueue", front, kind: "compact", body: "/compact" })
    expect(QueueCommand.parse(text, true)).toEqual({
      type: "error",
      message: "Queue compact does not support attachments",
    })
  })

  test.each(["/queue /compact extra", "/compact\nextra /queue", "/queue front /compact extra"])(
    "rejects compact arguments for %j",
    (text) => {
      expect(QueueCommand.parse(text)).toEqual({ type: "error", message: "Queue compact does not accept arguments" })
    },
  )

  test.each([
    ["/queue ! pwd\necho hello", false],
    ["! pwd\necho hello /queue", false],
    ["/queue front ! pwd\necho hello", true],
    ["! pwd\necho hello /queue front", true],
  ] as const)("parses shell content for %j", (text, front) => {
    expect(QueueCommand.parse(text)).toEqual({
      type: "enqueue",
      front,
      kind: "shell",
      body: "! pwd\necho hello",
      command: "pwd\necho hello",
    })
    expect(QueueCommand.parse(text, true)).toEqual({
      type: "error",
      message: "Queued shell commands do not support attachments",
    })
  })

  test.each(["/queue !", "/queue ! \n", "! /queue", "/queue front !"])("rejects empty shells for %j", (text) => {
    expect(QueueCommand.parse(text)).toEqual({ type: "error", message: "Queue shell command is empty" })
    expect(QueueCommand.parse(text, true)).toEqual({ type: "error", message: "Queue shell command is empty" })
  })

  test("does not share result objects or arrays between calls", () => {
    const first = QueueCommand.parse("/queue clear 2 1 2")
    const second = QueueCommand.parse("/queue clear 2 1 2")
    expect(first).toEqual({ type: "clear", indices: [2, 1] })
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    if (first?.type !== "clear" || second?.type !== "clear") throw new Error("Expected clear results")
    expect(second.indices).not.toBe(first.indices)
  })
})
