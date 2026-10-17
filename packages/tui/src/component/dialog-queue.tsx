import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useSync } from "../context/sync"
import { selectedForeground, useTheme } from "../context/theme"
import { useOpencodeKeymap } from "../keymap"
import { useDialog } from "../ui/dialog"
import { queuePreview, type QueueController } from "../queue/controller"
import { createQueueDialog } from "../queue/dialog"

export function DialogQueue(props: { sessionID: string; info?: boolean }) {
  return <QueueView sessionID={props.sessionID} queue={useSync().queue} info={props.info} />
}

export function QueueView(props: { sessionID: string; queue: QueueController; info?: boolean }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const keymap = useOpencodeKeymap()
  const controller = createQueueDialog(props.queue, props.sessionID)
  const snapshot = () => props.queue.data.snapshots[props.sessionID]
  const count = () => props.queue.pending(props.sessionID, "queue").length
  let scroll: ScrollBoxRenderable | undefined
  const off = keymap.intercept(
    "key",
    ({ event }) => {
      if (props.info || !controller.key(event)) return
      event.preventDefault()
      event.stopPropagation()
    },
    { priority: 2 },
  )
  onCleanup(off)
  onMount(() => {
    dialog.setSize("large")
    void props.queue.refresh(props.sessionID).catch(() => {})
  })
  createEffect(() => {
    const id = controller.current()?.id
    if (id) scroll?.scrollChildIntoView(`queue-${id}`)
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Queue ({count()}){snapshot()?.paused ? " PAUSED" : " RUNNING"}
          {snapshot()?.blocked ? " BLOCKED" : ""}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <text fg={theme.textMuted}>
        {snapshot()?.paused || snapshot()?.blocked
          ? "Automatic queued delivery is paused. Steering remains active."
          : "Automatic queued delivery is enabled."}
      </text>
      <Show when={props.info}>
        <text fg={theme.textMuted}>Queue information. Use /queues to manage.</text>
      </Show>
      <Show when={props.queue.data.errors[props.sessionID]}>
        <text fg={theme.error}>{props.queue.data.errors[props.sessionID]}</text>
      </Show>
      <Show
        when={controller.rows().length}
        fallback={<text fg={theme.textMuted}>{controller.busy() ? "Loading queue..." : "Queue is empty"}</text>}
      >
        <scrollbox
          ref={(value) => {
            scroll = value
          }}
          maxHeight={Math.max(3, Math.floor(dimensions().height / 2) - 6)}
        >
          <For each={["steer", "queue"] as const}>
            {(delivery) => (
              <Show when={controller.rows().some((item) => item.delivery === delivery)}>
                <text fg={theme.textMuted}>{delivery === "steer" ? "Steering" : "Queued"}</text>
                <For each={controller.rows().filter((item) => item.delivery === delivery)}>
                  {(item) => {
                    const active = () => !props.info && controller.current()?.id === item.id
                    const confirm = () => {
                      const value = controller.confirmation()
                      return value?.action === "delete" && value.id === item.id
                    }
                    return (
                      <box
                        id={`queue-${item.id}`}
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={active() ? theme.primary : undefined}
                        onMouseUp={() => {
                          if (!props.info) controller.select(item.id)
                        }}
                      >
                        <text fg={active() ? selectedForeground(theme, theme.primary) : theme.text} wrapMode="word">
                          {confirm() ? "Delete? [Y/any key cancels] " : ""}
                          {queuePreview(item.payload)}
                        </text>
                        <text fg={active() ? selectedForeground(theme, theme.primary) : theme.textMuted}>
                          {item.payload.kind} | {item.payload.agent} | {item.payload.model.providerID}/
                          {item.payload.model.modelID}
                          {item.payload.variant ? ` (${item.payload.variant})` : ""}
                          {item.state !== "pending" ? ` | ${item.state} (read-only)` : ""}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </Show>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={controller.confirmation()?.action === "clear"}>
        <text fg={theme.error}>Clear all pending items? Y confirms; any other key cancels.</text>
      </Show>
      <Show when={!props.info}>
        <text fg={theme.textMuted}>
          {controller.busy()
            ? "Updating queue... controls disabled"
            : "Up/Down select | Shift-Up/Down reorder | S convert | P pause/resume | Del delete | C clear all"}
        </text>
        <Show when={controller.current()?.state !== "pending" && controller.current()}>
          <text fg={theme.textMuted}>Claimed/uncertain items cannot be changed.</text>
        </Show>
      </Show>
    </box>
  )
}
