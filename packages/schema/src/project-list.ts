export * as ProjectList from "./project-list.js"

import { Schema } from "effect"
import { Event } from "./event.js"
import { NonNegativeInt } from "./schema.js"

export const Snapshot = Schema.Struct({
  projects: Schema.Array(Schema.String),
  revision: NonNegativeInt.annotate({
    description:
      "Persisted server-list revision. Increments only when membership or order changes; compare across HTTP responses and events, not their arrival order.",
  }),
}).annotate({
  identifier: "ProjectList.Snapshot",
})
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export const Operation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("merge"), projects: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("add"), directory: Schema.String }),
  Schema.Struct({ type: Schema.Literal("remove"), directory: Schema.String }),
  Schema.Struct({ type: Schema.Literal("move"), directory: Schema.String, toIndex: Schema.Int }),
]).annotate({ identifier: "ProjectList.Operation" })
export type Operation = Schema.Schema.Type<typeof Operation>

const Updated = Event.ephemeral({ type: "server.projects.updated", schema: Snapshot.fields })
export const Events = { Updated, Definitions: Event.inventory(Updated) }
