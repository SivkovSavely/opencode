import { Schema } from "effect"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "prompt", "steer", "status", "read", "cancel"]),
  sessionID: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  agent: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  variant: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  prompt: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000))),
  start: Schema.optional(Schema.Boolean),
  requestID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  before: Schema.optional(Schema.String.check(Schema.isMaxLength(160))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
})

export * as SessionControlV1 from "./session-control"
