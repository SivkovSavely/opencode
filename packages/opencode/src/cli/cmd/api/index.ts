import type { Argv, CommandModule } from "yargs"
import { catalog } from "./catalog.generated"
import { choices, coerceNumberUnion, numericStringUnion, objectSchema, requestSchema, resolved, schemaOptions, typeName, valueSchema } from "./schema"
import type { ApiArgs } from "./transport"
import { commonOptions, executeOperation, executeRequest, executeSpec } from "./transport"
import type { Catalog, Operation, Schema } from "./types"

type Node = { name: string; command?: Operation; children: Map<string, Node> }
const completionMode = process.argv.includes("--get-yargs-completions")
const schemaMode = process.argv.includes("--schema")

export const ApiCommand = makeApiCommand(catalog)

export function makeApiCommand(apiCatalog: Catalog): CommandModule {
  const tree: Node = { name: "api", children: new Map() }
  for (const operation of apiCatalog.operations) {
    let current = tree
    for (const part of operation.command) {
      let child = current.children.get(part)
      if (!child) {
        child = { name: part, children: new Map() }
        current.children.set(part, child)
      }
      current = child
    }
    current.command = operation
  }

  return {
    command: "api",
    describe: "call the OpenCode HTTP API",
    builder: (yargs: Argv) => {
      const result = yargs
        .options(commonOptions)
        .command([...tree.children.values()].sort((left, right) => left.name.localeCompare(right.name)).map((node) => commandTree(node, apiCatalog)))
        .command(specCommand)
        .command(requestCommand)
      return (completionMode ? result : result.demandCommand(1)).recommendCommands()
    },
    handler() {},
  }
}

export function commandPaths(apiCatalog: Catalog = catalog) {
  return apiCatalog.operations.map((operation) => operation.command.join(" "))
}

function commandTree(node: Node, apiCatalog: Catalog): CommandModule {
  if (node.command) return operationCommand(node.name, node.command, apiCatalog)
  return {
    command: node.name,
    describe: groupDescription(node, apiCatalog),
    builder: (yargs: Argv) => {
      const result = yargs.command([...node.children.values()].sort((left, right) => left.name.localeCompare(right.name)).map((child) => commandTree(child, apiCatalog)))
      return (completionMode ? result : result.demandCommand(1)).recommendCommands()
    },
    handler() {},
  }
}

function operationCommand(name: string, operation: Operation, apiCatalog: Catalog): CommandModule {
  const positional = operation.parameters.filter((parameter) => parameter.in === "path")
  const command = `${name}${positional.map((parameter) => ` ${completionMode || schemaMode ? "[" : "<"}${parameter.name}${completionMode || schemaMode ? "]" : ">"}`).join("")}`
  const optionList = schemaOptions(operation, apiCatalog)
  return {
    command,
    describe: operation.summary ?? `${operation.method} ${operation.path}`,
    builder: (yargs: Argv) => {
      let result: Argv = yargs.option("schema", { type: "boolean", describe: "print the request JSON Schema and exit" })
      for (const parameter of positional) {
        const finite = choices(parameter.schema, apiCatalog)
        result = result.positional(parameter.name, {
          type: "string",
          describe: parameter.description ?? `${parameter.name} (${schemaDetails(resolved(parameter.schema, apiCatalog), apiCatalog).join(", ")})`,
          ...(finite ? { choices: finite.map(String) } : {}),
        })
      }
      for (const option of optionList) {
        if (option.scope === "query" && ["directory", "workspace"].includes(option.flag)) continue
        const schema = resolved(option.schema, apiCatalog)
        const concrete = valueSchema(option.schema, apiCatalog)
        const item = concrete.type === "array" ? valueSchema(concrete.items, apiCatalog) : concrete
        const list = concrete.type === "array"
        const value = list ? concrete.items : option.schema
        const finite = choices(value, apiCatalog)
        const numberUnion = numericStringUnion(value, apiCatalog)
        const type = numberUnion ? "string" : item.type === "boolean" ? "boolean" : item.type === "number" || item.type === "integer" ? "number" : "string"
        result = result.option(option.flag, {
          type,
          ...(list ? { array: true } : {}),
          ...(finite ? { choices: finite as (string | number | true | undefined)[] } : {}),
          ...(numberUnion ? { coerce: coerceNumberUnion } : {}),
          ...(schema.default === undefined ? {} : { default: schema.default }),
          describe: optionDescription(option, schema, apiCatalog),
        })
      }
      const help = operationHelp(operation, positional, optionList, apiCatalog)
      return result.example(help.example, "invoke this API operation").epilog(help.text)
    },
    handler: async (args) => {
      if (!completionMode) await executeOperation(operation, args as ApiArgs, apiCatalog)
    },
  }
}

