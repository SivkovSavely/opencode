import { describe, expect, test } from "bun:test"
import { createServerProtocol, detectServerProtocol } from "./server-protocol"

const server = { url: "http://localhost:4096" }
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const location = () => json({ directory: "/tmp/project", project: { id: "project", directory: "/tmp/project" } })
const mockFetch = (run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  Object.assign(run, { preconnect: globalThis.fetch.preconnect })

describe("detectServerProtocol", () => {
  test("selects V2 when its API is available alongside legacy routes", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({ healthy: true, version: "1.18.4" }))
      if (path === "/api/health") return Promise.resolve(json({ healthy: true }))
      return Promise.resolve(location())
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
  })

  test("recognizes V2 from its location response contract", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      if (path === "/api/health") return Promise.resolve(json({ healthy: true }))
      return Promise.resolve(location())
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
  })

  test("recognizes the transitional V1 API health response when the V2 API is absent", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/api/health") return Promise.resolve(json({ healthy: true }))
      return Promise.resolve(json({}, 404))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("recognizes the legacy V1 health endpoint when the V2 API is absent", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({ healthy: true, version: "1.18.4" }))
      return Promise.resolve(json({}, 404))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("does not select a protocol when both health endpoints are unavailable", async () => {
    const fetcher = mockFetch(async () => json({ error: "Not Found" }, 404))

    expect(await detectServerProtocol(server, fetcher)).toBeUndefined()
  })

  test("does not identify a protocol from HTTP errors", async () => {
    const fetcher = mockFetch(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      return json({ healthy: true, pid: 123 }, path === "/global/health" ? 500 : 503)
    })

    expect(await detectServerProtocol(server, fetcher)).toBeUndefined()
  })

  test("does not treat an HTML health fallback as V2", async () => {
    const fetcher = mockFetch(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return json({}, 404)
      return new Response("<html>OpenCode</html>", { headers: { "content-type": "text/html" } })
    })

    expect(await detectServerProtocol(server, fetcher)).toBeUndefined()
  })

  test("does not treat malformed JSON health as V2", async () => {
    const fetcher = mockFetch(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return json({}, 404)
      return new Response("{", { headers: { "content-type": "application/json" } })
    })

    expect(await detectServerProtocol(server, fetcher)).toBeUndefined()
  })

  test("retries after both initial V1 probes time out and recovers without a page refresh", async () => {
    const calls = new Map<string, number>()
    const fetcher = mockFetch(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      const count = (calls.get(path) ?? 0) + 1
      calls.set(path, count)
      if ((path === "/global/health" || path === "/api/health") && count === 1)
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "TimeoutError")), {
            once: true,
          })
        })
      if (path === "/global/health") return json({ healthy: true, version: "1.18.4" })
      return json({}, 404)
    })
    const state = createServerProtocol(server, fetcher, { timeoutMs: 5, retryDelayMs: () => 1 })

    expect(await state.protocol).toBe("v1")
    expect(calls.get("/global/health")).toBe(2)
    expect(calls.get("/api/health")).toBe(2)
    expect(calls.get("/api/location")).toBe(1)
    state.dispose()
  })

  test("leaves the protocol unknown while unavailable and cancels retry activity", async () => {
    let calls = 0
    const fetcher = mockFetch(async () => {
      calls++
      return json({}, 404)
    })
    const state = createServerProtocol(server, fetcher, { timeoutMs: 5, retryDelayMs: () => 20 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(state.current()).toBeUndefined()
    state.dispose()
    await expect(state.protocol).rejects.toMatchObject({ name: "AbortError" })
    const stopped = calls
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toBe(stopped)
  })

  test("re-detects a changed protocol after the server reconnects", async () => {
    let protocol: "v1" | "v2" = "v1"
    const fetcher = mockFetch(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health")
        return protocol === "v1" ? json({ healthy: true, version: "1.18.4" }) : json({}, 404)
      if (path === "/api/health") return json({ healthy: true })
      return protocol === "v2" ? location() : json({}, 404)
    })
    const state = createServerProtocol(server, fetcher, { retryDelayMs: () => 1 })

    expect(await state.protocol).toBe("v1")
    protocol = "v2"
    expect(await state.refresh()).toBe("v2")
    expect(await state.get()).toBe("v2")
    state.dispose()
  })

  test("waits for an in-progress protocol refresh before dispatching API calls", async () => {
    let protocol: "v1" | "v2" = "v1"
    let release!: (response: Response) => void
    let legacyCalls = 0
    const fetcher = mockFetch(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") {
        legacyCalls++
        if (legacyCalls > 1) return new Promise<Response>((resolve) => (release = resolve))
        return json({ healthy: true, version: "1.18.4" })
      }
      if (path === "/api/health") return json({ healthy: true })
      return protocol === "v2" ? location() : json({}, 404)
    })
    const state = createServerProtocol(server, fetcher)

    expect(await state.protocol).toBe("v1")
    protocol = "v2"
    const refresh = state.refresh()
    let detected: "v1" | "v2" | undefined
    const latest = state.get().then((value) => (detected = value))

    expect(detected).toBeUndefined()
    release(json({}, 404))
    expect(await latest).toBe("v2")
    expect(await refresh).toBe("v2")
    state.dispose()
  })
})
