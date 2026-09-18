import type { ToolState } from "@opencode-ai/sdk/v2"

const formatters = new Map<string, Intl.DateTimeFormat>()

export function formatTimestamp(timestamp: number | undefined, locale?: string) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return ""

  const key = locale || "default"
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale || undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    formatters.set(key, formatter)
  }

  const parts = new Map(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]))
  const hour = parts.get("hour")
  const minute = parts.get("minute")
  const second = parts.get("second")
  if (!hour || !minute || !second) return ""
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}`
}

export function formatToolTimestamp(state: ToolState, locale?: string) {
  if (!("time" in state) || !state.time || typeof state.time.start !== "number") return ""
  return formatTimestamp(state.time.start, locale)
}
