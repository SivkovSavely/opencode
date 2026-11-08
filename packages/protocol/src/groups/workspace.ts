import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api"
import { ConflictError, ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "../errors.js"

export const WORKSPACE_DISPATCH_PATH = "/api/experimental/workspace/:workspaceID/dispatch"

export const WorkspaceDispatchInput = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "QUERY"]),
  path: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.optional(Schema.String.annotate({ description: "Original request bytes, base64 encoded." })),
}).annotate({ identifier: "Workspace.DispatchInput" })

export const WorkspaceDispatchEndpoint = HttpApiEndpoint.post("workspace.dispatch", WORKSPACE_DISPATCH_PATH, {
  params: { workspaceID: Schema.String },
  payload: WorkspaceDispatchInput,
  success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
  error: [InvalidRequestError, ForbiddenError, ConflictError, ServiceUnavailableError],
}).annotateMerge(
  OpenApi.annotations({
    identifier: "experimental.workspace.dispatch",
    summary: "Dispatch to a host-authorized workspace backend",
    description:
      "Experimental: may change without compatibility guarantees. Requires trusted host registration, independent backend credentials and explicit grants by declared native HTTP operation ID, including mutations and execution when authorized. Preserves backend status, media and streamed response. Recursive dispatch and interactive upgrades are denied. Session resources must belong to the registered backend location. No implicit-local fallback, additional execution policy or managed-isolation guarantee. The caller never supplies a destination URL or backend credentials.",
  }),
)
