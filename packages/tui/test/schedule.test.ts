import { expect, test } from "bun:test"
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2"
import { newSchedule, positiveInteger, scheduleDetails } from "../src/schedule/form"
import { createScheduleAPI } from "../src/schedule/api"
import { SessionID } from "@opencode-ai/schema/session-id"

test("schedule form defaults are delayed 15 minutes, always, latest and forever", () => {
  expect(newSchedule()).toEqual({
    message: "",
    spec: { mode: "interval", amount: 15, unit: "minutes", immediate: false },
    sessionState: "always",
    deferUntilIdle: false,
    missed: "latest",
  })
  for (const value of ["0", "-1", "1.5", "", "Infinity", "1e3", "9007199254740992"])
    expect(() => positiveInteger(value)).toThrow()
  expect(positiveInteger("31")).toBe(31)
})

for (const workspaceID of [undefined, "workspace-b"]) {
  test(`schedule transport routes all operations to session placement (${workspaceID ?? "local"})`, async () => {
    const requests: Request[] = []
    const session: Session = {
      id: "ses_schedule",
      slug: "s",
      projectID: "project",
      directory: "/worktree-b",
      workspaceID,
      title: "Schedule",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    const input = { ...newSchedule(), message: "  exact\nmessage  " }
    const info = {
      ...input,
      id: "schedule/id",
      sessionID: session.id,
      created: 1,
      anchor: 1,
      status: "active",
      completed: 0,
      next: 100,
      summary: "Every 15 minutes",
    }
    const client = createOpencodeClient({
      baseUrl: "http://schedule.test",
      directory: "/worktree-a",
      experimental_workspaceID: "workspace-a",
      headers: { authorization: "Bearer test" },
      fetch: Object.assign(
        async (request: Parameters<typeof fetch>[0]) => {
          const req = request instanceof Request ? request : new Request(request)
          requests.push(req)
          const path = new URL(req.url).pathname
          return Response.json(
            path.endsWith("/ses_schedule")
              ? session
              : path.endsWith("/preview")
                ? { summary: "Every 15 minutes", times: [1, 2, 3, 4, 5] }
                : path.endsWith("/history")
                  ? { items: [], cursor: 3 }
                  : req.method === "DELETE"
                    ? true
                    : req.method === "GET" && path.endsWith("/schedule")
                      ? [info]
                      : info,
          )
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const api = createScheduleAPI(client, () => undefined)
    expect(await api.list(session.id)).toHaveLength(1)
    await api.get(session.id, info.id)
    expect((await api.save(session.id, input)).message).toBe(input.message)
    await api.save(session.id, input, info.id)
    expect((await api.preview(session.id, input.spec, info.id)).times).toHaveLength(5)
    await api.pause(session.id, info.id, true)
    expect(await api.remove(session.id, info.id)).toBe(true)
    expect((await api.history(session.id, info.id, 12)).cursor).toBe(3)
    const operations = requests.filter((req) => new URL(req.url).pathname.includes("/schedule"))
    expect(operations).toHaveLength(8)
    for (const req of operations) {
      expect(new URL(req.url).searchParams.get("directory")).toBe("/worktree-b")
      expect(new URL(req.url).searchParams.get("workspace")).toBe(workspaceID ?? null)
      expect(req.headers.get("x-opencode-directory")).toBeNull()
      expect(req.headers.get("x-opencode-workspace")).toBeNull()
      expect(req.headers.get("authorization")).toBe("Bearer test")
    }
    expect(await operations[2].json()).toEqual(input)
    expect(operations[3].method).toBe("PUT")
    expect(await operations[4].json()).toEqual({ spec: input.spec, scheduleID: info.id })
    expect(await operations[5].json()).toEqual({ paused: true })
    expect(new URL(operations[7].url).searchParams.get("cursor")).toBe("12")
    expect(operations[1].url).toContain("schedule%2Fid")
  })
}

test("schedule transport rejects malformed server responses and exposes server failures", async () => {
  const client = createOpencodeClient({
    baseUrl: "http://schedule.test",
    fetch: Object.assign(async () => Response.json({ not: "a schedule" }), { preconnect: fetch.preconnect }),
  })
  const session: Session = {
    id: "ses_schedule",
    slug: "s",
    projectID: "p",
    directory: "/tmp",
    title: "t",
    version: "1",
    time: { created: 1, updated: 1 },
  }
  const api = createScheduleAPI(client, () => session)
  await expect(api.list(session.id)).rejects.toThrow()
  await expect(api.preview(session.id, newSchedule().spec)).rejects.toThrow()
})

test("schedule summary shows completed count, finite limit, status and idle deferral", () => {
  const details = scheduleDetails({
    ...newSchedule(),
    message: "Task",
    id: "s",
    sessionID: SessionID.make("ses_test"),
    created: 1,
    anchor: 1,
    completed: 3,
    limit: 4,
    status: "paused",
    summary: "Every 15 minutes",
    sessionState: "idle",
    deferUntilIdle: true,
  })
  expect(details.join("\n")).toContain("paused | 3/4 successes | Next: none")
  expect(details.join("\n")).toContain("Send when idle (defer while busy)")
})
