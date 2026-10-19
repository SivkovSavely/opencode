import { isIP } from "node:net"
import type { Catalog, Operation, Schema } from "./types"

export type CliOption = {
  flag: string
  key: string
  scope: "query" | "body"
  name: string
  child?: string
  schema: Schema
  required: boolean
  description?: string
}

const commonFlags = new Set([
  "url",
  "directory",
  "workspace",
  "username",
  "password",
  "password-stdin",
  "timeout",
  "header",
  "compact",
  "raw",
  "output",
  "body",
  "body-file",
  "event-format",
  "schema",
  "log-level",
  "print-logs",
  "pure",
  "help",
  "version",
  "h",
  "v",
])

export function resolved(input: Schema | undefined, catalog: Catalog): Schema {
  if (!input) return {}
  const ref = input.$ref?.split("/").at(-1)
  const base = ref ? resolved(catalog.components.schemas[ref], catalog) : {}
  const branches = (input.allOf ?? []).map((item) => resolved(item, catalog))
  const properties = Object.assign({}, base.properties, ...branches.map((item) => item.properties), input.properties)
  const required = [...new Set([...(base.required ?? []), ...branches.flatMap((item) => item.required ?? []), ...(input.required ?? [])])]
  const enums = [base, ...branches, input].flatMap((item) => item.enum ?? ("const" in item ? [item.const] : []))
  return {
    ...base,
    ...Object.assign({}, ...branches),
    ...input,
    properties: Object.keys(properties).length ? properties : undefined,
    required: required.length ? required : undefined,
    enum: enums.length ? [...new Set(enums)] : undefined,
    type: input.type ?? base.type ?? branches.find((item) => item.type)?.type,
  }
}

export function valueSchema(input: Schema | undefined, catalog: Catalog): Schema {
  const current = resolved(input, catalog)
  const variants = scalarVariants(current, catalog).filter((variant) => variant.type !== "null")
  if (variants.length === 1) return variants[0]
  if (numericStringUnion(current, catalog)) return { ...current, type: "number" }
  const types = [...new Set(variants.flatMap((variant) => Array.isArray(variant.type) ? variant.type : variant.type ? [variant.type] : []))]
  if (types.length === 1) return { ...current, type: types[0] }
  return current
}

export function choices(input: Schema | undefined, catalog: Catalog): unknown[] | undefined {
  if (!input) return undefined
  const current = resolved(input, catalog)
  if (current.enum) {
    const values = [...new Set(current.enum.filter((value) => value !== null))]
    return values.length ? values : undefined
  }
  const variants = [...(current.anyOf ?? []), ...(current.oneOf ?? [])]
  if (!variants.length) return undefined
  const values: unknown[] = []
  for (const variant of variants) {
    if (valueSchema(variant, catalog).type === "null") continue
    const allowed = choices(variant, catalog)
    if (!allowed) return undefined
    values.push(...allowed)
  }
  return values.length ? [...new Set(values)] : undefined
}

export function completionChoices(input: Schema | undefined, catalog: Catalog): unknown[] | undefined {
  if (!input) return undefined
  const current = resolved(input, catalog)
  if (current.enum) {
    const values = [...new Set(current.enum.filter((value) => value !== null))]
    return values.length ? values : undefined
  }
  const anyOf = current.anyOf ?? []
  const oneOf = current.oneOf ?? []
  if (oneOf.length) {
    const branches = oneOf.map((variant) => completionChoices(variant, catalog))
    if (branches.some((branch) => !branch)) return undefined
    return [...new Set(branches.flatMap((branch) => branch ?? []))]
  }
  const values = anyOf.flatMap((variant) => completionChoices(variant, catalog) ?? [])
  return values.length ? [...new Set(values)] : undefined
}

