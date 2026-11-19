import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { formatShellCommand, highlightShellCommand, type ShellToken } from "./shell-command"

export function ShellOutput(props: {
  command: string
  output: string
  shell?: string
  onCopy: (text: string) => Promise<boolean>
}) {
  const i18n = useI18n()
  return (
    <Show when={props.command || props.output}>
      <div data-component="bash-output" data-variant="shell">
        <div
          data-slot="bash-scroll"
          data-scrollable
          tabIndex={0}
          role="region"
          aria-label={i18n.t("ui.scrollView.ariaLabel")}
        >
          <Show when={props.command}>
            <div data-slot="bash-command">
              <pre data-slot="bash-pre" dir="ltr">
                <code>
                  <ShellCommand command={props.command} shell={props.shell} />
                </code>
              </pre>
              <ShellCopy text={props.command} label={i18n.t("ui.message.copy")} onCopy={props.onCopy} />
            </div>
          </Show>
          <Show when={props.output}>
            <div data-slot="bash-result">
              <pre data-slot="bash-pre" dir="ltr">
                <code>{props.output}</code>
              </pre>
              <ShellCopy text={props.output} label={i18n.t("ui.message.copyResponse")} onCopy={props.onCopy} />
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}

function ShellCommand(props: { command: string; shell?: string }) {
  const display = createMemo(() => formatShellCommand(props.command, props.shell))
  const [tokens, setTokens] = createSignal<ShellToken[]>([])
  createEffect(() => {
    const source = props.command
    const text = display()
    setTokens([{ text }])
    let active = true
    onCleanup(() => {
      active = false
    })
    highlightShellCommand(text).then(
      (result) => {
        if (active) setTokens(result)
      },
      () => {
        if (active) setTokens([{ text: source }])
      },
    )
  })
  return (
    <For each={tokens()}>
      {(token) => (
        <Show when={token.color} fallback={token.text}>
          <span style={{ color: token.color }}>{token.text}</span>
        </Show>
      )}
    </For>
  )
}

function ShellCopy(props: { text: string; label: string; onCopy: (text: string) => Promise<boolean> }) {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = true
  onCleanup(() => {
    active = false
    clearTimeout(timer)
  })
  createEffect(() => {
    props.text
    clearTimeout(timer)
    setCopied(false)
  })
  const copy = async () => {
    const text = props.text
    if (!(await props.onCopy(text).catch(() => false)) || !active || props.text !== text) return
    setCopied(true)
    clearTimeout(timer)
    timer = setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div data-slot="bash-copy">
      <TooltipV2 value={copied() ? i18n.t("ui.message.copied") : props.label} placement="top">
        <IconButtonV2
          icon={<Icon name={copied() ? "check" : "outline-copy"} size="small" />}
          size="normal"
          variant="ghost-muted"
          onMouseDown={(event) => event.preventDefault()}
          onClick={copy}
          aria-label={copied() ? i18n.t("ui.message.copied") : props.label}
        />
      </TooltipV2>
    </div>
  )
}
