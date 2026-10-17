import { createMemo, createEffect, onCleanup, type Accessor } from "solid-js"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { Schema } from "effect"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { useSDK } from "./sdk"
import { useServerSDK } from "./server-sdk"
import { useLanguage } from "./language"
import { queueCount, pendingSteers } from "@/utils/session-queue"

export function useSessionQueue(sessionID: Accessor<string | undefined>) {
  const sdk = useSDK()
  const server = useServerSDK()
  const cache = useQueryClient()
  const language = useLanguage()
  const key = () => ["session-queue", sdk().scope, sdk().directory, sessionID()] as const
  const query = createQuery(() => {
    const source = sdk()
    const id = sessionID()
    return {
      queryKey: key(),
      enabled: !!id,
      retry: false,
      throwOnError: false,
      refetchOnMount: "always",
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      queryFn: async () => {
        const snapshot = Schema.decodeUnknownSync(SessionQueueV1.Snapshot)(
          (await source.client.session.queueList({ sessionID: id!, directory: source.directory })).data,
        )
        const current = cache.getQueryData<SessionQueueV1.Snapshot>([
          "session-queue",
          source.scope,
          source.directory,
          id,
        ])
        return current && current.revision > snapshot.revision ? current : snapshot
      },
    }
  })
  // Queue availability must not suspend the transcript or its composer.
  const snapshot = () => (query.isFetched ? query.data : undefined)
  createEffect(() => {
    const id = sessionID()
    const directory = sdk().directory
    const queryKey = key()
    onCleanup(
      server().event.listen((event) => {
        const type: string = event.details.type
        if (type === "server.connected" || type === "global.disposed") {
          void cache.invalidateQueries({ queryKey })
          return
        }
        if (event.name !== directory || type !== "session.queue.changed") return
        const properties = event.details.properties
        if (!("sessionID" in properties) || properties.sessionID !== id) return
        const revision = "revision" in properties && typeof properties.revision === "number" ? properties.revision : 0
        if ((cache.getQueryData<SessionQueueV1.Snapshot>(queryKey)?.revision ?? -1) >= revision) return
        void cache.invalidateQueries({ queryKey }).then(() => {
          // An event can race the initial request, which TanStack joins instead of restarting.
          const current = cache.getQueryData<SessionQueueV1.Snapshot>(queryKey)
          if (current && current.revision < revision) void cache.invalidateQueries({ queryKey })
        })
      }),
    )
  })
  const update = async (mutation: SessionQueueV1.Mutation) => {
    const queryKey = key()
    const source = sdk()
    const current = snapshot()
    if (!current) throw new Error(language.t("common.requestFailed"))
    try {
      const result = await source.client.session.queueUpdate({
        sessionID: current.sessionID,
        directory: source.directory,
        revision: current.revision,
        mutation: mutation.action === "reorder" ? { ...mutation, ids: [...mutation.ids] } : mutation,
      })
      const next = Schema.decodeUnknownSync(SessionQueueV1.Snapshot)(result.data)
      cache.setQueryData<SessionQueueV1.Snapshot>(queryKey, (current) =>
        current && current.revision > next.revision ? current : next,
      )
    } finally {
      // Also reconcile a CAS conflict. Never retry a state-changing operation automatically.
      void cache.invalidateQueries({ queryKey })
    }
  }
  return {
    query,
    snapshot,
    update,
    count: createMemo(() => queueCount(snapshot())),
    pending: createMemo(() => pendingSteers(snapshot())),
  }
}
