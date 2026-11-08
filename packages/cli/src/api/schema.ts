import { isIP } from "node:net"
import type { Catalog, JsonSchema, Operation } from "./types"

export const commonNames = new Set([
  "server",
  "standalone",
  "print-logs",
  "log-level",
  "help",
  "version",
  "completions",
  "h",
  "v",
  "d",
  "H",
  "body",
  "body-file",
  "data",
  "header",
  "param",
  "password",
  "password-stdin",
  "username",
  "timeout",
  "compact",
  "raw",
  "output",
  "schema",
  "remote",
  "workspace",
  "wizard",
])

export function kebab(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_.\[\]]+/g, "-")
    .replace(/-+$/, "")
    .toLowerCase()
}

export function resolved(schema: JsonSchema = {}, catalog: Catalog, seen = new Set<string>()): JsonSchema {
  if (schema.$ref) {
    if (seen.has(schema.$ref)) throw new Error(`Cyclic schema alias: ${schema.$ref}`)
    const name = schema.$ref
      .replace(/^#\/components\/schemas\//, "")
      .replace(/~1/g, "/")
      .replace(/~0/g, "~")
    const target = catalog.components.schemas[name]
    if (!target) throw new Error(`Missing schema reference: ${schema.$ref}`)
    return { ...resolved(target, catalog, new Set([...seen, schema.$ref])), ...schema, $ref: undefined }
  }
  const branches = (schema.allOf ?? []).map((branch) => resolved(branch, catalog, seen))
  return {
    ...Object.assign({}, ...branches),
    ...schema,
    properties: Object.assign({}, ...branches.map((branch) => branch.properties), schema.properties),
    required: [...new Set([...branches.flatMap((branch) => branch.required ?? []), ...(schema.required ?? [])])],
  }
}

export function variants(schema: JsonSchema, catalog: Catalog): JsonSchema[] {
  const value = resolved(schema, catalog)
  const branches = value.anyOf ?? value.oneOf
  return branches ? branches.flatMap((branch) => variants(branch, catalog)) : [value]
}

export function choices(schema: JsonSchema, catalog: Catalog): string[] {
  return [
    ...new Set(
      variants(schema, catalog)
        .flatMap((branch) => branch.enum ?? ("const" in branch ? [branch.const] : []))
        .filter((value) => value !== null)
        .map(String),
    ),
  ]
}

export function scalar(schema: JsonSchema, catalog: Catalog): JsonSchema | undefined {
  const branches = variants(schema, catalog).filter((branch) => branch.type !== "null")
  const array = branches.find((branch) => branch.type === "array")
  if (array?.prefixItems?.length) return undefined
  if (array && array.items && scalar(array.items, catalog)) return array
  if (branches.every((branch) => ["string", "number", "integer", "boolean"].includes(String(branch.type))))
    return { ...branches[0], enum: undefined }
}

export type InputOption = {
  flag: string
  scope: "query" | "body" | "header"
  name: string
  child?: string
  schema: JsonSchema
  required: boolean
  description?: string
}

export function inputOptions(operation: Operation, catalog: Catalog): InputOption[] {
  const options: InputOption[] = operation.parameters
    .filter((param) => param.in !== "path")
    .flatMap((param) => {
      const object = variants(param.schema ?? {}, catalog).find((branch) => branch.type === "object")
      if (object && param.in === "query")
        return Object.entries(object.properties ?? {}).map(([name, schema]) => ({
          flag: param.name === "location" && name === "directory" ? "directory" : kebab(`${param.name}-${name}`),
          scope: "query" as const,
          name: param.name,
          child: name,
          schema,
          required: Boolean(param.required && object.required?.includes(name)),
          description: schema.description,
        }))
      const name = kebab(param.name)
      return [
        {
          flag: commonNames.has(name) ? `${param.in}-${name}` : name,
          scope: param.in as "query" | "header",
          name: param.name,
          schema: param.schema ?? {},
          required: param.required ?? false,
          description: param.description,
        },
      ]
    })
  const body = operation.requestBody?.content["application/json"]?.schema
  const object = body && variants(body, catalog).filter((branch) => branch.type !== "null")
  if (object?.length === 1)
    Object.entries(object[0].properties ?? {}).forEach(([name, schema]) => {
      if (!scalar(schema, catalog)) return
      const flag = kebab(name)
      options.push({
        flag: commonNames.has(flag) || options.some((option) => option.flag === flag) ? `body-${flag}` : flag,
        scope: "body",
        name,
        schema,
        required: object[0].required?.includes(name) ?? false,
        description: schema.description,
      })
    })
  const names = new Set<string>()
  options.forEach((option) => {
    if (!/^[a-z][a-z0-9-]*$/.test(option.flag))
      throw new Error(
        `${operation.operationId}: invalid flag name --${option.flag}; use a declared override or JSON body`,
      )
    if (names.has(option.flag)) throw new Error(`${operation.operationId}: flag collision --${option.flag}`)
    names.add(option.flag)
  })
  return options
}

export function coerce(value: string | readonly string[], schema: JsonSchema, catalog: Catalog): unknown {
  const type = scalar(schema, catalog)
  if (type?.type === "array")
    return (Array.isArray(value) ? value : [value]).map((item) => coerce(item, type.items ?? {}, catalog))
  const item = Array.isArray(value) ? value[0] : value
  if (Array.isArray(value) && value.length !== 1) throw new Error("This option cannot be repeated")
  if (type?.type === "number" || type?.type === "integer") return Number(item)
  if (type?.type === "boolean") {
    if (item !== "true" && item !== "false") throw new Error("Expected true or false")
    return item === "true"
  }
  return item
}

export function validate(input: unknown, schema: JsonSchema = {}, catalog: Catalog, at = "body"): string[] {
  const value = resolved(schema, catalog)
  const errors: string[] = []
  if (value.not && validate(input, value.not, catalog, at).length === 0) errors.push(`${at} matches a forbidden schema`)
  if (value.if) {
    const branch = validate(input, value.if, catalog, at).length === 0 ? value.then : value.else
    if (branch) errors.push(...validate(input, branch, catalog, at))
  }
  if (value.anyOf && !value.anyOf.some((branch) => validate(input, branch, catalog, at).length === 0))
    errors.push(`${at} must match a declared anyOf variant`)
  if (value.oneOf && value.oneOf.filter((branch) => validate(input, branch, catalog, at).length === 0).length !== 1)
    errors.push(`${at} must match exactly one declared oneOf variant`)
  const types = Array.isArray(value.type) ? value.type : value.type ? [value.type] : []
  const actual = input === null ? "null" : Array.isArray(input) ? "array" : typeof input
  if (
    types.length &&
    !types.some(
      (type) => type === actual || (type === "integer" && typeof input === "number" && Number.isInteger(input)),
    )
  )
    errors.push(`${at} must be ${types.join(" | ")}`)
  if (value.enum && !value.enum.some((item) => JSON.stringify(item) === JSON.stringify(input)))
    errors.push(`${at} must be one of ${value.enum.join(", ")}`)
  if ("const" in value && JSON.stringify(input) !== JSON.stringify(value.const))
    errors.push(`${at} must be ${JSON.stringify(value.const)}`)
  if (typeof input === "number") {
    if (!Number.isFinite(input)) errors.push(`${at} must be finite`)
    if (value.minimum !== undefined && input < value.minimum) errors.push(`${at} must be >= ${value.minimum}`)
    if (value.maximum !== undefined && input > value.maximum) errors.push(`${at} must be <= ${value.maximum}`)
    if (value.exclusiveMinimum !== undefined && input <= value.exclusiveMinimum)
      errors.push(`${at} must be > ${value.exclusiveMinimum}`)
    if (value.exclusiveMaximum !== undefined && input >= value.exclusiveMaximum)
      errors.push(`${at} must be < ${value.exclusiveMaximum}`)
    if (
      value.multipleOf !== undefined &&
      Math.abs(input / value.multipleOf - Math.round(input / value.multipleOf)) > 1e-10
    )
      errors.push(`${at} must be a multiple of ${value.multipleOf}`)
  }
  if (typeof input === "string") {
    if (value.minLength !== undefined && [...input].length < value.minLength) errors.push(`${at} is too short`)
    if (value.maxLength !== undefined && [...input].length > value.maxLength) errors.push(`${at} is too long`)
    if (value.pattern && !new RegExp(value.pattern).test(input)) errors.push(`${at} does not match ${value.pattern}`)
    if (value.format && !validFormat(input, value.format)) errors.push(`${at} must be a valid ${value.format}`)
  }
  if (Array.isArray(input)) {
    if (value.minItems !== undefined && input.length < value.minItems) errors.push(`${at} has too few items`)
    if (value.maxItems !== undefined && input.length > value.maxItems) errors.push(`${at} has too many items`)
    if (value.uniqueItems && new Set(input.map((item) => JSON.stringify(item))).size !== input.length)
      errors.push(`${at} must contain unique items`)
    input.forEach((item, index) =>
      errors.push(...validate(item, value.prefixItems?.[index] ?? value.items, catalog, `${at}[${index}]`)),
    )
  }
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    if (value.minProperties !== undefined && Object.keys(record).length < value.minProperties)
      errors.push(`${at} has too few properties`)
    if (value.maxProperties !== undefined && Object.keys(record).length > value.maxProperties)
      errors.push(`${at} has too many properties`)
    value.required?.forEach((name) => {
      if (!Object.hasOwn(record, name)) errors.push(`${at}.${name} is required`)
    })
    Object.entries(record).forEach(([name, item]) => {
      const child = value.properties?.[name]
      if (value.propertyNames) errors.push(...validate(name, value.propertyNames, catalog, `${at} property name`))
      const matching = Object.entries(value.patternProperties ?? {}).filter(([pattern]) =>
        new RegExp(pattern).test(name),
      )
      matching.forEach(([, schema]) => errors.push(...validate(item, schema, catalog, `${at}.${name}`)))
      if (child) errors.push(...validate(item, child, catalog, `${at}.${name}`))
      if (!child && !matching.length && value.additionalProperties === false)
        errors.push(`${at}.${name} is not allowed`)
      if (!child && !matching.length && typeof value.additionalProperties === "object")
        errors.push(...validate(item, value.additionalProperties, catalog, `${at}.${name}`))
    })
  }
  value.allOf?.forEach((branch) => errors.push(...validate(input, branch, catalog, at)))
  return [...new Set(errors)]
}

function validFormat(input: string, format: string) {
  if (format === "ipv4" || format === "ipv6") return isIP(input) === (format === "ipv4" ? 4 : 6)
  if (format === "uuid") return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(input)
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)
  if (format === "date" || format === "date-time") {
    const day = input.slice(0, 10)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day
    )
      return false
    return format === "date"
      ? input === day
      : /^\d{4}-\d{2}-\d{2}[tT](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[zZ]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
          input,
        ) && Number.isFinite(Date.parse(input))
  }
  if (format === "uri" || format === "url") return URL.canParse(input)
  return true
}
