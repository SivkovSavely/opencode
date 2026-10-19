export type Schema = {
  $ref?: string
  type?: string | string[]
  description?: string
  title?: string
  enum?: unknown[]
  const?: unknown
  anyOf?: Schema[]
  oneOf?: Schema[]
  allOf?: Schema[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: Schema | boolean
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number | boolean
  exclusiveMaximum?: number | boolean
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  minProperties?: number
  maxProperties?: number
  multipleOf?: number
  uniqueItems?: boolean
  pattern?: string
  format?: string
  default?: unknown
}

export type Parameter = {
  name: string
  in: string
  required?: boolean
  description?: string
  schema?: Schema
  style?: string
  explode?: boolean
}

export type Operation = {
  command: string[]
  method: string
  path: string
  operationId: string
  summary?: string
  description?: string
  transport: "http" | "sse" | "websocket"
  parameters: Parameter[]
  requestBody?: {
    required?: boolean
    description?: string
    content?: Record<string, { schema?: Schema }>
  }
}

export type Catalog = {
  spec?: Record<string, unknown>
  components: { schemas: Record<string, Schema> }
  operations: Operation[]
}
