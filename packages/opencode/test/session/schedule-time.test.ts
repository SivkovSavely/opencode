import { describe, expect, test } from "bun:test"
import { ScheduleTime } from "@/session/schedule-time"

const utc = (value: string) => Date.parse(value)

describe("schedule calculation", () => {
  test("interval anchors and strict boundaries", () => {
    const spec = { mode: "interval", amount: 2, unit: "hours", immediate: true } as const
    expect(ScheduleTime.preview(spec, 1000, 999, 3)).toEqual([1000, 7201000, 14401000])
    expect(ScheduleTime.next({ ...spec, immediate: false }, 1000, 0)).toBe(7201000)
    expect(ScheduleTime.next(spec, 1000, 1000)).toBe(7201000)
  })

  test("calendar skips missing month days and supports last day", () => {
    const spec = { mode: "calendar", rule: "monthly", day: 31, time: "09:00", timeZone: "UTC" } as const
    expect(ScheduleTime.preview(spec, 0, utc("2025-01-31T09:00:00Z"), 2)).toEqual([
      utc("2025-03-31T09:00:00Z"),
      utc("2025-05-31T09:00:00Z"),
    ])
    expect(
      ScheduleTime.next(
        { mode: "calendar", rule: "last-day", time: "09:00", timeZone: "UTC" },
        0,
        utc("2024-02-01T00:00:00Z"),
      ),
    ).toBe(utc("2024-02-29T09:00:00Z"))
    expect(
      ScheduleTime.next(
        { mode: "calendar", rule: "weekly", weekdays: [0, 2], time: "09:00", timeZone: "UTC" },
        0,
        utc("2025-01-06T00:00:00Z"),
      ),
    ).toBe(utc("2025-01-07T09:00:00Z"))
  })

  test("rejects interval overflow, including an immediate schedule's successor", () => {
    const spec = { mode: "interval", amount: Number.MAX_SAFE_INTEGER, unit: "weeks", immediate: true } as const
    expect(() => ScheduleTime.validate(spec)).toThrow("Interval duration is out of range")
    expect(() => ScheduleTime.next(spec, 1000, 999)).toThrow("Interval duration is out of range")
    expect(() =>
      ScheduleTime.next({ ...spec, amount: 1, unit: "minutes" }, 8_640_000_000_000_000, 8_640_000_000_000_000),
    ).toThrow("Schedule timestamp is out of range")
    expect(() => ScheduleTime.next({ ...spec, amount: 1 }, 0, Number.MAX_SAFE_INTEGER)).toThrow(
      "Invalid schedule timestamp",
    )
  })

  test("DST gaps are skipped and repeated times run once", () => {
    const spec = { mode: "calendar", rule: "daily", time: "02:30", timeZone: "America/New_York" } as const
    expect(ScheduleTime.next(spec, 0, utc("2025-03-08T08:00:00Z"))).toBe(utc("2025-03-10T06:30:00Z"))
    expect(ScheduleTime.preview({ ...spec, time: "01:30" }, 0, utc("2025-11-02T00:00:00Z"), 2)).toEqual([
      utc("2025-11-02T05:30:00Z"),
      utc("2025-11-03T06:30:00Z"),
    ])
  })

  test("cron and validation", () => {
    const cron = { mode: "cron", expression: "*/15 * * * *", timeZone: "UTC" } as const
    expect(ScheduleTime.next(cron, 0, utc("2025-01-01T00:00:00Z"))).toBe(utc("2025-01-01T00:15:00Z"))
    expect(() => ScheduleTime.validate({ ...cron, expression: "0 0 0 * * *" })).toThrow()
    expect(() => ScheduleTime.validate({ ...cron, expression: "0 0 31 2 *" })).toThrow()
    expect(() => ScheduleTime.validate({ ...cron, timeZone: "Not/AZone" })).toThrow()
    expect(() => ScheduleTime.validate({ mode: "calendar", rule: "weekly", time: "25:00", timeZone: "UTC" })).toThrow()
    expect(() => ScheduleTime.validate({ mode: "interval", amount: 0, unit: "minutes", immediate: false })).toThrow()
  })
})
