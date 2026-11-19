import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Schema } from "effect"
import { SessionDcpV1 } from "@opencode-ai/schema/v1/session-dcp"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

export function createSessionDcp(input: {
  source: Accessor<{ scope: string; directory: string; client: OpencodeClient }>
  sessionID: Accessor<string | undefined>
  workspaceID: Accessor<string | undefined>
  visible: Accessor<boolean>
}) {
  const selection = createMemo(() => ({
    source: input.source(),
    sessionID: input.sessionID(),
    workspaceID: input.workspaceID(),
    visible: input.visible(),
  }))
  const [state, setState] = createStore({
    snapshot: undefined as SessionDcpV1.Snapshot | undefined,
    loading: false,
    error: false,
  })
  let selected: ReturnType<typeof selection> | undefined
  let refresh = () => {}
  createEffect(() => {
    const target = selection()
    selected = target
    setState({ snapshot: undefined, loading: false, error: false })
    if (!target.sessionID || !target.visible) return
    const sessionID = target.sessionID
    let active = true
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: AbortController | undefined
    const load = () => {
      if (!active || pending || selection() !== target) return
      clearTimeout(timer)
      pending = true
      abort = new AbortController()
      setState({ loading: true, error: false })
      // Use this session's configured transport, including its remote base URL,
      // platform fetch and authentication. Never use the globally selected server.
      void target.source.client["client"]
        .get({
          url: `/session/${encodeURIComponent(sessionID)}/dcp`,
          query: { directory: target.source.directory, workspace: target.workspaceID },
          signal: abort.signal,
          throwOnError: true,
        })
        .then((response) => {
          const snapshot = Schema.decodeUnknownSync(SessionDcpV1.Snapshot)(response.data)
          if (snapshot.sessionID !== sessionID) throw new Error("DCP session mismatch")
          if (active && selection() === target) setState("snapshot", reconcile(snapshot))
        })
        .catch(() => {
          if (active && selection() === target) setState({ snapshot: undefined, error: true })
        })
        .finally(() => {
          pending = false
          if (!active || selection() !== target) return
          setState("loading", false)
          timer = setTimeout(load, 10_000)
        })
    }
    refresh = load
    load()
    onCleanup(() => {
      active = false
      clearTimeout(timer)
      abort?.abort()
      refresh = () => {}
    })
  })
  // Gate synchronously, not just in the effect: a route change must never render
  // the previous session's private snapshot for even one reactive update.
  return {
    snapshot: () => {
      const value = state.snapshot
      return selected === selection() ? value : undefined
    },
    loading: () => {
      const value = state.loading
      return selected === selection() && value
    },
    error: () => {
      const value = state.error
      return selected === selection() && value
    },
    refresh: () => refresh(),
  }
}
