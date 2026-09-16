import fs from "node:fs"
import path from "node:path"
import { EventDiagnostics, type DiagnosticRecord } from "@opencode-ai/core/event-diagnostics"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

const schemaVersion = 1
const intervalMs = 1_000
const processStartMs = performance.timeOrigin
const processStart = new Date(processStartMs).toISOString()
const filename = `hang-diagnostics-${processStart.replace(/[-:.TZ]/g, "")}-${process.pid}.jsonl`
const target = path.join(Global.Path.log, "hang-diagnostics", filename)

let started = false
let timer: ReturnType<typeof setTimeout> | undefined
let expected = 0

function write(record: DiagnosticRecord) {
  if (!EventDiagnostics.enabled) return
  try {
    fs.appendFileSync(
      target,
      JSON.stringify({
        wallClock: new Date().toISOString(),
        uptimeMs: performance.now(),
        pid: process.pid,
        schemaVersion,
        ...record,
      }) + "\n",
    )
  } catch {
    EventDiagnostics.setBreadcrumbSink(() => undefined)
  }
}

function sample() {
  const actual = performance.now()
  const interval = EventDiagnostics.takeInterval()
  const aggregate = EventDiagnostics.subscriberAggregate()
  const subscriberRecords = EventDiagnostics.subscribers()
  const memory = process.memoryUsage()
  write({
    marker: "sample",
    expectedUptimeMs: expected,
    actualUptimeMs: actual,
    eventLoopLagMs: Math.max(0, actual - expected),
    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      ...(memory.arrayBuffers === undefined ? {} : { arrayBuffers: memory.arrayBuffers }),
    },
    activeSseSubscribers: EventDiagnostics.activeSubscriberCount(),
    ...interval,
    estimatedSseBacklog: aggregate.backlog,
    maximumSubscriberBacklog: aggregate.maximumBacklog,
    sseTransports: aggregate.transports,
    activeSnapshotDiffs: EventDiagnostics.activeDiffCount(),
    subscribers: subscriberRecords,
    omittedSubscriberRecords: Math.max(0, EventDiagnostics.activeSubscriberCount() - subscriberRecords.length),
  })
  expected = actual + intervalMs
  timer = setTimeout(sample, intervalMs)
  timer.unref?.()
}

export function startHangDiagnostics() {
  if (started || !EventDiagnostics.enabled) return
  started = true
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    EventDiagnostics.setBreadcrumbSink(write)
    write({
      marker: "startup",
      version: InstallationVersion,
      argv: process.argv,
      bunVersion: process.versions.bun ?? "unknown",
      platform: process.platform,
      arch: process.arch,
      diagnosticsEnabled: process.env.OPENCODE_HANG_DIAGNOSTICS,
      processStartTime: processStart,
      diagnosticFile: target,
    })
    expected = performance.now() + intervalMs
    timer = setTimeout(sample, intervalMs)
    timer.unref?.()
  } catch {
    EventDiagnostics.setBreadcrumbSink(() => undefined)
  }
}

export function hangDiagnosticsFile() {
  return EventDiagnostics.enabled ? target : undefined
}
