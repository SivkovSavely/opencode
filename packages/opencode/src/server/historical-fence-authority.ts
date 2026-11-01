export * as HistoricalFenceAuthority from "./historical-fence-authority"

import { HistoricalFence } from "@opencode-ai/core/historical-fence"
import { createHash, createPublicKey, verify } from "node:crypto"
import { Effect } from "effect"

export type Binding = { databaseID: string; projectID: string; directory: string; workspaceID: string | null }

/** The key comes from operator configuration, never from the request. */
export const authorize = Effect.fn("HistoricalFenceAuthority.authorize")(function* (
  input: HistoricalFence.Attestation,
  signature: string,
  binding: Binding,
  publicKey: string | undefined,
) {
  if (!publicKey) return yield* new HistoricalFence.Rejected({ reason: "maintenance_disabled" })
  const signer = yield* Effect.try({
    try: () => {
      const key = createPublicKey(publicKey)
      if (
        key.asymmetricKeyType !== "ed25519" ||
        !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
        !verify(null, Buffer.from(HistoricalFence.canonical(input), "utf8"), key, Buffer.from(signature, "base64"))
      )
        return undefined
      return createHash("sha256")
        .update(key.export({ type: "spki", format: "der" }))
        .digest("hex")
    },
    catch: () => new HistoricalFence.Rejected({ reason: "invalid_signature" }),
  })
  if (!signer) return yield* new HistoricalFence.Rejected({ reason: "invalid_signature" })
  if (
    input.databaseID !== binding.databaseID ||
    input.projectID !== binding.projectID ||
    input.directory !== binding.directory ||
    input.workspaceID !== binding.workspaceID
  )
    return yield* new HistoricalFence.Rejected({ reason: "wrong_binding" })
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0 || input.issuedAt > Date.now())
    return yield* new HistoricalFence.Rejected({ reason: "invalid_issued_at" })
  if (
    !input.issuer.trim() ||
    !input.nonce.trim() ||
    !input.artifact.reference.trim() ||
    !/^[a-f0-9]{64}$/.test(input.artifact.sha256) ||
    input.members.length === 0 ||
    input.members.length > 1000
  )
    return yield* new HistoricalFence.Rejected({ reason: "invalid_evidence" })
  const members = new Map(input.members.map((member) => [member.sessionID, member]))
  const root = members.get(input.rootSessionID)
  if (
    !root ||
    root.role !== "root" ||
    root.parentSessionID !== null ||
    members.size !== input.members.length ||
    input.members.some(
      (member, index) =>
        !member.sessionID.trim() ||
        (index > 0 && input.members[index - 1].sessionID >= member.sessionID) ||
        (member.sessionID !== input.rootSessionID && member.role !== "descendant"),
    )
  )
    return yield* new HistoricalFence.Rejected({ reason: "invalid_membership" })
  for (const member of input.members) {
    if (member.sessionID === input.rootSessionID) continue
    const seen = new Set([member.sessionID])
    let parent = member.parentSessionID
    while (parent !== input.rootSessionID) {
      if (parent === null || seen.has(parent) || !members.has(parent))
        return yield* new HistoricalFence.Rejected({ reason: "invalid_membership" })
      seen.add(parent)
      parent = members.get(parent)?.parentSessionID ?? null
    }
  }
  return signer
})
