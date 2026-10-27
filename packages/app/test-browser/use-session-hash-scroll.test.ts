import { expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { useSessionHashScroll } from "../src/pages/session/use-session-hash-scroll"

function setup() {
  const [session, setSession] = createSignal("a")
  const requests: { session: string; resolve: () => void; reject: () => void }[] = []
  const host = document.createElement("div")
  document.body.append(host)
  const history = createMemoryHistory()
  history.set({
    value: `/#search:${encodeURIComponent(JSON.stringify({ messageID: "missing" }))}`,
    replace: true,
    scroll: false,
  })

  const Page = () => {
    useSessionHashScroll({
      sessionKey: session,
      sessionID: session,
      messagesReady: () => true,
      visibleUserMessages: () => [],
      messages: () => (session() === "b" ? [{ id: "other" } as Message] : []),
      historyMore: () => session() === "a",
      historyLoading: () => false,
      loadMore: (id) =>
        new Promise<void>((resolve, reject) =>
          requests.push({ session: id, resolve, reject: () => reject(new Error("failed")) }),
        ),
      currentMessageId: () => undefined,
      pendingMessage: () => undefined,
      setPendingMessage: () => {},
      setActiveMessage: () => {},
      autoScroll: { pause: () => {}, forceScrollToBottom: () => {} },
      scroller: () => undefined,
      anchor: (id) => id,
      scheduleScrollState: () => {},
      consumePendingMessage: () => undefined,
    })
    return document.createElement("div")
  }
  const dispose = render(
    () =>
      createComponent(MemoryRouter, {
        history,
        get children() {
          return createComponent(Route, { path: "/", component: Page })
        },
      }),
    host,
  )
  return {
    requests,
    setSession,
    dispose: () => {
      dispose()
      host.remove()
    },
  }
}

test("repeating a search during a failed request retries once without overlapping requests", async () => {
  const app = setup()
  try {
    expect(app.requests).toHaveLength(1)
    window.dispatchEvent(new Event("opencode:repeat-search-navigation"))
    window.dispatchEvent(new Event("opencode:repeat-search-navigation"))
    expect(app.requests).toHaveLength(1)
    app.requests[0]!.reject()
    await Promise.resolve()
    expect(app.requests).toHaveLength(2)
    app.requests[1]!.reject()
    await Promise.resolve()
    expect(app.requests).toHaveLength(2)
  } finally {
    app.dispose()
  }
})

test("a request settles after switching sessions and can continue when returning", async () => {
  const app = setup()
  try {
    expect(app.requests).toHaveLength(1)
    app.setSession("b")
    app.requests[0]!.resolve()
    await Promise.resolve()
    expect(app.requests).toHaveLength(1)
    app.setSession("a")
    expect(app.requests.map((request) => request.session)).toEqual(["a", "a"])
    app.requests[1]!.resolve()
    await Promise.resolve()
    expect(app.requests).toHaveLength(2)
  } finally {
    app.dispose()
  }
})

test("a failed request settles after switching sessions and remains retryable explicitly", async () => {
  const app = setup()
  try {
    app.setSession("b")
    app.requests[0]!.reject()
    await Promise.resolve()
    app.setSession("a")
    expect(app.requests).toHaveLength(1)
    window.dispatchEvent(new Event("opencode:repeat-search-navigation"))
    expect(app.requests.map((request) => request.session)).toEqual(["a", "a"])
    app.requests[1]!.reject()
    await Promise.resolve()
  } finally {
    app.dispose()
  }
})

test("completion does not mistake another session's messages for history progress", async () => {
  const app = setup()
  try {
    app.requests[0]!.resolve()
    await Promise.resolve()
    expect(app.requests).toHaveLength(2)
    app.setSession("b")
    app.requests[1]!.resolve()
    await Promise.resolve()
    app.setSession("a")
    expect(app.requests).toHaveLength(2)
  } finally {
    app.dispose()
  }
})

test("a repeat queued before switching sessions survives a failed request", async () => {
  const app = setup()
  try {
    window.dispatchEvent(new Event("opencode:repeat-search-navigation"))
    app.setSession("b")
    app.requests[0]!.reject()
    await Promise.resolve()
    expect(app.requests).toHaveLength(1)
    app.setSession("a")
    expect(app.requests.map((request) => request.session)).toEqual(["a", "a"])
    app.requests[1]!.reject()
    await Promise.resolve()
    expect(app.requests).toHaveLength(2)
  } finally {
    app.dispose()
  }
})
