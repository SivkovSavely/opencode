import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { generateKeyPairSync, sign } from "node:crypto"
import { HistoricalFence } from "@opencode-ai/core/historical-fence"
import { HistoricalFenceAuthority } from "../../src/server/historical-fence-authority"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("historical ownership authority", () => {
  it.live("requires the configured Ed25519 signer and exact database/workspace evidence binding", () =>
    Effect.gen(function* () {
      const keys = generateKeyPairSync("ed25519")
      const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
      const binding = {
        databaseID: "database",
        projectID: "project",
        directory: "/canonical/worktree",
        workspaceID: null,
      }
      const input: HistoricalFence.Attestation = {
        ...binding,
        version: 1,
        rootSessionID: "root",
        members: [
          { sessionID: "child", parentSessionID: "root", role: "descendant" },
          { sessionID: "root", parentSessionID: null, role: "root" },
        ],
        membershipCoverage: "attested-partial",
        artifact: { reference: "archive:verified-receipt", sha256: "a".repeat(64) },
        issuer: "operator",
        issuedAt: Date.now(),
        nonce: "unique-nonce",
      }
      const signature = sign(null, Buffer.from(HistoricalFence.canonical(input)), keys.privateKey).toString("base64")
      expect(yield* HistoricalFenceAuthority.authorize(input, signature, binding, publicKey)).toMatch(/^[a-f0-9]{64}$/)
      expect(
        yield* HistoricalFenceAuthority.authorize(input, signature, binding, undefined).pipe(Effect.flip),
      ).toMatchObject({ reason: "maintenance_disabled" })
      expect(
        yield* HistoricalFenceAuthority.authorize(
          input,
          signature,
          { ...binding, databaseID: "another-db" },
          publicKey,
        ).pipe(Effect.flip),
      ).toMatchObject({ reason: "wrong_binding" })
      expect(
        yield* HistoricalFenceAuthority.authorize(
          input,
          signature,
          { ...binding, workspaceID: "another-workspace" },
          publicKey,
        ).pipe(Effect.flip),
      ).toMatchObject({ reason: "wrong_binding" })
      expect(
        yield* HistoricalFenceAuthority.authorize({ ...input, issuer: "forged" }, signature, binding, publicKey).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "invalid_signature" })
      const untrusted = generateKeyPairSync("ed25519")
      const forged = sign(null, Buffer.from(HistoricalFence.canonical(input)), untrusted.privateKey).toString("base64")
      expect(
        yield* HistoricalFenceAuthority.authorize(input, forged, binding, publicKey).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid_signature" })
      for (const invalid of [
        { ...input, issuedAt: Date.now() + 60_000 },
        { ...input, members: [...input.members, input.members[0]] },
        { ...input, members: [{ ...input.members[0], parentSessionID: null }, input.members[1]] },
        { ...input, members: [{ ...input.members[0], parentSessionID: "child" }, input.members[1]] },
        { ...input, members: [{ ...input.members[0], parentSessionID: "unrelated-root" }, input.members[1]] },
        { ...input, members: [{ sessionID: "root", parentSessionID: "root", role: "root" as const }] },
        { ...input, members: [{ sessionID: "root", parentSessionID: null, role: "descendant" as const }] },
        { ...input, artifact: { reference: "", sha256: "raw-id-is-not-evidence" } },
      ]) {
        const signed = sign(null, Buffer.from(HistoricalFence.canonical(invalid)), keys.privateKey).toString("base64")
        expect(
          yield* HistoricalFenceAuthority.authorize(invalid, signed, binding, publicKey).pipe(Effect.flip),
        ).toBeInstanceOf(HistoricalFence.Rejected)
      }
      const rootOnly = { ...input, members: [input.members[1]] }
      expect(
        yield* HistoricalFenceAuthority.authorize(
          rootOnly,
          sign(null, Buffer.from(HistoricalFence.canonical(rootOnly)), keys.privateKey).toString("base64"),
          binding,
          publicKey,
        ),
      ).toMatch(/^[a-f0-9]{64}$/)
    }),
  )
})
