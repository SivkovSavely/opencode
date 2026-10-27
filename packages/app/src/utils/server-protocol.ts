import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

export type ServerProtocol = "v1" | "v2"
export type ServerProtocolSource = Promise<ServerProtocol> | (() => Promise<ServerProtocol>)

type DetectionOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

type ServerProtocolOptions = DetectionOptions & {
  retryDelayMs?: (attempt: number) => number
  onChange?: (protocol: ServerProtocol, previous?: ServerProtocol) => void
}

function headers(server: ServerConnection.HttpBase) {
  if (!server.password) return undefined
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

async function probe(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  path: string,
  options?: DetectionOptions,
) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Health probe timed out", "TimeoutError")),
    options?.timeoutMs ?? 5_000,
  )
  const abort = () => controller.abort(options?.signal?.reason)
  if (options?.signal?.aborted) abort()
  else options?.signal?.addEventListener("abort", abort, { once: true })

  try {
    const response = await fetch(new URL(path, server.url), {
      headers: headers(server),
      signal: controller.signal,
    })
    const json = response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false
    if (!response.ok || !json) return { status: response.status, json }
    return { status: response.status, json, value: await response.json().catch(() => undefined) }
  } finally {
    clearTimeout(timeout)
    options?.signal?.removeEventListener("abort", abort)
  }
}

export async function detectServerProtocol(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  options?: DetectionOptions,
): Promise<ServerProtocol | undefined> {
  const legacy = await probe(server, fetch, "/global/health", options).catch(() => undefined)
  if (options?.signal?.aborted) return undefined

  const current = await probe(server, fetch, "/api/health", options).catch(() => undefined)
  if (options?.signal?.aborted) return undefined
  const health = [legacy, current].find(
    (response) =>
      response?.status === 200 && response.json && isRecord(response.value) && response.value.healthy === true,
  )
  if (!health) return undefined

  const [location, projects, defaultModel] = await Promise.all([
    probe(server, fetch, "/api/location", options).catch(() => undefined),
    probe(server, fetch, "/api/project", options).catch(() => undefined),
    probe(server, fetch, "/api/model/default", options).catch(() => undefined),
  ])
  if (options?.signal?.aborted) return undefined
  const locationValid = location?.status === 200 && location.json && isLocation(location.value)
  const projectsValid = projects?.status === 200 && projects.json && isProjectList(projects.value)
  const defaultModelValid = defaultModel?.status === 200 && defaultModel.json && isDefaultModel(defaultModel.value)
  if (locationValid && projectsValid && defaultModelValid) return "v2"

  if (
    (location?.status !== 404 && !locationValid) ||
    (projects?.status !== 404 && !projectsValid) ||
    (defaultModel?.status !== 404 && !defaultModelValid)
  )
    return undefined
  const legacyProjects = await probe(server, fetch, "/project", options).catch(() => undefined)
  if (options?.signal?.aborted) return undefined
  if (legacyProjects?.status === 200 && legacyProjects.json && isProjectList(legacyProjects.value)) return "v1"
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isLocation(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.directory === "string" &&
    isRecord(value.project) &&
    typeof value.project.id === "string" &&
    typeof value.project.directory === "string"
  )
}

function isProjectList(value: unknown) {
  return (
    Array.isArray(value) &&
    value.every(
      (project) =>
        isRecord(project) &&
        typeof project.id === "string" &&
        typeof project.worktree === "string" &&
        isRecord(project.time) &&
        typeof project.time.created === "number" &&
        Number.isInteger(project.time.created) &&
        project.time.created >= 0 &&
        typeof project.time.updated === "number" &&
        Number.isInteger(project.time.updated) &&
        project.time.updated >= 0 &&
        Array.isArray(project.sandboxes) &&
        project.sandboxes.every((sandbox) => typeof sandbox === "string"),
    )
  )
}

function isDefaultModel(value: unknown) {
  return (
    isRecord(value) &&
    (value.data === null ||
      (isRecord(value.data) && typeof value.data.id === "string" && typeof value.data.providerID === "string"))
  )
}

export function resolveServerProtocol(source?: ServerProtocolSource) {
  return typeof source === "function" ? source() : source
}

export function createServerProtocol(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  options?: ServerProtocolOptions,
) {
  const controller = new AbortController()
  let current: ServerProtocol | undefined
  let pending: Promise<ServerProtocol> | undefined

  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason ?? new DOMException("Protocol detection stopped", "AbortError"))
        return
      }
      const timer = setTimeout(() => {
        controller.signal.removeEventListener("abort", abort)
        resolve()
      }, ms)
      const abort = () => {
        clearTimeout(timer)
        reject(controller.signal.reason ?? new DOMException("Protocol detection stopped", "AbortError"))
      }
      controller.signal.addEventListener("abort", abort, { once: true })
    })

  const detect = async () => {
    let attempt = 0
    while (!controller.signal.aborted) {
      const protocol = await detectServerProtocol(server, fetch, {
        signal: controller.signal,
        timeoutMs: options?.timeoutMs,
      }).catch(() => undefined)
      if (controller.signal.aborted) break
      if (protocol) {
        const previous = current
        current = protocol
        if (previous !== protocol) options?.onChange?.(protocol, previous)
        return protocol
      }
      await wait(options?.retryDelayMs?.(attempt) ?? Math.min(10_000, 250 * 2 ** attempt))
      attempt++
    }
    throw controller.signal.reason ?? new DOMException("Protocol detection stopped", "AbortError")
  }

  const refresh = () => {
    if (pending) return pending
    const run = detect().finally(() => {
      if (pending === run) pending = undefined
    })
    pending = run
    return run
  }

  const protocol = refresh()
  void protocol.catch(() => {})
  return {
    protocol,
    current: () => current,
    get: () => pending ?? (current ? Promise.resolve(current) : protocol),
    refresh,
    dispose: () => controller.abort(new DOMException("Protocol detection stopped", "AbortError")),
  }
}
