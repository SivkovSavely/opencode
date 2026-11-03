import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { sessionSchedule } from "./session-schedule"

describe("session schedule transport", () => {
  test("uses the configured transport and scope for preview and paginated history", async () => {
    const requests: Request[] = []
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      headers: { Authorization: "Basic test" },
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const request = new Request(input)
          requests.push(request.clone())
          return Response.json(
            request.url.includes("/history") ? { items: [], cursor: 42 } : { times: [123], summary: "test" },
          )
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const schedule = sessionSchedule(client, "session / one", "/project one")
    const spec = { mode: "interval", amount: 15, unit: "minutes", immediate: false } as const
    expect(await schedule.preview(spec, "schedule 1")).toEqual({ times: [123], summary: "test" })
    expect(await schedule.history("schedule 1", 42)).toEqual({ items: [], cursor: 42 })
    expect(new URL(requests[0].url).pathname).toBe("/session/session%20%2F%20one/schedule/preview")
    expect(new URL(requests[0].url).searchParams.get("directory")).toBe("/project one")
    expect(requests[0].headers.get("authorization")).toBe("Basic test")
    expect(await requests[0].json()).toEqual({ spec, scheduleID: "schedule 1" })
    expect(new URL(requests[1].url).pathname).toEndWith("/schedule/schedule%201/history")
    expect(new URL(requests[1].url).searchParams.get("cursor")).toBe("42")
  })

  test("rejects malformed responses and HTTP errors", async () => {
    const malformed = createOpencodeClient({
      baseUrl: "http://localhost",
      fetch: Object.assign(async () => Response.json({ times: [] }), { preconnect: fetch.preconnect }),
    })
    await expect(
      sessionSchedule(malformed, "s", "/").preview({ mode: "cron", expression: "* * * * *", timeZone: "UTC" }),
    ).rejects.toThrow()
    const failed = createOpencodeClient({
      baseUrl: "http://localhost",
      fetch: Object.assign(async () => Response.json({ message: "invalid" }, { status: 400 }), {
        preconnect: fetch.preconnect,
      }),
    })
    await expect(sessionSchedule(failed, "s", "/").list()).rejects.toBeDefined()
  })
})