export function numericStringUnion(input: Schema | undefined, catalog: Catalog) {
  const variants = scalarVariants(input, catalog).filter((variant) => variant.type !== "null")
  const special = new Set(["NaN", "Infinity", "-Infinity"])
  return variants.some((variant) => variant.type === "number" || variant.type === "integer") &&
    variants.every((variant) =>
      variant.type === "number" || variant.type === "integer" ||
      (variant.type === "string" && Boolean(variant.enum?.length) && variant.enum?.every((value) => typeof value === "string" && special.has(value))),
    )
}

export function coerceNumberUnion(value: unknown): unknown {
  const normalize = (item: unknown) => {
    if (typeof item !== "string" || ["NaN", "Infinity", "-Infinity"].includes(item)) return item
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(item)) return item
    const number = Number(item)
    return Number.isFinite(number) ? number : item
  }
  return Array.isArray(value) ? value.map(normalize) : normalize(value)
}

function scalarVariants(input: Schema | undefined, catalog: Catalog): Schema[] {
  const current = resolved(input, catalog)
  const variants = [...(current.anyOf ?? []), ...(current.oneOf ?? [])]
  return variants.length ? variants.flatMap((variant) => scalarVariants(variant, catalog)) : [current]
}

export function typeName(input: Schema | undefined, catalog: Catalog): string {
  const current = resolved(input, catalog)
  const variants = [...(current.anyOf ?? []), ...(current.oneOf ?? [])]
  if (variants.length) return variants.map((variant) => typeName(variant, catalog)).join(" | ")
  if (current.enum) return current.enum.map(String).join(" | ")
  if (current.properties) return "object"
  if (current.items) return `array of ${typeName(current.items, catalog)}`
  if (Array.isArray(current.type)) return current.type.join(" | ")
  return current.type ?? "JSON"
}

export function schemaOptions(operation: Operation, catalog: Catalog): CliOption[] {
  const options: CliOption[] = []
  for (const parameter of operation.parameters) {
    if (parameter.in !== "query") continue
    const schema = resolved(parameter.schema, catalog)
    const object = parameter.style === "deepObject" ? objectSchema(parameter.schema ?? {}, catalog) : undefined
    if (object?.properties) {
      for (const [child, childSchema] of Object.entries(object.properties)) {
        options.push({
          flag: child === "directory" || child === "workspace" ? child : `${parameter.name}-${child}`,
          key: child === "directory" || child === "workspace" ? child : `${parameter.name}${upperFirst(child)}`,
          scope: "query",
          name: parameter.name,
          child,
          schema: childSchema,
          required: object.required?.includes(child) ?? false,
          description: childSchema.description,
        })
      }
      continue
    }
    const flag = cliName(parameter.name)
    const optionFlag = commonFlags.has(flag) && !["directory", "workspace"].includes(flag) ? `query-${flag}` : flag
    options.push({
      flag: optionFlag,
      key: argKey(optionFlag),
      scope: "query",
      name: parameter.name,
      schema: parameter.schema ?? {},
      required: parameter.required ?? false,
      description: parameter.description ?? schema.description,
    })
  }

  const body = requestSchema(operation, catalog)
  const object = body && objectSchema(body, catalog)
  const properties = object && simpleProperties(object, catalog)
  const names = new Set(options.map((option) => option.flag))
  if (properties) {
    for (const [name, schema] of Object.entries(properties)) {
      const fieldFlag = cliName(name)
      const flag = names.has(fieldFlag) || commonFlags.has(fieldFlag) ? `body-${fieldFlag}` : fieldFlag
      options.push({
        flag,
        key: argKey(flag),
        scope: "body",
        name,
        schema,
        required: object?.required?.includes(name) ?? false,
        description: schema.description,
      })
    }
  }
  return options
}

export function requestSchema(operation: Operation, catalog: Catalog): Schema | undefined {
  const content = operation.requestBody?.content
  const schema = content?.["application/json"]?.schema ?? content?.["text/plain"]?.schema
  return schema ? resolved(schema, catalog) : undefined
}

