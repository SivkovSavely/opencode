import { createWriteStream } from "node:fs"
import { once } from "node:events"
import { writeFile } from "node:fs/promises"
import { catalog } from "./catalog.generated"
import { argKey, requestSchema, schemaOptions, validate } from "./schema"
import type { Catalog, Operation, Schema } from "./types"

export type ApiArgs = Record<string, unknown> & { _: Array<string | number> }

export const commonOptions = {
  url: { type: "string" as const, describe: "server base URL" },
  directory: { type: "string" as const, describe: "project directory context" },
  workspace: { type: "string" as const, describe: "workspace context" },
  username: { type: "string" as const, describe: "HTTP Basic username", default: process.env.OPENCODE_SERVER_USERNAME ?? "opencode" },
  password: { type: "string" as const, describe: "HTTP Basic password" },
  "password-stdin": { type: "boolean" as const, describe: "read the Basic password from stdin" },
  timeout: { type: "string" as const, describe: "request timeout, such as 5s or 2m" },
  header: { type: "string" as const, array: true, describe: "additional request header (repeatable)" },
  compact: { type: "boolean" as const, describe: "compact JSON output" },
  raw: { type: "boolean" as const, describe: "write response bytes without formatting" },
  output: { type: "string" as const, describe: "write response bytes to a file" },
  body: { type: "string" as const, describe: "JSON request body" },
  "body-file": { type: "string" as const, describe: "read the JSON request body from a file, or - for stdin" },
  "event-format": {
    type: "string" as const,
    choices: ["ndjson", "sse"],
    default: "ndjson",
    describe: "SSE output format",
  },
}

export async function executeOperation(operation: Operation, args: ApiArgs, apiCatalog: Catalog = catalog) {
  let interrupted = false
  try {
    if (args.schema) {
      const content = operation.requestBody?.content
      const mediaType = Object.keys(content ?? {})[0]
      await writeJson(
        mediaType
          ? { operationId: operation.operationId, mediaType, schema: content?.[mediaType]?.schema, components: apiCatalog.components.schemas }
          : {},
        false,
      )
      return
    }
    if (operation.transport === "websocket") {
      await connectPty(operation, args, apiCatalog)
      return
    }
    const request = await prepareRequest(operation, args, apiCatalog)
    const timeout = timeoutMs(args.timeout, operation.transport !== "http" || isLongPoll(operation))
    const controller = new AbortController()
    const timer = timeout === undefined ? undefined : setTimeout(() => controller.abort(), timeout)
    const interrupt = () => {
      interrupted = true
      controller.abort()
    }
    if (operation.transport === "sse") process.once("SIGINT", interrupt)
    try {
      const response = await fetch(request.url, {
        method: operation.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      })
      if (operation.transport === "sse") {
        if (!response.ok) return await reportResponseError(response, args, request.secrets)
        await streamEvents(response, args, controller.signal)
        return
      }
      await handleResponse(response, args, request.secrets)
    } finally {
      if (timer) clearTimeout(timer)
      if (operation.transport === "sse") process.removeListener("SIGINT", interrupt)
    }
  } catch (error) {
    if (isAbort(error)) {
      process.exitCode = interrupted ? 130 : 124
      return
    }
    process.stderr.write(`${safeError(error)}\n`)
    process.exitCode = 1
  }
}

