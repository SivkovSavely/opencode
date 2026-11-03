import type { RGBA } from "@opentui/core"
import { Show } from "solid-js"

export function UserMessageMetadata(props: {
  scheduled: boolean
  steering: boolean
  timestamp?: string
  color: RGBA
  foreground: RGBA
  muted: RGBA
}) {
  return (
    <>
      <Show
        when={props.steering}
        fallback={
          <Show when={props.timestamp}>
            <text fg={props.muted}>{props.timestamp}</text>
          </Show>
        }
      >
        <text fg={props.muted}>
          <span style={{ bg: props.color, fg: props.foreground, bold: true }}> STEERING </span>
        </text>
      </Show>
      <Show when={props.scheduled}>
        <text fg={props.muted}>
          <span style={{ bg: props.color, fg: props.foreground, bold: true }}> SCHEDULED </span>
        </text>
      </Show>
    </>
  )
}
