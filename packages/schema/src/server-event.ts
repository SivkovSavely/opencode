export * as ServerEvent from "./server-event"

import { Schema } from "effect"
import { Event } from "./event"

export const Connected = Event.define({ type: "server.connected", schema: {} })
export const Disposed = Event.define({ type: "global.disposed", schema: {} })
export const ProjectsUpdated = Event.define({
  type: "server.projects.updated",
  schema: { projects: Schema.Array(Schema.String) },
})

export const Definitions = Event.inventory(Connected, Disposed, ProjectsUpdated)
