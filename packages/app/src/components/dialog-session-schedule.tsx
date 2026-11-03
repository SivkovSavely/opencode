import { For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import type { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { sessionSchedule } from "@/utils/session-schedule"
import { scheduleError, SessionScheduleEditor } from "./session-schedule-editor"

export function DialogSessionSchedule(props: { sessionID: string }) {
  const language = useLanguage()
  const sdk = useSDK()()
  const api = sessionSchedule(useServerSDK()().client, props.sessionID, sdk.directory)
  const [state, setState] = createStore({
    items: [] as SessionScheduleV1.Info[],
    loading: true,
    listRequest: 0,
    pending: false,
    error: "",
    editor: false,
    edit: undefined as SessionScheduleV1.Info | undefined,
    confirm: "",
    historyID: "",
    history: [] as SessionScheduleV1.Occurrence[],
    cursor: undefined as number | undefined,
    historyPending: false,
    historyError: "",
    historyRequest: 0,
  })
  const refresh = async () => {
    setState({ loading: true, error: "", listRequest: state.listRequest + 1 })
    const request = state.listRequest
    await api.list().then(
      (items) => {
        if (state.listRequest === request) setState("items", items)
      },
      (error) => {
        if (state.listRequest === request) setState("error", scheduleError(error, language.t("common.requestFailed")))
      },
    )
    if (state.listRequest === request) setState("loading", false)
  }
  onMount(() => void refresh())
  const mutate = async (action: () => Promise<unknown>) => {
    if (state.pending) return
    setState({ pending: true, error: "", loading: false, listRequest: state.listRequest + 1 })
    await action().then(
      async () => {
        setState("confirm", "")
        await refresh()
      },
      (error) => setState("error", scheduleError(error, language.t("common.requestFailed"))),
    )
    setState("pending", false)
  }
  const history = async (id: string, more = false) => {
    if (state.historyPending && id === state.historyID) return
    const cursor = more ? state.cursor : undefined
    setState({
      historyID: id,
      historyPending: true,
      historyError: "",
      historyRequest: state.historyRequest + 1,
      ...(more ? {} : { history: [], cursor: undefined }),
    })
    const request = state.historyRequest
    await api.history(id, cursor).then(
      (result) => {
        if (state.historyID !== id || state.historyRequest !== request) return
        setState({ history: more ? [...state.history, ...result.items] : [...result.items], cursor: result.cursor })
      },
      (error) => {
        if (state.historyID === id && state.historyRequest === request)
          setState("historyError", scheduleError(error, language.t("common.requestFailed")))
      },
    )
    if (state.historyID === id && state.historyRequest === request) setState("historyPending", false)
  }
  const date = (time: number) => new Date(time).toLocaleString(language.locale())
  return (
    <Dialog title={language.t("schedule.title")} size="large">
      <div class="flex flex-col gap-4 px-6 pb-6 max-h-[75vh] overflow-y-auto">
        <Show
          when={state.editor}
          fallback={
            <>
              <div class="flex flex-wrap gap-2 justify-between">
                <Button
                  disabled={state.loading || state.pending}
                  onClick={() => setState({ editor: true, edit: undefined })}
                >
                  {language.t("schedule.create")}
                </Button>
                <Button variant="ghost" disabled={state.loading || state.pending} onClick={() => void refresh()}>
                  {language.t("schedule.refresh")}
                </Button>
              </div>
              <Show when={state.loading}>
                <p role="status">{language.t("common.loading")}</p>
              </Show>
              <Show when={state.error}>
                <p role="alert">{state.error}</p>
              </Show>
              <Show when={!state.loading && !state.items.length}>
                <p class="text-text-weak">{language.t("schedule.empty")}</p>
              </Show>
              <For each={state.items}>
                {(item) => (
                  <section
                    class="rounded-lg border border-border-weak-base p-3 flex flex-col gap-2"
                    data-schedule-id={item.id}
                  >
                    <h3 class="text-text-strong">{item.summary}</h3>
                    <p class="whitespace-pre-wrap break-words line-clamp-3">{item.message}</p>
                    <p>{language.t(`schedule.status.${item.status}`)}</p>
                    <p class="text-text-weak">
                      {item.next === undefined
                        ? language.t("schedule.noNext")
                        : language.t("schedule.next", { time: date(item.next) })}
                    </p>
                    <p class="text-text-weak">
                      {item.limit === undefined
                        ? language.t("schedule.count.forever", { count: item.completed })
                        : language.t("schedule.count.limit", { count: item.completed, limit: item.limit })}
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        variant="ghost"
                        disabled={state.pending}
                        onClick={() => setState({ edit: item, editor: true })}
                      >
                        {language.t("schedule.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={state.pending || item.status === "completed"}
                        onClick={() => void mutate(() => api.pause(item.id, item.status !== "paused"))}
                      >
                        {language.t(item.status === "paused" ? "schedule.resume" : "schedule.pause")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (state.historyID === item.id) setState("historyID", "")
                          else void history(item.id)
                        }}
                      >
                        {language.t("schedule.history")}
                      </Button>
                      <Button variant="ghost" disabled={state.pending} onClick={() => setState("confirm", item.id)}>
                        {language.t("common.delete")}
                      </Button>
                    </div>
                    <Show when={state.confirm === item.id}>
                      <div role="alert" class="flex flex-col gap-2">
                        <p>{language.t("schedule.delete.confirm")}</p>
                        <div class="flex gap-2">
                          <Button disabled={state.pending} onClick={() => void mutate(() => api.remove(item.id))}>
                            {language.t("common.delete")}
                          </Button>
                          <Button variant="ghost" disabled={state.pending} onClick={() => setState("confirm", "")}>
                            {language.t("common.cancel")}
                          </Button>
                        </div>
                      </div>
                    </Show>
                    <Show when={state.historyID === item.id}>
                      <h4>{language.t("schedule.history")}</h4>
                      <Show when={state.historyError}>
                        <p role="alert">{state.historyError}</p>
                        <Button onClick={() => void history(item.id, state.history.length > 0)}>
                          {language.t("queue.retry")}
                        </Button>
                      </Show>
                      <Show when={!state.historyPending && !state.historyError && !state.history.length}>
                        <p>{language.t("schedule.history.empty")}</p>
                      </Show>
                      <ol class="flex flex-col gap-2">
                        <For each={state.history}>
                          {(occurrence) => (
                            <li class="border-t border-border-weak-base pt-2">
                              <time dateTime={new Date(occurrence.scheduled).toISOString()}>
                                {date(occurrence.scheduled)}
                              </time>
                              <span class="ml-2">{language.t(`schedule.occurrence.${occurrence.state}`)}</span>
                              <Show when={occurrence.error}>
                                <p class="text-text-weak break-words">{occurrence.error}</p>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ol>
                      <Show when={state.historyPending}>
                        <p role="status">{language.t("common.loading")}</p>
                      </Show>
                      <Show when={state.cursor !== undefined}>
                        <Button disabled={state.historyPending} onClick={() => void history(item.id, true)}>
                          {language.t("schedule.history.more")}
                        </Button>
                      </Show>
                    </Show>
                  </section>
                )}
              </For>
            </>
          }
        >
          <SessionScheduleEditor
            schedule={state.edit}
            preview={api.preview}
            onCancel={() => setState("editor", false)}
            onSave={async (input) => {
              setState({ loading: false, listRequest: state.listRequest + 1 })
              if (state.edit) await api.update(state.edit.id, input)
              else await api.create(input)
              setState("editor", false)
              await refresh()
            }}
          />
        </Show>
      </div>
    </Dialog>
  )
}
