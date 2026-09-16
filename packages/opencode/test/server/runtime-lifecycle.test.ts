import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("runtime lifecycle", () => {
  test("reports the listener runtime and rejects unsupported restart", async () => {
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const status = await fetch(new URL("/global/runtime", listener.url))
      expect(status.status).toBe(200)
      const info = await status.json()
      expect(info.state).toBe("running")

      const restart = await fetch(new URL("/global/runtime/restart", listener.url), { method: "POST" })
      expect(restart.status).toBe(info.restartSupported ? 200 : 400)
      if (info.restartSupported) await listener.lifecycle.awaitStop
    } finally {
      await listener.stop(true)
    }
  })

  test("shutdown request is accepted and reaches quiescence", async () => {
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const response = await fetch(new URL("/global/runtime/shutdown", listener.url), { method: "POST" })
      expect(response.status).toBe(200)
      await listener.lifecycle.awaitStop
      expect((await response.json()).state).toBe("stopping")
    } finally {
      await listener.stop(true)
    }
  })
})
