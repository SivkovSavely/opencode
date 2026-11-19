import { createServer, type IncomingHttpHeaders } from "node:http"
import { WebSocketServer } from "ws"

/** Owned loopback OAuth/Codex bridge; request captures deliberately exclude all headers and credentials. */
export async function createCodexServer(upstream: string, expectations?: { access?: string; accountId?: string }) {
  const target = new URL(upstream)
  if (target.hostname !== "127.0.0.1") throw new Error("Codex fixture requires a loopback upstream")
  const frames: Record<string, unknown>[] = []
  const requests = new Set<AbortController>()
  const refreshes: number[] = []
  let issuedAccess = expectations?.access
  const observations: {
    transport: "http" | "ws"
    authorized: boolean
    accountMatched: boolean
    internalHeaderPresent: boolean
  }[] = []
  const observe = (transport: "http" | "ws", headers: IncomingHttpHeaders) =>
    observations.push({
      transport,
      authorized: issuedAccess !== undefined && headers.authorization === `Bearer ${issuedAccess}`,
      accountMatched: headers["chatgpt-account-id"] === (expectations?.accountId ?? "fixture-account"),
      internalHeaderPresent: headers["x-opencode-title"] !== undefined,
    })
  const forward = async (body: Record<string, unknown>, signal: AbortSignal) => {
    frames.push(body)
    return fetch(new URL("/v1/responses", upstream), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    })
  }
  const server = createServer(async (request, response) => {
    const controller = new AbortController()
    requests.add(controller)
    response.once("close", () => controller.abort())
    try {
      if (request.url === "/oauth/token" && request.method === "POST") {
        for await (const _chunk of request) {
          // Drain fabricated form data without retaining or logging credentials.
        }
        refreshes.push(1)
        issuedAccess = "fixture-refreshed-access"
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            access_token: issuedAccess,
            refresh_token: "fixture-refreshed-refresh",
            expires_in: 3600,
          }),
        )
        return
      }
      if (request.url !== "/backend-api/codex/responses" || request.method !== "POST") {
        response.writeHead(404).end()
        return
      }
      if (!request.headers.authorization?.startsWith("Bearer ")) {
        response.writeHead(401).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid fixture response body")
      observe("http", request.headers)
      const result = await forward({ ...body }, controller.signal)
      response.writeHead(result.status, { "content-type": "text/event-stream" })
      const reader = result.body?.getReader()
      if (reader) {
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            response.write(next.value)
          }
        } finally {
          reader.releaseLock()
        }
      }
      response.end()
    } catch {
      response.destroy()
    } finally {
      requests.delete(controller)
    }
  })
  const sockets = new WebSocketServer({ server, path: "/backend-api/codex/responses" })
  sockets.on("connection", (socket, request) => {
    if (!request.headers.authorization?.startsWith("Bearer ")) {
      socket.close(1008)
      return
    }
    const active = new Set<AbortController>()
    socket.on("error", () => {})
    socket.on("close", () => {
      for (const controller of active) controller.abort()
    })
    socket.on("message", async (data) => {
      const controller = new AbortController()
      active.add(controller)
      requests.add(controller)
      try {
        const body: unknown = JSON.parse(data.toString())
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid fixture frame")
        observe("ws", request.headers)
        const result = await forward({ ...body }, controller.signal)
        if (!result.ok || !result.body) throw new Error("Fixture upstream rejected response")
        const decoder = new TextDecoder()
        let pending = ""
        const terminal: string[] = []
        const reader = result.body.getReader()
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            pending += decoder.decode(next.value, { stream: true })
            while (pending.includes("\n\n")) {
              const boundary = pending.indexOf("\n\n")
              const event = pending
                .slice(0, boundary)
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("\n")
              pending = pending.slice(boundary + 2)
              if (!event || event === "[DONE]") continue
              const parsed: unknown = JSON.parse(event)
              // TestLLMServer may emit completion before its scripted trailing gate.
              // Preserve the terminal event and all following events until clean EOF.
              if (
                terminal.length ||
                (parsed &&
                  typeof parsed === "object" &&
                  "type" in parsed &&
                  typeof parsed.type === "string" &&
                  ["response.completed", "response.failed", "response.incomplete", "error"].includes(parsed.type))
              ) {
                terminal.push(event)
                continue
              }
              socket.send(event)
            }
          }
          controller.signal.throwIfAborted()
          for (const event of terminal) socket.send(event)
        } finally {
          reader.releaseLock()
        }
      } catch {
        socket.terminate()
      } finally {
        active.delete(controller)
        requests.delete(controller)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing Codex fixture port")
  const dropConnections = () => {
    for (const controller of requests) controller.abort()
    for (const socket of sockets.clients) socket.terminate()
    server.closeAllConnections()
  }
  return {
    issuer: `http://127.0.0.1:${address.port}`,
    endpoint: `http://127.0.0.1:${address.port}/backend-api/codex/responses`,
    frames: frames as ReadonlyArray<Record<string, unknown>>,
    observations: observations as ReadonlyArray<(typeof observations)[number]>,
    refreshes: () => refreshes.length,
    dropConnections,
    close: async () => {
      dropConnections()
      await Promise.all([
        new Promise<void>((resolve) => sockets.close(() => resolve())),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ])
    },
  }
}
