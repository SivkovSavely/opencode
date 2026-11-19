export * as SessionHandoffV1 from "./session-handoff"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

const ID = Schema.String.check(Schema.isNonEmpty())
const nullableID = Schema.NullOr(ID)
const nullableInt = Schema.NullOr(NonNegativeInt)
const Dispatch = Schema.Literals(["none", "prepared", "started_or_unknown", "completed", "unknown"])
const Liveness = Schema.Literals(["live", "dead", "unknown"])
const ResultState = Schema.Literals(["none", "completed", "error", "uncertain"])

export const Capability = Schema.Struct({
  version: Schema.Literal("legacy-queue-prompt-handoff-recovery/4"),
  enrollment: Schema.Literal(true),
  modelControl: Schema.Literal(true),
  guardedRecovery: Schema.Literal(true),
  applicationMarker: Schema.Literal(true),
  assistantProvenance: Schema.Literal(true),
  interruptedResources: Schema.Literal(true),
  startupHold: Schema.Literal("enrolled_only"),
  ownerDeathRequired: Schema.Literal(true),
  taskDescendantRecovery: Schema.Literal(true),
  historicalExecution: Schema.Literal(true),
}).annotate({ identifier: "SessionHandoffV1.Capability" })
export interface Capability extends Schema.Schema.Type<typeof Capability> {}

