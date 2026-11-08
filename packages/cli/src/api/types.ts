export type JsonSchema = {
  $ref?: string
  type?: string | string[]
  description?: string
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  not?: JsonSchema
  if?: JsonSchema
  then?: JsonSchema
  else?: JsonSchema
  properties?: Record<string, JsonSchema>
  patternProperties?: Record<string, JsonSchema>
  propertyNames?: JsonSchema
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  prefixItems?: JsonSchema[]
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  minProperties?: number
  maxProperties?: number
  uniqueItems?: boolean
  pattern?: string
  format?: string
}

export type Parameter = {
  name: string
  in: string
  required?: boolean
  description?: string
  schema?: JsonSchema
  style?: string
  explode?: boolean
}

export type Operation = {
  operationId: string
  command: string[]
  method: string
  path: string
  summary?: string
  description?: string
  transport: "http" | "sse" | "websocket"
  unsupported?: string
  parameters: Parameter[]
  requestBody?: { required?: boolean; content: Record<string, { schema?: JsonSchema }> }
}

export type Catalog = {
  components: { schemas: Record<string, JsonSchema> }
  operations: Operation[]
}

export type ApiDocument = {
  components?: Catalog["components"]
  paths: Record<string, Record<string, unknown>>
}
