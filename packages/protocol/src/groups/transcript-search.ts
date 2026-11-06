import { TranscriptSearch } from "@opencode/schema/transcript-search"
import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"

const annotations = (method: string) =>
  OpenApi.annotations({
    identifier: `experimental.transcript.${method}`,
    summary: `Transcript ${method}`,
    description:
      "Experimental: may change without compatibility guarantees. Searches only public persisted categories within the documented content and scan bounds; completeness is not a historical snapshot.",
  })

export const TranscriptEndpoints = [
  HttpApiEndpoint.post("transcript.search", "/api/experimental/transcript/search", {
    payload: TranscriptSearch.Request,
    success: Schema.Struct({ data: TranscriptSearch.Response }),
    error: InvalidRequestError,
  }).annotateMerge(annotations("search")),
  HttpApiEndpoint.get("transcript.status", "/api/experimental/transcript/status", {
    success: Schema.Struct({ data: TranscriptSearch.Status }),
  }).annotateMerge(annotations("status")),
  HttpApiEndpoint.post("transcript.backfill", "/api/experimental/transcript/backfill", {
    payload: TranscriptSearch.Backfill,
    success: Schema.Struct({ data: TranscriptSearch.Status }),
  }).annotateMerge(annotations("backfill")),
  HttpApiEndpoint.get("transcript.facets", "/api/experimental/transcript/facets", {
    success: Schema.Struct({ data: TranscriptSearch.Facets }),
  }).annotateMerge(annotations("facets")),
] as const
