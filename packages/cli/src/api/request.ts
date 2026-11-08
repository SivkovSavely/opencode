import { Option, Redacted, Schema } from "effect"
import { HttpMethod } from "effect/http"
import { WORKSPACE_DISPATCH_PATH } from "@opencode/protocol/groups/workspace"
import type { ApiInput } from "./commands"
import type { Catalog, Operation } from "./types"
import { coerce, inputOptions, resolved, validate, variants } from "./schema"

export type PreparedRequest = {
  method: string
  path: string
  body?: string | Uint8Array
  headers: Headers
  transport: Operation["transport"]
}

export function safeServer(value: string) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Expected an HTTP(S) server URL without credentials, query or fragment")
  return url
}

export function requestHeaders(values: readonly string[]) {
  const headers = new Headers()
  values.forEach((value) => {
    const index = value.indexOf(":")
    const name = value.slice(0, index).trim()
    if (index < 1 || /[\r\n]/.test(value) || !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name))
      throw new Error("Invalid custom header; expected name:value")
    if (["authorization", "host", "content-length", "connection", "transfer-encoding"].includes(name.toLowerCase()))
      throw new Error(`Header ${name} is managed by the transport`)
    headers.append(name, value.slice(index + 1).trim())
  })
  return headers
}

export function safePath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\r\n#]/.test(value))
    throw new Error("Expected a server-relative /path without authority, backslash or fragment")
  if (
    value
      .split("?")[0]
      .split("/")
      .some((part) => /^(?:\.|%2e){1,2}$/i.test(part))
  )
    throw new Error("Dot path segments are not supported")
  return value
}

export function interpolate(path: string, params: Record<string, string>) {
  const used = new Set<string>()
  const pathname = path.replace(/\{([^}]+)\}|\*/g, (_match, name: string | undefined) => {
    const key = name ?? "path"
    if (params[key] === undefined) throw new Error(`Missing path parameter: ${key}`)
    used.add(key)
    if (name) {
      if ([".", ".."].includes(params[key])) throw new Error(`Invalid dot path parameter: ${key}`)
      return encodeURIComponent(params[key])
    }
    return params[key]
      .split("/")
      .map((part) => {
        if ([".", ".."].includes(part)) throw new Error("Wildcard path cannot contain dot segments")
        return encodeURIComponent(part)
      })
      .join("/")
  })
  const query = new URLSearchParams(Object.entries(params).filter(([name]) => !used.has(name))).toString()
  return safePath(query ? `${pathname}?${query}` : pathname)
}

