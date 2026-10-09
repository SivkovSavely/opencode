import type { Part, UserMessage } from "@opencode-ai/sdk/v2"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { chronologicalUserMessages, highlightRanges, normalizePromptText, searchMessages } from "./message-search"
import "./dialog-jump-to-message.css"

export function DialogJumpToMessage(props: {
  sessionID: string
  isCurrentSession: () => boolean
  messages: () => UserMessage[]
  parts: (messageID: string) => Part[]
  historyMore: () => boolean
  historyLoading: () => boolean
  historyMessageCount: () => number
  loadOlder: (sessionID: string) => Promise<void>
  select: (messageID: string) => void
  onClose: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const [regex, setRegex] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const [failed, setFailed] = createSignal(false)
  const [loadingOlder, setLoadingOlder] = createSignal(false)
  let resultsRef: HTMLDivElement | undefined
  let closed = false

  const complete = createMemo(() => !props.historyMore() && !props.historyLoading())
  const messages = createMemo(() =>
    complete()
      ? chronologicalUserMessages(props.messages()).map((message) => {
          const parts = props.parts(message.id)
          const text = normalizePromptText(parts)
          return {
            message,
            text,
            preview: text || (parts.some((part) => part.type === "file") ? language.t("common.attachment") : ""),
          }
        })
      : [],
  )
  const results = createMemo(() => searchMessages(messages(), query(), regex()))
  const activeMessage = createMemo(() => results().matches[active()])
  const timestamp = createMemo(
    () => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }),
  )

  createEffect(() => {
    query()
    regex()
    results()
    setActive(0)
  })

  createEffect(() => {
    if (props.isCurrentSession()) return
    dialog.close()
  })

  createEffect(() => {
    if (!props.isCurrentSession() || failed() || loadingOlder() || !props.historyMore() || props.historyLoading()) return
    setLoadingOlder(true)
    void props.loadOlder(props.sessionID).then(
      () => {
        if (!closed) setLoadingOlder(false)
      },
      () => {
        if (closed) return
        setFailed(true)
        setLoadingOlder(false)
      },
    )
  })

  onCleanup(() => {
    closed = true
    props.onClose()
  })

  const move = (delta: -1 | 1) => {
    const count = results().matches.length
    if (!count) return
    setActive((index) => (index + delta + count) % count)
    requestAnimationFrame(() => resultsRef?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" }))
  }

  const select = (messageID: string) => {
    if (!props.isCurrentSession()) return
    props.select(messageID)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return
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
      const message = activeMessage()
      if (message) select(message.message.id)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      dialog.close()
    }
  }

  return (
    <Dialog class="dialog-jump-to-message" size="large">
      <DialogHeader>
        <DialogTitle>{language.t("common.search.placeholder")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="dialog-jump-to-message-body">
        <div class="dialog-jump-to-message-search">
          <TextInputV2
            value={query()}
            autofocus
            autocomplete="off"
            spellcheck={false}
            appearance="large"
            placeholder={language.t("common.search.placeholder")}
            aria-label={language.t("common.search.placeholder")}
            aria-autocomplete="list"
            aria-controls="dialog-jump-to-message-results"
            aria-activedescendant={activeMessage() ? `dialog-jump-to-message-option-${active()}` : undefined}
            invalid={results().invalid}
            leadingIcon={<Icon name="magnifying-glass" />}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            class="dialog-jump-to-message-regex"
            aria-label={`${language.t("common.search.placeholder")} .*`}
            aria-pressed={regex()}
            onClick={() => setRegex((value) => !value)}
          >
            .*
          </button>
        </div>

        <Show
          when={complete()}
          fallback={
            <div class="dialog-jump-to-message-status" aria-live="polite">
              <Show
                when={failed()}
                fallback={
                  <>
                    <progress aria-label={language.t("session.messages.loadingEarlier")} />
                    <span>{language.t("session.messages.loadingEarlier")}</span>
                    <span>{language.t("common.moreCountSuffix", { count: props.historyMessageCount() })}</span>
                  </>
                }
              >
                <span role="alert">{language.t("common.requestFailed")}</span>
                <button type="button" class="dialog-jump-to-message-retry" onClick={() => setFailed(false)}>
                  {language.t("common.loadMore")}
                </button>
              </Show>
            </div>
          }
        >
          <Show
            when={results().matches.length > 0}
            fallback={<div class="dialog-jump-to-message-empty">{language.t("palette.empty")}</div>}
          >
            <ScrollView class="dialog-jump-to-message-scroll" viewportRef={(element) => (resultsRef = element)}>
              <div
                id="dialog-jump-to-message-results"
                class="dialog-jump-to-message-results"
                role="listbox"
                aria-label={language.t("common.search.placeholder")}
              >
                <For each={results().matches}>
                  {(item, index) => {
                    const created = item.message.time?.created
                    return (
                      <button
                        id={`dialog-jump-to-message-option-${index()}`}
                        type="button"
                        class="dialog-jump-to-message-row"
                        role="option"
                        aria-selected={active() === index()}
                        data-active={active() === index() ? "" : undefined}
                        onMouseMove={(event) => {
                          if (event.movementX === 0 && event.movementY === 0) return
                          setActive(index())
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => select(item.message.id)}
                      >
                      <span class="dialog-jump-to-message-meta">
                        <Show when={created !== undefined}>{timestamp().format(created!)}</Show>
                      </span>
                        <span class="dialog-jump-to-message-preview">
                          <HighlightedText text={item.preview} query={query()} regex={regex()} />
                        </span>
                      </button>
                    )
                  }}
                </For>
              </div>
            </ScrollView>
          </Show>
        </Show>
      </DialogBody>
    </Dialog>
  )
}

function HighlightedText(props: { text: string; query: string; regex: boolean }) {
  const pieces = createMemo(() => {
    const ranges = highlightRanges(props.text, props.query, props.regex)
    if (!ranges.length) return [{ text: props.text, match: false }]

    let cursor = 0
    return ranges.flatMap((range) => {
      const result = [
        ...(range.start > cursor ? [{ text: props.text.slice(cursor, range.start), match: false }] : []),
        { text: props.text.slice(range.start, range.end), match: true },
      ]
      cursor = range.end
      return result
    }).concat(cursor < props.text.length ? [{ text: props.text.slice(cursor), match: false }] : [])
  })

  return (
    <span>
      <For each={pieces()}>{(piece) => (piece.match ? <mark>{piece.text}</mark> : piece.text)}</For>
    </span>
  )
}
