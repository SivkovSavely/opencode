import { writeFile } from "node:fs/promises"
import path from "node:path"
import { OpenApi } from "effect/unstable/httpapi"
import { OpenCodeHttpApi } from "../src/server/routes/instance/httpapi/api"
import type { Catalog, Operation, Schema } from "../src/cli/cmd/api/types"

const output = path.join(import.meta.dir, "../src/cli/cmd/api/catalog.generated.ts")
const specOutput = path.join(import.meta.dir, "../src/cli/cmd/api/spec.generated.ts")
const methods = ["get", "post", "put", "patch", "delete", "options", "head"] as const

const commandOverrides: Record<string, string> = {
  "global.health": "health",
  "global.event": "global event subscribe",
  "global.runtime": "global runtime status",
  "app.log": "log write",
  "config.providers": "config providers list",
  "experimental.capabilities.get": "experimental capabilities",
  "experimental.console.get": "experimental console get",
  "experimental.console.listOrgs": "experimental console org list",
  "experimental.console.switchOrg": "experimental console org switch",
  "tool.list": "experimental tool list",
  "tool.ids": "experimental tool ids",
  "worktree.list": "experimental worktree list",
  "worktree.create": "experimental worktree create",
  "worktree.remove": "experimental worktree delete",
  "worktree.reset": "experimental worktree reset",
  "experimental.workspace.remove": "experimental workspace delete",
  "find.text": "file search text",
  "find.files": "file search files",
  "find.symbols": "file search symbols",
  "app.agents": "agent list",
  "app.skills": "skill list",
  "project.initGit": "project git init",
  "vcs.diff.raw": "vcs diff-raw",
  "sync.history.list": "sync history",
  "tui.control.response": "tui control respond",
  "v2.health.get": "v2 health",
  "provider.auth": "provider auth list",
  "pty.remove": "pty delete",
  "session.messages": "session message list",
  "session.message": "session message get",
  "session.deleteMessage": "session message delete",
  "session.queueList": "session queue list",
  "session.queueSubmit": "session queue submit",
  "session.queueUpdate": "session queue update",
  "session.queueFlush": "session queue flush",
  "permission.respond": "session permission respond",
  "part.update": "session message part update",
  "part.delete": "session message part delete",
  "pty.connectToken": "pty connect-token",
  "v2.projectCopy.create": "experimental project copy create",
  "v2.projectCopy.remove": "experimental project copy delete",
  "v2.projectCopy.refresh": "experimental project copy refresh",
  "experimental.projectCopy.generateName": "experimental project copy generate-name",
  "v2.session.switchAgent": "v2 session agent set",
  "v2.session.switchModel": "v2 session model set",
  "v2.session.messages": "v2 session message list",
  "v2.session.message": "v2 session message get",
  "v2.credential.remove": "v2 credential delete",
  "v2.permission.saved.remove": "v2 permission saved delete",
  "v2.pty.remove": "v2 pty delete",
}