function optionDescription(option: ReturnType<typeof schemaOptions>[number], schema: Schema, apiCatalog: Catalog) {
  const details = schemaDetails(schema, apiCatalog)
  if (valueSchema(option.schema, apiCatalog).type === "array") details.push("repeatable")
  if (option.required) details.push("required")
  return `${option.description ?? "API parameter"} (${details.join(", ")})`
}

function schemaDetails(schema: Schema, apiCatalog: Catalog) {
  const details = [typeName(schema, apiCatalog)]
  if (schema.minimum !== undefined) details.push(`min ${schema.minimum}`)
  if (schema.maximum !== undefined) details.push(`max ${schema.maximum}`)
  if (typeof schema.exclusiveMinimum === "number") details.push(`greater than ${schema.exclusiveMinimum}`)
  else if (schema.exclusiveMinimum && schema.minimum !== undefined) details.push(`greater than ${schema.minimum}`)
  if (typeof schema.exclusiveMaximum === "number") details.push(`less than ${schema.exclusiveMaximum}`)
  else if (schema.exclusiveMaximum && schema.maximum !== undefined) details.push(`less than ${schema.maximum}`)
  if (schema.minLength !== undefined) details.push(`min length ${schema.minLength}`)
  if (schema.maxLength !== undefined) details.push(`max length ${schema.maxLength}`)
  if (schema.minItems !== undefined) details.push(`min items ${schema.minItems}`)
  if (schema.maxItems !== undefined) details.push(`max items ${schema.maxItems}`)
  if (schema.minProperties !== undefined) details.push(`min properties ${schema.minProperties}`)
  if (schema.maxProperties !== undefined) details.push(`max properties ${schema.maxProperties}`)
  if (schema.multipleOf !== undefined) details.push(`multiple of ${schema.multipleOf}`)
  if (schema.pattern) details.push(`pattern ${schema.pattern}`)
  if (schema.format) details.push(`format ${schema.format}`)
  if (schema.default !== undefined) details.push(`default ${JSON.stringify(schema.default)}`)
  return details
}

const specCommand: CommandModule = {
  command: "spec",
  describe: "print the bundled API specification, or fetch /doc from the server",
  builder: (yargs: Argv) => yargs.option("remote", { type: "boolean", describe: "fetch the connected server's GET /doc" }),
  handler: async (args) => {
    if (!completionMode) await executeSpec(args as ApiArgs)
  },
}

const requestCommand: CommandModule = {
  command: "request <method> <path>",
  describe: "make a generic HTTP request",
  builder: (yargs: Argv) =>
    yargs
      .positional("method", { type: "string", choices: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] })
      .positional("path", { type: "string", describe: "absolute API path, including any query string" }),
  handler: async (args) => {
    if (!completionMode) await executeRequest(String(args.method).toUpperCase(), String(args.path), args as ApiArgs)
  },
}

function groupDescription(node: Node, apiCatalog: Catalog) {
  const operations = apiCatalog.operations.filter((operation) => operation.command[0] === node.name)
  return `${node.name} API commands${operations.length ? ` (${operations.length} operations in this namespace)` : ""}`
}

function operationHelp(operation: Operation, positional: Operation["parameters"], options: ReturnType<typeof schemaOptions>, apiCatalog: Catalog) {
  const lines = [
    `HTTP: ${operation.method} ${operation.path}`,
    operation.description,
    positional.length
      ? `Path arguments: ${positional.map((parameter) => `<${parameter.name}> (${schemaDetails(resolved(parameter.schema, apiCatalog), apiCatalog).join(", ")}, required)`).join(", ")}`
      : "Path arguments: none",
  ].filter(Boolean) as string[]
  const query = options.filter((option) => option.scope === "query")
  lines.push(query.length
    ? `Query options: ${query.map((option) => `--${option.flag} (${typeName(option.schema, apiCatalog)}${option.required ? ", required" : ", optional"})`).join(", ")}`
    : "Query options: none")
  const body = requestSchema(operation, apiCatalog)
  if (body) {
    lines.push(`Request body${operation.requestBody?.required ? " (required)" : " (optional)"}:`)
    lines.push(...schemaTree(body, 0, "", apiCatalog))
    if (body.anyOf?.length || body.oneOf?.length || Object.values(resolved(body, apiCatalog).properties ?? {}).some((schema) => resolved(schema, apiCatalog).properties)) {
      lines.push("Use --body, --body-file, or --schema for complex/discriminated request schemas.")
    }
  } else {
    lines.push("Request body: none")
  }
  lines.push("Connection options: --url, --directory, --workspace, --username, --password, --password-stdin, --timeout, --header")
  if (operation.method === "POST" && operation.path === "/api/session") {
    lines.push("For session creation, --directory and --workspace populate body.location.directory and body.location.workspaceID.")
  }
  lines.push("Input/output options: --body, --body-file, --compact, --raw, --output")
  const example = `opencode api ${operation.command.join(" ")}${positional.map((parameter) => ` ${exampleValue(parameter.name, parameter.schema, apiCatalog)}`).join("")}${exampleOptions(operation, options, apiCatalog)}`
  return { text: lines.join("\n"), example }
}

