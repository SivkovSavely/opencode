import { catalog } from "./catalog.generated"
import { argKey, completionChoices, schemaOptions, valueSchema } from "./schema"
import { normalizeApiArgs } from "./args"
import type { Operation } from "./types"

type Resource = { path: string; fields: string[]; limit: boolean; routing: "direct" | "deep" | "none" }

let pendingCompletion: Promise<void> = Promise.resolve()

export function waitForApiCompletion() {
  return pendingCompletion
}

export function apiCompletion(current: string, argv: Record<string, unknown>, fallback: (done?: (error: Error | null, choices?: string[]) => void) => void, done: (values: string[]) => void) {
  apiCompletionFor(catalog, current, argv, fallback, done)
}

export function apiCompletionFor(
  apiCatalog: typeof catalog,
  current: string,
  argv: Record<string, unknown>,
  fallback: (done?: (error: Error | null, choices?: string[]) => void) => void,
  done: (values: string[]) => void,
) {
  const words = completionWords(argv)
  if (words[0] !== "api") return fallback((error, defaults) => done(error ? [] : defaults ?? []))
  const partial = process.env.COMP_LINE?.endsWith(" ") ? "" : current
  const result = completeApi(partial, words, argv, apiCatalog)
  if (Array.isArray(result)) done(result)
  else pendingCompletion = result.then(done)
}

export function completionSuggestions(apiCatalog: typeof catalog, current: string, words: string[], argv: Record<string, unknown>, raw: string[] = []) {
  return completeApi(current, words, argv, apiCatalog, raw)
}

export async function dynamicResources(current: string, argv: Record<string, unknown>, apiCatalog: typeof catalog = catalog) {
  const words = Array.isArray(argv._) ? argv._.map(String) : []
  const operation = operationFromArgs(argv, apiCatalog)
  if (!operation) return []
  const positional = operation.parameters.filter((parameter) => parameter.in === "path")
  const consumed = words.slice(operation.command.length + 1)
  const position = consumed.length - 1
  const parameter = positional[position]
  if (!parameter) return []
  const resource = resourceFor(parameter.name, operation)
  if (!resource) return []
  const args = { ...argv }
  for (const [index, item] of positional.entries()) {
    const key = argKey(item.name)
    if (typeof args[key] !== "string" && typeof consumed[index] === "string") args[key] = consumed[index]
  }
  return fetchResources(current, args, resource)
}

async function fetchResources(current: string, argv: Record<string, unknown>, resource: Resource) {
  if (argv.passwordStdin || argv["password-stdin"]) return []
  const server = argv.url ?? process.env.OPENCODE_API_URL ?? "http://127.0.0.1:4096"
  try {
    if (resource.path.includes("{sessionID}") && typeof argv.sessionID !== "string") return []
    const route = resource.path.replace("{sessionID}", encodeURIComponent(String(argv.sessionID ?? "")))
    const url = new URL(route, new URL(String(server)).origin)
    if (resource.limit) url.searchParams.set("limit", "20")
    const directory = argv.directory ?? argv["location-directory"]
    const workspace = argv.workspace ?? argv["location-workspace"]
    const location = resource.routing === "deep" ? "location[" : ""
    if (directory) url.searchParams.set(`${location}directory${location ? "]" : ""}`, String(directory))
    if (workspace) url.searchParams.set(`${location}workspace${location ? "]" : ""}`, String(workspace))
    const headers = new Headers()
    const password = typeof argv.password === "string" ? argv.password : process.env.OPENCODE_SERVER_PASSWORD
    if (password) {
      const username = argv.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
      headers.set("authorization", `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`)
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(300) })
    if (!response.ok || !response.body) return []
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (size < 256_000) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.length
      if (size > 256_000) {
        await reader.cancel()
        return []
      }
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return findResources(body, resource.fields).filter((value) => value.startsWith(current)).slice(0, 30)
  } catch {
    return []
  }
}

