import { Schema } from "effect"
import { optional } from "../schema"

export const Event = Schema.Literals(["completed", "failed", "cancelled", "idle"])
export type Event = typeof Event.Type
export const Mode = Schema.Literals(["once", "persistent"])
export const Delivery = Schema.Literals(["auto", "record"])
export const Status = Schema.Literals(["active", "resolved", "cancelled", "exhausted", "invalidated"])

export const Create = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  owner: Schema.String,
  source: Schema.String,
  destination: Schema.String,
  events: Schema.Array(Event).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  mode: Mode,
  delivery: Delivery,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 128 })),
  agent: optional(Schema.String),
})
export interface Create extends Schema.Schema.Type<typeof Create> {}

export const Scope = Schema.Struct({
  sessionID: Schema.String,
  projectID: Schema.String,
  directory: Schema.String,
  workspaceID: optional(Schema.String),
})
export interface Scope extends Schema.Schema.Type<typeof Scope> {}

export * as SessionWatchV1 from "./session-watch"