function exampleOptions(operation: Operation, options: ReturnType<typeof schemaOptions>, apiCatalog: Catalog) {
  const query = options.filter((option) => option.scope === "query" && option.required)
  const bodyOptions = options.filter((option) => option.scope === "body")
  const body = requestSchema(operation, apiCatalog)
  const required = (body && objectSchema(body, apiCatalog)?.required) ?? []
  const requiredBodyOptions = required.map((name) => bodyOptions.find((option) => option.name === name))
  if (required.length && requiredBodyOptions.every((option): option is NonNullable<typeof option> => option !== undefined)) {
    return [...query, ...requiredBodyOptions].map((option) => ` ${exampleOption(option, apiCatalog)}`).join("")
  }
  if (operation.requestBody?.required && required.length) return ` --body-file request.json`
  const optionalBody = bodyOptions.find((option) => option.name === "title") ?? bodyOptions.find((option) => option.name === "agent") ?? bodyOptions.find((option) => !required.includes(option.name))
  if (optionalBody) return [...query, optionalBody].map((option) => ` ${exampleOption(option, apiCatalog)}`).join("")
  if (query.length) return query.map((option) => ` ${exampleOption(option, apiCatalog)}`).join("")
  if (!operation.requestBody?.required) return ""
  if (body && objectSchema(body, apiCatalog)?.properties) return ` --body '{}'`
  return ` --body-file request.json`
}

function exampleOption(option: ReturnType<typeof schemaOptions>[number], apiCatalog: Catalog) {
  const schema = resolved(option.schema, apiCatalog)
  const item = schema.type === "array" ? resolved(schema.items, apiCatalog) : schema
  const finite = choices(schema.type === "array" ? schema.items : option.schema, apiCatalog)
  if (item.type === "boolean") return `--${option.flag}`
  const prefix = /^\^([a-z]+_?)/i.exec(item.pattern ?? "")?.[1]
  const value = finite?.[0] ?? (item.type === "number" || item.type === "integer" ? 1 : prefix ? `${prefix}example` : "Example")
  return `--${option.flag} ${typeof value === "string" && value.includes(" ") ? `"${value}"` : String(value)}`
}

function schemaTree(input: Schema, depth: number, prefix: string, apiCatalog: Catalog): string[] {
  const schema = resolved(input, apiCatalog)
  if (schema.anyOf?.length || schema.oneOf?.length) {
    const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]
    return branches.map((branch, index) => `${"  ".repeat(depth)}${prefix || "variant"} ${index + 1}: ${typeName(branch, apiCatalog)}`).concat(
      branches.flatMap((branch, index) => schemaTree(branch, depth + 1, `${prefix || "variant"} ${index + 1}`, apiCatalog)),
    )
  }
  const properties = schema.properties ?? {}
  if (!Object.keys(properties).length) return [`${"  ".repeat(depth)}${prefix || "value"}: ${typeName(input, apiCatalog)}`]
  return Object.entries(properties).flatMap(([name, property]) => {
    const required = schema.required?.includes(name) ? "required" : "optional"
    const current = resolved(property, apiCatalog)
    const description = current.description
    const line = `${"  ".repeat(depth)}${name} (${required}, ${schemaDetails(current, apiCatalog).join(", ")})${description ? `: ${description}` : ""}`
    const nested = depth < 2 && resolved(property, apiCatalog).properties ? schemaTree(property, depth + 1, "", apiCatalog) : []
    return [line, ...nested]
  })
}

function exampleValue(name: string, schema: Schema | undefined, apiCatalog: Catalog) {
  const value = name.toLowerCase()
  const prefix = /^\^([a-z]+_?)/i.exec(resolved(schema, apiCatalog).pattern ?? "")?.[1]
  if (prefix) return `${prefix}example`
  if (value.includes("session")) return "ses_example"
  if (value.includes("message")) return "msg_example"
  if (value.includes("project")) return "prj_example"
  if (value.includes("pty")) return "pty_example"
  if (value.includes("provider")) return "provider-id"
  return "example"
}