function completeApi(current: string, allWords: string[], argv: Record<string, unknown>, apiCatalog: typeof catalog, rawInput?: string[]): string[] | Promise<string[]> {
  const raw = rawInput ?? process.argv.slice(process.argv.indexOf("--get-yargs-completions") + 1).filter((word) => word && word !== "--get-yargs-completions")
  const normalized = normalizeCompletionUrl(raw, allWords, current, argv)
  allWords = normalized.words
  argv = normalized.argv
  const words = allWords.at(-1) === current ? allWords.slice(0, -1) : allWords
  const commandWords = words.slice(1)
  const currentEqual = current.indexOf("=")
  const operation = operationFromWords(commandWords, apiCatalog)
  if (currentEqual > 0 && current.startsWith("-")) {
    const flag = current.slice(0, currentEqual).replace(/^-+/, "")
    const partial = current.slice(currentEqual + 1)
    const finite = optionChoices(flag, operation, apiCatalog)
    const resource = optionResource(flag, operation)
    const values = finite.length ? finite.map(String) : resource ? fetchResources(partial, argv, resource) : []
    return Array.isArray(values)
      ? values.filter((value) => value.startsWith(partial)).map((value) => `${current.slice(0, currentEqual + 1)}${value}`)
      : values.then((items) => items.filter((value) => value.startsWith(partial)).map((value) => `${current.slice(0, currentEqual + 1)}${value}`))
  }
  if (current.startsWith("-") && current.includes("=")) return []
  const trailingIndex = current === "" ? raw.length : raw.length - 1
  if (raw[trailingIndex - 1] === "=") {
    const option = raw[trailingIndex - 2]
    if (option?.startsWith("--")) {
      const flag = option.slice(2)
      const finite = optionChoices(flag, operation, apiCatalog)
      if (finite.length) return finite.map(String).filter((value) => value.startsWith(current))
      const resource = optionResource(flag, operation)
      if (resource && !current.startsWith("-")) return fetchResources(current, argv, resource)
    }
  }
  const previous = current === "" ? raw.at(-1) : raw.at(-2)
  if (previous !== "--" && previous?.startsWith("--")) {
    const hasEquals = previous.includes("=")
    const flag = previous.slice(2).split("=", 1)[0]
    const finite = optionChoices(flag, operation, apiCatalog)
    const boolean = optionBoolean(flag, operation, apiCatalog)
    if (!hasEquals && !current.startsWith("-")) {
      if (finite.length && !boolean) return finite.map(String).filter((value) => value.startsWith(current))
      const resource = optionResource(flag, operation)
      if (resource) return fetchResources(current, argv, resource)
      if (!boolean) return []
    }
    if (current.startsWith("-")) return optionSuggestions(current, operation, raw, apiCatalog)
  }
  if (current.startsWith("-")) return optionSuggestions(current, operation, raw, apiCatalog)

  const commandCandidates = [...new Set(apiCatalog.operations.flatMap((item) =>
    item.command.length > commandWords.length && item.command.slice(0, commandWords.length).every((part, index) => part === commandWords[index])
      ? [item.command[commandWords.length]]
      : [],
  ).concat(commandWords.length === 0 ? ["spec", "request"] : []))]
  if (commandCandidates.length) return commandCandidates.filter((candidate) => candidate.startsWith(current)).map((candidate) => completionLabel(candidate, `${candidate} API command`))

  if (commandWords[0] === "request") {
    if (commandWords.length === 1) return ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].filter((method) => method.startsWith(current))
    if (commandWords.length === 2) return [...new Set(["/doc", ...apiCatalog.operations.map((item) => item.path)])].filter((route) => route.startsWith(current))
  }

  if (operation) {
    const position = commandWords.length - operation.command.length
    const parameter = operation.parameters.filter((item) => item.in === "path")[position]
    const finite = parameter && completionChoices(parameter.schema, apiCatalog)
    if (finite) return finite.map(String).filter((value) => value.startsWith(current))
    if (parameter) {
      return dynamicResources(current, { ...argv, _: ["api", ...commandWords, current] }, apiCatalog)
    }
  }
  return []
}

