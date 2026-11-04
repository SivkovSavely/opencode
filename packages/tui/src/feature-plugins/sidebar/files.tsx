import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { Locale } from "../../util/locale"
import { useSync } from "../../context/sync"
import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"
import type { FileDiff } from "@opencode-ai/schema/file-diff"

const id = "internal:sidebar-files"

function changeCountWidth(item: { additions: number; deletions: number }) {
  return [item.additions ? `+${item.additions}` : "", item.deletions ? `-${item.deletions}` : ""]
    .filter(Boolean)
    .join(" ").length
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const sync = useSync()
  const theme = () => props.api.theme.current
  // The public sidebar API only exposes named files, so retain aggregates from the raw summary here.
  const summary = createMemo(() => SnapshotDiff.limit(sync.data.session_diff[props.session_id] ?? []))
  const totals = createMemo(() => SnapshotDiff.totals(summary()))
  const omitted = createMemo(() => summary().some((item) => item.omitted))
  const list = createMemo(() => summary().filter((item): item is FileDiff.Info & { file: string } => !!item.file))

  return (
    <Show when={summary().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Modified Files ({totals().filesComplete ? totals().files : "?"})</b>
          </text>
        </box>
        <Show when={omitted()}>
          <text fg={theme().warning}>Some change details were omitted. Statistics may be incomplete.</text>
          <text fg={theme().textMuted}>
            +{totals().additions} -{totals().deletions}
          </text>
        </Show>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme().textMuted} wrapMode="none">
                  {Locale.truncateLeft(item.file, Math.max(2, 36 - changeCountWidth(item)))}
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={item.additions}>
                    <text fg={theme().diffAdded}>+{item.additions}</text>
                  </Show>
                  <Show when={item.deletions}>
                    <text fg={theme().diffRemoved}>-{item.deletions}</text>
                  </Show>
                </box>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
