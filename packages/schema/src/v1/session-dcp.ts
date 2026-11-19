export * as SessionDcpV1 from "./session-dcp"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "../schema"
import { SessionID } from "../session-id"

export const Block = Schema.Struct({
  blockId: PositiveInt,
  status: Schema.Literals(["active", "pruned", "nested", "superseded", "user-decompressed", "inactive", "unknown"]),
  active: optional(Schema.Boolean),
  summaryPruned: optional(Schema.Boolean),
  topic: optional(Schema.String),
  batchTopic: optional(Schema.String),
  summary: optional(Schema.String),
  mode: optional(Schema.String),
  runId: optional(PositiveInt),
  startId: optional(Schema.String),
  endId: optional(Schema.String),
  createdAt: optional(NonNegativeInt),
  deactivatedAt: optional(NonNegativeInt),
  deactivatedByBlockId: optional(PositiveInt),
  includedBlockIds: optional(Schema.Array(PositiveInt)),
  consumedBlockIds: optional(Schema.Array(PositiveInt)),
  parentBlockIds: optional(Schema.Array(PositiveInt)),
  directMessageCount: optional(NonNegativeInt),
  directToolCount: optional(NonNegativeInt),
  effectiveMessageCount: optional(NonNegativeInt),
  effectiveToolCount: optional(NonNegativeInt),
  compressedTokens: optional(NonNegativeInt),
  summaryTokens: optional(NonNegativeInt),
  durationMs: optional(NonNegativeInt),
}).annotate({ identifier: "SessionDcpV1.Block" })
export interface Block extends Schema.Schema.Type<typeof Block> {}

export const Operation = Schema.Struct({
  id: PositiveInt,
  type: Schema.String,
  timestamp: optional(NonNegativeInt),
  topic: optional(Schema.String),
  blockIds: optional(Schema.Array(PositiveInt)),
  consumedBlockIds: optional(Schema.Array(PositiveInt)),
  newlyCoveredMessages: optional(NonNegativeInt),
  existingBlocks: optional(NonNegativeInt),
  savings: optional(
    Schema.Struct({
      before: optional(NonNegativeInt),
      after: optional(NonNegativeInt),
      saved: optional(Schema.Int),
      reductionPercent: optional(Schema.Finite),
    }),
  ),
}).annotate({ identifier: "SessionDcpV1.Operation" })
export interface Operation extends Schema.Schema.Type<typeof Operation> {}

export const Info = Schema.Struct({
  sessionID: SessionID,
  state: Schema.Literal("available"),
  lastUpdated: optional(Schema.String),
  blocks: Schema.Array(Block),
  stats: Schema.Struct({
    activeSummaryTokens: optional(NonNegativeInt),
    historicalRemovedTokens: optional(NonNegativeInt),
    prunedToolCount: optional(NonNegativeInt),
    prunedMessageCount: optional(NonNegativeInt),
  }),
  operations: optional(Schema.Array(Operation)),
}).annotate({ identifier: "SessionDcpV1.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Snapshot = Schema.Union([
  Info,
  Schema.Struct({
    sessionID: SessionID,
    state: Schema.Literals(["absent", "invalid", "too-large", "unavailable"]),
  }),
]).annotate({ identifier: "SessionDcpV1.Snapshot", discriminator: "state" })
export type Snapshot = typeof Snapshot.Type
