import { Schema } from "effect"
import { createStore } from "solid-js/store"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { errorMessage } from "../util/error"

export type QueueAPI = {
  list(sessionID: string): Promise<unknown>
  submit(sessionID: string, input: SessionQueueV1.Submit): Promise<unknown>
  update(sessionID: string, input: SessionQueueV1.Update): Promise<unknown>
  flush(sessionID: string): Promise<unknown>
}

export function createQueueController(api: QueueAPI) {
  const [data, setData] = createStore<{
    snapshots: Record<string, SessionQueueV1.Snapshot | undefined>
    busy: Record<string, boolean | undefined>
    loading: Record<string, boolean | undefined>
    errors: Record<string, string | undefined>
  }>({ snapshots: {}, busy: {}, loading: {}, errors: {} })
  const requests = new Map<string, Promise<SessionQueueV1.Snapshot>>()
  const invalidated = new Set<string>()

  function accept(value: unknown) {
    const snapshot = Schema.decodeUnknownSync(SessionQueueV1.Snapshot)(value)
    if (snapshot.revision >= (data.snapshots[snapshot.sessionID]?.revision ?? -1)) {
      setData("snapshots", snapshot.sessionID, snapshot)
    }
    return data.snapshots[snapshot.sessionID]!
  }

  function refresh(sessionID: string): Promise<SessionQueueV1.Snapshot> {
    const existing = requests.get(sessionID)
    if (existing) {
      invalidated.add(sessionID)
      return existing
    }
    setData("loading", sessionID, true)
    const request = (async () => {
      do {
        invalidated.delete(sessionID)
        accept(await api.list(sessionID))
      } while (invalidated.has(sessionID))
      setData("errors", sessionID, undefined)
      return data.snapshots[sessionID]!
    })()
      .catch((error) => {
        setData("errors", sessionID, errorMessage(error))
        throw error
      })
      .finally(() => {
        requests.delete(sessionID)
        setData("loading", sessionID, false)
      })
    requests.set(sessionID, request)
    return request
  }

  async function mutate(sessionID: string, run: () => Promise<unknown>) {
    if (data.busy[sessionID]) return false
    setData("busy", sessionID, true)
    setData("errors", sessionID, undefined)
    try {
      accept(await run())
      return true
    } catch (error) {
      setData("errors", sessionID, errorMessage(error))
      // A conflict or lost acknowledgement requires authoritative state, not an optimistic rollback.
      await refresh(sessionID).catch(() => {})
      setData("errors", sessionID, errorMessage(error))
      return false
    } finally {
      setData("busy", sessionID, false)
    }
  }

  const result = {
    data,
    refresh,
    changed(sessionID: string, revision: number) {
      if (!(sessionID in data.snapshots) && !requests.has(sessionID)) return
      if (revision <= (data.snapshots[sessionID]?.revision ?? -1)) return
      void refresh(sessionID).catch(() => {})
    },
    reconnect() {
      for (const sessionID of new Set([...Object.keys(data.snapshots), ...requests.keys()])) {
        void refresh(sessionID).catch(() => {})
      }
    },
    pending(sessionID: string, delivery?: SessionQueueV1.Delivery) {
      return (data.snapshots[sessionID]?.items ?? []).filter(
        (item) => item.state === "pending" && (!delivery || item.delivery === delivery),
      )
    },
    steering(sessionID: string, messageID: string) {
      return result.pending(sessionID, "steer").some((item) => item.messageID === messageID)
    },
    submit(sessionID: string, input: SessionQueueV1.Submit) {
      return mutate(sessionID, () => api.submit(sessionID, input))
    },
    async update(sessionID: string, mutation: SessionQueueV1.Mutation) {
      if (data.busy[sessionID]) return false
      const request = requests.get(sessionID)
      if (request) {
        if (!(await request.catch(() => undefined))) return false
        if (data.busy[sessionID]) return false
      }
      const snapshot = data.snapshots[sessionID] ?? (await refresh(sessionID).catch(() => undefined))
      if (!snapshot) return false
      if (mutation.action === "delete" || mutation.action === "convert") {
        if (!snapshot.items.some((item) => item.id === mutation.id && item.state === "pending")) return false
      }
      return mutate(sessionID, () => api.update(sessionID, { revision: snapshot.revision, mutation }))
    },
    flush(sessionID: string) {
      return mutate(sessionID, () => api.flush(sessionID))
    },
  }
  return result
}

export type QueueController = ReturnType<typeof createQueueController>

export function queueRows(snapshot?: SessionQueueV1.Snapshot) {
  return (snapshot?.items ?? [])
    .filter((item) => item.state === "pending" || item.state === "claimed" || item.state === "uncertain")
    .toSorted(
      (a, b) =>
        Number(b.delivery === "steer") - Number(a.delivery === "steer") ||
        a.position - b.position ||
        a.id.localeCompare(b.id),
    )
}

export function queuePreview(payload: SessionQueueV1.Payload) {
  if (payload.kind === "compact") return "/compact"
  if (payload.kind === "shell") return `!${payload.command}`
  const files =
    payload.parts?.flatMap((part) => (part.type === "file" ? [`[${part.filename ?? part.mime}]`] : [])) ?? []
  const text =
    payload.kind === "command"
      ? `/${payload.command} ${payload.arguments}`.trimEnd()
      : payload.parts
          .flatMap((part) => {
            if (part.type === "text" && !part.synthetic) return [part.text]
            if (part.type === "agent") return [`@${part.name}`]
            if (part.type === "subtask") return [part.description]
            return []
          })
          .join(" ")
  return [text, ...files].filter(Boolean).join(" ").replace(/\s+/g, " ")
}
