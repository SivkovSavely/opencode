import { Schema } from "effect"
import { optional } from "./schema"
import { statics } from "./schema"
import { Model } from "./model"

export interface Selection extends Schema.Schema.Type<typeof Selection> {}
export const Selection = Schema.Struct({
  inheritActive: Schema.Boolean.pipe(optional),
  model: Schema.Struct({ providerID: Model.Ref.fields.providerID, modelID: Model.Ref.fields.id }).pipe(optional),
  variant: Model.Ref.fields.variant,
}).annotate({ identifier: "Prompt.Selection" })

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}).annotate({ identifier: "Prompt.Source" })

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "Prompt.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) =>
        schema.make({
          uri: input.uri,
          mime: input.mime,
          name: input.name,
          description: input.description,
          source: input.source,
        }),
    })),
  )

export interface AgentAttachment extends Schema.Schema.Type<typeof AgentAttachment> {}
export const AgentAttachment = Schema.Struct({
  name: Schema.String,
  source: Source.pipe(optional),
}).annotate({ identifier: "Prompt.AgentAttachment" })

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  agent: Schema.String.pipe(optional),
  model: Model.Ref.pipe(optional),
  requestedModel: Model.Ref.pipe(optional),
  selection: Selection.pipe(optional),
})
  .annotate({ identifier: "Prompt" })
  .pipe(
    statics((schema) => ({
      equivalence: Schema.toEquivalence(schema),
      fromUserMessage: (input: Prompt) =>
        schema.make({
          text: input.text,
          ...(input.files === undefined ? {} : { files: input.files }),
          ...(input.agents === undefined ? {} : { agents: input.agents }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.requestedModel === undefined ? {} : { requestedModel: input.requestedModel }),
          ...(input.selection === undefined ? {} : { selection: input.selection }),
        }),
    })),
  )
