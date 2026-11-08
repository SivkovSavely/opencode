import { open } from "node:fs/promises"
import type { Endpoint } from "@opencode/client/effect/service"
import { Service } from "@opencode/client/effect/service"
import type { PreparedRequest } from "./request"
import { safePath, safeServer } from "./request"
import type { ApiDocument } from "./types"

export type OutputOptions = { compact?: boolean; raw?: boolean; output?: string; timeout: number; signal?: AbortSignal }

export async function readSpec(endpoint: Endpoint, timeout: number, signal?: AbortSignal) {
  const response = await fetch(new URL("/openapi.json", safeServer(endpoint.url)), {
    headers: Service.headers(endpoint),
    redirect: "manual",
    signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Cannot read remote OpenAPI: HTTP ${response.status}`)
  }
  return (await response.json()) as ApiDocument
}

export async function execute(endpoint: Endpoint, request: PreparedRequest, options: OutputOptions) {
  const base = safeServer(endpoint.url)
  const url = new URL(safePath(request.path), base)
  if (url.origin !== base.origin) throw new Error("Request cannot change server origin")
  const headers = new Headers(Service.headers(endpoint))
  request.headers.forEach((value, name) => headers.set(name, value))
  const controller = new AbortController()
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(options.timeout),
    ...(options.signal ? [options.signal] : []),
  ])
  const abort = () => controller.abort(new Error("Request interrupted"))
  const file = options.output ? await open(options.output, "w") : undefined
  process.once("SIGINT", abort)
  process.once("SIGTERM", abort)
  const write = async (chunk: string | Uint8Array) => {
    if (file) {
      await file.writeFile(chunk)
      return
    }
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(chunk, (error) => (error ? reject(error) : resolve())),
    )
  }
  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body instanceof Uint8Array ? new Uint8Array(request.body) : request.body,
      redirect: "manual",
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${response.status === 401 ? "; server password required or rejected (Basic username opencode)" : ""}`,
      )
    }
    if (!response.body) return
    if (options.raw || request.transport === "sse" || !response.headers.get("content-type")?.includes("json")) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ""
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (request.transport !== "sse" || options.raw) {
            await write(chunk.value)
            continue
          }
          pending = (pending + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n")
          const frames = pending.split("\n\n")
          pending = frames.pop() ?? ""
          if ([pending, ...frames].some((frame) => Buffer.byteLength(frame) > 1024 * 1024))
            throw new Error("SSE event exceeds 1 MiB; use --raw for byte streaming")
          for (const frame of frames) {
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            if (!data) continue
            const event = frame
              .split("\n")
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim()
            await write(JSON.stringify({ ...(event ? { event } : {}), data }) + "\n")
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      return
    }
    await write(JSON.stringify(await response.json(), null, options.compact ? undefined : 2) + "\n")
  } finally {
    controller.abort()
    process.off("SIGINT", abort)
    process.off("SIGTERM", abort)
    await file?.close()
  }
}
