import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"
import { createServerProtocol } from "../../utils/server-protocol"

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createRefreshQueue", () => {
  test("clears queued directories by normalized key", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")
    queue.clear("C:/tmp/demo")

    await tick()

    expect(calls).toEqual([])
    queue.dispose()
  })

  test("passes the original directory to bootstrapInstance", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")

    await tick()

    expect(calls).toEqual(["C:\\tmp\\demo"])
    queue.dispose()
  })

  test("prioritizes the active directory and bounds startup behind delayed protocol detection", async () => {
    const calls: string[] = []
    let running = 0
    let peak = 0
    let completed = 0
    let finish!: () => void
    let probe!: () => void
    let available = false
    const done = new Promise<void>((resolve) => (finish = resolve))
    const probed = new Promise<void>((resolve) => (probe = resolve))
    const fetcher = Object.assign(
      async (input: string | URL | Request) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname
        if (path === "/global/health")
          return available
            ? new Response(JSON.stringify({ healthy: true }), { headers: { "content-type": "application/json" } })
            : new Response("", { status: 503 })
        if (path === "/api/health") {
          if (!available) probe()
          return new Response("", { status: available ? 404 : 503 })
        }
        if (path === "/api/location") return new Response("", { status: 404 })
        if (path === "/api/project" || path === "/api/model/default") return new Response("", { status: 404 })
        if (path === "/project")
          return new Response("[]", { headers: { "content-type": "application/json" } })
        probe()
        return new Response("", { status: 503 })
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const protocol = createServerProtocol({ url: "http://localhost:4096" }, fetcher, { retryDelayMs: () => 50 })
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: async (directory) => {
        running++
        peak = Math.max(peak, running)
        const kind = await protocol.get()
        expect(kind).toBe("v1")
        calls.push(directory)
        await new Promise((resolve) => setTimeout(resolve, 1))
        running--
        completed++
        if (completed === 40) finish()
      },
    })

    for (let index = 0; index < 40; index++) queue.push(`/project/${index}`)
    queue.push("/project/39", { priority: true })

    await probed
    await tick()
    expect(protocol.current()).toBeUndefined()
    expect(calls).toEqual([])
    available = true

    await done

    expect(calls).toHaveLength(40)
    expect(calls[0]).toBe("/project/39")
    expect(peak).toBe(2)
    queue.dispose()
    protocol.dispose()
  })

  test("resumes queued directories after a global refresh", async () => {
    const calls: string[] = []
    let paused = true
    const queue = createRefreshQueue({
      paused: () => paused,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("/project")
    await tick()
    expect(calls).toEqual([])

    paused = false
    queue.resume()
    await tick()

    expect(calls).toEqual(["/project"])
    queue.dispose()
  })

  test("does not start queued directories after disposal", async () => {
    const calls: string[] = []
    let release!: () => void
    let started!: () => void
    let startedCount = 0
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const firstBatch = new Promise<void>((resolve) => (started = resolve))
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: async (directory) => {
        calls.push(directory)
        startedCount++
        if (startedCount === 2) started()
        await blocked
      },
    })

    queue.push("/project/1")
    queue.push("/project/2")
    queue.push("/project/3")
    await firstBatch
    queue.dispose()
    release()
    await tick()

    expect(calls).toEqual(["/project/1", "/project/2"])
  })
})
