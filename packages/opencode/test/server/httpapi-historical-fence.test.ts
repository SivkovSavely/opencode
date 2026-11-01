import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { HistoricalFence } from "@opencode-ai/core/historical-fence"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { HistoricalFenceProof } from "../../src/server/routes/instance/httpapi/groups/historical-fence"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { OpenApi } from "effect/unstable/httpapi"
import { httpApiLayerWithRuntime, requestInDirectory } from "./httpapi-layer"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const keys = generateKeyPairSync("ed25519")
const authorization = `Basic ${Buffer.from("operator:secret").toString("base64")}`
const it = testEffect(
  Layer.unwrap(
    Effect.gen(function* () {
      const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await disposeAllInstances()
          await resetDatabase()
        }),
      )
      return httpApiLayerWithRuntime(runtime).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              OPENCODE_SERVER_USERNAME: "operator",
              OPENCODE_SERVER_PASSWORD: "secret",
              OPENCODE_HISTORICAL_FENCE_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
            }),
          ),
        ),
      )
    }),
  ),
)

describe("historical fence HTTP maintenance", () => {
  it.live("recursive Session deletion retains exact known membership and denies late queue writes", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const create = (parentID?: string) =>
        requestInDirectory("/session", directory, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ parentID }),
        }).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))),
        )
      const root = yield* create()
      const child = yield* create(root.id)
      const grandchild = yield* create(child.id)
      expect(
        (yield* requestInDirectory(`/session/${root.id}`, directory, { method: "DELETE", headers: { authorization } }))
          .status,
      ).toBe(200)
      const retired = yield* requestInDirectory(`/session/${root.id}/retire`, directory, {
        method: "POST",
        headers: { authorization },
      })
      expect(retired.status).toBe(200)
      expect(yield* retired.json).toMatchObject({
        sessionIDs: [root.id, child.id, grandchild.id].sort(),
        membershipCoverage: "observed-partial",
        historicalCleanup: "unknown",
        commandStatus: "unknown",
        evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      for (const sessionID of [root.id, child.id, grandchild.id]) {
        const late = yield* requestInDirectory(`/session/${sessionID}/queue`, directory, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({
            id: randomUUID(),
            payload: {
              kind: "prompt",
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              parts: [{ type: "text", text: "late" }],
            },
          }),
        })
        expect([404, 409]).toContain(late.status)
      }
    }),
  )
  it.live("preserves signed explicit nulls in public SDK contracts", () =>
    Effect.sync(() => {
      const schemas = OpenApi.fromApi(PublicApi).components.schemas
      expect(schemas.HistoricalFenceAttestation).toMatchObject({
        properties: { workspaceID: { anyOf: expect.arrayContaining([{ type: "null" }]) } },
      })
      expect(schemas.HistoricalFenceIdentity).toMatchObject({
        properties: { workspaceID: { anyOf: expect.arrayContaining([{ type: "null" }]) } },
      })
      expect(JSON.stringify(schemas.HistoricalFenceAttestation)).toContain('"parentSessionID":{"anyOf"')
    }),
  )
  it.live(
    "requires HTTP auth independently of signatures, admits exact evidence without Session recreation, repeats durably",
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
        const identityPath = "/maintenance/historical-fence/identity"
        expect((yield* requestInDirectory(identityPath, directory)).status).toBe(401)
        const response = yield* requestInDirectory(identityPath, directory, { headers: { authorization } })
        expect(response.status).toBe(200)
        const binding = yield* response.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                databaseID: Schema.String,
                projectID: Schema.String,
                directory: Schema.String,
                workspaceID: Schema.NullOr(Schema.String),
              }),
            ),
          ),
        )
        expect(binding.directory).toBe(directory)
        expect(binding.databaseID).toMatch(/^[a-f0-9]{64}$/)
        const root = `ses_${randomUUID().replaceAll("-", "")}`
        const retire = `/session/${root}/retire`
        expect(
          (yield* requestInDirectory(retire, directory, { method: "POST", headers: { authorization } })).status,
        ).toBe(404)
        const input: HistoricalFence.Attestation = {
          ...binding,
          version: 1,
          rootSessionID: root,
          members: [{ sessionID: root, parentSessionID: null, role: "root" }],
          membershipCoverage: "attested-partial",
          artifact: { reference: "archive:verified-root", sha256: "a".repeat(64) },
          issuer: "operator",
          issuedAt: Date.now(),
          nonce: randomUUID(),
        }
        const body = JSON.stringify({
          attestation: input,
          signature: sign(null, Buffer.from(HistoricalFence.canonical(input)), keys.privateKey).toString("base64"),
        })
        expect(
          (yield* requestInDirectory("/maintenance/historical-fence", directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          })).status,
        ).toBe(401)
        const enroll = () =>
          requestInDirectory("/maintenance/historical-fence", directory, {
            method: "POST",
            headers: { authorization, "content-type": "application/json" },
            body,
          })
        const enrolled = yield* enroll()
        expect(enrolled.status).toBe(200)
        const proof = yield* enrolled.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(HistoricalFenceProof)))
        expect(proof).toMatchObject({
          admissionFence: "permanent",
          historicalCleanup: "unknown",
          commandStatus: "unknown",
          membershipCoverage: "attested-partial",
          sessionIDs: [root],
        })
        const repeat = yield* enroll()
        expect(yield* repeat.json).toEqual(proof)
        expect((yield* requestInDirectory(`/session/${root}`, directory, { headers: { authorization } })).status).toBe(
          404,
        )
        const retired = yield* requestInDirectory(retire, directory, { method: "POST", headers: { authorization } })
        expect(retired.status).toBe(200)
        expect(yield* retired.json).toMatchObject({
          rootSessionID: root,
          sessionIDs: [root],
          commandStatus: "unknown",
          membershipCoverage: "attested-partial",
          historicalCleanup: "unknown",
          evidenceHash: proof.evidenceHash,
        })
      }),
  )
})
