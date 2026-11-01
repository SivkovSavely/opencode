import { HistoricalFence } from "@opencode-ai/core/historical-fence"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"

export class HistoricalFenceError extends Schema.ErrorClass<HistoricalFenceError>("HistoricalFenceError")(
  {
    reason: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export const HistoricalFenceProof = Schema.Struct({
  rootSessionID: Schema.String,
  sessionIDs: Schema.Array(Schema.String),
  membershipCoverage: Schema.Literal("attested-partial"),
  admissionFence: Schema.Literal("permanent"),
  historicalCleanup: Schema.Literal("unknown"),
  commandStatus: Schema.Literal("unknown"),
  evidenceHash: Schema.String,
  recordedAt: Schema.Number,
  signer: Schema.String,
})

export const HistoricalFenceApi = HttpApi.make("historical-fence").add(
  HttpApiGroup.make("historicalFence")
    .add(
      HttpApiEndpoint.get("identity", "/maintenance/historical-fence/identity", {
        query: WorkspaceRoutingQuery,
        success: Schema.Struct({
          databaseID: Schema.String,
          projectID: Schema.String,
          directory: Schema.String,
          workspaceID: Schema.NullOr(Schema.String),
        }).annotate({ identifier: "HistoricalFenceIdentity" }),
        error: HistoricalFenceError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "historicalFence.identity",
          summary: "Get historical fence signing binding",
        }),
      ),
      HttpApiEndpoint.post("enroll", "/maintenance/historical-fence", {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({ attestation: HistoricalFence.Attestation, signature: Schema.String }),
        success: HistoricalFenceProof,
        error: HistoricalFenceError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "historicalFence.enroll",
          summary: "Fence attested historical Session identities",
          description:
            "Opt-in operator maintenance. Verifies a configured Ed25519 authority; records immutable ownership evidence and permanent admission tombstones. Attested membership is partial, never proof of command termination. Exact signed retries return the same durable proof.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
