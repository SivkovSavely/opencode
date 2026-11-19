import type {
  SessionHandoffV1ControlReceipt,
  SessionHandoffV1ExecutionView,
  SessionHandoffV1Identity,
  SessionHandoffV1Selection,
} from "../src/v2/gen/types.gen"

declare const identity: SessionHandoffV1Identity
declare const selection: SessionHandoffV1Selection
declare const control: SessionHandoffV1ControlReceipt
export const typedIdentity: {
  queueID: string
  userMessageID: string
  ownerLineage: string
  ownerInstance: string
  fence: number
  revision: number
  contextDigest: string
} = identity
export const typedSelection: { providerID: string; modelID: string; variant: string } = selection
export const typedTimestamp: number = control.createdAt
export const typedRecoveryFence: number | null = control.recoveryFence

export const execution = {
  sessionID: "ses_test",
  directory: "/tmp/test",
  enrolled: false,
  identity: null,
  state: "not_enrolled",
  ownerLiveness: "unknown",
  recoveryRevision: null,
  effectiveSelection: null,
  baselineSelection: null,
  pendingRequestID: null,
  boundaries: [],
  assistants: [],
  summaries: [],
  interruptedResources: [],
  eligibility: "not_enrolled",
  descendants: [],
  descendantDigest: null,
  candidate: null,
  taskNotifications: [],
  viewKind: "current",
  isCurrent: true,
} satisfies SessionHandoffV1ExecutionView
export const receipt = {
  kind: "model_control",
  requestID: "control_test",
  sessionID: execution.sessionID,
  directory: execution.directory,
  expected: {
    queueID: "queue_test",
    userMessageID: "msg_test",
    ownerLineage: "lineage_test",
    ownerInstance: "instance_test",
    fence: 1,
    revision: 1,
    contextDigest: "digest_test",
  },
  target: { providerID: "test", modelID: "test", variant: "default" },
  state: "expired",
  reason: null,
  boundary: null,
  dispatch: "none",
  recoveryFence: null,
  interruptedResources: [],
  children: [],
  createdAt: 0,
  updatedAt: 0,
} satisfies SessionHandoffV1ControlReceipt
