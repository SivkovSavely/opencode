import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import https from "node:https"
import http from "node:http"
import { readFile } from "node:fs/promises"
import { compiledProxy } from "./fixtures/compiled-codex"

test.skipIf(process.env.PHASE14_COMPILED !== "1")(
  "compiled fixture rejects untrusted TLS, wrong certificate names, wrong Host and CONNECT destinations",
  async () => {
    const proxy = await compiledProxy("http://127.0.0.1:1")
    const directory = process.env.PHASE14_DIR
    assert(directory)
    const ca = await readFile(`${directory}/ca.pem`)
    const request = (servername: string, trust: boolean, host = servername) =>
      new Promise<number>((resolve, reject) => {
        const request = https.get(
          {
            hostname: "127.0.0.1",
            port: proxy.tlsPort,
            servername,
            rejectUnauthorized: true,
            ca: trust ? ca : undefined,
            headers: { host },
            agent: false,
          },
          (response) => {
            response.resume()
            resolve(response.statusCode!)
          },
        )
        request.on("error", reject)
      })
    try {
      await expect(request("auth.openai.com", false)).rejects.toThrow()
      await expect(request("wrong.invalid", true)).rejects.toThrow()
      expect(await request("auth.openai.com", true, "wrong.invalid")).toBe(421)
      expect(await request("auth.openai.com", true)).toBe(404)
      const rejected = await new Promise<number>((resolve, reject) => {
        const request = http.request(proxy.url, { method: "CONNECT", path: "wrong.invalid:443", agent: false })
        request.on("connect", (response, socket) => {
          socket.destroy()
          resolve(response.statusCode!)
        })
        request.on("error", reject)
        request.end()
      })
      expect(rejected).toBe(403)
      expect(proxy.observations.connect).toBe(0)
      expect(proxy.observations.rejected).toBe(3)
    } finally {
      await proxy.close()
    }
  },
)

test.skipIf(process.env.PHASE14_COMPILED !== "1")(
  "compiled TLS bridge cancels its upstream when the owned model client disconnects",
  async () => {
    const closed = Promise.withResolvers<void>()
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("data: {}\n\n")
      response.once("close", () => closed.resolve())
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert(address && typeof address !== "string")
    const proxy = await compiledProxy(`http://127.0.0.1:${address.port}`)
    try {
      const ca = await readFile(`${process.env.PHASE14_DIR}/ca.pem`)
      await new Promise<void>((resolve, reject) => {
        const request = https.request(
          {
            hostname: "127.0.0.1",
            port: proxy.tlsPort,
            servername: "chatgpt.com",
            ca,
            rejectUnauthorized: true,
            method: "POST",
            path: "/backend-api/codex/responses",
            headers: { host: "chatgpt.com" },
            agent: false,
          },
          (response) =>
            response.once("data", () => {
              response.destroy()
              resolve()
            }),
        )
        request.on("error", reject)
        request.end("{}")
      })
      await closed.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(proxy.observations).toMatchObject({ cancellations: 1, failures: [] })
    } finally {
      await proxy.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)
