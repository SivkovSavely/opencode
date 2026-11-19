import assert from "node:assert/strict"
import { createServer } from "node:http"
import https from "node:https"
import { connect } from "node:net"
import { appendFile, readFile, readlink } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"

export const candidate = "/tmp/opencode/phase13-build.nejsA8/opencode-candidate-r6"

export async function compiledPort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  assert(![4096, 8765].includes(address.port))
  return address.port
}

export async function compiledReady(pid: number, port: number, seed: boolean) {
  assert.equal(await readlink(`/proc/${pid}/exe`), candidate)
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(`/proc/${pid}/exe`)) hash.update(chunk)
  const sha256 = hash.digest("hex")
  assert.equal(sha256, "737a999e672b91ee9b770a73d598bb3f6cc2e7aa841bcaa4bc421f70a311b7b1")
  const base = `http://127.0.0.1:${port}`
  const response = await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(1000) })
  assert.equal(response.status, 200)
  if (seed) {
    const auth = await fetch(`${base}/auth/openai`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "oauth",
        access: "fixture-expired-access",
        refresh: "fixture-expired-refresh",
        expires: 0,
        accountId: "fixture-account",
      }),
    })
    assert.equal(auth.status, 200)
  }
  await appendFile(
    `${process.env.PHASE14_DIR}/processes.ndjson`,
    JSON.stringify({ pid, port, exe: candidate, sha256, seed, authSeedSucceeded: seed ? true : null }) + "\n",
    { mode: 0o600 },
  )
}

// The proxy never resolves or forwards a public destination. CONNECT terminates
// at an owned TLS listener; only that listener forwards to the loopback fixture.
export async function compiledProxy(issuer: string) {
  const directory = process.env.PHASE14_DIR
  assert(directory)
  assert.equal(process.env.PHASE14_ISOLATED, "1")
  assert((await readFile("/proc/self/cgroup", "utf8")).includes("baila-build.slice"))
  assert.equal(new URL(issuer).hostname, "127.0.0.1")
  const allowed = new Set(["auth.openai.com", "chatgpt.com"])
  const observations = {
    connect: 0,
    rejected: 0,
    rejectedDestinations: [] as string[],
    refresh: 0,
    http: 0,
    ws: 0,
    cancellations: 0,
    failures: [] as string[],
    names: [] as string[],
  }
  const sockets = new Set<import("node:net").Socket>()
  const track = (socket: import("node:net").Socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.once("close", () => sockets.delete(socket))
  }
  const tls = https.createServer(
    {
      key: await readFile(`${directory}/server.key`),
      cert: await readFile(`${directory}/server.pem`),
    },
    async (request, response) => {
      const hostname = request.headers.host?.replace(/:443$/, "")
      if (!hostname || !allowed.has(hostname)) {
        observations.rejected++
        response.writeHead(421).end()
        return
      }
      const refresh = hostname === "auth.openai.com" && request.url === "/oauth/token"
      const model = hostname === "chatgpt.com" && request.url === "/backend-api/codex/responses"
      if (request.method !== "POST" || (!refresh && !model)) {
        observations.rejected++
        response.writeHead(404).end()
        return
      }
      observations.names.push(hostname)
      if (refresh) observations.refresh++
      if (model) observations.http++
      const controller = new AbortController()
      response.once("close", () => controller.abort())
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const upstream = await fetch(new URL(request.url!, issuer), {
        method: "POST",
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" && !["host", "connection", "content-length"].includes(entry[0]),
          ),
        ),
        body: Buffer.concat(chunks),
        signal: controller.signal,
      }).catch(() => undefined)
      if (!upstream) {
        response.destroy()
        return
      }
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      })
      try {
        if (upstream.body) {
          await upstream.body.pipeTo(
            new WritableStream({
              write: (chunk) => {
                response.write(chunk)
              },
            }),
          )
        }
      } catch (error) {
        if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
          observations.cancellations++
          return
        }
        observations.failures.push("upstream_stream_failed")
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      response.end()
    },
  )
  tls.on("connection", track)
  tls.on("tlsClientError", () => {})
  tls.on("upgrade", (request, socket, head) => {
    if (
      request.headers.host?.replace(/:443$/, "") !== "chatgpt.com" ||
      request.url !== "/backend-api/codex/responses"
    ) {
      observations.rejected++
      socket.destroy()
      return
    }
    observations.ws++
    observations.names.push("chatgpt.com")
    const upstream = connect(Number(new URL(issuer).port), "127.0.0.1", () => {
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n`)
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) upstream.write(`${key}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`)
      }
      upstream.write("\r\n")
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    track(upstream)
    socket.once("close", () => upstream.destroy())
    upstream.once("close", () => socket.destroy())
  })
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve))
  const address = tls.address()
  assert(address && typeof address !== "string")
  const proxy = createServer((_request, response) => response.writeHead(405).end())
  proxy.on("connection", track)
  proxy.on("connect", (request, socket, head) => {
    if (!["auth.openai.com:443", "chatgpt.com:443"].includes(request.url ?? "")) {
      observations.rejected++
      const destination = /^[a-zA-Z0-9.-]+:[0-9]+$/.test(request.url ?? "") ? request.url! : "malformed"
      if (!observations.rejectedDestinations.includes(destination)) observations.rejectedDestinations.push(destination)
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
      return
    }
    observations.connect++
    const upstream = connect(address.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    track(upstream)
    socket.once("close", () => upstream.destroy())
    upstream.once("close", () => socket.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const port = proxy.address()
  assert(port && typeof port !== "string")
  return {
    url: `http://127.0.0.1:${port.port}`,
    tlsPort: address.port,
    observations,
    async close() {
      for (const socket of sockets) socket.destroy()
      await Promise.all([tls, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    },
  }
}
