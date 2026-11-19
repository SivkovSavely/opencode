import { afterEach, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSdkForServer } from "@/utils/server"
import { createSessionDcp } from "../src/components/session/session-dcp"

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  const requests: { request: Request; response: ReturnType<typeof Promise.withResolvers<Response>> }[] = []
  const source = (url: string, directory: string) => ({
    scope: url,
    directory,
    client: createSdkForServer({
      server: { url, username: "reader", password: "secret" },
      directory,
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const response = Promise.withResolvers<Response>()
          requests.push({ request: new Request(input), response })
          return response.promise
        },
        { preconnect: fetch.preconnect },
      ),
    }),
  })
  const [state, setState] = createStore({
    source: source("https://first.example", "/one"),
    id: "ses_one",
    workspace: undefined as string | undefined,
    visible: true,
  })
  const reader = createRoot((dispose) => {
    cleanup.push(dispose)
    return createSessionDcp({
      source: () => state.source,
      sessionID: () => state.id,
      workspaceID: () => state.workspace,
      visible: () => state.visible,
    })
  })
  return { state, setState, reader, requests, source }
}

test("uses the selected SDK auth/server and immediately clears old session, workspace and server state", async () => {
  const s = setup()
  await tick()
  expect(s.requests).toHaveLength(1)
  expect(s.requests[0].request.url).toBe("https://first.example/session/ses_one/dcp?directory=%2Fone")
  expect(s.requests[0].request.headers.get("authorization")).toBe(`Basic ${btoa("reader:secret")}`)
  s.requests[0].response.resolve(Response.json({ sessionID: "ses_one", state: "absent" }))
  await tick()
  expect(s.reader.snapshot()?.state).toBe("absent")
  s.setState("id", "ses_two")
  expect(s.reader.snapshot()).toBeUndefined()
  await tick()
  const old = s.requests[1]
  s.setState("workspace", "ws_next")
  expect(s.reader.snapshot()).toBeUndefined()
  await tick()
  expect(old.request.signal.aborted).toBe(true)
  expect(new URL(s.requests[2].request.url).searchParams.get("workspace")).toBe("ws_next")
  s.setState("source", s.source("https://second.example", "/two"))
  expect(s.reader.snapshot()).toBeUndefined()
  await tick()
  expect(s.requests[3].request.url).toContain("https://second.example/session/ses_two/dcp")
  s.requests[3].response.resolve(Response.json({ sessionID: "ses_two", state: "available", blocks: [], stats: {} }))
  await tick()
  old.response.resolve(Response.json({ sessionID: "ses_two", state: "absent" }))
  await tick()
  expect(s.reader.snapshot()?.state).toBe("available")
})

test("does not overlap refreshes, rejects wrong-session responses, and aborts when hidden", async () => {
  const s = setup()
  await tick()
  s.reader.refresh()
  s.reader.refresh()
  expect(s.requests).toHaveLength(1)
  s.requests[0].response.resolve(Response.json({ sessionID: "ses_wrong", state: "absent" }))
  await tick()
  expect(s.reader.error()).toBe(true)
  expect(s.reader.snapshot()).toBeUndefined()
  s.reader.refresh()
  await tick()
  expect(s.requests).toHaveLength(2)
  s.setState("visible", false)
  await tick()
  expect(s.requests[1].request.signal.aborted).toBe(true)
  s.reader.refresh()
  expect(s.requests).toHaveLength(2)
  s.setState("visible", true)
  await tick()
  expect(s.requests).toHaveLength(3)
  s.requests[2].response.resolve(Response.json({ sessionID: "ses_one", state: "invalid" }))
  await tick()
  expect(s.reader.snapshot()?.state).toBe("invalid")
  expect(s.reader.error()).toBe(false)
})

test("keeps HTTP and malformed response errors local without showing response internals", async () => {
  const s = setup()
  await tick()
  s.requests[0].response.resolve(Response.json({ path: "/secret", stack: "private" }, { status: 403 }))
  await tick()
  expect(s.reader.error()).toBe(true)
  expect(s.reader.snapshot()).toBeUndefined()
  s.reader.refresh()
  await tick()
  s.requests[1].response.resolve(Response.json({ sessionID: "ses_one", state: "available", blocks: "corrupt" }))
  await tick()
  expect(s.reader.error()).toBe(true)
  expect(s.reader.snapshot()).toBeUndefined()
})
