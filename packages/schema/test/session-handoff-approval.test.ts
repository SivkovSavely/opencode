import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionHandoffV1 } from "../src/v1/session-handoff"

const request = {
  requestID: "request",
  expected: {
    queueID: "queue",
    userMessageID: "user",
    ownerLineage: "lineage",
    ownerInstance: "instance",
    fence: 1,
    revision: 2,
    contextDigest: "context",
  },
  expectedRecoveryRevision: 3,
  target: { providerID: "provider", modelID: "model", variant: "default" },
  expectedDescendantDigest: "descendants",
  children: [],
}
const approval = {
  version: 1,
  expected: request.expected,
  expectedRecoveryRevision: 3,
  expectedDescendantDigest: "descendants",
  resources: [],
}

test("recovery approval reference is optional and validates its digest", () => {
  expect(Schema.decodeUnknownOption(SessionHandoffV1.RecoveryRequest)(request)._tag).toBe("Some")
  expect(
    Schema.decodeUnknownOption(SessionHandoffV1.RecoveryRequest)({
      ...request,
      operatorAttestation: true,
    })._tag,
  ).toBe("None")
  expect(
    Schema.decodeUnknownOption(SessionHandoffV1.RecoveryRequest)({
      ...request,
      legacyResourceApproval: { path: "/tmp/approval.json", sha256: "a".repeat(64), content: approval },
    })._tag,
  ).toBe("Some")
  expect(
    Schema.decodeUnknownOption(SessionHandoffV1.RecoveryRequest)({
      ...request,
      legacyResourceApproval: { path: "relative.json", sha256: "bad", content: approval },
    })._tag,
  ).toBe("None")
})

test("approval unit names must be safe user-scope units", () => {
  const entry = {
    sessionID: "session",
    assistantMessageID: "assistant",
    partID: "part",
    resourceRef: "/private/tool-output",
    callID: "call",
    tool: "bash",
    commandSHA256: "a".repeat(64),
    unit: "job.scope",
    invocationID: "0123456789abcdef0123456789abcdef",
    host: "host",
    bootID: "boot",
    unitStarted: true,
    unitClosed: true,
    workConfinedToUnit: true,
    residualWrapperReadOnlyGit: true,
    historicalSourceUnproven: true,
    pidDeathUnproven: true,
    evidenceSHA256: ["b".repeat(64)],
  } as const
  expect(Schema.decodeUnknownOption(SessionHandoffV1.LegacyResourceApprovalEntry)(entry)._tag).toBe("Some")
  expect(
    Schema.decodeUnknownOption(SessionHandoffV1.LegacyResourceApprovalEntry)({
      ...entry,
      resourceRef: "/private/tool-output",
    })._tag,
  ).toBe("Some")
  expect(
    Schema.decodeUnknownOption(SessionHandoffV1.LegacyResourceApprovalEntry)({ ...entry, unit: "--job.scope" })._tag,
  ).toBe("None")
})

test("recovery receipt reconciliation markers bind every resource identity", () => {
  const marker = {
    requestID: "request",
    recoveryRevision: 3,
    descendantDigest: "descendants",
    sessionID: "session",
    assistantMessageID: "assistant",
    partID: "part",
    callID: "call",
    tool: "bash",
    commandSHA256: "a".repeat(64),
    unit: "job.scope",
    invocationID: "invocation",
    host: "host",
    bootID: "boot",
    unitStarted: true,
    unitClosed: true,
    workConfinedToUnit: true,
    residualWrapperReadOnlyGit: true,
    historicalSourceUnproven: true,
    pidDeathUnproven: true,
    evidenceSHA256: ["b".repeat(64)],
  } as const
  const receipt = {
    kind: "recovery",
    requestID: "request",
    sessionID: "session",
    directory: "/tmp",
    expected: request.expected,
    target: request.target,
    state: "pending",
    reason: null,
    boundary: null,
    dispatch: "none",
    recoveryFence: null,
    interruptedResources: [],
    legacyResourceReconciliations: [marker],
    createdAt: 1,
    updatedAt: 1,
    children: [],
  }
  expect(Schema.decodeUnknownSync(SessionHandoffV1.ControlReceipt)(receipt).legacyResourceReconciliations).toEqual([marker])
  expect(
    Schema.decodeUnknownOption(SessionHandoffV1.ControlReceipt)({
      ...receipt,
      legacyResourceReconciliations: [{ ...marker, commandSHA256: "invalid" }],
    })._tag,
  ).toBe("None")
})