export function buildCatalog(spec: Record<string, unknown>): Catalog {
  const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>
  const operations: Operation[] = []
  const keys = new Map<string, string>()
  const usedCommands = new Map<string, string>()

  for (const [route, item] of Object.entries(paths ?? {})) {
    for (const name of Object.keys(item)) {
      if ([...methods, "parameters", "servers", "summary", "description", "$ref"].includes(name) || name.startsWith("x-")) continue
      throw new Error(`${route} uses unsupported OpenAPI path-item field '${name}'; update the API CLI generator before adding this route`)
    }
    for (const method of methods) {
      const endpoint = item[method]
      if (!endpoint) continue
      const declaredId = String(endpoint.operationId ?? "")
      const operationId = declaredId || `auto.${method}.${route.replace(/[^a-zA-Z0-9]+/g, ".")}`
      const key = `${method.toUpperCase()} ${route}`
      if (keys.has(key)) throw new Error(`Duplicate API operation ${key}`)
      keys.set(key, operationId)

      const command = (commandOverrides[declaredId] ?? automaticCommand(declaredId, route, method))
        .split(" ")
        .map((part) => kebab(part))
      const commandKey = command.join(" ")
      const previous = usedCommands.get(commandKey)
      if (previous) throw new Error(`API CLI command collision: '${commandKey}' maps to ${previous} and ${key}`)
      usedCommands.set(commandKey, key)

      const content = endpoint.responses as Record<string, { content?: Record<string, unknown> }> | undefined
      const media = Object.values(content ?? {}).flatMap((response) => Object.keys(response.content ?? {}))
      const summary = String(endpoint.summary ?? "")
      const websocket = endpoint["x-websocket"] === true || (route.includes("/pty/") && route.endsWith("/connect"))
      if (websocket && !route.includes("/pty/")) throw new Error(`${key} declares an unsupported WebSocket transport; add a dedicated API CLI adapter`)
      const sse = endpoint["x-sse"] === true || media.includes("text/event-stream") || /\bsubscribe\b/i.test(summary) || (method === "get" && route.endsWith("/event"))
      const transport = websocket
        ? "websocket"
        : sse
        ? "sse"
        : "http"
      const parameters = (endpoint.parameters ?? []) as Operation["parameters"]
      for (const parameter of parameters) validateParameterSerialization(key, parameter, spec)
      if (route.endsWith("/*") && !parameters.some((parameter) => parameter.in === "path")) {
        parameters.push({ name: "path", in: "path", required: true, schema: { type: "string" } })
      }
      const requestBody = endpoint.requestBody as Operation["requestBody"]
      if (
        requestBody &&
        Object.keys(requestBody.content ?? {}).some((type) => !["application/json", "text/plain"].includes(type))
      ) {
        throw new Error(`${key} uses unsupported request content type: ${Object.keys(requestBody.content ?? {}).join(", ")}`)
      }

      operations.push({
        command,
        method: method.toUpperCase(),
        path: route,
        operationId,
        summary: endpoint.summary as string | undefined,
        description: endpoint.description as string | undefined,
        transport,
        parameters,
        requestBody,
      })
    }
  }

  for (const [name, operation] of usedCommands) {
    const prefix = [...usedCommands.keys()].find((key) => key !== name && key.startsWith(`${name} `))
    if (prefix) throw new Error(`API CLI command '${name}' is both an operation and a group for '${prefix}' (${operation})`)
  }

  const schemas = referencedSchemas(operations, (spec.components as { schemas?: Record<string, Schema> } | undefined)?.schemas ?? {})
  return { spec, components: { schemas }, operations }
}

function validateParameterSerialization(key: string, parameter: Operation["parameters"][number], spec: Record<string, unknown>) {
  if (parameter.in !== "query" && parameter.in !== "path") {
    throw new Error(`${key} uses unsupported ${parameter.in} parameter '${parameter.name}'; add a request adapter`)
  }
  const schema = resolveSchema(parameter.schema, spec)
  const type = Array.isArray(schema.type) ? schema.type.filter((item) => item !== "null") : [schema.type]
  if (parameter.in === "path") {
    if (parameter.style && parameter.style !== "simple") throw new Error(`${key} uses unsupported path parameter style '${parameter.style}'`)
    if (type.includes("object") || type.includes("array")) throw new Error(`${key} uses an unsupported structured path parameter '${parameter.name}'`)
    return
  }
  const style = parameter.style ?? "form"
  if (style === "deepObject") {
    const object = objectSchema(schema, spec)
    if (parameter.explode === false || !object?.properties) throw new Error(`${key} uses unsupported deepObject query parameter '${parameter.name}'`)
    for (const property of Object.values(object.properties)) {
      const child = resolveSchema(property, spec)
      if (child.properties || child.type === "object" || (child.type === "array" && resolveSchema(child.items, spec).type === "object")) {
        throw new Error(`${key} uses a nested deepObject query parameter '${parameter.name}'`)
      }
    }
    return
  }
  if (style !== "form") throw new Error(`${key} uses unsupported query parameter style '${style}'`)
  if (type.includes("object")) throw new Error(`${key} uses an unsupported form object query parameter '${parameter.name}'`)
  if (type.includes("array") && (parameter.explode === false || resolveSchema(schema.items, spec).type === "object")) {
    throw new Error(`${key} uses unsupported array query encoding for '${parameter.name}'`)
  }
}

function referencedSchemas(operations: Operation[], schemas: Record<string, Schema>) {
  const result: Record<string, Schema> = {}
  const refs = new Map<string, string>()
  for (const operation of operations) {
    const inputs = [
      ...operation.parameters.map((parameter) => parameter.schema),
      ...Object.values(operation.requestBody?.content ?? {}).map((content) => content.schema),
    ]
    for (const input of inputs) {
      for (const ref of schemaRefs(input)) refs.set(ref, `${operation.method} ${operation.path}`)
    }
  }
  while (refs.size) {
    const [name, operation] = refs.entries().next().value as [string, string]
    refs.delete(name)
    if (Object.hasOwn(result, name)) continue
    const schema = schemas[name]
    if (!schema) throw new Error(`${operation} references missing request schema '${name}'`)
    result[name] = schema
    for (const ref of schemaRefs(schema)) refs.set(ref, operation)
  }
  return result
}

