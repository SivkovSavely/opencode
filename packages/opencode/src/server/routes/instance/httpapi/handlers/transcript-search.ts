import { TranscriptSearch } from "@opencode-ai/core/session/transcript-search"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

export const transcriptSearchHandlers = HttpApiBuilder.group(RootHttpApi, "transcriptSearch", (handlers) =>
  Effect.gen(function* () {
    const search = yield* TranscriptSearch.Service
    return handlers
      .handle("search", ({ payload }) =>
        search
          .search(payload)
          .pipe(
            Effect.catch((error) =>
              error instanceof TranscriptSearch.InvalidQuery
                ? Effect.fail(new InvalidRequestError({ message: error.message }))
                : Effect.die(error),
            ),
          ),
      )
      .handle("status", () => search.status().pipe(Effect.orDie))
      .handle("backfill", () => search.advance().pipe(Effect.orDie))
      .handle("facets", () => search.facets().pipe(Effect.orDie))
  }),
)
