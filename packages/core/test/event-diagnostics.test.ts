import { describe, expect, test } from "bun:test"
import { makeEventDiagnostics, type DiagnosticRecord } from "../src/event-diagnostics"

describe("event diagnostics", () => {
  test("tracks subscriber lifecycle and transport-specific backlog", () => {
    const records: DiagnosticRecord[] = []
    const diagnostics = makeEventDiagnostics(true)
    diagnostics.setBreadcrumbSink((record) => records.push(record))
    const subscriber = diagnostics.connectSubscriber({ transport: "global-event" })

    expect(diagnostics.activeSubscriberCount()).toBe(1)
    expect(diagnostics.subscribers()).toEqual([
      expect.objectContaining({ id: subscriber?.id, transport: "global-event" }),
    ])

    diagnostics.queueOffer(subscriber, "session.updated")
    diagnostics.queueOffer(subscriber, "session.updated")
    diagnostics.queueDrain(subscriber, "session.updated")

    expect(diagnostics.subscriberAggregate()).toMatchObject({
      backlog: 1,
      transports: {
        "global-event": {
          subscribers: 1,
          backlog: 1,
          maximumBacklog: 2,
          backlogKind: "estimated-callback-stream",
        },
      },
    })
    expect(diagnostics.takeInterval()).toMatchObject({
      sseQueueOffers: 2,
      sseQueueDrains: 1,
      sseTransportIntervals: { "global-event": { sseQueueOffers: 2, sseQueueDrains: 1 } },
    })

    diagnostics.disconnectSubscriber(subscriber)
    diagnostics.disconnectSubscriber(subscriber)
    expect(diagnostics.activeSubscriberCount()).toBe(0)
    expect(records.filter((record) => record.marker === "sse_subscriber_connect")).toEqual([
      expect.objectContaining({ subscriberID: subscriber?.id, transport: "global-event", activeSubscribers: 1 }),
    ])
    expect(records.filter((record) => record.marker === "sse_subscriber_disconnect")).toEqual([
      expect.objectContaining({ subscriberID: subscriber?.id, transport: "global-event", activeSubscribers: 0 }),
    ])
  })

  test("accounts for subscriber backlog and resets interval counters", () => {
    const records: DiagnosticRecord[] = []
    const diagnostics = makeEventDiagnostics(true)
    diagnostics.setBreadcrumbSink((record) => records.push(record))
    const subscriber = diagnostics.connectSubscriber({ directory: "/tmp/project" })

    diagnostics.queueOffer(subscriber, "message.updated")
    diagnostics.queueOffer(subscriber, "message.updated")
    diagnostics.queueOffer(subscriber, "session.updated")
    diagnostics.queueDrain(subscriber, "message.updated")

    expect(diagnostics.subscribers()).toEqual([
      expect.objectContaining({
        transport: "event",
        enqueued: 3,
        dequeued: 1,
        backlog: 2,
        maximumBacklog: 3,
        eventTypes: { "message.updated": 2, "session.updated": 1 },
      }),
    ])
    expect(diagnostics.subscriberAggregate()).toMatchObject({
      transports: { event: { subscribers: 1, backlog: 2, maximumBacklog: 3, backlogKind: "queue" } },
    })
    expect(diagnostics.takeInterval()).toMatchObject({ sseQueueOffers: 3, sseQueueDrains: 1 })
    expect(diagnostics.takeInterval()).toMatchObject({ sseQueueOffers: 0, sseQueueDrains: 0 })
    Array.from({ length: 98 }, () => diagnostics.queueOffer(subscriber, "message.updated"))
    expect(records.filter((record) => record.marker === "sse_backlog_threshold")).toHaveLength(1)
  })

  test("keeps overflow subscriber accounting exact", () => {
    const diagnostics = makeEventDiagnostics(true)
    const tracked = Array.from({ length: 4096 }, () => diagnostics.connectSubscriber({ transport: "event" }))
    const globalOverflow = diagnostics.connectSubscriber({ transport: "global-event" })
    const apiOverflow = diagnostics.connectSubscriber({ transport: "api-event" })

    expect(globalOverflow?.tracked).toBe(false)
    expect(apiOverflow?.tracked).toBe(false)
    expect(diagnostics.subscriberAggregate()).toMatchObject({
      tracked: 4096,
      transports: {
        event: { subscribers: 4096 },
        "global-event": { subscribers: 1 },
        "api-event": { subscribers: 1 },
      },
    })
    expect(diagnostics.activeSubscriberCount()).toBe(4098)

    diagnostics.disconnectSubscriber(globalOverflow)
    diagnostics.disconnectSubscriber(globalOverflow)
    expect(diagnostics.activeSubscriberCount()).toBe(4097)
    expect(diagnostics.subscriberAggregate().transports["global-event"].subscribers).toBe(0)
    expect(diagnostics.subscriberAggregate().transports["api-event"].subscribers).toBe(1)

    diagnostics.disconnectSubscriber(apiOverflow)
    tracked.forEach((id) => diagnostics.disconnectSubscriber(id))
    expect(diagnostics.activeSubscriberCount()).toBe(0)
  })

  test("records large serialized events without retaining their contents", () => {
    const records: DiagnosticRecord[] = []
    const diagnostics = makeEventDiagnostics(true)
    diagnostics.setBreadcrumbSink((record) => records.push(record))
    const content = "secret-content"

    const subscriber = diagnostics.connectSubscriber({ transport: "api-event" })
    diagnostics.serialized(subscriber, "message.updated", 1024 * 1024, 1024 * 1024)
    diagnostics.diffFullStart({ from: "before-hash", to: "after-hash", changedFileCount: 1 })
    diagnostics.diffFileStart({
      operationID: 1,
      filename: "secret.txt",
      beforeChars: content.length,
      beforeBytes: content.length,
      afterChars: content.length,
      afterBytes: content.length,
      additions: 1,
      deletions: 1,
      status: "modified",
    })

    expect(records.some((record) => record.marker === "sse_large_event")).toBe(true)
    expect(records).toContainEqual(
      expect.objectContaining({ marker: "sse_large_event", subscriberID: subscriber?.id, transport: "api-event" }),
    )
    expect(JSON.stringify(records)).not.toContain(content)
    expect(JSON.stringify(diagnostics.subscribers())).not.toContain(content)
  })

  test("records skipped diff metadata without retaining file contents", () => {
    const records: DiagnosticRecord[] = []
    const diagnostics = makeEventDiagnostics(true)
    diagnostics.setBreadcrumbSink((record) => records.push(record))
    const content = "secret-content"
    const operationID = diagnostics.diffFullStart({ from: "before", to: "after" })

    diagnostics.diffFileSkipped({
      operationID,
      filename: "generated.c",
      reason: ["size", "churn"],
      beforeBytes: 2_097_153,
      afterBytes: 2_097_154,
      additions: 20_001,
      deletions: 20_000,
      sizeLimit: 2 * 1024 * 1024,
      churnLimit: 20_000,
    })
    diagnostics.diffFullEnd({
      operationID,
      elapsedMs: 1,
      files: 1,
      totalBeforeChars: 0,
      totalBeforeBytes: 2_097_153,
      totalAfterChars: 0,
      totalAfterBytes: 2_097_154,
      totalPatchChars: 0,
      totalPatchBytes: 0,
      skippedFiles: 1,
      skippedBytes: 4_194_307,
      skippedReasonCounts: { size: 1, churn: 1 },
      largestSkippedInput: { filename: "generated.c", bytes: 4_194_307 },
    })

    expect(records).toContainEqual(
      expect.objectContaining({
        marker: "diff_file_skipped",
        operationID,
        filename: "generated.c",
        reason: ["size", "churn"],
        beforeBytes: 2_097_153,
        afterBytes: 2_097_154,
      }),
    )
    expect(JSON.stringify(records)).not.toContain(content)
    expect(records).toContainEqual(
      expect.objectContaining({
        marker: "diff_full_end",
        skippedFiles: 1,
        skippedBytes: 4_194_307,
        skippedReasonCounts: { size: 1, churn: 1 },
      }),
    )
  })

  test("does no diagnostic work when disabled", () => {
    const records: DiagnosticRecord[] = []
    const diagnostics = makeEventDiagnostics(false)
    diagnostics.setBreadcrumbSink((record) => records.push(record))
    const subscriber = diagnostics.connectSubscriber()

    diagnostics.logicalEvent("message.updated")
    diagnostics.queueOffer(subscriber, "message.updated")
    diagnostics.serialized(subscriber, "message.updated", 100, 100)
    diagnostics.diffFileSkipped({
      operationID: undefined,
      filename: "generated.c",
      reason: ["size"],
      beforeBytes: 1,
      afterBytes: 2,
      additions: 1,
      deletions: 1,
      sizeLimit: 2,
      churnLimit: 2,
    })
    diagnostics.diffFullEnd({
      operationID: undefined,
      elapsedMs: 1,
      files: 1,
      totalBeforeChars: 1,
      totalBeforeBytes: 1,
      totalAfterChars: 1,
      totalAfterBytes: 1,
      totalPatchChars: 0,
      totalPatchBytes: 0,
      skippedFiles: 1,
      skippedBytes: 3,
      skippedReasonCounts: { size: 1, churn: 0 },
    })

    expect(subscriber).toBeUndefined()
    expect(diagnostics.activeSubscriberCount()).toBe(0)
    expect(diagnostics.takeInterval()).toEqual({
      logicalEvents: 0,
      logicalEventTypes: {},
      diffStarted: 0,
      diffCompleted: 0,
      sseQueueOffers: 0,
      sseQueueDrains: 0,
      serializedSseEvents: 0,
      serializedSseChars: 0,
      serializedSseBytes: 0,
      sseTransportIntervals: {
        "global-event": {
          sseQueueOffers: 0,
          sseQueueDrains: 0,
          serializedSseEvents: 0,
          serializedSseChars: 0,
          serializedSseBytes: 0,
        },
        event: {
          sseQueueOffers: 0,
          sseQueueDrains: 0,
          serializedSseEvents: 0,
          serializedSseChars: 0,
          serializedSseBytes: 0,
        },
        "api-event": {
          sseQueueOffers: 0,
          sseQueueDrains: 0,
          serializedSseEvents: 0,
          serializedSseChars: 0,
          serializedSseBytes: 0,
        },
      },
    })
    expect(records).toEqual([])
  })

  test("limits subscriber record allocation and reports omitted records", () => {
    const diagnostics = makeEventDiagnostics(true)
    Array.from({ length: 3 }, () => diagnostics.connectSubscriber({ transport: "event" }))

    expect(diagnostics.subscribers(2)).toHaveLength(2)
    expect(diagnostics.activeSubscriberCount() - diagnostics.subscribers(2).length).toBe(1)
  })

  test("reports tracked and overflow records omitted from a bounded sample", () => {
    const diagnostics = makeEventDiagnostics(true)
    Array.from({ length: 4096 }, () => diagnostics.connectSubscriber({ transport: "event" }))
    Array.from({ length: 2 }, () => diagnostics.connectSubscriber({ transport: "global-event" }))

    const records = diagnostics.subscribers(256)
    expect(records).toHaveLength(256)
    expect(diagnostics.activeSubscriberCount() - records.length).toBe(3842)
  })

  test("ignores queue calls after disconnect", () => {
    const diagnostics = makeEventDiagnostics(true)
    const subscriber = diagnostics.connectSubscriber({ transport: "event" })
    diagnostics.disconnectSubscriber(subscriber)
    diagnostics.queueOffer(subscriber, "message.updated")
    diagnostics.queueDrain(subscriber, "message.updated")
    diagnostics.serialized(subscriber, "message.updated", 10, 10)

    expect(diagnostics.activeSubscriberCount()).toBe(0)
    expect(diagnostics.takeInterval()).toMatchObject({
      sseQueueOffers: 0,
      sseQueueDrains: 0,
      serializedSseEvents: 0,
    })
  })
})