export async function executeRequest(method: string, route: string, args: ApiArgs) {
  try {
    rejectStdinConflict(args)
    if (args.directory !== undefined || args.workspace !== undefined) {
      throw new Error("api request does not infer route-specific directory/workspace routing; add the supported query parameters to PATH or use a named operation")
    }
    const url = apiUrl(args.url)
    if (!route.startsWith("/") || route.startsWith("//")) throw new Error("PATH must be an absolute route beginning with one /")
    const target = new URL(route, url.origin)
    if (target.origin !== url.origin) throw new Error("PATH must remain on the configured server origin")
    const bodyErrors: string[] = []
    const body = await readBody(args, undefined, catalog, undefined, bodyErrors)
    if (bodyErrors.length) throw new Error(bodyErrors.join("\n"))
    const request = await requestHeaders(args)
    const headers = request.headers
    if (body !== undefined) headers.set("content-type", "application/json")
    const timeout = timeoutMs(args.timeout, true)
    const controller = new AbortController()
    const timer = timeout === undefined ? undefined : setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(target, { method, headers, body, signal: controller.signal })
      await handleResponse(response, args, [...request.secrets, ...bodySecrets(body)])
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (error) {
    process.stderr.write(`${safeError(error)}\n`)
    process.exitCode = isAbort(error) ? 124 : 1
  }
}

export async function executeSpec(args: ApiArgs) {
  if (!args.remote) {
    const { spec } = await import("./spec.generated")
    await emitBytes(new TextEncoder().encode(JSON.stringify(spec, null, args.compact || args.raw ? undefined : 2) + "\n"), args.output)
    return
  }
  await executeRequest("GET", "/doc", { ...args, timeout: args.timeout ?? "30s" })
}

export async function prepareRequest(operation: Operation, args: ApiArgs, apiCatalog: Catalog) {
  rejectStdinConflict(args)
  const errors: string[] = []
  const options = schemaOptions(operation, apiCatalog)
  const bodyLocation = operation.method === "POST" && operation.path === "/api/session" && Boolean(requestSchema(operation, apiCatalog)?.properties?.location)
  const query = new URLSearchParams()
  const queryValues: Array<{ name: string; value: unknown; schema: Schema }> = []
  for (const option of options.filter((item) => item.scope === "query")) {
    const value = readArg(args, option.key, option.flag)
    if (value === undefined) {
      if (option.required) errors.push(`--${option.flag} is required`)
      continue
    }
    errors.push(...validate(value, option.schema, apiCatalog, `--${option.flag}`))
    queryValues.push({ name: option.child ? `${option.name}[${option.child}]` : option.name, value, schema: option.schema })
  }
  for (const name of ["directory", "workspace"]) {
    if (args[name] === undefined) continue
    const parameter = operation.parameters.find((item) => item.in === "query" && item.name === `location[${name}]`)
    if (!parameter) continue
    const option = options.find((item) => item.scope === "query" && item.name === parameter.name)
    const explicit = option ? readArg(args, option.key, option.flag) : undefined
    if (explicit !== undefined && String(explicit) !== String(args[name])) {
      errors.push(`--${name} conflicts with --${option?.flag} for ${operation.method} ${operation.path}`)
      continue
    }
    if (explicit === undefined) {
      errors.push(...validate(args[name], parameter.schema, apiCatalog, `--${name}`))
      queryValues.push({ name: parameter.name, value: args[name], schema: parameter.schema ?? {} })
    }
  }
  for (const parameter of operation.parameters.filter((item) => item.in === "query" && item.required)) {
    const matched = queryValues.some((item) => item.name === parameter.name || item.name.startsWith(`${parameter.name}[`))
    if (!matched && !options.some((item) => item.scope === "query" && item.name === parameter.name)) {
      errors.push(`required query parameter '${parameter.name}' is unsupported by generated flags`)
    }
  }
  for (const item of queryValues) appendQuery(query, item.name, item.value)

  if (args.directory !== undefined && !supportsRouting(operation, "directory", options) && !bodyLocation) {
    errors.push(`--directory is not supported by ${operation.method} ${operation.path}; this route may derive its location from its resource ID`)
  }
  if (args.workspace !== undefined && !supportsRouting(operation, "workspace", options) && !bodyLocation) {
    errors.push(`--workspace is not supported by ${operation.method} ${operation.path}; this route may derive its location from its resource ID`)
  }

  const routePath = buildPath(operation, args, apiCatalog, errors)
  const body = await readBody(args, operation, apiCatalog, options, errors, bodyLocation)
  if (errors.length) throw new Error(errors.join("\n"))
  const url = apiUrl(args.url)
  const target = new URL(routePath, url.origin)
  target.search = query.toString()
  const headers = await requestHeaders(args)
  if (body !== undefined) headers.headers.set("content-type", requestContentType(operation))
  return { url: target, headers: headers.headers, body, secrets: [...headers.secrets, ...bodySecrets(body)] }
}

async function readBody(
  args: ApiArgs,
  operation: Operation | undefined,
  apiCatalog: Catalog,
  options = operation ? schemaOptions(operation, apiCatalog) : [],
  errors: string[] = [],
  bodyLocation = false,
) {
  const hasBody = args.body !== undefined
  const hasFile = args.bodyFile !== undefined || args["body-file"] !== undefined
  const file = args.bodyFile ?? args["body-file"]
  const bodyOptions = options.filter((item) => item.scope === "body")
  const fields = bodyOptions.filter((option) => readArg(args, option.key, option.flag) !== undefined)
  if (hasBody && hasFile) errors.push("Use only one of --body and --body-file")
  if ((hasBody || hasFile) && fields.length) errors.push("Use either --body/--body-file or request-field flags, not both")
  if (!operation && fields.length) errors.push("Endpoint-specific body flags are unavailable for api request")

  let value: unknown
  if (hasBody || hasFile) {
    const text = hasBody
      ? String(args.body)
      : file === "-"
        ? await Bun.stdin.text()
        : await Bun.file(String(file)).text()
    if (operation && requestContentType(operation) === "text/plain") {
      value = text
    } else {
      try {
        value = JSON.parse(text)
      } catch {
        errors.push("Request body must contain valid JSON")
        return undefined
      }
    }
  } else if (fields.length) {
    value = Object.fromEntries(fields.map((option) => [option.name, readArg(args, option.key, option.flag)]))
  }

  if (bodyLocation && (args.directory !== undefined || args.workspace !== undefined)) {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : value === undefined ? {} : undefined
    if (!object) {
      errors.push("--directory and --workspace require an object request body for this operation")
    } else {
      const current = object.location
      const location = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : current === undefined ? {} : undefined
      if (!location) {
        errors.push("body.location must be an object when using --directory or --workspace")
      } else if (args.workspace !== undefined && args.directory === undefined && location.directory === undefined) {
        errors.push("--workspace on v2 session create requires --directory or body.location.directory")
      } else {
        value = {
          ...object,
          location: {
            ...location,
            ...(args.directory === undefined ? {} : { directory: args.directory }),
            ...(args.workspace === undefined ? {} : { workspaceID: args.workspace }),
          },
        }
      }
    }
  }

  const bodySchema = operation ? requestSchema(operation, apiCatalog) : undefined
  if (operation?.requestBody?.required && value === undefined) errors.push("Request body is required; provide --body, --body-file, or request-field flags")
  if (value !== undefined) errors.push(...validate(value, bodySchema, apiCatalog, "body"))
  if (value === undefined) return undefined
  return JSON.stringify(value)
}

function buildPath(operation: Operation, args: ApiArgs, apiCatalog: Catalog, errors: string[]) {
  let path = operation.path
  for (const parameter of operation.parameters.filter((item) => item.in === "path")) {
    const value = args[parameter.name] ?? args[argKey(parameter.name)]
    if (value === undefined) {
      errors.push(`Missing required path argument <${parameter.name}>`)
      continue
    }
    errors.push(...validate(String(value), parameter.schema, apiCatalog, `<${parameter.name}>`))
    const encoded = operation.path.endsWith("/*") && parameter.name === "path"
      ? String(value).split("/").map(encodeURIComponent).join("/")
      : encodeURIComponent(String(value))
    path = path.replace(`{${parameter.name}}`, encoded)
  }
  if (operation.path.endsWith("/*")) {
    const parameter = operation.parameters.find((item) => item.in === "path")
    const value = parameter ? args[parameter.name] ?? args[argKey(parameter.name)] : undefined
    if (value !== undefined) path = path.replace(/\/\*$/, `/${String(value).split("/").map(encodeURIComponent).join("/")}`)
  }
  return path
}

function supportsRouting(operation: Operation, name: string, options: ReturnType<typeof schemaOptions>) {
  return options.some((option) => option.scope === "query" && (option.key === name || option.child === name)) ||
    operation.parameters.some((parameter) => parameter.in === "query" && (parameter.name === name || parameter.name === `location[${name}]`))
}

function appendQuery(query: URLSearchParams, name: string, value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) query.append(name, stringifyQuery(item))
    return
  }
  query.append(name, stringifyQuery(value))
}

