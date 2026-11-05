import { expect, test } from "bun:test"
import { formatTimestamp } from "./timestamp"

test("formats local 24-hour clocks with seconds and no fractional seconds", () => {
  expect(formatTimestamp(new Date(2026, 0, 2, 19, 44, 37, 999).getTime(), "en-US")).toBe("19:44:37")
  expect(formatTimestamp(new Date(2026, 0, 2, 0, 0, 0).getTime(), "en-US")).toBe("00:00:00")
  expect(formatTimestamp(0, "en-US")).not.toBe("")
})

test("does not fabricate missing or invalid instants", () => {
  for (const value of [undefined, "123", NaN, Infinity, -Infinity, 8.64e15 + 1]) {
    expect(formatTimestamp(value, "en-US")).toBe("")
  }
})

test("uses localized digits and the client timezone", () => {
  const time = new Date(2026, 0, 2, 19, 44, 37).getTime()
  expect(formatTimestamp(time, "ar-EG")).toBe("١٩:٤٤:٣٧")
  const command = [
    "bun",
    "-e",
    'import { formatTimestamp } from "./src/message/timestamp.ts"; console.log(formatTimestamp(0, "en-US"))',
  ]
  const utc = Bun.spawnSync(command, { env: { ...process.env, TZ: "UTC" } })
  const eastern = Bun.spawnSync(command, { env: { ...process.env, TZ: "America/New_York" } })
  expect(utc.exitCode).toBe(0)
  expect(eastern.exitCode).toBe(0)
  expect(utc.stdout.toString().trim()).toBe("00:00:00")
  expect(eastern.stdout.toString().trim()).toBe("19:00:00")
})