export async function prepare(input: ApiInput, catalog: Catalog, operation?: Operation): Promise<PreparedRequest> {
  if (!Number.isSafeInteger(input.timeout) || input.timeout <= 0 || input.timeout > 2147483647)
    throw new Error("--timeout must be between 1 and 2147483647 milliseconds")
  if (input.passwordStdin && Option.isSome(input.password))
    throw new Error("--password and --password-stdin cannot be combined")
  if (input.passwordStdin && Option.getOrUndefined(input.bodyFile) === "-")
    throw new Error("Password and body cannot both read stdin")
  const headers = requestHeaders(input.header)
  const bodyFile = Option.getOrUndefined(input.bodyFile)
  const text = Option.getOrUndefined(input.body)
  if (text !== undefined && bodyFile !== undefined) throw new Error("Use only one of --body and --body-file")
  const bytes =
    bodyFile === "-"
      ? new Uint8Array(await Bun.stdin.arrayBuffer())
      : bodyFile
        ? new Uint8Array(
            await Bun.file(bodyFile)
              .arrayBuffer()
              .catch(() => {
                throw new Error(`Cannot read --body-file: ${bodyFile}`)
              }),
          )
        : undefined
  if (!operation) {
    const raw = input.request.args
    if (raw.length !== 2 || ![...HttpMethod.all].some((method) => method === raw[0].toUpperCase()))
      throw new Error("Expected METHOD /path or a known operation ID")
    const url = new URL(safePath(raw[1]), "http://api.invalid")
    Object.entries(Option.getOrElse(input.param, () => ({}))).forEach(([key, value]) =>
      url.searchParams.append(key, value),
    )
    const directory = input.values.directory?.[0]
    if (directory !== undefined) url.searchParams.set("location[directory]", String(directory))
    if (["GET", "HEAD"].includes(raw[0].toUpperCase()) && (text !== undefined || bytes !== undefined))
      throw new Error("GET/HEAD requests cannot have a body")
    if ((text !== undefined || bytes) && !headers.has("content-type")) headers.set("content-type", "application/json")
    return workspaceRequest(input, {
      method: raw[0].toUpperCase(),
      path: url.pathname + url.search,
      headers,
      body: bytes ?? text,
      transport: "http",
    })
  }
  if (operation.unsupported) throw new Error(`${operation.operationId}: ${operation.unsupported}`)
  const pathParams = operation.parameters.filter((param) => param.in === "path")
  const params: Record<string, string> = { ...Option.getOrElse(input.param, () => ({})) }
  if (input.request.args.length > pathParams.length) throw new Error("Too many path parameters")
  pathParams.forEach((param, index) => {
    const value = input.request.args[index] ?? params[param.name]
    if (value === undefined) throw new Error(`Missing path parameter: ${param.name}`)
    const errors = validate(coerce(value, param.schema ?? {}, catalog), param.schema, catalog, param.name)
    if (errors.length) throw new Error(errors.join("\n"))
    params[param.name] = value
  })
  const query = new URLSearchParams()
  const media = Object.keys(operation.requestBody?.content ?? {})[0]
  const bodySchema = operation.requestBody?.content[media]?.schema
  const rawBody = bytes ? new TextDecoder().decode(bytes) : text
  const body: Record<string, unknown> = {}
  const typed = inputOptions(operation, catalog)
  typed.forEach((option) => {
    const supplied = input.values[option.flag]
    const fallback = params[option.name]
    if (!supplied?.length && fallback === undefined) {
      if (option.required && option.scope !== "body") throw new Error(`--${option.flag} is required`)
      return
    }
    const value = coerce(supplied?.length ? supplied.map(String) : String(fallback), option.schema, catalog)
    const errors = validate(value, option.schema, catalog, `--${option.flag}`)
    if (errors.length) throw new Error(errors.join("\n"))
    if (option.scope === "body") {
      body[option.name] = value
      return
    }
    if (option.scope === "header") {
      headers.set(option.name, String(value))
      return
    }
    const name = option.child ? `${option.name}[${option.child}]` : option.name
    ;(Array.isArray(value) ? value : [value]).forEach((item) => query.append(name, String(item)))
  })
  Object.keys(params).forEach((name) => {
    if (!operation.parameters.some((param) => param.name === name))
      throw new Error(`Unknown operation parameter: ${name}`)
  })
  if (rawBody !== undefined && Object.keys(body).length)
    throw new Error("Do not combine body flags with --body or --body-file")
  const decoded =
    rawBody !== undefined && media === "application/json"
      ? Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(rawBody)
      : undefined
  if (decoded && Option.isNone(decoded)) throw new Error("Invalid JSON in --body or --body-file")
  const parsed: unknown = decoded
    ? Option.getOrUndefined(decoded)
    : Object.keys(body).length ||
        (media === "application/json" && (operation.requestBody?.required || input.values.directory?.length))
      ? body
      : undefined
  const directory = input.values.directory?.[0]
  if (directory !== undefined && !typed.some((option) => option.flag === "directory")) {
    const location = bodySchema && resolved(bodySchema, catalog).properties?.location
    const locationShape = location && variants(location, catalog).find((branch) => branch.type === "object")
    if (!locationShape)
      throw new Error("This native operation does not expose the requested directory/workspace routing")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Context requires a JSON object body")
    const record = parsed as Record<string, unknown>
    if (record.location !== undefined)
      throw new Error("Do not combine location in the body with directory/workspace flags")
    record.location = {
      ...(directory !== undefined ? { directory: String(directory) } : {}),
    }
  }
  if (media === "application/json" && parsed !== undefined) {
    const errors = validate(parsed, bodySchema, catalog)
    if (errors.length) throw new Error(errors.join("\n"))
  }
  if (operation.requestBody?.required && parsed === undefined && rawBody === undefined)
    throw new Error("Request body is required; use --body or --body-file")
  if (!media && (rawBody !== undefined || Object.keys(body).length))
    throw new Error("This operation has no request body")
  if (media) headers.set("content-type", media)
  const path = interpolate(
    operation.path,
    Object.fromEntries(pathParams.map((param) => [param.name, params[param.name]])),
  )
  return workspaceRequest(input, {
    method: operation.method,
    path: query.size ? `${path}?${query}` : path,
    headers,
    body: media === "application/json" ? (parsed === undefined ? undefined : JSON.stringify(parsed)) : (bytes ?? text),
    transport: operation.transport,
  })
}

function workspaceRequest(input: ApiInput, request: PreparedRequest): PreparedRequest {
  const workspace = Option.getOrUndefined(input.workspace)
  if (workspace === undefined) return request
  if (!workspace || /[\r\n]/.test(workspace)) throw new Error("Expected a workspace ID")
  return {
    method: "POST",
    path: WORKSPACE_DISPATCH_PATH.replace(":workspaceID", encodeURIComponent(workspace)),
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      method: request.method,
      path: request.path,
      headers: Object.fromEntries(request.headers),
      ...(request.body === undefined ? {} : { body: Buffer.from(request.body).toString("base64") }),
    }),
    transport: request.transport,
  }
}

export function passwordValue(input: ApiInput) {
  return Option.map(input.password, Redacted.value)
}
