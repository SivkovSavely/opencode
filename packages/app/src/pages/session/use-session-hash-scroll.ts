import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { useLocation, useNavigate } from "@solidjs/router"
import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { messageIdFromHash, searchMessageTargetFromHash, type SearchMessageTarget } from "./message-id-from-hash"

export const useSessionHashScroll = (input: {
  sessionKey: () => string
  sessionID: () => string | undefined
  messagesReady: () => boolean
  visibleUserMessages: () => UserMessage[]
  messages?: () => Message[]
  parts?: (messageID: string) => Part[]
  userMessageForTarget?: (target: SearchMessageTarget) => UserMessage | undefined
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  currentMessageId: () => string | undefined
  pendingMessage: () => string | undefined
  setPendingMessage: (value: string | undefined) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  autoScroll: { pause: () => void; forceScrollToBottom: () => void }
  scroller: () => HTMLDivElement | undefined
  anchor: (id: string) => string
  revealMessage?: (id: string) => void
  revealTarget?: (target: SearchMessageTarget) => void
  scheduleScrollState: (el: HTMLDivElement) => void
  consumePendingMessage: (key: string) => string | undefined
}) => {
  const visibleUserMessages = createMemo(() => input.visibleUserMessages())
  const messageById = createMemo(() => new Map(visibleUserMessages().map((m) => [m.id, m])))
  let pendingKey = ""
  let clearing = false
  let navigation = 0
  const searchHistoryRequests = new Map<string, { count: number; attempts: number }>()

  const location = useLocation()
  const navigate = useNavigate()

  const frames = new Set<number>()
  let highlightTimer: number | undefined
  let highlightedElement: HTMLElement | undefined
  const queue = (fn: () => void) => {
    const id = requestAnimationFrame(() => {
      frames.delete(id)
      fn()
    })
    frames.add(id)
  }
  const cancel = () => {
    for (const id of frames) cancelAnimationFrame(id)
    frames.clear()
  }

  const clearMessageHash = () => {
    cancel()
    input.consumePendingMessage(input.sessionKey())
    if (input.pendingMessage()) input.setPendingMessage(undefined)
    if (!location.hash) return
    clearing = true
    navigate(location.pathname + location.search, { replace: true })
  }

  const updateHash = (id: string) => {
    const hash = `#${input.anchor(id)}`
    if (location.hash === hash) return
    clearing = false
    navigate(location.pathname + location.search + hash, {
      replace: true,
    })
  }

  const scrollToElement = (el: HTMLElement, behavior: ScrollBehavior) => {
    const root = input.scroller()
    if (!root) return false

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    const sticky = root.querySelector("[data-session-title]")
    const inset = sticky instanceof HTMLElement ? sticky.offsetHeight : 0
    const top = Math.max(0, a.top - b.top + root.scrollTop - inset)
    root.scrollTo({ top, behavior })
    return true
  }

  const seek = (id: string, behavior: ScrollBehavior, left = 4): boolean => {
    input.revealMessage?.(id)
    const el = document.getElementById(input.anchor(id))
    if (el) return scrollToElement(el, behavior)
    if (left <= 0) return false
    queue(() => {
      seek(id, behavior, left - 1)
    })
    return false
  }

  const scrollToMessage = (message: UserMessage, behavior: ScrollBehavior = "smooth") => {
    cancel()
    if (input.currentMessageId() !== message.id) input.setActiveMessage(message)
    input.revealMessage?.(message.id)

    if (seek(message.id, behavior)) {
      updateHash(message.id)
      return
    }

    updateHash(message.id)
  }

  const seekSearchTarget = (
    target: SearchMessageTarget,
    behavior: ScrollBehavior,
    generation: number,
    sessionKey: string,
    left = 32,
  ) => {
    if (generation !== navigation || input.sessionKey() !== sessionKey) return
    input.revealTarget?.(target)
    const selector = target.partID
      ? `[data-timeline-message-id="${CSS.escape(target.messageID)}"][data-timeline-part-id="${CSS.escape(target.partID)}"]`
      : `[data-search-message-id="${CSS.escape(target.messageID)}"]`
    const element = document.querySelector<HTMLElement>(selector)
    if (element) {
      highlightedElement?.classList.remove("timeline-search-target")
      if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
      highlightedElement = element
      element.classList.add("timeline-search-target")
      highlightTimer = window.setTimeout(() => {
        element.classList.remove("timeline-search-target")
        if (highlightedElement === element) highlightedElement = undefined
        highlightTimer = undefined
      }, 1800)
      scrollToElement(element, behavior)
      return
    }
    if (left > 0) {
      queue(() => seekSearchTarget(target, behavior, generation, sessionKey, left - 1))
    }
  }

  const applySearchTarget = (
    target: SearchMessageTarget,
    behavior: ScrollBehavior,
    generation: number,
    sessionKey: string,
  ) => {
    const message = input.messages?.().find((item) => item.id === target.messageID)
    if (!message) return
    if (target.partID && !input.parts?.(target.messageID).some((part) => part.id === target.partID)) return
    const userMessage = input.userMessageForTarget?.(target)
    if (!userMessage) return
    input.autoScroll.pause()
    if (input.currentMessageId() !== userMessage.id) input.setActiveMessage(userMessage)
    seekSearchTarget(target, behavior, generation, sessionKey)
  }

  const applyHash = (behavior: ScrollBehavior, generation = navigation, sessionKey = input.sessionKey()) => {
    const hash = location.hash.slice(1)
    if (!hash) {
      input.autoScroll.forceScrollToBottom()
      const el = input.scroller()
      if (el) input.scheduleScrollState(el)
      return
    }

    const searchTarget = searchMessageTargetFromHash(hash)
    if (searchTarget) {
      applySearchTarget(searchTarget, behavior, generation, sessionKey)
      return
    }

    const messageId = messageIdFromHash(hash)
    if (messageId) {
      input.autoScroll.pause()
      const msg = messageById().get(messageId)
      if (msg) {
        scrollToMessage(msg, behavior)
        return
      }
      return
    }

    const target = document.getElementById(hash)
    if (target) {
      input.autoScroll.pause()
      scrollToElement(target, behavior)
      return
    }

    input.autoScroll.forceScrollToBottom()
    const el = input.scroller()
    if (el) input.scheduleScrollState(el)
  }

  createEffect(() => {
    const hash = location.hash
    const sessionKey = input.sessionKey()
    const generation = ++navigation
    cancel()
    if (!hash) clearing = false
    if (!input.sessionID() || !input.messagesReady()) return
    const searchTarget = searchMessageTargetFromHash(hash)
    if (searchTarget) input.parts?.(searchTarget.messageID)
    input.messages?.()
    queue(() => {
      if (generation !== navigation || input.sessionKey() !== sessionKey) return
      applyHash("auto", generation, sessionKey)
    })
  })

  createEffect(() => {
    if (!input.sessionID() || !input.messagesReady()) return

    visibleUserMessages()

    const searchTarget = searchMessageTargetFromHash(location.hash)
    if (searchTarget) return

    let targetId = input.pendingMessage()
    if (!targetId) {
      const key = input.sessionKey()
      if (pendingKey !== key) {
        pendingKey = key
        const next = input.consumePendingMessage(key)
        if (next) {
          input.setPendingMessage(next)
          targetId = next
        }
      }
    }

    if (!targetId && !clearing) targetId = messageIdFromHash(location.hash)
    if (!targetId) return

    const pending = input.pendingMessage() === targetId
    const msg = messageById().get(targetId)
    if (!msg) return

    if (pending) input.setPendingMessage(undefined)
    if (input.currentMessageId() === targetId && !pending) return

    input.autoScroll.pause()
    cancel()
    queue(() => scrollToMessage(msg, "auto"))
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID || !input.messagesReady()) return

    visibleUserMessages()

    const searchTarget = searchMessageTargetFromHash(location.hash)
    if (searchTarget) {
      const messageLoaded = input.messages?.().some((message) => message.id === searchTarget.messageID)
      const userMessageLoaded = input.userMessageForTarget?.(searchTarget)
      if (messageLoaded && userMessageLoaded) return
      if (!input.historyMore() || input.historyLoading()) return
      const sessionKey = input.sessionKey()
      const requestKey = `${sessionKey}\0${searchTarget.messageID}\0${searchTarget.partID ?? ""}`
      const count = input.messages?.().length ?? 0
      const previous = searchHistoryRequests.get(requestKey)
      if (previous && count <= previous.count && previous.attempts >= 2) return
      const attempts = previous && count <= previous.count ? previous.attempts + 1 : 1
      searchHistoryRequests.set(requestKey, { count, attempts })
      void input.loadMore(sessionID).then(
        () => {
          if (input.sessionKey() !== sessionKey) return
          if ((input.messages?.().length ?? 0) > count) {
            searchHistoryRequests.delete(requestKey)
            return
          }
          searchHistoryRequests.set(requestKey, { count, attempts })
        },
        () => {
          if (input.sessionKey() === sessionKey) searchHistoryRequests.set(requestKey, { count, attempts: 2 })
        },
      )
      return
    }

    let targetId = input.pendingMessage()
    if (!targetId && !clearing) targetId = messageIdFromHash(location.hash)
    if (!targetId) return
    if (messageById().has(targetId)) return
    if (!input.historyMore() || input.historyLoading()) return

    void input.loadMore(sessionID)
  })

  onMount(() => {
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual"
    }
  })

  onCleanup(() => {
    cancel()
    if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
    highlightedElement?.classList.remove("timeline-search-target")
  })

  return {
    clearMessageHash,
    scrollToMessage,
    applyHash,
  }
}
