import type { SessionMessageUser } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { useDialogLayer } from "@opencode/ui/context/dialog"
import { createEffect, createMemo, createUniqueId, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import {
  createHistoryProgress,
  messagePreview,
  parseMessageSearch,
  promptSearchItems,
  searchMessages,
  type SearchRange,
} from "./message-search"
import type { Data } from "@opencode/client/solid"
import "./message-search.css"

export function DialogJumpToMessage(props: {
  messages: () => SessionMessageUser[]
  history: Data["session"]["message"]
  sessionID: string
  signal: AbortSignal
  select: (id: string) => void
  close: () => void
}) {
  const language = useLanguage()
  const layer = useDialogLayer()
  const listID = createUniqueId()

  const [state, setState] = createStore({
    query: "",
    // SAFETY: Widen the empty initial selection for later result IDs.
    active: undefined as string | undefined,
    // SAFETY: The empty initial list is populated only by the typed search implementation.
    matches: [] as { id: string; match: SearchRange | undefined }[],
    searching: false,
    searchFailed: false,
    discovering: true,
    failed: false,
    stalled: false,
    scrollTop: 0,
    height: 320,
  })

  const items = createMemo(() => promptSearchItems(props.messages()))
  const byID = createMemo(() => new Map(items().map((item) => [item.id, item])))
  const expression = createMemo(() => parseMessageSearch(state.query))
  const results = createMemo(() => state.matches.filter((item) => byID().has(item.id)))
  const activeIndex = createMemo(() => results().findIndex((item) => item.id === state.active))
  const rowHeight = 40
  const progress = createHistoryProgress()
  let list: HTMLDivElement | undefined
  let field: HTMLInputElement | undefined
  let worker: Worker | undefined
  const alive = () => !props.signal.aborted
  const optionID = (id: string) => `${listID}-${encodeURIComponent(id)}`

  const changeQuery = (query: string) => {
    setState({ query, active: undefined, matches: [], scrollTop: 0 })

    if (list) list.scrollTop = 0
  }

  layer?.setEscapeHandler(() => {
    if (!state.query) return false
    changeQuery("")
    field?.focus()

    return true
  })

  const discover = async () => {
    setState({ discovering: true, failed: false, stalled: false })

    try {
      while (alive() && props.history.more(props.sessionID)) {
        const page = await props.history.loadPage(props.sessionID)

        if (!alive()) return

        if (!progress.accept(page)) {
          setState({ failed: true, stalled: true })

          return
        }

        // Shared work is awaited by the native client, never treated as an exhausted page.
        if (page.status === "skipped" && props.history.more(props.sessionID)) {
          setState({ failed: true, stalled: true })

          return
        }
      }
    } catch {
      if (alive()) setState("failed", true)
    } finally {
      if (alive()) setState("discovering", false)
    }
  }

  createEffect(() => {
    const query = state.query
    const corpus = items()
    worker?.terminate()
    worker = undefined
    setState({ searchFailed: false, searching: false })

    if (!alive()) return

    if (!expression().regex || expression().invalid) {
      setState("matches", searchMessages(corpus, expression()))

      return
    }

    setState("searching", true)
    worker = new Worker(new URL("./message-search.worker.ts", import.meta.url), { type: "module" })
    const current = worker
    worker.onmessage = (event: MessageEvent<{ id: string; match: SearchRange | undefined }[]>) => {
      if (alive() && worker === current) setState({ matches: event.data, searching: false })
    }

    worker.onerror = () => {
      if (alive() && worker === current) setState({ searching: false, searchFailed: true })
    }

    worker.postMessage({ query, items: corpus })
  })

  createEffect(() => {
    const matches = results()

    if (matches.some((item) => item.id === state.active)) return
    setState("active", undefined)
  })

  const shown = createMemo(() => {
    const start = Math.max(0, Math.floor(state.scrollTop / rowHeight) - 4)
    const end = Math.min(results().length, Math.ceil((state.scrollTop + state.height) / rowHeight) + 4)
    const indices = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index)
    const active = activeIndex()

    if (active >= 0 && !indices.includes(active)) indices.push(active)

    return indices.sort((a, b) => a - b)
  })

  const select = (id: string | undefined) => {
    if (!id || !byID().has(id) || !alive()) return
    props.select(id)
    props.close()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return

    if (event.key === "Enter") {
      event.preventDefault()
      select(state.active ?? results()[0]?.id)

      return
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const count = results().length

    if (!count) return
    const index = activeIndex()

    const next =
      index < 0
        ? event.key === "ArrowDown"
          ? 0
          : count - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count

    setState("active", results()[next].id)

    if (!list) return
    const top = next * rowHeight

    if (top < list.scrollTop) list.scrollTop = top

    if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight - list.clientHeight
    setState("scrollTop", list.scrollTop)
  }

  onMount(() => {
    field?.focus()

    const observer = new ResizeObserver(() => {
      if (list) setState("height", list.clientHeight)
    })

    if (list) observer.observe(list)
    const cancel = () => worker?.terminate()
    props.signal.addEventListener("abort", cancel, { once: true })
    onCleanup(() => {
      observer.disconnect()
      props.signal.removeEventListener("abort", cancel)
    })
    void discover()
  })
  onCleanup(() => worker?.terminate())

  return (
    <Dialog size="large" class="message-jump-dialog" containerClass="message-jump-container">
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("session.jump.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div class="message-jump-query">
          <input
            ref={field}
            autofocus
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={listID}
            aria-activedescendant={state.active ? optionID(state.active) : undefined}
            aria-label={language.t("session.jump.search")}
            placeholder={language.t("session.jump.search")}
            value={state.query}
            onInput={(event) => changeQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <Show when={state.query}>
            <Button
              variant="ghost"
              onClick={() => {
                changeQuery("")
                field?.focus()
              }}
            >
              {language.t("common.clear")}
            </Button>
          </Show>
        </div>
        <div class="message-jump-status" role="status" aria-live="polite">
          <Show when={state.discovering || state.searching}>
            <Loader />
          </Show>
          {language.plural(
            state.discovering || state.failed ? "session.jump.partial" : "session.jump.count",
            results().length,
            { count: results().length, loaded: items().length },
          )}
          <Show when={state.discovering}>{language.t("session.jump.loading")}</Show>
          <Show when={state.searching}>{language.t("session.jump.searching")}</Show>
        </div>
        <Show when={expression().invalid}>
          <p role="alert">{language.t("session.jump.invalid")}</p>
        </Show>
        <Show when={state.failed}>
          <div role="alert">
            {language.t(state.stalled ? "session.jump.stalled" : "session.jump.failed")}
            <Button
              variant="ghost"
              onClick={() => {
                progress.clear()
                void discover()
              }}
            >
              {language.t("common.retry")}
            </Button>
          </div>
        </Show>
        <Show when={state.searchFailed}>
          <p role="alert">{language.t("session.jump.searchFailed")}</p>
        </Show>
        <div
          ref={list}
          id={listID}
          role="listbox"
          aria-label={language.t("session.jump.results")}
          class="message-jump-results"
          data-scrollable
          aria-busy={state.discovering || state.searching}
          onScroll={(event) => setState("scrollTop", event.currentTarget.scrollTop)}
        >
          <div style={{ height: `${results().length * rowHeight}px`, position: "relative" }}>
            <For each={shown()}>
              {(index) => {
                const result = () => results()[index]
                const item = () => byID().get(result()?.id ?? "")

                return (
                  <Show when={item()}>
                    {(message) => (
                      <div
                        id={optionID(message().id)}
                        role="option"
                        aria-selected={state.active === message().id}
                        aria-posinset={index + 1}
                        aria-setsize={results().length}
                        class="message-jump-option"
                        style={{ top: `${index * rowHeight}px`, height: `${rowHeight}px` }}
                        onPointerMove={() => setState("active", message().id)}
                        onClick={() => select(message().id)}
                      >
                        <span aria-hidden="true" class="message-jump-ordinal">
                          {index + 1}
                        </span>
                        <MeasuredPreview
                          text={
                            message().text ||
                            language.t(message().attachment ? "session.jump.attachment" : "session.jump.emptyPrompt")
                          }
                          match={result()?.match}
                        />
                        <Show when={message().created !== undefined}>
                          <time
                            dateTime={new Date(message().created!).toISOString()}
                            title={new Date(message().created!).toLocaleString(language.intl(), {
                              dateStyle: "full",
                              timeStyle: "long",
                              hourCycle: "h23",
                            })}
                          >
                            {new Date(message().created!).toLocaleTimeString(language.intl(), {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                              hourCycle: "h23",
                            })}
                          </time>
                        </Show>
                      </div>
                    )}
                  </Show>
                )
              }}
            </For>
          </div>
          <Show when={!results().length && !state.searching && !expression().invalid}>
            <p class="message-jump-empty">{language.t("session.jump.noResults")}</p>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <div class="message-jump-hints">
          <Show when={expression().regex}>
            <span>{language.t("session.jump.regex")}</span>
          </Show>
          <span>{language.t("session.jump.navigateHint")}</span>
          <span>{language.t("session.jump.escapeHint")}</span>
        </div>
      </DialogFooter>
    </Dialog>
  )
}

function MeasuredPreview(props: { text: string; match: SearchRange | undefined }) {
  let element: HTMLSpanElement | undefined
  const [state, setState] = createStore({ width: 0, font: "", size: 13, spacing: 0 })
  const canvas = document.createElement("canvas").getContext("2d")

  const segments = createMemo(() =>
    messagePreview(props.text, state.width, props.match, (text) => {
      if (!canvas) return Array.from(text).length * (state.size * 0.6 + state.spacing)
      canvas.font = state.font

      return canvas.measureText(text).width + Math.max(0, Array.from(text).length - 1) * state.spacing
    }),
  )

  onMount(() => {
    const measure = () => {
      if (!element) return
      const style = getComputedStyle(element)
      setState({
        width: element.clientWidth,
        font: style.font,
        size: parseFloat(style.fontSize),
        spacing: parseFloat(style.letterSpacing) || 0,
      })
    }

    const observer = new ResizeObserver(measure)

    if (element) observer.observe(element)
    void document.fonts.ready.then(measure)
    measure()
    onCleanup(() => observer.disconnect())
  })

  return (
    <span ref={element} class="message-jump-preview" aria-label={props.text}>
      <For each={segments()}>{(segment) => (segment.match ? <mark>{segment.text}</mark> : segment.text)}</For>
    </span>
  )
}