export function objectSchema(input: Schema, catalog: Catalog): Schema | undefined {
  const current = resolved(input, catalog)
  const variants = [...(current.anyOf ?? []), ...(current.oneOf ?? [])]
  if (variants.length) {
    const objects = variants.map((variant) => resolved(variant, catalog)).filter((variant) => variant.type !== "null")
    if (objects.length !== 1) return undefined
    const branch = objects[0]
    return {
      ...current,
      ...branch,
      properties: { ...current.properties, ...branch.properties },
      required: [...new Set([...(current.required ?? []), ...(branch.required ?? [])])],
    }
  }
  return current.properties ? current : undefined
}

export function validate(input: unknown, schema: Schema | undefined, catalog: Catalog, at = "value"): string[] {
  if (!schema) return []
  const errors: string[] = []
  const current = resolved(schema, catalog)
  const branches = [...(schema.allOf ?? [])]
  for (const branch of branches) errors.push(...validate(input, branch, catalog, at))
  const anyOf = current.anyOf ?? []
  const oneOf = current.oneOf ?? []
  const anyMatch = anyOf.length > 0 && anyOf.some((branch) => validate(input, branch, catalog, at).length === 0)
  const oneMatches = oneOf.filter((branch) => validate(input, branch, catalog, at).length === 0)
  if (anyOf.length && !anyMatch) errors.push(`${at} must match one of: ${anyOf.map((branch) => typeName(branch, catalog)).join(", ")}`)
  if (oneOf.length && oneMatches.length !== 1) errors.push(`${at} must match exactly one of: ${oneOf.map((branch) => typeName(branch, catalog)).join(", ")}`)
  if (errors.length && (anyOf.length || oneOf.length)) return errors
  if (current.enum && !current.enum.some((value) => Object.is(value, input))) errors.push(`${at} must be one of ${current.enum.map(String).join(", ")}`)
  const types = Array.isArray(current.type) ? current.type : current.type ? [current.type] : []
  if (types.length === 1 && types[0] === "null") {
    if (input !== null) errors.push(`${at} must be null`)
    return errors
  }
  if (input === null && types.includes("null")) return errors
  if (types.includes("string") && typeof input !== "string") errors.push(`${at} must be a string`)
  if (types.includes("boolean") && typeof input !== "boolean") errors.push(`${at} must be a boolean`)
  if ((types.includes("integer") || types.includes("number")) && (typeof input !== "number" || !Number.isFinite(input))) {
    errors.push(`${at} must be a ${types.includes("integer") ? "integer" : "number"}`)
  } else if (types.includes("integer") && typeof input === "number" && !Number.isInteger(input)) {
    errors.push(`${at} must be an integer`)
  }
  if (types.includes("array") && !Array.isArray(input)) errors.push(`${at} must be an array`)
  if (types.includes("object") && (input === null || typeof input !== "object" || Array.isArray(input))) {
    errors.push(`${at} must be an object`)
  }
  if (typeof input === "string") {
    if (current.minLength !== undefined && [...input].length < current.minLength) errors.push(`${at} must be at least ${current.minLength} characters`)
    if (current.maxLength !== undefined && [...input].length > current.maxLength) errors.push(`${at} must be at most ${current.maxLength} characters`)
    if (current.pattern && !new RegExp(current.pattern).test(input)) errors.push(`${at} does not match ${current.pattern}`)
    if (current.format && !validFormat(input, current.format)) errors.push(`${at} must be a valid ${current.format}`)
  }
  if (typeof input === "number") {
    if (current.minimum !== undefined && input < current.minimum) errors.push(`${at} must be at least ${current.minimum}`)
    if (current.maximum !== undefined && input > current.maximum) errors.push(`${at} must be at most ${current.maximum}`)
    if (typeof current.exclusiveMinimum === "number" && input <= current.exclusiveMinimum) errors.push(`${at} must be greater than ${current.exclusiveMinimum}`)
    if (current.exclusiveMinimum === true && current.minimum !== undefined && input <= current.minimum) errors.push(`${at} must be greater than ${current.minimum}`)
    if (typeof current.exclusiveMaximum === "number" && input >= current.exclusiveMaximum) errors.push(`${at} must be less than ${current.exclusiveMaximum}`)
    if (current.exclusiveMaximum === true && current.maximum !== undefined && input >= current.maximum) errors.push(`${at} must be less than ${current.maximum}`)
    if (current.multipleOf !== undefined && input % current.multipleOf !== 0) errors.push(`${at} must be a multiple of ${current.multipleOf}`)
  }
  if (Array.isArray(input)) {
    if (current.minItems !== undefined && input.length < current.minItems) errors.push(`${at} must contain at least ${current.minItems} items`)
    if (current.maxItems !== undefined && input.length > current.maxItems) errors.push(`${at} must contain at most ${current.maxItems} items`)
    if (current.uniqueItems && new Set(input.map((item) => JSON.stringify(item))).size !== input.length) errors.push(`${at} must contain unique items`)
    if (current.items) errors.push(...input.flatMap((item, index) => validate(item, current.items, catalog, `${at}[${index}]`)))
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    if (current.minProperties !== undefined && Object.keys(input).length < current.minProperties) errors.push(`${at} must contain at least ${current.minProperties} properties`)
    if (current.maxProperties !== undefined && Object.keys(input).length > current.maxProperties) errors.push(`${at} must contain at most ${current.maxProperties} properties`)
  }
  if (input && typeof input === "object" && !Array.isArray(input) && current.properties) {
    for (const name of current.required ?? []) {
      if (!(name in input)) errors.push(`${at}.${name} is required`)
    }
    for (const [name, value] of Object.entries(input)) {
      const property = current.properties[name]
      if (property) errors.push(...validate(value, property, catalog, `${at}.${name}`))
      else if (current.additionalProperties === false) errors.push(`${at}.${name} is not allowed`)
      else if (current.additionalProperties && typeof current.additionalProperties === "object") {
        errors.push(...validate(value, current.additionalProperties, catalog, `${at}.${name}`))
      }
    }
  }
  return [...new Set(errors)]
}

