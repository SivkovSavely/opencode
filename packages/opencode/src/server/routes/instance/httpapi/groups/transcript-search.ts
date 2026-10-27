import { TranscriptSearch } from "@opencode-ai/core/session/transcript-search"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

export const TranscriptSearchApi = HttpApi.make("transcript-search").add(
  HttpApiGroup.make("transcriptSearch").add(
    HttpApiEndpoint.post("search", "/global/transcript/search", {
      payload: TranscriptSearch.Request,
      success: TranscriptSearch.Response,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "transcriptSearch.search",
        summary: "Search persisted transcripts",
        description:
          "Read-only search of persisted transcripts, including historical multi-value identities and category-specific tool input/output/errors. Literal queries of at least three characters use SQLite FTS5 trigram candidate selection; shorter literals use the bounded document scan. Dates are inclusive matching-content timestamps in milliseconds. Running includes pending; interrupted requires explicit tool metadata, not error text. Default sort is newest; oldest and session-title use deterministic message/document tie breakers. Opaque cursors are bound to the query and filters, not limit; reset when parameters change or backfill becomes ready. Metadata is live, not snapshot-isolated: edits to sort/filter fields between pages can move documents. Matches at most 500 eligible documents per page; follow nextCursor even on empty pages. complete means the indexed, bounded-content range is exhausted and backfill is ready, not that truncated text was searched. Each content category is limited to 65536 SQLite characters; truncatedDocuments counts capped documents scanned on this page, even without matches. Hit offsets are UTF-16. Assistant errors have no partID. Regex accepts /source/flags or source plus flags (gimsu); g is ignored for first-match search. Supports literals, escapes, dot, classes and anchors, not groups, alternation or quantifiers; regexes require a literal run of at least three characters for candidate selection.",
      }),
    ),
    HttpApiEndpoint.get("status", "/global/transcript/search/status", {
      success: TranscriptSearch.Status,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "transcriptSearch.status",
        summary: "Get transcript search readiness",
        description:
          "Returns durable backfill readiness without advancing it. Use the backfill operation while ready is false; progress resumes after restart.",
      }),
    ),
    HttpApiEndpoint.post("backfill", "/global/transcript/search/backfill", {
      success: TranscriptSearch.Status,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "transcriptSearch.backfill",
        summary: "Advance transcript search backfill",
        description:
          "Indexes at most 200 persisted parts or messages. Repeat while ready is false; progress is durable and resumes after restart.",
      }),
    ),
    HttpApiEndpoint.get("facets", "/global/transcript/search/facets", {
      success: TranscriptSearch.Facets,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "transcriptSearch.facets",
        summary: "Get historical transcript facets",
        description:
          "Lists all historical projects, agents, providers, models and tool names, including removed configurations. Scalar facet details include lastUsed ranking metadata; model identities retain provider/model pairs and project details include worktree paths. Values are discovered independently of the current search query.",
      }),
    ),
  ),
)
