import { describe, expect, test } from "bun:test"
import { createServerProtocol, detectServerProtocol } from "./server-protocol"

const server = { url: "http://localhost:4096" }
const projectList = () =>
  json([{ id: "project", worktree: "/tmp/project", time: { created: 0, updated: 0 }, sandboxes: [] }])
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const location = () => json({ directory: "/tmp/project", project: { id: "project", directory: "/tmp/project" } })
const mockFetch = (run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  Object.assign(run, { preconnect: globalThis.fetch.preconnect })
const pathOf = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : input).pathname

function v1Response(path: string) {
  if (path === "/global/health") return json({ healthy: true, version: "1.18.4" })
  if (path === "/api/health") return json({ healthy: true })
  if (path === "/project") return projectList()
  return json({}, 404)
}

function v2Response(path: string) {
  if (path === "/global/health") return json({ healthy: true, version: "1.18.4" })
  if (path === "/api/health") return json({ healthy: true })
  if (path === "/api/location") return location()
  if (path === "/api/project") return projectList()
  if (path === "/api/model/default") return json({ data: null })
  return json({}, 404)
}

describe("detectServerProtocol", () => {
  test("selects V1 for the observed hybrid server when required V2 Web endpoints are missing", async () => {
    const paths: string[] = []
    const fetcher = mockFetch(async (input) => {
      const path = pathOf(input)
      paths.push(path)
      if (path === "/api/location") return location()
      if (path === "/api/project" || path === "/api/model/default") return json({}, 404)
      return v1Response(path)
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
    expect(paths).toContain("/api/location")
    expect(paths).toContain("/api/project")
    expect(paths).toContain("/api/model/default")
    expect(paths).toContain("/project")
  })

  test("selects V2 only when all Web initialization endpoints satisfy their contracts", async () => {
    const paths: string[] = []
    const fetcher = mockFetch(async (input) => {
      const path = pathOf(input)
      paths.push(path)
      return v2Response(path)
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
    expect(paths).toContain("/global/health")
    expect(paths).toContain("/api/location")
    expect(paths).toContain("/api/project")
    expect(paths).toContain("/api/model/default")
    expect(paths).not.toContain("/project")
  })

  test("selects V1 when the V2 endpoints are absent and the legacy project API works", async () => {
    const fetcher = mockFetch(async (input) => v1Response(pathOf(input)))

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("leaves the protocol unknown when V2 probes have transient failures", async () => {
    for (const failure of ["connection", "timeout", "server"] as const) {
      const fetcher = mockFetch(async (input, init) => {
        const path = pathOf(input)
        if (path === "/global/health" || path === "/api/health") return json({ healthy: true })
        if (path === "/project") return projectList()
        if (failure === "connection") throw new TypeError("Connection failed")
        if (failure === "timeout")
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "TimeoutError")), {
              once: true,
            }),
          )
        return json({}, 503)
      })

      expect(await detectServerProtocol(server, fetcher, { timeoutMs: 2 })).toBeUndefined()
    }
  })

  test("does not select V1 when a V2 404 is mixed with unresolved probes", async () => {
    const failures: Array<Response | "connection"> = [
      json({}, 401),
      json({}, 403),
      json({}, 429),
      json({}, 503),
      new Response("<html>OpenCode</html>", { headers: { "content-type": "text/html" } }),
      new Response("{", { headers: { "content-type": "application/json" } }),
      "connection",
    ]

    for (const failure of failures) {
      const paths: string[] = []
      const fetcher = mockFetch(async (input) => {
        const path = pathOf(input)
        paths.push(path)
        if (path === "/global/health" || path === "/api/health") return json({ healthy: true })
        if (path === "/api/location") return location()
        if (path === "/api/project") return json({}, 404)
        if (path === "/api/model/default") {
          if (failure === "connection") throw new TypeError("Connection failed")
          return failure
        }
        if (path === "/project") return projectList()
        return json({}, 404)
      })

      expect(await detectServerProtocol(server, fetcher)).toBeUndefined()
      expect(paths).not.toContain("/project")
    }
  })

  test("does not treat authorization failures as missing endpoints", async () => {
    const fetcher = mockFetch(async (input) => {
      const path = pathOf(input)
      if (path === "/global/health" || path === "/api/health") return json({ healthy: true })
      if (path === "/api/location") return location()
      if (path === "/api/project") return json({}, 403)
      if (path === "/api/model/default") return json({}, 401)
      return projectList()
    })

    expect(await detectServerProtocol(server, fetcher)).toBeUndefined()
  })

  test("rejects HTML and malformed JSON API fallbacks", async () => {
    for (const invalid of [
      new Response("<html>OpenCode</html>", { headers: { "content-type": "text/html" } }),
      new Response("{", { headers: { "content-type": "application/json" } }),
    ]) {
      const fetcher = mockFetch(async (input) => {
        const path = pathOf(input)
        if (path === "/global/health" || path === "/api/health") return json({ healthy: true })
        if (path === "/api/location") return location()
        if (path === "/api/project") return invalid
        if (path === "/api/model/default") return json({ data: null })
        return json({}, 404)
      })

      expect(await detectServerProtocol(server, fetcher)).toBeUndefined()
    }
  })

  test("does not infer V1 from malformed legacy project data", async () => {
    const fetcher = mockFetch(async (input) => {
      const path = pathOf(input)
      if (path === "/global/health" || path === "/api/health") return json({ healthy: true })
      if (path === "/project") return json({ projects: [] })
      return json({}, 404)
    })

    expect(await detectServerProtocol(server, fetcher)).toBeUndefined()
  })

  test("rejects project lists missing required contract fields", async () => {
    const incomplete = [
      json([{ id: "project", worktree: "/tmp/project" }]),
      json([{ id: "project", worktree: "/tmp/project", time: { created: 0, updated: 0 } }]),
      json([{ id: "project", worktree: "/tmp/project", sandboxes: [] }]),
    ]

    for (const projects of incomplete) {
      const v2Fetcher = mockFetch(async (input) => {
        const path = pathOf(input)
        if (path === "/global/health" || path === "/api/health") return json({ healthy: true })
        if (path === "/api/location") return location()
        if (path === "/api/project") return projects
        if (path === "/api/model/default") return json({ data: null })
        return json({}, 404)
      })
      expect(await detectServerProtocol(server, v2Fetcher)).toBeUndefined()

      const v1Fetcher = mockFetch(async (input) => {
        const path = pathOf(input)
        if (path === "/global/health" || path === "/api/health") return json({ healthy: true })
        if (path === "/project") return projects
        return json({}, 404)
      })
      expect(await detectServerProtocol(server, v1Fetcher)).toBeUndefined()
    }
  })

  test("does not select a protocol when both health endpoints are unavailable", async () => {
    const fetcher = mockFetch(async () => json({ error: "Not Found" }, 404))

    expect(await detectServerProtocol(server, fetcher)).toBeUndefined()
  })

  test("retries after health probes time out and recovers without a page refresh", async () => {
    const calls = new Map<string, number>()
    const fetcher = mockFetch(async (input, init) => {
      const path = pathOf(input)
      const count = (calls.get(path) ?? 0) + 1
      calls.set(path, count)
      if ((path === "/global/health" || path === "/api/health") && count === 1)
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "TimeoutError")), {
            once: true,
          }),
        )
      return v1Response(path)
    })
    const state = createServerProtocol(server, fetcher, { timeoutMs: 5, retryDelayMs: () => 1 })

    expect(await state.protocol).toBe("v1")
    expect(calls.get("/global/health")).toBe(2)
    expect(calls.get("/api/health")).toBe(2)
    expect(calls.get("/api/location")).toBe(1)
    expect(calls.get("/api/project")).toBe(1)
    expect(calls.get("/api/model/default")).toBe(1)
    expect(calls.get("/project")).toBe(1)
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

  test("shares concurrent detection and cancels probes when disposed", async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const calls = new Map<string, number>()
    const fetcher = mockFetch(async (input, init) => {
      const path = pathOf(input)
      calls.set(path, (calls.get(path) ?? 0) + 1)
      if (path === "/global/health" || path === "/api/health") return json({ healthy: true })
      if (path === "/api/location") {
        entered()
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          }),
        )
      }
      return projectList()
    })
    const state = createServerProtocol(server, fetcher)
    const pending = state.protocol
    await started

    expect(state.get()).toBe(pending)
    expect(state.refresh()).toBe(pending)
    expect(calls.get("/api/location")).toBe(1)
    state.dispose()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("re-detects a changed protocol after the server reconnects", async () => {
    let protocol: "v1" | "v2" = "v1"
    const fetcher = mockFetch(async (input) => {
      const path = pathOf(input)
      if (path === "/global/health") return protocol === "v1" ? v1Response(path) : json({}, 404)
      return protocol === "v2" ? v2Response(path) : v1Response(path)
    })
    const state = createServerProtocol(server, fetcher, { retryDelayMs: () => 1 })

    expect(await state.protocol).toBe("v1")
    protocol = "v2"
    expect(await state.refresh()).toBe("v2")
    expect(await state.get()).toBe("v2")
    protocol = "v1"
    expect(await state.refresh()).toBe("v1")
    expect(await state.get()).toBe("v1")
    state.dispose()
  })

  test("waits for an in-progress protocol refresh before dispatching API calls", async () => {
    let protocol: "v1" | "v2" = "v1"
    let release!: (response: Response) => void
    let legacyCalls = 0
    const fetcher = mockFetch(async (input) => {
      const path = pathOf(input)
      if (path === "/global/health") {
        legacyCalls++
        if (legacyCalls > 1) return new Promise<Response>((resolve) => (release = resolve))
      }
      if (protocol === "v2") return v2Response(path)
      return v1Response(path)
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
