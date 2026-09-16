export type DiagnosticRecord = Record<string, unknown>
export type DiffSkipReason = "size" | "churn"

export const SseTransports = ["global-event", "event", "api-event"] as const
export type SseTransport = (typeof SseTransports)[number]

export type SubscriberHandle = {
  id: number
  transport: SseTransport
  tracked: boolean
  active: boolean
  directory?: string
  workspaceID?: string
}

type SerializedEventInfo = { type: string; chars: number; bytes: number }

type TransportInterval = {
  sseQueueOffers: number
  sseQueueDrains: number
  serializedSseEvents: number
  serializedSseChars: number
  serializedSseBytes: number
  largestSerializedEvent?: SerializedEventInfo
}

type TransportAggregate = {
  subscribers: number
  backlog: number
  maximumBacklog: number
  backlogKind: "queue" | "estimated-callback-stream"
}

export type SubscriberInfo = {
  id: number
  transport: SseTransport
  directory?: string
  workspaceID?: string
  enqueued: number
  dequeued: number
  backlog: number
  maximumBacklog: number
  eventTypes: Record<string, number>
  serializedCount: number
  serializedChars: number
  serializedBytes: number
  largestSerializedEvent?: SerializedEventInfo
}

export type EventInterval = {
  logicalEvents: number
  logicalEventTypes: Record<string, number>
  diffStarted: number
  diffCompleted: number
  sseQueueOffers: number
  sseQueueDrains: number
  serializedSseEvents: number
  serializedSseChars: number
  serializedSseBytes: number
  largestSerializedEvent?: SerializedEventInfo
  sseTransportIntervals: Record<SseTransport, TransportInterval>
}

export type EventDiagnostics = ReturnType<typeof makeEventDiagnostics>

const MAX_EVENT_TYPES = 128
const MAX_TRACKED_SUBSCRIBERS = 4096
const BACKLOG_THRESHOLDS = [100, 1_000, 10_000]
const SIZE_THRESHOLDS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]

function makeTransportIntervals(): Record<SseTransport, TransportInterval> {
  return Object.fromEntries(
    SseTransports.map((transport) => [
      transport,
      {
        sseQueueOffers: 0,
        sseQueueDrains: 0,
        serializedSseEvents: 0,
        serializedSseChars: 0,
        serializedSseBytes: 0,
      },
    ]),
  ) as Record<SseTransport, TransportInterval>
}

function makeTransportAggregates(): Record<SseTransport, TransportAggregate> {
  return Object.fromEntries(
    SseTransports.map((transport) => [
      transport,
      {
        subscribers: 0,
        backlog: 0,
        maximumBacklog: 0,
        backlogKind: transport === "global-event" ? "estimated-callback-stream" : "queue",
      },
    ]),
  ) as Record<SseTransport, TransportAggregate>
}

