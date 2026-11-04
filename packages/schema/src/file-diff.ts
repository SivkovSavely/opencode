export * as FileDiff from "./file-diff"

import { Schema } from "effect"
import { optional } from "./schema"

export const Info = Schema.Struct({
  file: optional(Schema.String),
  patch: optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: optional(Schema.Literals(["added", "deleted", "modified"])),
  // Without a file this is an aggregate of omitted changes, not a synthetic path.
  // An absent count means the total file count is unknown. Large files may also have uncounted lines.
  omitted: optional(
    Schema.Struct({
      reason: Schema.String,
      files: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      statisticsIncomplete: optional(Schema.Boolean),
    }),
  ),
}).annotate({ identifier: "SnapshotFileDiff" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