export function requiredFields(input: Schema | undefined, catalog: Catalog): string[] {
  if (!input) return []
  const current = resolved(input, catalog)
  return Object.keys(current.properties ?? {}).map((name) => `${current.required?.includes(name) ? "required" : "optional"} ${name}: ${typeName(current.properties?.[name], catalog)}`)
}

function validFormat(input: string, format: string) {
  if (format === "date-time") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(input) && Number.isFinite(Date.parse(input))
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(input) && Number.isFinite(Date.parse(input))
  if (format === "time") return /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(input)
  if (format === "uuid") return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)
  if (format === "ipv4") return isIP(input) === 4
  if (format === "ipv6") return isIP(input) === 6
  if (format === "uri" || format === "url") {
    try {
      new URL(input)
      return true
    } catch {
      return false
    }
  }
  return true
}

function simpleProperties(input: Schema, catalog: Catalog) {
  const current = resolved(input, catalog)
  const alternatives = [...(current.oneOf ?? []), ...(current.anyOf ?? [])]
  if (alternatives.filter((schema) => resolved(schema, catalog).type !== "null").length > 1) return undefined
  const properties = current.properties
  if (!properties) return undefined
  return Object.fromEntries(
    Object.entries(properties).filter(([, schema]) => {
      const item = resolved(schema, catalog)
      return !item.properties && (!item.items || isPrimitive(resolved(item.items, catalog))) && !item.oneOf?.length
    }),
  )
}

function isPrimitive(schema: Schema) {
  return ["string", "number", "integer", "boolean"].includes(Array.isArray(schema.type) ? schema.type[0] : schema.type ?? "")
}

function cliName(name: string) {
  return name
    .replace(/\[([^\]]+)\]/g, "-$1")
    .replace(/\]/g, "")
    .replace(/\[/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()
}

export function argKey(name: string) {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function upperFirst(name: string) {
  return name[0].toUpperCase() + name.slice(1)
}
