const formatters = new Map<string, Intl.DateTimeFormat>()

// Persisted or plugin-provided timestamps can be absent or malformed at the display boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function formatTimestamp(value: unknown, locale?: string) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 8.64e15) return ""

  const key = locale || "default"

  const formatter =
    formatters.get(key) ??
    new Intl.DateTimeFormat(locale || undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })

  formatters.set(key, formatter)
  const parts = formatter.formatToParts(value)
  const hour = parts.find((part) => part.type === "hour")?.value
  const minute = parts.find((part) => part.type === "minute")?.value
  const second = parts.find((part) => part.type === "second")?.value

  return hour && minute && second ? `${hour}:${minute}:${second}` : ""
}