export function makeEventDiagnostics(enabled = process.env.OPENCODE_HANG_DIAGNOSTICS === "1") {
  let breadcrumb: ((record: DiagnosticRecord) => void) | undefined
  let nextSubscriberID = 1
  let nextDiffID = 1
  let activeSubscribers = 0
  let activeDiffs = 0
  let diffStarted = 0
  let diffCompleted = 0
  const subscribers = new Map<
    number,
    {
      transport: SseTransport
      directory?: string
      workspaceID?: string
      enqueued: number
      dequeued: number
      maximumBacklog: number
      eventTypes: Map<string, number>
      serializedCount: number
      serializedChars: number
      serializedBytes: number
      largestSerializedEvent?: SerializedEventInfo
      backlogThresholds: Set<number>
    }
  >()
  const activeByTransport = new Map<SseTransport, number>(SseTransports.map((transport) => [transport, 0]))
  let logicalEvents = 0
  let logicalEventTypes = new Map<string, number>()
  let sseQueueOffers = 0
  let sseQueueDrains = 0
  let serializedSseEvents = 0
  let serializedSseChars = 0
  let serializedSseBytes = 0
  let largestSerializedEvent: SerializedEventInfo | undefined
  let transportIntervals = makeTransportIntervals()

  const count = (map: Map<string, number>, type: string) => {
    const key = map.has(type) || map.size < MAX_EVENT_TYPES - 1 ? type : "__other__"
    map.set(key, (map.get(key) ?? 0) + 1)
  }

  const largest = (current: SerializedEventInfo | undefined, next: typeof largestSerializedEvent) =>
    !current || (next?.bytes ?? 0) > current.bytes ? next : current

  const transportFor = (subscriber: SubscriberHandle | undefined) =>
    subscriber?.active ? subscriber.transport : undefined

  const intervalFor = (transport: SseTransport | undefined) => (transport ? transportIntervals[transport] : undefined)

  const emit = (marker: string, fields: DiagnosticRecord = {}) => {
    if (!enabled) return
    breadcrumb?.({ marker, ...fields })
  }

  const threshold = (size: number) => {
    for (let i = SIZE_THRESHOLDS.length - 1; i >= 0; i--) {
      if (size >= SIZE_THRESHOLDS[i]) return SIZE_THRESHOLDS[i]
    }
    return undefined
  }

  return {
    enabled,
    setBreadcrumbSink(sink: (record: DiagnosticRecord) => void) {
      if (enabled) breadcrumb = sink
    },
    logicalEvent(type: string) {
      if (!enabled) return
      logicalEvents++
      count(logicalEventTypes, type)
    },
    connectSubscriber(input: { transport?: SseTransport; directory?: string; workspaceID?: string } = {}) {
      if (!enabled) return undefined
      const { transport: requestedTransport, ...location } = input
      const transport = requestedTransport ?? "event"
      activeSubscribers++
      activeByTransport.set(transport, (activeByTransport.get(transport) ?? 0) + 1)
      const id = nextSubscriberID++
      const tracked = subscribers.size < MAX_TRACKED_SUBSCRIBERS
      const subscriber = { id, transport, tracked, active: true, ...location }
      if (tracked) {
        subscribers.set(id, {
          ...location,
          transport,
          enqueued: 0,
          dequeued: 0,
          maximumBacklog: 0,
          eventTypes: new Map(),
          serializedCount: 0,
          serializedChars: 0,
          serializedBytes: 0,
          backlogThresholds: new Set(),
        })
      }
      emit("sse_subscriber_connect", {
        subscriberID: id,
        transport,
        ...location,
        activeSubscribers,
        ...(tracked ? {} : { tracked: false }),
      })
      return subscriber
    },
    disconnectSubscriber(subscriber: SubscriberHandle | undefined) {
      if (!enabled || !subscriber?.active) return
      subscriber.active = false
      if (subscriber.tracked) subscribers.delete(subscriber.id)
      activeSubscribers--
      activeByTransport.set(subscriber.transport, Math.max(0, (activeByTransport.get(subscriber.transport) ?? 0) - 1))
      emit("sse_subscriber_disconnect", {
        subscriberID: subscriber.id,
        transport: subscriber.transport,
        ...(subscriber.directory ? { directory: subscriber.directory } : {}),
        ...(subscriber.workspaceID ? { workspaceID: subscriber.workspaceID } : {}),
        activeSubscribers,
      })
    },
    queueOffer(subscriber: SubscriberHandle | undefined, type: string, accepted = true) {
      if (!enabled || !subscriber?.active) return
      const transport = transportFor(subscriber)
      if (!transport) return
      const interval = intervalFor(transport)
      sseQueueOffers++
      if (interval) interval.sseQueueOffers++
      if (!accepted) return
      const tracked = subscribers.get(subscriber.id)
      if (!tracked) return
      tracked.enqueued++
      count(tracked.eventTypes, type)
      const backlog = tracked.enqueued - tracked.dequeued
      if (backlog > tracked.maximumBacklog) tracked.maximumBacklog = backlog
      for (const value of BACKLOG_THRESHOLDS) {
        if (backlog < value || tracked.backlogThresholds.has(value)) continue
        tracked.backlogThresholds.add(value)
        emit("sse_backlog_threshold", {
          subscriberID: subscriber.id,
          transport: tracked.transport,
          backlog,
          threshold: value,
        })
      }
    },
    queueDrain(subscriber: SubscriberHandle | undefined, _type: string) {
      if (!enabled || !subscriber?.active) return
      const transport = transportFor(subscriber)
      if (!transport) return
      const interval = intervalFor(transport)
      const tracked = subscribers.get(subscriber.id)
      sseQueueDrains++
      if (interval) interval.sseQueueDrains++
      if (!tracked) return
      tracked.dequeued++
    },
    serialized(subscriber: SubscriberHandle | undefined, type: string, chars: number, bytes: number) {
      if (!enabled || (subscriber !== undefined && !subscriber.active)) return
      const item = { type, chars, bytes }
      serializedSseEvents++
      serializedSseChars += chars
      serializedSseBytes += bytes
      largestSerializedEvent = largest(largestSerializedEvent, item)
      const transport = transportFor(subscriber)
      const interval = intervalFor(transport)
      if (interval) {
        interval.serializedSseEvents++
        interval.serializedSseChars += chars
        interval.serializedSseBytes += bytes
        interval.largestSerializedEvent = largest(interval.largestSerializedEvent, item)
      }
      const tracked = subscriber === undefined ? undefined : subscribers.get(subscriber.id)
      if (tracked) {
        tracked.serializedCount++
        tracked.serializedChars += chars
        tracked.serializedBytes += bytes
        tracked.largestSerializedEvent = largest(tracked.largestSerializedEvent, item)
      }
      const sizeThreshold = threshold(bytes)
      if (sizeThreshold)
        emit("sse_large_event", {
          subscriberID: subscriber?.id,
          ...(transport ? { transport } : {}),
          eventType: type,
          bytes,
          chars,
          threshold: sizeThreshold,
        })
    },
    takeInterval(): EventInterval {
      if (!enabled) {
        return {
          logicalEvents: 0,
          logicalEventTypes: {},
          diffStarted: 0,
          diffCompleted: 0,
          sseQueueOffers: 0,
          sseQueueDrains: 0,
          serializedSseEvents: 0,
          serializedSseChars: 0,
          serializedSseBytes: 0,
          sseTransportIntervals: makeTransportIntervals(),
        }
      }
      const result = {
        logicalEvents,
        logicalEventTypes: Object.fromEntries(logicalEventTypes),
        diffStarted,
        diffCompleted,
        sseQueueOffers,
        sseQueueDrains,
        serializedSseEvents,
        serializedSseChars,
        serializedSseBytes,
        ...(largestSerializedEvent ? { largestSerializedEvent } : {}),
        sseTransportIntervals: transportIntervals,
      }
      logicalEvents = 0
      logicalEventTypes = new Map()
      diffStarted = 0
      diffCompleted = 0
      sseQueueOffers = 0
      sseQueueDrains = 0
      serializedSseEvents = 0
      serializedSseChars = 0
      serializedSseBytes = 0
      largestSerializedEvent = undefined
      transportIntervals = makeTransportIntervals()
      return result
    },
    subscribers(limit = 256): SubscriberInfo[] {
      if (!enabled) return []
      const result: SubscriberInfo[] = []
      for (const [id, subscriber] of subscribers) {
        if (result.length >= limit) break
        result.push({
          id,
          transport: subscriber.transport,
          ...(subscriber.directory ? { directory: subscriber.directory } : {}),
          ...(subscriber.workspaceID ? { workspaceID: subscriber.workspaceID } : {}),
          enqueued: subscriber.enqueued,
          dequeued: subscriber.dequeued,
          backlog: subscriber.enqueued - subscriber.dequeued,
          maximumBacklog: subscriber.maximumBacklog,
          eventTypes: Object.fromEntries(subscriber.eventTypes),
          serializedCount: subscriber.serializedCount,
          serializedChars: subscriber.serializedChars,
          serializedBytes: subscriber.serializedBytes,
          ...(subscriber.largestSerializedEvent ? { largestSerializedEvent: subscriber.largestSerializedEvent } : {}),
        })
      }
      return result
    },
    subscriberAggregate() {
      if (!enabled) return { backlog: 0, maximumBacklog: 0, tracked: 0, transports: makeTransportAggregates() }
      let backlog = 0
      let maximumBacklog = 0
      const transports = makeTransportAggregates()
      for (const transport of SseTransports) transports[transport].subscribers = activeByTransport.get(transport) ?? 0
      for (const subscriber of subscribers.values()) {
        const current = subscriber.enqueued - subscriber.dequeued
        backlog += current
        maximumBacklog = Math.max(maximumBacklog, subscriber.maximumBacklog)
        transports[subscriber.transport].backlog += current
        transports[subscriber.transport].maximumBacklog = Math.max(
          transports[subscriber.transport].maximumBacklog,
          subscriber.maximumBacklog,
        )
      }
      return { backlog, maximumBacklog, tracked: subscribers.size, transports }
    },
    activeSubscriberCount() {
      return enabled ? activeSubscribers : 0
    },
    activeDiffCount() {
      return enabled ? activeDiffs : 0
    },
    diffFullStart(input: {
      from: string
      to: string
      directory?: string
      projectID?: string
      sessionID?: string
      messageID?: string
      changedFileCount?: number
    }) {
      if (!enabled) return undefined
      const id = nextDiffID++
      activeDiffs++
      diffStarted++
      emit("diff_full_start", { operationID: id, ...input, from: input.from.slice(0, 16), to: input.to.slice(0, 16) })
      return id
    },
    diffBatch(input: {
      operationID: number | undefined
      batchIndex: number
      files: number
      beforeChars: number
      beforeBytes: number
      afterChars: number
      afterBytes: number
    }) {
      if (!enabled || input.operationID === undefined) return
      emit("diff_batch", input)
    },
    diffFullFiles(operationID: number | undefined, changedFileCount: number) {
      if (!enabled || operationID === undefined) return
      emit("diff_full_files", { operationID, changedFileCount })
    },
    diffFileStart(input: {
      operationID: number | undefined
      filename: string
      beforeChars: number
      beforeBytes: number
      afterChars: number
      afterBytes: number
      additions: number
      deletions: number
      status: string
    }) {
      if (!enabled || input.operationID === undefined) return
      emit("diff_file_start", input)
      const inputThreshold = threshold(input.beforeBytes + input.afterBytes)
      if (inputThreshold)
        emit("diff_large_input", {
          operationID: input.operationID,
          filename: input.filename,
          beforeBytes: input.beforeBytes,
          afterBytes: input.afterBytes,
          threshold: inputThreshold,
        })
    },
    diffFileSkipped(input: {
      operationID: number | undefined
      filename: string
      reason: DiffSkipReason[]
      beforeBytes: number
      afterBytes: number
      additions: number
      deletions: number
      sizeLimit: number
      churnLimit: number
    }) {
      if (!enabled || input.operationID === undefined) return
      emit("diff_file_skipped", input)
    },
    diffFileEnd(input: {
      operationID: number | undefined
      filename: string
      elapsedMs: number
      patchChars: number
      patchBytes: number
    }) {
      if (!enabled || input.operationID === undefined) return
      emit("diff_file_end", input)
      const sizeThreshold = threshold(input.patchBytes)
      if (sizeThreshold)
        emit("diff_large_patch", {
          operationID: input.operationID,
          filename: input.filename,
          patchBytes: input.patchBytes,
          threshold: sizeThreshold,
        })
      if (input.elapsedMs > 100) {
        emit("diff_slow", {
          operationID: input.operationID,
          filename: input.filename,
          elapsedMs: input.elapsedMs,
          threshold: input.elapsedMs > 5_000 ? 5_000 : input.elapsedMs > 1_000 ? 1_000 : 100,
        })
      }
    },
    diffFullEnd(input: {
      operationID: number | undefined
      elapsedMs: number
      files: number
      totalBeforeChars: number
      totalBeforeBytes: number
      totalAfterChars: number
      totalAfterBytes: number
      totalPatchChars: number
      totalPatchBytes: number
      skippedFiles: number
      skippedBytes: number
      skippedReasonCounts: Record<DiffSkipReason, number>
      aborted?: boolean
      slowestFile?: { filename: string; elapsedMs: number }
      largestInput?: { filename: string; bytes: number }
      largestPatch?: { filename: string; bytes: number }
      largestSkippedInput?: { filename: string; bytes: number }
    }) {
      if (!enabled || input.operationID === undefined) return
      activeDiffs--
      diffCompleted++
      emit("diff_full_end", input)
    },
  }
}

export const EventDiagnostics = makeEventDiagnostics()

export * as EventDiagnosticsModule from "./event-diagnostics"