function normalizeCompletionUrl(raw: string[], words: string[], current: string, argv: Record<string, unknown>) {
  const flag = raw.findIndex((word) => word === "--url" || word.startsWith("--url="))
  if (flag < 0) return { words, argv }
  const inline = raw[flag].startsWith("--url=")
  const separateEquals = !inline && raw[flag + 1] === "="
  const initialIndex = flag + (inline ? 0 : separateEquals ? 2 : 1)
  const initial = inline ? raw[flag].slice("--url=".length) : raw[initialIndex]
  if (!initial) return { words, argv }
  const parts = [initial]
  let index = initialIndex + 1
  while (index < raw.length) {
    const part = raw[index]
    if (index === raw.length - 1 && part === current) break
    if (part.startsWith("--")) break
    if (/^[/:]/.test(part) || (parts.at(-1)?.endsWith(":") && /^\d+$/.test(part))) {
      parts.push(part)
      index++
      continue
    }
    break
  }
  const url = parts.join("")
  if (!/^https?:\/\//.test(url)) return { words, argv }
  const normalizedWords = [...words]
  for (const part of [...(separateEquals ? ["="] : []), ...parts]) {
    const position = normalizedWords.indexOf(part, 1)
    if (position >= 0) normalizedWords.splice(position, 1)
  }
  return { words: normalizedWords, argv: { ...argv, url, _: normalizedWords } }
}

function completionWords(argv: Record<string, unknown>) {
  const words = Array.isArray(argv._) ? argv._.map(String) : []
  const marker = process.argv.indexOf("--get-yargs-completions")
  if (marker < 0) return words
  const raw = process.argv.slice(marker + 1).filter((word) => word !== "--get-yargs-completions")
  const input = raw[0] === "opencode" ? raw.slice(1) : raw
  if (!normalizeApiArgs(input).api) return ["__non_api_completion__", ...words]
  if (words[0] === "opencode") return words.slice(1)
  return words[0] === "api" ? words : ["api", ...words]
}

function operationFromWords(words: string[], apiCatalog: typeof catalog) {
  return apiCatalog.operations
    .filter((operation) => operation.command.length <= words.length && operation.command.every((part, index) => words[index] === part))
    .sort((left, right) => right.command.length - left.command.length)[0]
}

function optionChoices(flag: string, operation: Operation | undefined, apiCatalog: typeof catalog) {
  const option = operation && schemaOptions(operation, apiCatalog).find((item) => item.flag === flag)
  if (option) return completionChoices(option.schema, apiCatalog) ?? (valueSchema(option.schema, apiCatalog).type === "boolean" ? [true, false] : [])
  if (flag === "event-format") return ["ndjson", "sse"]
  if (flag === "log-level") return ["DEBUG", "INFO", "WARN", "ERROR"]
  if (["compact", "raw", "password-stdin", "pure", "print-logs", "remote"].includes(flag)) return [true, false]
  if (flag === "method" && process.argv.includes("request")) return ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
  return []
}

function optionBoolean(flag: string, operation: Operation | undefined, apiCatalog: typeof catalog) {
  const option = operation && schemaOptions(operation, apiCatalog).find((item) => item.flag === flag)
  if (option && valueSchema(option.schema, apiCatalog).type === "boolean") return true
  return ["compact", "raw", "password-stdin", "pure", "print-logs", "remote"].includes(flag)
}

function optionSuggestions(current: string, operation: Operation | undefined, raw: string[], apiCatalog: typeof catalog) {
  const options = new Map<string, { description: string; repeatable?: boolean; boolean?: boolean }>([
    ["-h", { description: "show help" }],
    ["--help", { description: "show help" }],
    ["-v", { description: "show version number" }],
    ["--version", { description: "show version number" }],
    ["print-logs", { description: "print logs to stderr", boolean: true }],
    ["log-level", { description: "log level" }],
    ["pure", { description: "run without external plugins", boolean: true }],
    ["url", { description: "server base URL" }],
    ["directory", { description: "project directory" }],
    ["workspace", { description: "workspace ID" }],
    ["username", { description: "HTTP Basic username" }],
    ["password", { description: "HTTP Basic password" }],
    ["password-stdin", { description: "read password from stdin", boolean: true }],
    ["timeout", { description: "request timeout" }],
    ["header", { description: "additional request header", repeatable: true }],
    ["compact", { description: "compact JSON output", boolean: true }],
    ["raw", { description: "raw response bytes", boolean: true }],
    ["output", { description: "write response to file" }],
    ["body", { description: "JSON request body" }],
    ["body-file", { description: "request body file" }],
    ["event-format", { description: "SSE output format" }],
  ])
  if (operation) {
    options.set("schema", { description: "print request JSON Schema", boolean: true })
    for (const option of schemaOptions(operation, apiCatalog)) {
      const schema = valueSchema(option.schema, apiCatalog)
      options.set(option.flag, {
        description: option.description ?? option.scope,
        repeatable: schema.type === "array",
        boolean: schema.type === "boolean",
      })
    }
  }
  if (process.argv.includes("request")) options.set("method", { description: "HTTP method" })
  if (process.argv.includes("request")) options.set("path", { description: "API path" })
  if (process.argv.includes("request") || process.argv.includes("spec")) options.set("remote", { description: "fetch remote API specification", boolean: true })
  const used = new Set(raw.flatMap((value) => value.startsWith("--") ? [value.slice(2).split("=", 1)[0]] : []))
  return [...options].flatMap(([name, option]) => {
    if (used.has(name) && !option.repeatable) return []
    const result = [name.startsWith("-") ? name : `--${name}`]
    if (option.boolean) result.push(`--no-${name}`)
    return result.filter((value) => value.startsWith(current)).map((value) => completionLabel(value, option.description))
  })
}

function completionLabel(value: string, description: string) {
  if (!process.env.SHELL?.includes("zsh") && !process.env.ZSH_NAME?.includes("zsh")) return value
  return `${value.replace(/:/g, "\\:")}:${description.replace(/:/g, "\\:")}`
}

function operationFromArgs(argv: Record<string, unknown>, apiCatalog: typeof catalog) {
  const words = Array.isArray(argv._) ? argv._.map(String) : []
  const command = words[0] === "api" ? words.slice(1) : words
  return apiCatalog.operations
    .filter((operation) => operation.command.every((part, index) => command[index] === part))
    .sort((left, right) => right.command.length - left.command.length)[0]
}

function resourceFor(parameter: string, operation: Operation): Resource | undefined {
  const newer = operation.command[0] === "v2"
  if (parameter === "sessionID") return { path: newer ? "/api/session" : "/session", fields: ["id", "sessionID"], limit: true, routing: "direct" }
  if (parameter === "projectID") return { path: "/project", fields: ["id", "projectID"], limit: false, routing: "none" }
  if (parameter === "providerID") return { path: newer ? "/api/provider" : "/provider", fields: ["id", "providerID"], limit: false, routing: "none" }
  if (parameter === "ptyID") return { path: newer ? "/api/pty" : "/pty", fields: ["id", "ptyID"], limit: false, routing: newer ? "deep" : "direct" }
  if (parameter === "integrationID") return { path: "/api/integration", fields: ["id", "integrationID"], limit: false, routing: "none" }
  if (parameter === "permissionID") return { path: "/permission", fields: ["id", "permissionID", "requestID"], limit: false, routing: "direct" }
  if (parameter === "requestID") {
    if (newer && operation.command.includes("session") && operation.command.includes("permission")) {
      return { path: "/api/session/{sessionID}/permission", fields: ["id", "requestID"], limit: false, routing: "none" }
    }
    if (newer && operation.command.includes("session") && operation.command.includes("question")) {
      return { path: "/api/session/{sessionID}/question", fields: ["id", "requestID"], limit: false, routing: "none" }
    }
    if (newer && operation.command.includes("question")) return { path: "/api/question/request", fields: ["id", "requestID"], limit: false, routing: "none" }
    if (newer && operation.command.includes("permission")) return { path: "/api/permission/request", fields: ["id", "requestID"], limit: false, routing: "none" }
    if (operation.command.includes("question")) return { path: "/question", fields: ["id", "requestID"], limit: false, routing: "direct" }
    if (operation.command.includes("permission")) return { path: "/permission", fields: ["id", "requestID"], limit: false, routing: "direct" }
  }
  if (parameter === "id" && newer && operation.command.includes("permission")) {
    return { path: "/api/permission/saved", fields: ["id"], limit: false, routing: "none" }
  }
  if (parameter === "id" && operation.command.includes("workspace")) return { path: "/experimental/workspace", fields: ["id"], limit: false, routing: "none" }
  if (parameter === "name" && operation.command.includes("mcp")) return { path: "/mcp", fields: ["name"], limit: false, routing: "none" }
  return undefined
}

function optionResource(flag: string, operation: Operation | undefined): Resource | undefined {
  const newer = operation?.command[0] === "v2"
  if (flag === "workspace") return { path: "/experimental/workspace", fields: ["id", "workspaceID"], limit: false, routing: "direct" }
  if (flag === "agent") return { path: newer ? "/api/agent" : "/agent", fields: ["name", "id"], limit: false, routing: newer ? "deep" : "direct" }
  if ((flag === "command" || flag === "name") && operation?.operationId === "session.command") {
    return { path: newer ? "/api/command" : "/command", fields: ["name", "id"], limit: false, routing: newer ? "deep" : "direct" }
  }
  if (flag === "model" && newer) return { path: "/api/model", fields: ["id", "modelID"], limit: false, routing: "deep" }
  return undefined
}

function findResources(value: unknown, fields: string[], depth = 0): string[] {
  if (depth > 5 || !value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap((item) => findResources(item, fields, depth + 1))
  const object = value as Record<string, unknown>
  const own = fields.flatMap((field) => typeof object[field] === "string" ? [object[field] as string] : [])
  if (own.length) return own
  return Object.values(object).flatMap((item) => findResources(item, fields, depth + 1))
}