export const Selection = Schema.Struct({ providerID: ID, modelID: ID, variant: ID }).annotate({
  identifier: "SessionHandoffV1.Selection",
})
export interface Selection extends Schema.Schema.Type<typeof Selection> {}
export const SummarySelection = Schema.Struct({ providerID: ID, modelID: ID, variant: nullableID }).annotate({
  identifier: "SessionHandoffV1.SummarySelection",
})
export interface SummarySelection extends Schema.Schema.Type<typeof SummarySelection> {}
export const Identity = Schema.Struct({
  queueID: ID,
  userMessageID: ID,
  ownerLineage: ID,
  ownerInstance: ID,
  fence: NonNegativeInt,
  revision: NonNegativeInt,
  contextDigest: ID,
}).annotate({ identifier: "SessionHandoffV1.Identity" })
export interface Identity extends Schema.Schema.Type<typeof Identity> {}
export const TaskLink = Schema.Struct({
  parentSessionID: ID,
  parentAssistantMessageID: ID,
  parentCallID: ID,
  childSessionID: ID,
  childUserMessageID: ID,
  mode: Schema.Literals(["foreground", "background"]),
}).annotate({ identifier: "SessionHandoffV1.TaskLink" })
export interface TaskLink extends Schema.Schema.Type<typeof TaskLink> {}
export const ChildExpectation = Schema.Struct({
  link: TaskLink,
  inputDigest: ID,
  ownerLineage: ID,
  ownerInstance: ID,
  fence: NonNegativeInt,
  recoveryRevision: NonNegativeInt,
}).annotate({ identifier: "SessionHandoffV1.ChildExpectation" })
export interface ChildExpectation extends Schema.Schema.Type<typeof ChildExpectation> {}
export const EnrollRequest = Schema.Struct({
  requestID: ID,
  queueID: ID,
  userMessageID: ID,
  ownerLineage: ID,
  ownerInstance: ID,
  fence: NonNegativeInt,
  historyDigest: ID,
}).annotate({ identifier: "SessionHandoffV1.EnrollRequest", parseOptions: { onExcessProperty: "error" } })
export interface EnrollRequest extends Schema.Schema.Type<typeof EnrollRequest> {}
export const ControlRequest = Schema.Struct({ requestID: ID, expected: Identity, target: Selection }).annotate({
  identifier: "SessionHandoffV1.ControlRequest",
  parseOptions: { onExcessProperty: "error" },
})
export interface ControlRequest extends Schema.Schema.Type<typeof ControlRequest> {}
export const RecoveryRequest = Schema.Struct({
  requestID: ID,
  expected: Identity,
  expectedRecoveryRevision: NonNegativeInt,
  target: Selection,
  expectedDescendantDigest: ID,
  children: Schema.Array(ChildExpectation),
}).annotate({ identifier: "SessionHandoffV1.RecoveryRequest", parseOptions: { onExcessProperty: "error" } })
export interface RecoveryRequest extends Schema.Schema.Type<typeof RecoveryRequest> {}
export const Boundary = Schema.Struct({
  sequence: NonNegativeInt,
  requestID: ID,
  kind: Schema.Literals(["model_control", "recovery"]),
  priorSelection: Selection,
  selection: Selection,
  afterAssistantMessageID: nullableID,
  firstOrdinaryAssistantMessageID: nullableID,
  appliedAt: NonNegativeInt,
}).annotate({ identifier: "SessionHandoffV1.Boundary" })
export interface Boundary extends Schema.Schema.Type<typeof Boundary> {}
export const AssistantProvenance = Schema.Struct({
  messageID: ID,
  parentUserMessageID: ID,
  queueID: ID,
  authorizationUserMessageID: ID,
  epochSequence: NonNegativeInt,
  controlRequestID: nullableID,
  selection: Selection,
  selectionEvidence: Schema.Literals(["persisted_message", "normalized_dispatch"]),
  dispatch: Dispatch,
}).annotate({ identifier: "SessionHandoffV1.AssistantProvenance" })
export interface AssistantProvenance extends Schema.Schema.Type<typeof AssistantProvenance> {}
export const SummaryProvenance = Schema.Struct({
  messageID: ID,
  parentUserMessageID: ID,
  queueID: ID,
  epochSequence: NonNegativeInt,
  configuredCompactionSelection: Schema.NullOr(SummarySelection),
  dispatchSelection: Schema.NullOr(SummarySelection),
  selectionEvidence: Schema.Literals(["persisted_message", "normalized_dispatch", "unknown"]),
  dispatch: Dispatch,
}).annotate({ identifier: "SessionHandoffV1.SummaryProvenance" })
export interface SummaryProvenance extends Schema.Schema.Type<typeof SummaryProvenance> {}
export const InterruptedResource = Schema.Struct({
  assistantMessageID: ID,
  partID: ID,
  callID: ID,
  tool: ID,
  resourceKind: Schema.Literals(["process", "task", "output", "other", "unknown"]),
  resourceRef: Schema.NullOr(Schema.String),
  liveness: Schema.Literals(["live", "dead", "unknown", "not_applicable"]),
  effect: Schema.Literal("uncertain"),
  evidence: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SessionHandoffV1.InterruptedResource" })
export interface InterruptedResource extends Schema.Schema.Type<typeof InterruptedResource> {}
export const ChildRecoveryStatus = Schema.Struct({
  link: TaskLink,
  priorFence: NonNegativeInt,
  recoveryFence: NonNegativeInt,
  state: Schema.Literals(["claimed", "reconciling", "continuing", "terminal", "held", "failed"]),
  resultAssistantMessageID: nullableID,
  resultState: ResultState,
  interruptedResources: Schema.Array(InterruptedResource),
}).annotate({ identifier: "SessionHandoffV1.ChildRecoveryStatus" })
export interface ChildRecoveryStatus extends Schema.Schema.Type<typeof ChildRecoveryStatus> {}
export const TaskDescendant = Schema.Struct({
  link: Schema.NullOr(TaskLink),
  childSessionID: ID,
  parentSessionID: nullableID,
  proof: Schema.Literals(["verified", "ambiguous_lineage", "ambiguous_input", "unsupported_child"]),
  state: Schema.Literals(["active", "held", "terminal", "ambiguous"]),
  selection: Schema.NullOr(Selection),
  agent: nullableID,
  inputDigest: nullableID,
  ownerLineage: nullableID,
  ownerInstance: nullableID,
  fence: nullableInt,
  recoveryRevision: nullableInt,
  ownerLiveness: Liveness,
  resultAssistantMessageID: nullableID,
  resultState: ResultState,
  interruptedResources: Schema.Array(InterruptedResource),
}).annotate({ identifier: "SessionHandoffV1.TaskDescendant" })
export interface TaskDescendant extends Schema.Schema.Type<typeof TaskDescendant> {}
export const EnrollmentCandidate = Schema.Struct({
  queueID: ID,
  userMessageID: ID,
  ownerLineage: ID,
  ownerInstance: ID,
  fence: NonNegativeInt,
  historyDigest: ID,
}).annotate({ identifier: "SessionHandoffV1.EnrollmentCandidate" })
export interface EnrollmentCandidate extends Schema.Schema.Type<typeof EnrollmentCandidate> {}
export const TaskNotification = Schema.Struct({
  messageID: ID,
  link: TaskLink,
  queueID: ID,
  authorizationUserMessageID: ID,
  classification: Schema.Literals(["in_action", "later_input"]),
  epochSequence: nullableInt,
  state: Schema.Literals(["pending", "delivered", "held"]),
}).annotate({ identifier: "SessionHandoffV1.TaskNotification" })
export interface TaskNotification extends Schema.Schema.Type<typeof TaskNotification> {}
export const EnrollmentReceipt = Schema.Struct({
  kind: Schema.Literal("enrollment"),
  requestID: ID,
  sessionID: ID,
  directory: ID,
  queueID: ID,
  userMessageID: ID,
  state: Schema.Literals(["enrolled", "expired"]),
  identity: Schema.NullOr(Identity),
  createdAt: NonNegativeInt,
}).annotate({ identifier: "SessionHandoffV1.EnrollmentReceipt" })
export interface EnrollmentReceipt extends Schema.Schema.Type<typeof EnrollmentReceipt> {}
export const ControlReceipt = Schema.Struct({
  kind: Schema.Literals(["model_control", "recovery"]),
  requestID: ID,
  sessionID: ID,
  directory: ID,
  expected: Identity,
  target: Selection,
  state: Schema.Literals(["pending", "applied", "expired", "no_effect"]),
  reason: Schema.NullOr(Schema.String),
  boundary: Schema.NullOr(Boundary),
  dispatch: Dispatch,
  recoveryFence: nullableInt,
  interruptedResources: Schema.Array(InterruptedResource),
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
  children: Schema.Array(ChildRecoveryStatus),
}).annotate({ identifier: "SessionHandoffV1.ControlReceipt" })
export interface ControlReceipt extends Schema.Schema.Type<typeof ControlReceipt> {}
export const Receipt = Schema.Union([EnrollmentReceipt, ControlReceipt]).annotate({
  identifier: "SessionHandoffV1.Receipt",
})
export type Receipt = typeof Receipt.Type
export const ErrorCode = Schema.Literals([
  "invalid_request",
  "incomplete_action_selector",
  "not_found",
  "history_unavailable",
  "request_id_conflict",
  "not_enrolled",
  "wrong_session",
  "wrong_directory",
  "wrong_queue",
  "wrong_user",
  "stale_context",
  "stale_fence",
  "owner_live",
  "owner_unknown",
  "terminal_action",
  "pending_conflict",
  "invalidated",
  "ambiguous_history",
  "ambiguous_lineage",
  "ambiguous_input",
  "unsupported_child",
  "unresolved_resource",
  "unsupported_recovery",
  "unsupported_model",
  "unsupported_variant",
  "unsupported_dispatch",
]).annotate({ identifier: "SessionHandoffV1.ErrorCode" })
export type ErrorCode = typeof ErrorCode.Type
export const Error = Schema.Struct({ code: ErrorCode, message: Schema.String }).annotate({
  identifier: "SessionHandoffV1.Error",
})
export interface Error extends Schema.Schema.Type<typeof Error> {}
export const ExecutionView = Schema.Struct({
  sessionID: ID,
  directory: ID,
  enrolled: Schema.Boolean,
  identity: Schema.NullOr(Identity),
  state: Schema.Literals(["not_enrolled", "active", "held", "terminal", "invalidated", "ambiguous"]),
  ownerLiveness: Liveness,
  recoveryRevision: nullableInt,
  effectiveSelection: Schema.NullOr(Selection),
  baselineSelection: Schema.NullOr(Selection),
  pendingRequestID: nullableID,
  boundaries: Schema.Array(Boundary),
  assistants: Schema.Array(AssistantProvenance),
  summaries: Schema.Array(SummaryProvenance),
  interruptedResources: Schema.Array(InterruptedResource),
  eligibility: Schema.Literals([
    "eligible",
    "not_enrolled",
    "terminal",
    "stale",
    "owner_live",
    "owner_unknown",
    "ambiguous_lineage",
    "ambiguous_input",
    "unsupported_child",
    "unresolved_resource",
    "ambiguous_history",
    "unsupported",
  ]),
  descendants: Schema.Array(TaskDescendant),
  descendantDigest: nullableID,
  candidate: Schema.NullOr(EnrollmentCandidate),
  taskNotifications: Schema.Array(TaskNotification),
  viewKind: Schema.Literals(["current", "historical"]),
  isCurrent: Schema.Boolean,
}).annotate({ identifier: "SessionHandoffV1.ExecutionView" })
export interface ExecutionView extends Schema.Schema.Type<typeof ExecutionView> {}
