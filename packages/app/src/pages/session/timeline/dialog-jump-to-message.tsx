import type { Part, UserMessage } from "@opencode-ai/sdk/v2"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { chronologicalUserMessages, messagePreview, normalizePromptText, parseMessageSearch, searchMessages } from "./message-search"
import "./dialog-jump-to-message.css"

export function DialogJumpToMessage(props: {
  sessionID: string
  isCurrentSession: () => boolean
  messages: () => UserMessage[]
  parts: (messageID: string) => Part[]
  historyMore: () => boolean
  historyLoading: () => boolean
  historyRecordCount: () => number
  loadOlder: (sessionID: string) => Promise<void>
  select: (messageID: string) => void
  onClose: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({
    query: "",
    activeID: undefined as string | undefined,
    failed: false,
    loadingOlder: false,
    resultsViewport: undefined as HTMLDivElement | undefined,
    previewWidth: 0,
    measurePreviewElement: undefined as HTMLSpanElement | undefined,
  })
  const messagesCache = new WeakMap<
    UserMessage,
    {
      parts: Part[]
      signature: { part: Part; type: Part["type"]; text?: string; synthetic?: boolean; ignored?: boolean }[]
      item: { message: UserMessage; text: string; preview: string }
    }
  >()
  let searchInput: HTMLInputElement | undefined
  let measureContext: CanvasRenderingContext2D | null = null
  let font = ""
  let letterSpacing = 0
  let closed = false

  const messages = createMemo(() =>
    chronologicalUserMessages(props.messages()).map((message) => {
      const parts = props.parts(message.id)
      const cached = messagesCache.get(message)
      if (
        cached?.parts === parts &&
        cached.signature.length === parts.length &&
        cached.signature.every((entry, index) => {
          const part = parts[index]
          return (
            entry.part === part &&
            entry.type === part.type &&
            entry.text === (part.type === "text" ? part.text : undefined) &&
            entry.synthetic === (part.type === "text" ? part.synthetic : undefined) &&
            entry.ignored === (part.type === "text" ? part.ignored : undefined)
          )
        })
      )
        return cached.item
      const text = normalizePromptText(parts)
      const item = {
        message,
        text,
        preview: text || (parts.some((part) => part.type === "file") ? language.t("common.attachment") : ""),
      }
      messagesCache.set(message, {
        parts,
        signature: parts.map((part) => ({
          part,
          type: part.type,
          text: part.type === "text" ? part.text : undefined,
          synthetic: part.type === "text" ? part.synthetic : undefined,
          ignored: part.type === "text" ? part.ignored : undefined,
        })),
        item,
      })
      return item
    }),
  )
  const search = createMemo(() => parseMessageSearch(state.query))
  const results = createMemo(() => searchMessages(messages(), search()))
  const resultIndex = createMemo(() => new Map(results().matches.map((result, index) => [result.item.message.id, index])))
  const activeIndex = createMemo(() => {
    const id = state.activeID
    return id ? resultIndex().get(id) : undefined
  })
  const activeResult = createMemo(() => {
    const index = activeIndex()
    return index === undefined ? undefined : results().matches[index]
  })
  const complete = createMemo(() => !props.historyMore() && !props.historyLoading())
  const shortTime = createMemo(() =>
    new Intl.DateTimeFormat(language.intl(), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
  )
  const fullTime = createMemo(() =>
    new Intl.DateTimeFormat(language.intl(), {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
  )

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return results().matches.length
    },
    getScrollElement: () => state.resultsViewport ?? null,
    initialRect: { width: 0, height: 400 },
    estimateSize: () => 34,
    overscan: 12,
    get getItemKey() {
      const current = results().matches
      return (index: number) => current[index]?.item.message.id ?? index
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      const active = activeIndex()
      if (active === undefined || indexes.includes(active)) return indexes
      return [...indexes, active].sort((a, b) => a - b)
    },
  })

  createEffect(() => {
    const element = state.measurePreviewElement
    if (!element) return
    measureContext = document.createElement("canvas").getContext("2d")
    const update = () => {
      const style = getComputedStyle(element)
      font = style.font
      letterSpacing = Number.parseFloat(style.letterSpacing) || 0
      if (measureContext) measureContext.font = font
      setState("previewWidth", element.clientWidth)
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    state.query
    setState("activeID", undefined)
  })

  createEffect(() => {
    const id = state.activeID
    if (id && !resultIndex().has(id)) setState("activeID", undefined)
  })

  createEffect(() => {
    if (!props.isCurrentSession()) dialog.close()
  })

  createEffect(() => {
    if (!props.isCurrentSession() || state.failed || state.loadingOlder || !props.historyMore() || props.historyLoading()) return
    setState("loadingOlder", true)
    const before = props.historyRecordCount()
    void props.loadOlder(props.sessionID).then(
      () => {
        if (closed) return
        if (
          props.isCurrentSession() &&
          props.historyMore() &&
          !props.historyLoading() &&
          props.historyRecordCount() <= before
        ) {
          setState("failed", true)
        }
        setState("loadingOlder", false)
      },
      () => {
        if (closed) return
        setState("failed", true)
        setState("loadingOlder", false)
      },
    )
  })

  onCleanup(() => {
    closed = true
    props.onClose()
  })

  const measure = (text: string) => {
    if (!measureContext) return text.length * 7
    return measureContext.measureText(text).width + Math.max(0, text.length - 1) * letterSpacing
  }

  const move = (delta: -1 | 1) => {
    const count = results().matches.length
    if (!count) return
    const current = activeIndex()
    const index = current === undefined ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count
    setState("activeID", results().matches[index].item.message.id)
    virtualizer.scrollToIndex(index, { align: "auto" })
  }

  const select = (messageID: string) => {
    if (!props.isCurrentSession()) return
    props.select(messageID)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === "Escape" && state.query) {
      event.preventDefault()
      event.stopPropagation()
      setState("query", "")
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      event.stopPropagation()
      move(1)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      event.stopPropagation()
      move(-1)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      const messageID = activeResult()?.item.message.id ?? results().matches[0]?.item.message.id
      if (messageID) select(messageID)
      return
    }
  }

  const footerCount = () =>
    complete()
      ? language.plural("session.jumpToMessage.count", messages().length, {
          matches: results().matches.length,
          total: messages().length,
        })
      : language.plural("session.jumpToMessage.loadedCount", messages().length, {
          matches: results().matches.length,
          loaded: messages().length,
        })

  createEffect(() => {
    if (!dialog.active) return
    const remove = dialog.onEscapeKeyDown((event) => {
      if (!state.query) return
      event.preventDefault()
      setState("query", "")
    })
    onCleanup(remove)
  })

  return (
    <Dialog
      class="dialog-jump-to-message"
      size="large"
    >
      <DialogHeader>
        <DialogTitle>{language.t("session.jumpToMessage.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="dialog-jump-to-message-body">
        <div class="dialog-jump-to-message-search">
          <TextInputV2
            value={state.query}
            ref={(element) => (searchInput = element)}
            autofocus
            autocomplete="off"
            spellcheck={false}
            appearance="large"
            placeholder={language.t("session.jumpToMessage.searchPlaceholder")}
            aria-label={language.t("session.jumpToMessage.searchPlaceholder")}
            aria-autocomplete="list"
            aria-controls="dialog-jump-to-message-results"
            aria-activedescendant={activeResult() ? `dialog-jump-to-message-option-${state.activeID}` : undefined}
            invalid={search().invalid}
            showClearButton={!!state.query}
            clearLabel={language.t("common.clear")}
            onClearClick={() => {
              setState("query", "")
              searchInput?.focus({ preventScroll: true })
            }}
            leadingIcon={<Icon name="magnifying-glass" />}
            onInput={(event) => setState("query", event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <Show when={search().invalid}>
          <div class="dialog-jump-to-message-error" role="alert">
            {language.t("session.jumpToMessage.invalidRegex")}
          </div>
        </Show>

        <Show when={!complete()}>
          <div class="dialog-jump-to-message-status" aria-live="polite">
            <Show when={state.failed} fallback={<>
              <progress aria-label={language.t("session.messages.loadingEarlier")} />
              <span>{language.t("session.messages.loadingEarlier")}</span>
            </>}>
              <span role="alert">{language.t("common.requestFailed")}</span>
              <button type="button" class="dialog-jump-to-message-retry" onClick={() => setState("failed", false)}>
                {language.t("common.loadMore")}
              </button>
            </Show>
          </div>
        </Show>

        <Show
          when={results().matches.length > 0}
          fallback={<div class="dialog-jump-to-message-empty">{language.t("palette.empty")}</div>}
        >
          <ScrollView
            class="dialog-jump-to-message-scroll"
            viewportRef={(element) => setState("resultsViewport", element)}
          >
            <div
              class="dialog-jump-to-message-results"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              <div class="dialog-jump-to-message-measure-row" aria-hidden="true">
                <span class="dialog-jump-to-message-meta" />
                <span
                  ref={(element) => setState("measurePreviewElement", element)}
                  class="dialog-jump-to-message-preview"
                />
              </div>
              <div
                id="dialog-jump-to-message-results"
                class="dialog-jump-to-message-options"
                role="listbox"
                aria-label={language.t("session.jumpToMessage.title")}
              >
                <For each={virtualizer.getVirtualItems()}>
                  {(row) => {
                    const result = () => results().matches[row.index]
                    return (
                      <Show when={result()}>
                        {(entry) => {
                          const item = () => entry().item
                          const messageID = () => item().message.id
                          const created = () => item().message.time?.created
                          const createdDate = () => {
                            const value = created()
                            return value === undefined ? undefined : new Date(value)
                          }
                          const preview = () => messagePreview(item().preview, state.previewWidth, entry().match, measure)
                          return (
                            <button
                              id={`dialog-jump-to-message-option-${messageID()}`}
                              type="button"
                              class="dialog-jump-to-message-row"
                              role="option"
                              aria-selected={state.activeID === messageID()}
                              data-active={state.activeID === messageID() ? "" : undefined}
                              style={{
                                height: `${row.size}px`,
                                transform: `translateY(${row.start}px)`,
                              }}
                              onMouseMove={(event) => {
                                if (event.movementX === 0 && event.movementY === 0) return
                                setState("activeID", messageID())
                              }}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => select(messageID())}
                            >
                              <span class="dialog-jump-to-message-meta">
                                <Show when={createdDate()}>
                                  {(time) => (
                                    <time
                                      dateTime={time().toISOString()}
                                      title={fullTime().format(time())}
                                    >
                                      {shortTime().format(time())}
                                    </time>
                                  )}
                                </Show>
                              </span>
                              <span class="dialog-jump-to-message-preview">
                                <For each={preview()}>
                                  {(segment) => (segment.match ? <mark>{segment.text}</mark> : segment.text)}
                                </For>
                              </span>
                            </button>
                          )
                        }}
                      </Show>
                    )
                  }}
                </For>
              </div>
            </div>
          </ScrollView>
        </Show>

        <div class="dialog-jump-to-message-footer">
          <span class="dialog-jump-to-message-count">
            {footerCount()}
            <Show when={search().regex}> · {language.t("session.jumpToMessage.regexMode")}</Show>
          </span>
          <span class="dialog-jump-to-message-hints">
            <Show when={results().matches.length > 0}>
              <span class="dialog-jump-to-message-keyboard-hints">
                {language.t(state.query ? "session.jumpToMessage.keyboard.clear" : "session.jumpToMessage.keyboard.close")}
              </span>
            </Show>
            <span>{language.t("session.jumpToMessage.regexHint")}</span>
          </span>
        </div>
      </DialogBody>
    </Dialog>
  )
}