function stringifyQuery(value: unknown) {
  if (value === null) return "null"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function requestContentType(operation: Operation) {
  return Object.keys(operation.requestBody?.content ?? {})[0] ?? "application/json"
}

async function requestHeaders(args: ApiArgs) {
  const headers = new Headers()
  const secrets: string[] = []
  const items = Array.isArray(args.header) ? args.header : args.header === undefined ? [] : [args.header]
  for (const item of items) {
    const value = String(item)
    const separator = value.indexOf(":")
    if (separator < 1) throw new Error("--header must use NAME:VALUE format")
    headers.append(value.slice(0, separator).trim(), value.slice(separator + 1).trim())
  }
  const password = args.passwordStdin || args["password-stdin"]
    ? (await Bun.stdin.text()).replace(/\r?\n$/, "")
    : typeof args.password === "string" ? args.password : process.env.OPENCODE_SERVER_PASSWORD
  if (password !== undefined) {
    const username = args.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
    headers.set("authorization", authorization)
    secrets.push(password, authorization)
  }
  return { headers, secrets }
}

async function handleResponse(response: Response, args: ApiArgs, secrets: string[] = []) {
  if (!response.ok) return reportResponseError(response, args, secrets)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (args.output) return emitBytes(bytes, String(args.output))
  if (!bytes.length || args.raw) {
    await writeStdout(bytes)
    return
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  const text = new TextDecoder().decode(bytes)
  if (contentType.includes("json") || contentType.includes("+json")) {
    try {
      const value: unknown = JSON.parse(text)
      await writeJson(value, Boolean(args.compact))
      return
    } catch {
      await writeStdout(bytes)
      return
    }
  }
  await writeStdout(bytes)
}

async function reportResponseError(response: Response, args?: ApiArgs, secrets: string[] = []) {
  const text = await response.text()
  const status = `${response.status} ${response.statusText}`.trim()
  const body = text ? await redactResponse(text, response.headers.get("content-type"), args, secrets) : ""
  process.stderr.write(`HTTP ${status}${body ? `\n${body}` : ""}\n`)
  process.exitCode = 1
}

async function emitBytes(bytes: Uint8Array, destination: unknown) {
  if (typeof destination === "string") {
    await writeFile(destination, bytes)
    return
  }
  await writeStdout(bytes)
}

async function writeJson(value: unknown, compact: boolean) {
  await writeStdout(JSON.stringify(value, null, compact ? undefined : 2) + "\n")
}

async function writeStdout(value: string | Uint8Array) {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(value, (error) => (error ? reject(error) : resolve()))
  })
}

