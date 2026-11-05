import type { SessionInfo } from "@opencode/client/promise"
import { queryOptions, skipToken } from "@tanstack/solid-query"
import type { ServerConnection } from "@/runtime/server/registry"
import type { ServerCtx } from "@/runtime/server/runtime"
import { loadHomeBookmarks, loadHomeSessionIndex } from "./index"

// Keep the immutable result opaque so Solid Query does not recursively unwrap every session on mount.
const selectSessions = (sessions: SessionInfo[]) => () => sessions

export function homeSessionsQuery(
  conn: ServerConnection.Any | undefined,
  ctx: ServerCtx | undefined,
  bookmarks = false,
) {
  return queryOptions({
    queryKey: [bookmarks ? "home-bookmarks" : "home-sessions", conn] as const,
    queryFn: ctx
      ? ({ signal }) =>
          bookmarks
            ? ctx.data.session.loadBookmarks(() =>
                loadHomeBookmarks((input, options) => ctx.sdk.api.session.list(input, options), signal),
              )
            : ctx.data.session.load(() =>
                loadHomeSessionIndex((input, options) => ctx.sdk.api.session.list(input, options), signal),
              )
      : skipToken,
    retry: false,
    staleTime: 30_000,
    // Returning to Home shows the last list and refreshes it, instead of loading again once the cache expires.
    gcTime: Infinity,
    refetchOnMount: true,
    refetchOnReconnect: true,
    select: selectSessions,
  })
}
