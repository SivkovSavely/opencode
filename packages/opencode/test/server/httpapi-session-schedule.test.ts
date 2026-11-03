import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { SessionScheduleApi } from "../../src/server/routes/instance/httpapi/groups/session-schedule"

describe("session schedule API contract", () => {
  test("declares all management and preview routes", () => {
    const paths = OpenApi.fromApi(SessionScheduleApi).paths
    expect(Object.keys(paths["/session/{sessionID}/schedule"])).toEqual(["get", "post"])
    expect(Object.keys(paths["/session/{sessionID}/schedule/preview"])).toEqual(["post"])
    expect(Object.keys(paths["/session/{sessionID}/schedule/{scheduleID}"])).toEqual(["get", "put", "delete"])
    expect(Object.keys(paths["/session/{sessionID}/schedule/{scheduleID}/pause"])).toEqual(["post"])
    expect(Object.keys(paths["/session/{sessionID}/schedule/{scheduleID}/history"])).toEqual(["get"])
  })

  test("decodes all modes and omits absent optional fields", () => {
    const input = { message: "hello", sessionState: "always", deferUntilIdle: false, missed: "latest" } as const
    const decode = Schema.decodeUnknownSync(SessionScheduleV1.Input)
    for (const spec of [
      { mode: "interval", amount: 1, unit: "minutes", immediate: true },
      { mode: "calendar", rule: "daily", time: "09:00", timeZone: "UTC" },
      { mode: "cron", expression: "0 9 * * *", timeZone: "UTC" },
    ] as const) {
      const value = decode({ ...input, spec })
      expect(Schema.encodeSync(SessionScheduleV1.Input)(value)).toEqual({ ...input, spec })
    }
    expect(() =>
      decode({ ...input, spec: { mode: "interval", amount: 0, unit: "minutes", immediate: true } }),
    ).toThrow()
  })
})