function schemaRefs(input: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(input)) {
    for (const item of input) schemaRefs(item, refs)
    return refs
  }
  if (!input || typeof input !== "object") return refs
  const schema = input as Record<string, unknown>
  if (typeof schema.$ref === "string") {
    const ref = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref)
    if (!ref) throw new Error(`Request schema uses unsupported reference '${schema.$ref}'`)
    refs.add(ref[1].replace(/~1/g, "/").replace(/~0/g, "~"))
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    const value = schema[key]
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const nested of Object.values(value)) schemaRefs(nested, refs)
    }
  }
  for (const key of [
    "allOf",
    "anyOf",
    "oneOf",
    "items",
    "additionalProperties",
    "additionalItems",
    "not",
    "prefixItems",
    "contains",
    "propertyNames",
    "if",
    "then",
    "else",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentSchema",
    "dependencies",
  ]) {
    schemaRefs(schema[key], refs)
  }
  return refs
}

function resolveSchema(input: Schema | undefined, spec: Record<string, unknown>): Schema {
  if (!input) return {}
  if (input.$ref) {
    const components = spec.components as { schemas?: Record<string, Schema> } | undefined
    const name = input.$ref.split("/").at(-1) ?? ""
    return resolveSchema(components?.schemas?.[name], spec)
  }
  const branches = (input.allOf ?? []).map((item) => resolveSchema(item, spec))
  const properties = Object.assign({}, ...branches.map((item) => item.properties), input.properties)
  return {
    ...Object.assign({}, ...branches),
    ...input,
    properties: Object.keys(properties).length ? properties : undefined,
    type: input.type ?? branches.find((item) => item.type && item.type !== "null")?.type,
  }
}

function objectSchema(input: Schema, spec: Record<string, unknown>) {
  const current = resolveSchema(input, spec)
  const variants = [...(current.anyOf ?? []), ...(current.oneOf ?? [])]
  if (!variants.length) return current
  const objects = variants.map((variant) => resolveSchema(variant, spec)).filter((variant) => variant.type !== "null")
  if (objects.length !== 1) return undefined
  const branch = objects[0]
  return {
    ...current,
    ...branch,
    properties: { ...current.properties, ...branch.properties },
    required: [...new Set([...(current.required ?? []), ...(branch.required ?? [])])],
  }
}

function automaticCommand(operationId: string, route: string, method: string) {
  if (operationId) return operationId.replace(/^app\./, "").split(".").map(kebab).join(" ")
  return [
    ...(route.startsWith("/api/") ? ["v2"] : []),
    ...route.split("/").filter(Boolean).filter((part) => part !== "api" && !part.startsWith("{") && part !== "*"),
    method,
  ].join(" ")
}

function kebab(input: string) {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()
}

export function source(catalog: Catalog) {
  const serialized = JSON.stringify({ components: catalog.components, operations: catalog.operations })
  return `import type { Catalog } from "./types"\n\nexport const catalog = JSON.parse(${JSON.stringify(serialized)}) as Catalog\n`
}

export function sourceSpec(spec: Record<string, unknown>) {
  return `export const spec = JSON.parse(${JSON.stringify(JSON.stringify(spec))}) as Record<string, unknown>\n`
}

if (import.meta.main) {
  const catalog = buildCatalog(OpenApi.fromApi(OpenCodeHttpApi) as unknown as Record<string, unknown>)
  const generated = source(catalog)
  const generatedSpec = sourceSpec(catalog.spec ?? {})
  if (process.argv.includes("--check")) {
    const current = await Bun.file(output).text().catch(() => "")
    const currentSpec = await Bun.file(specOutput).text().catch(() => "")
    if (current === generated && currentSpec === generatedSpec) {
      console.log(`API CLI catalog is current (${catalog.operations.length} operations).`)
    } else {
      const previous = await import("../src/cli/cmd/api/catalog.generated").then((module) => module.catalog).catch(() => undefined)
      const before = new Set(previous?.operations.map((operation) => `${operation.method} ${operation.path}`) ?? [])
      const after = new Set(catalog.operations.map((operation) => `${operation.method} ${operation.path}`))
      const changed = [
        ...[...after].filter((key) => !before.has(key)).map((key) => `added ${key}`),
        ...[...before].filter((key) => !after.has(key)).map((key) => `removed ${key}`),
      ]
      console.error(
        [
          `API CLI catalog is stale${changed.length ? `: ${changed.join(", ")}` : " (route or schema metadata changed)"}.`,
          "Run `bun run api:generate` from packages/opencode, then `bun run api:check`.",
        ].join("\n"),
      )
      process.exitCode = 1
    }
  } else {
    await writeFile(output, generated)
    await writeFile(specOutput, generatedSpec)
    console.log(`Generated ${catalog.operations.length} API operations in ${path.relative(process.cwd(), output)}.`)
  }
}