async function streamEvents(response: Response, args: ApiArgs, signal: AbortSignal) {
  if (!response.body) return
  const raw = args.eventFormat === "sse" || args["event-format"] === "sse" || args.raw
  const output = args.output ? createWriteStream(String(args.output)) : process.stdout
  const write = (value: string | Uint8Array) => new Promise<void>((resolve, reject) => {
    let complete = false
    const finish = (error?: Error | null) => {
      if (complete) return
      complete = true
      signal.removeEventListener("abort", abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"))
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    output.write(value, (error) => finish(error))
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let event: { data: string[]; id?: string; type?: string; retry?: number } = { data: [] }
  let lastId: string | undefined
  const dispatch = async () => {
    if (!event.data.length && !event.type && !event.id) return
    if (raw) return
    const data = event.data.join("\n")
    let parsed: unknown = data
    try {
      parsed = JSON.parse(data)
    } catch {}
    if (event.id !== undefined) lastId = event.id
    await write(JSON.stringify({ ...(event.type ? { event: event.type } : {}), ...(lastId ? { id: lastId } : {}), ...(event.retry !== undefined ? { retry: event.retry } : {}), data: parsed }) + "\n")
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (raw) {
        await write(chunk.value)
        continue
      }
      pending += decoder.decode(chunk.value, { stream: true })
      pending = pending.replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n")
      let boundary = pending.indexOf("\n\n")
      while (boundary >= 0) {
        const block = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue
          const separator = line.indexOf(":")
          const field = separator < 0 ? line : line.slice(0, separator)
          const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "")
          if (field === "data") event.data.push(value)
          if (field === "event") event.type = value
          if (field === "id" && !value.includes("\0")) event.id = value
          if (field === "retry" && /^\d+$/.test(value)) event.retry = Number(value)
        }
        await dispatch()
        event = { data: [] }
        boundary = pending.indexOf("\n\n")
      }
    }
    pending += decoder.decode().replace(/\r/g, "\n")
    if (pending) {
      for (const line of pending.split(/\r?\n/)) {
        if (line.startsWith("data:")) event.data.push(line.slice(5).replace(/^ /, ""))
        if (line.startsWith("event:")) event.type = line.slice(6).replace(/^ /, "")
        if (line.startsWith("id:")) event.id = line.slice(3).replace(/^ /, "")
        if (line.startsWith("retry:") && /^\d+$/.test(line.slice(6).trim())) event.retry = Number(line.slice(6).trim())
      }
    }
    await dispatch()
  } finally {
    if (args.output) {
      output.end()
      await once(output, "finish")
    }
  }
}

async function connectPty(operation: Operation, args: ApiArgs, apiCatalog: Catalog) {
  if (args.passwordStdin || args["password-stdin"]) throw new Error("--password-stdin cannot be used for pty connect because stdin carries terminal input")
  const built = await prepareRequest(operation, args, apiCatalog)
  const tokenPath = operation.path.replace(/\/connect$/, "/connect-token")
  const tokenOperation = apiCatalog.operations.find((item) => item.method === "POST" && item.path === tokenPath)
  if (!tokenOperation) throw new Error(`Missing PTY ticket endpoint for ${operation.path}`)
  const tokenRequest = await prepareRequest(tokenOperation, {
    ...args,
    directory: args.locationDirectory ?? args["location-directory"] ?? args.directory,
    workspace: args.locationWorkspace ?? args["location-workspace"] ?? args.workspace,
  }, apiCatalog)
  const headers = new Headers(tokenRequest.headers)
  headers.set("x-opencode-ticket", "1")
  const response = await fetch(tokenRequest.url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs(args.timeout, false) ?? 30_000),
  })
  if (!response.ok) return reportResponseError(response, args, tokenRequest.secrets)
  const tokenBody: unknown = await response.json()
  const ticket = findTicket(tokenBody)
  if (!ticket) throw new Error("The server did not return a PTY connect ticket")
  const socketUrl = new URL(built.url)
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:"
  socketUrl.searchParams.set("ticket", ticket)
  const { default: WebSocket } = await import("ws")
  const socket = new WebSocket(socketUrl, { headers: Object.fromEntries([...built.headers.entries()].filter(([name]) => name.toLowerCase() !== "authorization")) })
  let socketError: Error | undefined
  let closeError: Error | undefined
  let interrupted = false
  let timedOut = false
  socket.on("error", (error) => {
    socketError = error
    if (socket.readyState === WebSocket.OPEN) socket.close()
  })
  const wasRaw = Boolean(process.stdin.isTTY && process.stdin.isRaw)
  const tty = Boolean(process.stdin.isTTY)
  if (tty && process.stdin.setRawMode) process.stdin.setRawMode(true)
  process.stdin.resume()
  const pending: Buffer[] = []
  let inputEnded = false
  const sendInput = (data: Buffer) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data)
    else if (socket.readyState === WebSocket.CONNECTING) pending.push(data)
  }
  const stop = () => {
    if (socket.readyState === WebSocket.CONNECTING) {
      inputEnded = true
      return
    }
    socket.close()
  }
  const interrupt = () => {
    interrupted = true
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate()
      return
    }
    socket.close()
    const timer = setTimeout(() => socket.terminate(), 500)
    timer.unref()
  }
  const timeout = args.timeout === undefined ? undefined : timeoutMs(args.timeout, false)
  const timer = timeout === undefined ? undefined : setTimeout(() => {
    timedOut = true
    socket.terminate()
  }, timeout)
  process.stdin.on("data", sendInput)
  process.stdin.once("end", stop)
  process.once("SIGINT", interrupt)
  try {
    await new Promise<void>((resolve, reject) => {
      const closeBeforeOpen = (code: number, reason: Buffer) => {
        reject(new Error(`PTY WebSocket closed before connecting (${code}): ${reason.toString()}`))
      }
      socket.on("close", closeBeforeOpen)
      socket.once("open", () => {
        if (timer) clearTimeout(timer)
        socket.removeListener("close", closeBeforeOpen)
        resolve()
      })
    })
    const closed = new Promise<void>((resolve) => socket.once("close", (code, reason) => {
      if (code !== 1000 && code !== 1001) closeError = new Error(`PTY WebSocket closed (${code}): ${reason.toString()}`)
      resolve()
    }))
    const output = args.output ? createWriteStream(String(args.output)) : undefined
    let outputError: Error | undefined
    const outputFinished = output
      ? once(output, "finish").then(() => {}).catch((error) => {
          outputError = error instanceof Error ? error : new Error("PTY output could not be written")
        })
      : undefined
    output?.on("error", (error) => {
      outputError = error
      if (socket.readyState === WebSocket.OPEN) socket.close()
    })
    socket.on("message", (data, binary) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (bytes[0] === 0) return
      const value = binary ? bytes : bytes.toString("utf8")
      if (!output) {
        process.stdout.write(value)
        return
      }
      if (!output.write(value)) {
        socket.pause()
        output.once("drain", () => socket.resume())
      }
    })
    for (const data of pending) socket.send(data)
    if (inputEnded) socket.close()
    await closed
    if (output) {
      output.end()
      await outputFinished
    }
    if (outputError) throw outputError
    if (interrupted) {
      process.exitCode = 130
      return
    }
    if (timedOut) {
      process.exitCode = 124
      return
    }
    if (socketError) throw socketError
    if (closeError) throw closeError
  } catch (error) {
    if (interrupted) {
      process.exitCode = 130
      return
    }
    if (timedOut) {
      process.exitCode = 124
      return
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    process.stdin.removeListener("data", sendInput)
    process.stdin.removeListener("end", stop)
    process.removeListener("SIGINT", interrupt)
    if (tty && process.stdin.setRawMode) process.stdin.setRawMode(wasRaw)
  }
}

