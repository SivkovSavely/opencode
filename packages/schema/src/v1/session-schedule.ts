export * as SessionScheduleV1 from "./session-schedule"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "../schema"
import { SessionID } from "../session-id"

export const Spec = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("interval"),
    amount: PositiveInt,
    unit: Schema.Literals(["minutes", "hours", "days", "weeks"]),
    immediate: Schema.Boolean,
  }),
  Schema.Struct({
    mode: Schema.Literal("calendar"),
    rule: Schema.Literals(["daily", "weekly", "monthly", "last-day"]),
    time: Schema.String,
    weekdays: optional(Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })))),
    day: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 }))),
    timeZone: Schema.String,
  }),
  Schema.Struct({ mode: Schema.Literal("cron"), expression: Schema.String, timeZone: Schema.String }),
]).annotate({ identifier: "SessionScheduleV1.Spec", discriminator: "mode" })
export type Spec = typeof Spec.Type

export const Input = Schema.Struct({
  message: Schema.String,
  spec: Spec,
  sessionState: Schema.Literals(["always", "busy", "idle"]),
  deferUntilIdle: Schema.Boolean,
  missed: Schema.Literals(["latest", "all", "none"]),
  limit: optional(PositiveInt),
}).annotate({ identifier: "SessionScheduleV1.Input" })
export interface Input extends Schema.Schema.Type<typeof Input> {}

export const Info = Schema.Struct({
  ...Input.fields,
  id: Schema.String,
  sessionID: SessionID,
  created: NonNegativeInt,
  anchor: NonNegativeInt,
  status: Schema.Literals(["active", "paused", "completed"]),
  completed: NonNegativeInt,
  next: optional(NonNegativeInt),
  summary: Schema.String,
}).annotate({ identifier: "SessionScheduleV1.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Occurrence = Schema.Struct({
  id: Schema.String,
  scheduleID: Schema.String,
  scheduled: NonNegativeInt,
  processed: optional(NonNegativeInt),
  state: Schema.Literals([
    "pending",
    "deferred",
    "accepted",
    "delivered",
    "skipped_busy",
    "skipped_idle",
    "discarded",
    "failed",
    "uncertain",
  ]),
  messageID: optional(Schema.String),
  error: optional(Schema.String),
}).annotate({ identifier: "SessionScheduleV1.Occurrence" })
export interface Occurrence extends Schema.Schema.Type<typeof Occurrence> {}

export const History = Schema.Struct({ items: Schema.Array(Occurrence), cursor: optional(NonNegativeInt) }).annotate({
  identifier: "SessionScheduleV1.History",
})
export interface History extends Schema.Schema.Type<typeof History> {}

export const Preview = Schema.Struct({ times: Schema.Array(NonNegativeInt), summary: Schema.String }).annotate({
  identifier: "SessionScheduleV1.Preview",
})
export interface Preview extends Schema.Schema.Type<typeof Preview> {}
