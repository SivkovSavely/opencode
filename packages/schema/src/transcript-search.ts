export * as TranscriptSearch from "./transcript-search.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

const bounded = Schema.String.check(Schema.isMaxLength(256))
const values = Schema.Array(bounded).check(Schema.isMaxLength(100))
export const Role = Schema.Literals(["user", "assistant"])
export const Category = Schema.Literals(["text", "file", "tool-input", "tool-output", "tool-error", "assistant-error"])
export const Sort = Schema.Literals(["newest", "oldest", "session-title"])
export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  query: bounded.check(Schema.isMinLength(1)),
  mode: Schema.Literals(["literal", "regex"]).pipe(optional),
  flags: bounded.pipe(optional),
  caseSensitive: Schema.Boolean.pipe(optional),
  cursor: Schema.String.check(Schema.isMaxLength(4096)).pipe(optional),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(optional),
  projectIDs: values.pipe(optional),
  sessionIDs: values.pipe(optional),
  roles: Schema.Array(Role).check(Schema.isMaxLength(100)).pipe(optional),
  categories: Schema.Array(Category).check(Schema.isMaxLength(100)).pipe(optional),
  content: Schema.Array(Schema.Struct({ role: Role, category: Category }))
    .check(Schema.isMaxLength(100))
    .pipe(optional),
  agents: values.pipe(optional),
  providerIDs: values.pipe(optional),
  models: Schema.Array(Schema.Struct({ providerID: bounded, modelID: bounded }))
    .check(Schema.isMaxLength(100))
    .pipe(optional),
  toolNames: values.pipe(optional),
  toolStatuses: Schema.Array(Schema.Literals(["running", "completed", "error", "interrupted"]))
    .check(Schema.isMaxLength(100))
    .pipe(optional),
  dateFrom: Schema.Finite.pipe(optional),
  dateTo: Schema.Finite.pipe(optional),
  sessionKind: Schema.Literals(["all", "root", "subagent"]).pipe(optional),
  archived: Schema.Literals(["all", "active", "archived"]).pipe(optional),
  sort: Sort.pipe(optional),
}).annotate({ identifier: "TranscriptSearch.Request" })

export interface Hit extends Schema.Schema.Type<typeof Hit> {}
export const Hit = Schema.Struct({
  documentID: Schema.String,
  messageID: Schema.String,
  partID: Schema.String.pipe(optional),
  sessionID: Schema.String,
  projectID: Schema.String,
  projectPath: Schema.String,
  directory: Schema.String,
  title: Schema.String,
  role: Role,
  category: Category,
  agent: Schema.String.pipe(optional),
  providerID: Schema.String.pipe(optional),
  modelID: Schema.String.pipe(optional),
  toolName: Schema.String.pipe(optional),
  toolStatus: Schema.String.pipe(optional),
  parentID: Schema.String.pipe(optional),
  archived: Schema.Boolean,
  timeCreated: Schema.Finite,
  excerpt: Schema.String,
  excerptOffset: Schema.Finite,
  offset: Schema.Finite,
  matchLength: Schema.Finite,
  truncated: Schema.Boolean,
}).annotate({ identifier: "TranscriptSearch.Hit" })

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  ready: Schema.Boolean,
  backfillCursor: Schema.String,
  generation: Schema.String,
}).annotate({ identifier: "TranscriptSearch.Status" })

export interface Response extends Schema.Schema.Type<typeof Response> {}
export const Response = Schema.Struct({
  hits: Schema.Array(Hit),
  nextCursor: Schema.String.pipe(optional),
  scanned: Schema.Finite,
  complete: Schema.Boolean,
  scanLimit: Schema.Finite,
  contentLimit: Schema.Finite,
  scanLimited: Schema.Boolean,
  truncatedDocuments: Schema.Finite,
  status: Status,
}).annotate({ identifier: "TranscriptSearch.Response" })

const detail = Schema.Struct({ value: Schema.String, lastUsed: Schema.Finite })
export interface Backfill extends Schema.Schema.Type<typeof Backfill> {}
export const Backfill = Schema.Struct({ rebuild: Schema.Boolean.pipe(optional) }).annotate({
  identifier: "TranscriptSearch.Backfill",
})
export interface Facets extends Schema.Schema.Type<typeof Facets> {}
export const Facets = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String, lastUsed: Schema.Finite })),
  agents: Schema.Array(detail),
  providers: Schema.Array(detail),
  models: Schema.Array(Schema.Struct({ providerID: Schema.String, modelID: Schema.String, lastUsed: Schema.Finite })),
  tools: Schema.Array(detail),
  truncated: Schema.Boolean,
}).annotate({ identifier: "TranscriptSearch.Facets" })