function findTicket(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  if ("ticket" in value && typeof value.ticket === "string") return value.ticket
  for (const child of Object.values(value)) {
    const found = findTicket(child)
    if (found) return found
  }
  return undefined
}

function apiUrl(input: unknown) {
  const value = String(input ?? process.env.OPENCODE_API_URL ?? "http://127.0.0.1:4096")
  const url = new URL(value)
  if (!(["http:", "https:"].includes(url.protocol))) throw new Error("--url must use http:// or https://")
  if (url.username || url.password) throw new Error("Do not embed credentials in --url; use --username and --password instead")
  return url
}

function readArg(args: ApiArgs, key: string, flag: string) {
  if (Object.hasOwn(args, key)) return args[key]
  if (Object.hasOwn(args, flag)) return args[flag]
  return undefined
}

function timeoutMs(value: unknown, unbounded: boolean) {
  if (value === undefined) return unbounded ? undefined : 30_000
  const input = String(value)
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(input)
  if (!match) throw new Error("--timeout must be a duration such as 500ms, 30s, or 2m")
  const milliseconds = Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2] ?? "ms"] ?? 1)
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("--timeout must be greater than zero")
  return milliseconds
}

function isLongPoll(operation: Operation) {
  return operation.path === "/tui/control/next" || operation.path.endsWith("/wait")
}

