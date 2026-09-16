import { afterEach, describe, expect, test } from "bun:test"
import { gunzipSync, inflateSync } from "node:zlib"
import { GlobalBus } from "../../src/bus/global"
import { EventDiagnostics } from "@opencode-ai/core/event-diagnostics"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function app() {
  return Server.Default().app
}

// /config echoes the config back. Padding the config pushes the response body
// well past the 1024 B threshold so we can observe compression behavior.
function fatConfig() {
  const instructions: string[] = []
  for (let i = 0; i < 50; i++) {
    instructions.push(`padding-instruction-${i}-${"x".repeat(40)}`)
  }
  return {
    formatter: false,
    lsp: false,
    username: "compression-test-user",
    instructions,
  }
}

describe("HttpApi compression", () => {
  describe("encodes responses", () => {
    test("gzips JSON when Accept-Encoding includes gzip and body exceeds threshold", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("gzip")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = gunzipSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
      expect(compressed.byteLength).toBeLessThan(decompressed.byteLength)
    })

    test("uses deflate when only deflate is acceptable", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "deflate" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("deflate")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = inflateSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
    })

    test("prefers gzip when both gzip and deflate are acceptable", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip, deflate" },
      })
      expect(response.headers.get("content-encoding")).toBe("gzip")
    })

    test("does not include the original Content-Length when compressed", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      const compressed = new Uint8Array(await response.arrayBuffer())
      const declared = response.headers.get("content-length")
      // Either absent (transfer-encoding chunked) or matches the compressed length.
      if (declared !== null) expect(Number(declared)).toBe(compressed.byteLength)
    })
  })

  describe("skips", () => {
    test("when no Accept-Encoding header is present", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when Accept-Encoding only allows unsupported encodings", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "br" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when the response body is below the 1024-byte threshold", async () => {
      // A bare config produces a tiny response (~few hundred bytes).
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.status).toBe(200)
      const body = new Uint8Array(await response.arrayBuffer())
      expect(body.byteLength).toBeLessThan(1024)
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("HEAD requests", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        method: "HEAD",
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })
  })

  describe("streaming exclusions", () => {
    test("/event SSE is not compressed", async () => {
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const controller = new AbortController()
      const response = await app().request("/event", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
      } finally {
        controller.abort()
        await response.body?.cancel().catch(() => {})
      }
    })

    test("/global/event SSE is not compressed", async () => {
      const controller = new AbortController()
      const listenersBefore = GlobalBus.listenerCount("event")
      const subscribersBefore = EventDiagnostics.activeSubscriberCount()
      const response = await app().request("/global/event", {
        headers: { "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      const reader = response.body?.getReader()
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
        if (!reader) throw new Error("missing response body")
        const connected = await reader.read()
        expect(new TextDecoder().decode(connected.value)).toContain("server.connected")
        expect(GlobalBus.listenerCount("event")).toBe(listenersBefore)
        expect(EventDiagnostics.activeSubscriberCount()).toBe(subscribersBefore)

        const event = reader.read()
        for (let attempt = 0; attempt < 100 && GlobalBus.listenerCount("event") === listenersBefore; attempt++) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        expect(GlobalBus.listenerCount("event")).toBe(listenersBefore + 1)
        expect(EventDiagnostics.activeSubscriberCount()).toBe(subscribersBefore + (EventDiagnostics.enabled ? 1 : 0))
        GlobalBus.emit("event", { directory: "global", payload: { type: "test.event", properties: {} } })
        expect(new TextDecoder().decode((await event).value)).toContain("test.event")
      } finally {
        controller.abort()
        await reader?.cancel().catch(() => {})
      }
      expect(GlobalBus.listenerCount("event")).toBe(listenersBefore)
      expect(EventDiagnostics.activeSubscriberCount()).toBe(subscribersBefore)
    })
  })
})
