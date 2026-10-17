export * as SessionQueueV1 from "./session-queue"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { NonNegativeInt, optional } from "../schema"
import { SessionID } from "../session-id"
import { SessionV1 } from "./session"

const common = {
  agent: Schema.String,
  model: Schema.Struct({ providerID: Schema.String, modelID: Schema.String }),
  variant: optional(Schema.String),
}

export const Payload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("prompt"),
    ...common,
    parts: Schema.Array(
      Schema.Union([
        SessionV1.TextPartInput,
        SessionV1.FilePartInput,
        SessionV1.AgentPartInput,
        SessionV1.SubtaskPartInput,
      ]),
    ),
    system: optional(Schema.String),
    format: optional(SessionV1.Format),
    tools: optional(Schema.Record(Schema.String, Schema.Boolean)),
  }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    ...common,
    command: Schema.String,
    arguments: Schema.String,
    parts: optional(Schema.Array(SessionV1.FilePartInput)),
  }),
  Schema.Struct({ kind: Schema.Literal("shell"), ...common, command: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("compact"), ...common }),
]).annotate({ identifier: "SessionQueueV1.Payload", discriminator: "kind" })
export type Payload = typeof Payload.Type

export const Delivery = Schema.Literals(["queue", "steer"]).annotate({ identifier: "SessionQueueV1.Delivery" })
export type Delivery = typeof Delivery.Type

export const State = Schema.Literals(["pending", "claimed", "delivered", "deleted", "uncertain"]).annotate({
  identifier: "SessionQueueV1.State",
})
export type State = typeof State.Type

export const Entry = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  delivery: Delivery,
  state: State,
  position: Schema.Int,
  payload: Payload,
  messageID: optional(SessionV1.MessageID),
  created: NonNegativeInt,
}).annotate({ identifier: "SessionQueueV1.Entry" })
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

export const Snapshot = Schema.Struct({
  sessionID: SessionID,
  revision: NonNegativeInt,
  paused: Schema.Boolean,
  blocked: Schema.Boolean,
  items: Schema.Array(Entry),
}).annotate({ identifier: "SessionQueueV1.Snapshot" })
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export const Submit = Schema.Struct({
  id: Schema.String,
  payload: Payload,
  front: optional(Schema.Boolean),
}).annotate({ identifier: "SessionQueueV1.Submit" })
export interface Submit extends Schema.Schema.Type<typeof Submit> {}

export const Mutation = Schema.Union([
  Schema.Struct({ action: Schema.Literal("pause"), paused: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("clear") }),
  Schema.Struct({ action: Schema.Literal("delete"), id: Schema.String }),
  Schema.Struct({ action: Schema.Literal("convert"), id: Schema.String, delivery: Delivery }),
  Schema.Struct({ action: Schema.Literal("reorder"), delivery: Delivery, ids: Schema.Array(Schema.String) }),
]).annotate({ identifier: "SessionQueueV1.Mutation", discriminator: "action" })
export type Mutation = typeof Mutation.Type

export const Update = Schema.Struct({ revision: NonNegativeInt, mutation: Mutation }).annotate({
  identifier: "SessionQueueV1.Update",
})
export interface Update extends Schema.Schema.Type<typeof Update> {}

const Changed = define({
  type: "session.queue.changed",
  schema: { sessionID: SessionID, revision: NonNegativeInt },
})
export const Event = { Changed, Definitions: inventory(Changed) }