function isAbort(error: unknown) {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
}

function safeError(error: unknown) {
  if (!(error instanceof Error)) return "API request failed"
  const message = error.message.replace(/https?:\/\/[^\s]+/g, "server URL")
  if (["AbortError", "TimeoutError"].includes(error.name)) return "API request timed out"
  return message || "API request failed"
}

function rejectStdinConflict(args: ApiArgs) {
  const bodyFile = args.bodyFile ?? args["body-file"]
  if (bodyFile === "-" && (args.passwordStdin || args["password-stdin"])) {
    throw new Error("--body-file - and --password-stdin both read stdin; provide the password another way")
  }
}

async function redactResponse(text: string, contentType: string | null, args?: ApiArgs, requestSecrets: string[] = []) {
  const secrets = [typeof args?.password === "string" ? args.password : process.env.OPENCODE_SERVER_PASSWORD].filter(
    (secret): secret is string => typeof secret === "string" && secret.length > 0,
  )
  const username = args?.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  if (secrets[0]) secrets.push(`Basic ${Buffer.from(`${username}:${secrets[0]}`).toString("base64")}`)
  for (const header of (Array.isArray(args?.header) ? args.header : args?.header === undefined ? [] : [args.header]).map(String)) {
    const split = header.indexOf(":")
    if (split > 0) secrets.push(header.slice(split + 1).trim())
  }
  for (const [name, input] of Object.entries(args ?? {})) {
    if (isSecretField(name) && typeof input === "string") secrets.push(input)
  }
  if (typeof args?.path === "string") {
    const path = new URL(args.path, "http://localhost")
    for (const [name, secret] of path.searchParams) {
      if (isSecretField(name)) secrets.push(secret)
    }
  }
  const bodyFile = args?.bodyFile ?? args?.["body-file"]
  const body = typeof args?.body === "string"
    ? parseJson(args.body)
    : typeof bodyFile === "string" && bodyFile !== "-"
      ? await Bun.file(bodyFile).json().catch(() => undefined)
      : undefined
  collectSecrets(body, secrets)
  secrets.push(...requestSecrets)
  const variants = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]))].sort((left, right) => right.length - left.length)
  const parsed = contentType?.includes("json") ? parseJson(text) : undefined
  if (parsed !== undefined) return JSON.stringify(redactValue(parsed, variants), null, 2)
  return redactText(text, variants)
}

