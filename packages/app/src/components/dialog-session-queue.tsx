import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import type { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { useLanguage } from "@/context/language"
import type { useSessionQueue } from "@/context/session-queue"
import { queueOrder, queuePreview } from "@/utils/session-queue"

export function DialogSessionQueue(props: { queue: ReturnType<typeof useSessionQueue> }) {
  const language = useLanguage()
  const [state, setState] = createStore({ pending: false, error: "", confirm: false })
  const items = createMemo(() => new Map(props.queue.snapshot()?.items.map((item) => [item.id, item])))
  const mutate = async (mutation: SessionQueueV1.Mutation) => {
    if (state.pending) return
    setState({ pending: true, error: "" })
    try {
      await props.queue.update(mutation)
      setState("confirm", false)
    } catch (error) {
      setState("error", error instanceof Error ? error.message : language.t("common.requestFailed"))
    } finally {
      setState("pending", false)
    }
  }
  const group = (delivery: SessionQueueV1.Delivery) =>
    (props.queue.snapshot()?.items ?? [])
      .filter((item) => item.delivery === delivery)
      .sort((left, right) => left.position - right.position)
  const move = (item: SessionQueueV1.Entry, direction: number) => {
    const mutation = queueOrder(props.queue.snapshot()?.items ?? [], item.id, direction)
    if (mutation) void mutate(mutation)
  }
  return (
    <Dialog title={language.t("queue.title")} size="large">
      <div
        class="flex flex-col gap-4 px-6 pb-6 min-h-32 max-h-[75vh] overflow-y-auto"
        aria-busy={state.pending || props.queue.query.isLoading}
      >
        <Show when={props.queue.query.isError}>
          <div role="alert">{language.t("common.requestFailed")}</div>
          <Button onClick={() => void props.queue.query.refetch()}>{language.t("queue.retry")}</Button>
        </Show>
        <Show when={props.queue.query.isLoading}>{language.t("common.loading")}</Show>
        <Show when={props.queue.snapshot()}>
          {(snapshot) => (
            <div class="flex flex-wrap gap-2 items-center">
              <span role="status">
                {snapshot().paused
                  ? language.t("queue.paused")
                  : snapshot().blocked
                    ? language.t("queue.blocked")
                    : language.t("queue.running")}
              </span>
              <Button
                disabled={state.pending}
                onClick={() => void mutate({ action: "pause", paused: !snapshot().paused && !snapshot().blocked })}
              >
                {snapshot().paused || snapshot().blocked ? language.t("queue.resume") : language.t("queue.pause")}
              </Button>
              <Button disabled={state.pending || !props.queue.count()} onClick={() => setState("confirm", true)}>
                {language.t("queue.clear")}
              </Button>
            </div>
          )}
        </Show>
        <Show when={state.confirm}>
          <div class="flex flex-col gap-2" role="alert">
            <p>{language.t("queue.clear.confirm")}</p>
            <div class="flex gap-2">
              <Button disabled={state.pending} onClick={() => void mutate({ action: "clear" })}>
                {language.t("queue.clear.accept")}
              </Button>
              <Button disabled={state.pending} variant="ghost" onClick={() => setState("confirm", false)}>
                {language.t("common.cancel")}
              </Button>
            </div>
          </div>
        </Show>
        <Show when={state.error}>
          <div role="alert">{state.error}</div>
        </Show>
        <Show when={state.pending}>
          <span aria-live="polite">{language.t("common.loading")}</span>
        </Show>
        <For each={["steer", "queue"] as const}>
          {(delivery) => (
            <section aria-label={delivery === "steer" ? language.t("queue.steering") : language.t("queue.queued")}>
              <h3 class="text-text-strong pb-2">
                {delivery === "steer" ? language.t("queue.steering") : language.t("queue.queued")}
                {` (${group(delivery).filter((item) => item.state === "pending").length})`}
              </h3>
              <Show when={group(delivery).length} fallback={<p class="text-text-weak">{language.t("queue.empty")}</p>}>
                <ol class="flex flex-col gap-2">
                  <For each={group(delivery).map((item) => item.id)}>
                    {(id) => {
                      const item = () => items().get(id)!
                      const pending = () => group(delivery).filter((entry) => entry.state === "pending")
                      const index = () => pending().findIndex((entry) => entry.id === id)
                      const disabled = () => state.pending || item().state !== "pending"
                      const preview = () => queuePreview(item().payload, language.t("queue.compact"))
                      const files = () => {
                        const payload = item().payload
                        return payload.kind === "prompt" || payload.kind === "command"
                          ? (payload.parts?.flatMap((part) => (part.type === "file" ? [part] : [])) ?? [])
                          : []
                      }
                      return (
                        <li
                          data-queue-id={id}
                          class="rounded-lg border border-border-weak-base p-3 flex flex-col gap-2"
                        >
                          <p class="whitespace-pre-wrap break-words line-clamp-4">{preview()}</p>
                          <For each={files()}>
                            {(file) => (
                              <div class="text-text-weak break-all">
                                <Show when={file.mime.startsWith("image/") && file.url.startsWith("data:")}>
                                  <img
                                    class="max-h-24 max-w-full rounded-md"
                                    src={file.url}
                                    alt={file.filename ?? language.t("common.attachment")}
                                  />
                                </Show>
                                {file.filename ?? file.mime}
                              </div>
                            )}
                          </For>
                          <span class="text-text-weak text-12-regular">
                            {item().payload.agent} / {item().payload.model.providerID}/{item().payload.model.modelID}
                            <Show when={item().payload.variant}>{` / ${item().payload.variant}`}</Show>
                          </span>
                          <Show when={item().state !== "pending"}>
                            <span>
                              {item().state === "claimed" ? language.t("queue.claimed") : language.t("queue.uncertain")}
                            </span>
                          </Show>
                          <div class="flex flex-wrap gap-1">
                            <Button
                              variant="ghost"
                              disabled={item().state !== "pending"}
                              aria-disabled={state.pending || index() <= 0}
                              classList={{ "opacity-50": state.pending || index() <= 0 }}
                              onClick={() => move(item(), -1)}
                            >
                              {language.t("queue.up")}
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={item().state !== "pending"}
                              aria-disabled={state.pending || index() === pending().length - 1}
                              classList={{ "opacity-50": state.pending || index() === pending().length - 1 }}
                              onClick={() => move(item(), 1)}
                            >
                              {language.t("queue.down")}
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={disabled()}
                              onClick={() =>
                                void mutate({
                                  action: "convert",
                                  id,
                                  delivery: delivery === "steer" ? "queue" : "steer",
                                })
                              }
                            >
                              {delivery === "steer" ? language.t("queue.toQueue") : language.t("queue.toSteer")}
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={disabled()}
                              onClick={() => void mutate({ action: "delete", id })}
                            >
                              {language.t("common.delete")}
                            </Button>
                          </div>
                        </li>
                      )
                    }}
                  </For>
                </ol>
              </Show>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  )
}
