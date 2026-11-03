import { Cron } from "effect"
import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"

export * as ScheduleTime from "./schedule-time"

const units = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 }
const maxTimestamp = 8_640_000_000_000_000

function cron(spec: Exclude<SessionScheduleV1.Spec, { mode: "interval" }>) {
  if (spec.mode === "cron") {
    if (spec.expression.trim().split(/\s+/).length !== 5)
      throw new Error("Cron expression must have exactly five fields")
    return Cron.parseUnsafe(spec.expression, spec.timeZone)
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(spec.time)) throw new Error("Calendar time must be HH:mm")
  if (
    spec.rule === "weekly" &&
    (!spec.weekdays?.length || spec.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
  )
    throw new Error("Weekly schedules require weekdays from 0 to 6")
  if (
    spec.rule === "monthly" &&
    (spec.day === undefined || !Number.isInteger(spec.day) || spec.day < 1 || spec.day > 31)
  )
    throw new Error("Monthly schedules require a day from 1 to 31")
  if (spec.rule !== "weekly" && spec.weekdays !== undefined)
    throw new Error("Weekdays are only valid for weekly schedules")
  if (spec.rule !== "monthly" && spec.day !== undefined) throw new Error("Day is only valid for monthly schedules")
  const [hour, minute] = spec.time.split(":")
  return Cron.parseUnsafe(
    `${minute} ${hour} ${spec.rule === "monthly" ? spec.day : "*"} * ${spec.rule === "weekly" ? spec.weekdays?.join(",") : "*"}`,
    spec.timeZone,
  )
}

export function validate(spec: SessionScheduleV1.Spec): void {
  if (spec.mode === "interval") {
    if (
      !Number.isSafeInteger(spec.amount) ||
      spec.amount <= 0 ||
      !["minutes", "hours", "days", "weeks"].includes(spec.unit) ||
      typeof spec.immediate !== "boolean"
    )
      throw new Error("Invalid interval schedule")
    if (!Number.isSafeInteger(spec.amount * units[spec.unit]) || spec.amount * units[spec.unit] > maxTimestamp)
      throw new Error("Interval duration is out of range")
    return
  }
  if (spec.mode !== "calendar" && spec.mode !== "cron") throw new Error("Invalid schedule mode")
  if (spec.mode === "calendar" && !["daily", "weekly", "monthly", "last-day"].includes(spec.rule))
    throw new Error("Invalid calendar rule")
  const parsed = cron(spec)
  try {
    Cron.next(parsed, Date.UTC(2024, 0, 1))
  } catch {
    throw new Error("Schedule has no possible occurrence")
  }
}

export function next(spec: SessionScheduleV1.Spec, anchor: number, after: number): number {
  validate(spec)
  if (
    !Number.isSafeInteger(anchor) ||
    !Number.isSafeInteger(after) ||
    Math.abs(anchor) > maxTimestamp ||
    Math.abs(after) > maxTimestamp
  )
    throw new Error("Invalid schedule timestamp")
  if (spec.mode === "interval") {
    const duration = spec.amount * units[spec.unit]
    const first = anchor + (spec.immediate ? 0 : duration)
    const result = first + Math.max(0, Math.floor((after - first) / duration) + 1) * duration
    if (!Number.isSafeInteger(result) || Math.abs(result) > maxTimestamp)
      throw new Error("Schedule timestamp is out of range")
    return result
  }
  const parsed = cron(spec)
  let cursor = after
  for (let i = 0; i < 400; i++) {
    cursor = Cron.next(parsed, cursor).getTime()
    // Effect maps nonexistent local times forward; skip those, and use its earlier
    // offset for repeated times (one occurrence per local wall-clock time).
    if (!Cron.match(parsed, cursor)) continue
    if (spec.mode === "calendar" && spec.rule === "last-day") {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: spec.timeZone,
        day: "numeric",
        month: "numeric",
        year: "numeric",
      }).formatToParts(cursor)
      const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
      if (value("day") !== new Date(Date.UTC(value("year"), value("month"), 0)).getUTCDate()) continue
    }
    if (cursor > after) return cursor
  }
  throw new Error("Unable to find next schedule occurrence")
}

export function preview(spec: SessionScheduleV1.Spec, anchor: number, after: number, count = 5): number[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error("Invalid preview count")
  const times: number[] = []
  while (times.length < count) times.push(next(spec, anchor, times.at(-1) ?? after))
  return times
}

export function summary(spec: SessionScheduleV1.Spec): string {
  if (spec.mode === "interval") return `Every ${spec.amount} ${spec.unit}${spec.immediate ? " (immediately)" : ""}`
  if (spec.mode === "cron") return `${spec.expression} (${spec.timeZone})`
  const rule =
    spec.rule === "daily"
      ? "Every day"
      : spec.rule === "weekly"
        ? `Every ${spec.weekdays?.map((day) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]).join(", ")}`
        : spec.rule === "monthly"
          ? `Every month on day ${spec.day}`
          : "Last day of every month"
  return `${rule} at ${spec.time} (${spec.timeZone})`
}