function redactValue(input: unknown, secrets: string[], key = ""): unknown {
  if (key && isSecretField(key)) return "[REDACTED]"
  if (typeof input === "string") return redactText(input, secrets)
  if (Array.isArray(input)) return input.map((item) => redactValue(item, secrets, key))
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, redactValue(value, secrets, name)]))
  }
  return input
}

function redactText(input: string, secrets: string[]) {
  return secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), input)
}

function parseJson(input: string) {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return undefined
  }
}

function collectSecrets(input: unknown, secrets: string[], key = "") {
  if (key && isSecretField(key)) {
    if (typeof input === "string" || typeof input === "number") secrets.push(String(input))
    return
  }
  if (Array.isArray(input)) {
    for (const value of input) collectSecrets(value, secrets, key)
    return
  }
  if (input && typeof input === "object") {
    for (const [name, value] of Object.entries(input)) collectSecrets(value, secrets, name)
  }
}

function bodySecrets(body: string | undefined) {
  if (!body) return []
  const secrets: string[] = []
  collectSecrets(parseJson(body), secrets)
  return secrets
}

function isSecretField(name: string) {
  return /authorization|password|secret|token|ticket|credential|api.?key|(?:^|[_-])key$|(?:^|[_-])access$|(?:^|[_-])refresh$|^auth$/i.test(name)
}
