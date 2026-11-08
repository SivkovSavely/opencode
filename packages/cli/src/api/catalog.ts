import { HttpMethod } from "effect/http"
import type { ApiDocument, Catalog, Operation, Parameter } from "./types"
import { inputOptions, kebab, scalar, variants } from "./schema"

const methods = [...HttpMethod.all].map((method) => method.toLowerCase())
const overrides: Record<string, string> = {
  "server.info": "health",
  "pty.connect.token": "pty connect-token",
  "experimental.mcp.client": "experimental mcp client connect",
}
const unsupportedWebSockets = new Set(["pty.connect", "experimental.persistentPty.connect", "experimental.mcp.client"])

export function buildCatalog(spec: ApiDocument): Catalog {
  const catalog: Catalog = { components: spec.components ?? { schemas: {} }, operations: [] }
  const ids = new Set<string>()
  const commands = new Set<string>(["request", "spec", "catalog", "complete", "completion"])
  Object.entries(spec.paths)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([path, item]) => {
      operationEntries(item).forEach(([method, raw]) => {
        if (!methods.includes(method)) {
          if (!["parameters", "summary", "description", "servers"].includes(method) && !method.startsWith("x-"))
            throw new Error(`${path}: unsupported path item ${method}`)
          return
        }
        const endpoint = raw as {
          operationId?: string
          summary?: string
          description?: string
          parameters?: Parameter[]
          requestBody?: Operation["requestBody"]
          responses?: Record<string, { content?: Record<string, unknown> }>
          "x-websocket"?: boolean
        }
        const id = endpoint.operationId
        if (!id) throw new Error(`${method.toUpperCase()} ${path}: missing operationId`)
        if (ids.has(id)) throw new Error(`Duplicate operationId: ${id}`)
        ids.add(id)
        const command = (overrides[id] ?? id.split(".").map(kebab).join(" ")).split(" ")
        if (command.some((part) => !/^[a-z][a-z0-9-]*$/.test(part)))
          throw new Error(`${id}: invalid CLI command name; add an explicit override`)
        const key = command.join(" ")
        if (commands.has(key)) throw new Error(`API CLI command collision: ${key} (${id})`)
        commands.add(key)
        if (endpoint["x-websocket"] && !unsupportedWebSockets.has(id))
          throw new Error(`${id}: unsupported WebSocket; declare a dedicated adapter or explicit unsupported boundary`)
        const media = Object.values(endpoint.responses ?? {}).flatMap((response) => Object.keys(response.content ?? {}))
        const parameters = [...((item.parameters as Parameter[]) ?? []), ...(endpoint.parameters ?? [])]
        if (path.endsWith("/*"))
          parameters.push({ in: "path", name: "path", required: true, schema: { type: "string" } })
        const operation: Operation = {
          operationId: id,
          command,
          method: method.toUpperCase(),
          path,
          summary: endpoint.summary,
          description: endpoint.description,
          parameters,
          requestBody: endpoint.requestBody,
          transport: endpoint["x-websocket"] ? "websocket" : media.includes("text/event-stream") ? "sse" : "http",
          unsupported: endpoint["x-websocket"]
            ? "Interactive WebSocket transport is not supported by api; use the native PTY/MCP client"
            : undefined,
        }
        Object.keys(endpoint.requestBody?.content ?? {}).forEach((type) => {
          if (!["application/json", "text/plain", "application/octet-stream"].includes(type))
            throw new Error(`${id}: unsupported request media ${type}; add an adapter`)
        })
        if (Object.keys(endpoint.requestBody?.content ?? {}).length > 1)
          throw new Error(`${id}: ambiguous request media; declare a media-selection adapter`)
        parameters.forEach((param) => {
          if (!["path", "query", "header"].includes(param.in))
            throw new Error(`${id}: unsupported ${param.in} parameter ${param.name}`)
          const object = variants(param.schema ?? {}, catalog).find((branch) => branch.type === "object")
          if (object && param.in === "query") {
            // Native LocationQuery has a dedicated bracket-encoded wire representation, including routes missing style metadata.
            if (param.style !== "deepObject" && param.name !== "location")
              throw new Error(`${id}: unsupported object serialization for ${param.name}`)
            if (param.required && !object.required?.length)
              throw new Error(`${id}: required deepObject ${param.name} has no serializable required fields`)
            if (
              param.explode === false ||
              !Object.keys(object.properties ?? {}).length ||
              object.additionalProperties === true ||
              typeof object.additionalProperties === "object" ||
              Object.values(object.properties ?? {}).some((child) => {
                const shape = scalar(child, catalog)
                return !shape || shape.type === "array"
              })
            )
              throw new Error(`${id}: unsupported deepObject ${param.name}`)
            return
          }
          if (param.style && param.style !== (param.in === "query" ? "form" : "simple"))
            throw new Error(`${id}: unsupported serialization ${param.style}`)
          if (
            !scalar(param.schema ?? {}, catalog) ||
            (param.in !== "query" && scalar(param.schema ?? {}, catalog)?.type === "array") ||
            (param.explode === false && scalar(param.schema ?? {}, catalog)?.type === "array")
          )
            throw new Error(`${id}: unsupported parameter serialization for ${param.name}`)
        })
        inputOptions(operation, catalog)
        catalog.operations.push(operation)
      })
    })
  commands.forEach((command) => {
    if ([...commands].some((other) => other.startsWith(`${command} `)))
      throw new Error(`API CLI leaf/group collision: ${command}; add an override`)
  })
  function refs(input: unknown) {
    if (!input || typeof input !== "object") return
    if (Array.isArray(input)) return input.forEach(refs)
    const value = input as Record<string, unknown>
    if (typeof value.$ref === "string") {
      const name = /^#\/components\/schemas\/(.+)$/.exec(value.$ref)?.[1]?.replace(/~1/g, "/").replace(/~0/g, "~")
      if (!name || !catalog.components.schemas[name]) throw new Error(`Missing or unsupported reference: ${value.$ref}`)
    }
    Object.values(value).forEach(refs)
  }
  refs(spec)
  catalog.operations.sort((a, b) => {
    const first = a.command.join(" ")
    const second = b.command.join(" ")
    return first < second ? -1 : first > second ? 1 : 0
  })
  return catalog
}

export function catalogSource(catalog: Catalog) {
  return JSON.stringify(catalog, null, 2) + "\n"
}

export function catalogDifferences(current: Catalog, expected: Catalog) {
  const before = new Map(current.operations.map((operation) => [operation.operationId, operation]))
  const after = new Map(expected.operations.map((operation) => [operation.operationId, operation]))
  return [
    ...expected.operations.flatMap((operation) =>
      !before.has(operation.operationId)
        ? [`added ${operation.operationId}`]
        : JSON.stringify(operation) !== JSON.stringify(before.get(operation.operationId))
          ? [`changed ${operation.operationId} (route/parameters/body/help/transport)`]
          : [],
    ),
    ...current.operations
      .filter((operation) => !after.has(operation.operationId))
      .map((operation) => `removed ${operation.operationId}`),
    ...(JSON.stringify(current.components) !== JSON.stringify(expected.components)
      ? ["changed schema definitions"]
      : []),
  ]
}
export function operationEntries(item: Record<string, unknown>) {
  return Object.entries(item).flatMap(([method, raw]) =>
    method === "x-oai-additionalOperations"
      ? Object.entries(raw as Record<string, unknown>).map(
          ([method, operation]) => [method.toLowerCase(), operation] as const,
        )
      : [[method, raw] as const],
  )
}
