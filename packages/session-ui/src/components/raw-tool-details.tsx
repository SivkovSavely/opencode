import { createMemo, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Collapsible } from "@opencode/ui/collapsible"
import { Button } from "@opencode/ui/button"
import { useI18n } from "@opencode/ui/context/i18n"
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { formatRawToolString } from "./raw-tool-format"
import { formatRawToolValue, rawToolRequest, rawToolResponse } from "./raw-tool-value"
import "./raw-tool-details.css"

type Formatted = { source: string; value: string }

function RawSection(props: { label: string; children: JSX.Element }) {
  const [state, setState] = createStore({ open: false })
  return (
    <Collapsible variant="ghost" open={state.open} onOpenChange={(open) => setState("open", open)}>
      <Collapsible.Trigger aria-label={props.label}>
        <span>{props.label}</span>
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Show when={state.open}>{props.children}</Show>
      </Collapsible.Content>
    </Collapsible>
  )
}

function RawValue(props: {
  value: unknown
  label: string
  incomplete?: boolean
  formatted?: Formatted
  onFormat: (value: Formatted | undefined) => void
}) {
  const i18n = useI18n()
  const format = createMemo(() =>
    !props.incomplete && typeof props.value === "string" ? formatRawToolString(props.value) : undefined,
  )
  const formatted = () =>
    typeof props.value === "string" && props.formatted?.source === props.value ? props.formatted.value : undefined
  const action = () => formatted() !== undefined || format() !== undefined
  return (
    <div data-slot="raw-tool-details-value">
      <Show when={action()}>
        <Button
          size="small"
          variant="ghost"
          onClick={() => {
            if (formatted() !== undefined) return props.onFormat(undefined)
            const value = format()
            if (value && typeof props.value === "string") props.onFormat({ source: props.value, value: value.value })
          }}
        >
          {formatted() !== undefined
            ? i18n.t("ui.tool.rawDetails.showRaw")
            : i18n.t(format()?.format === "json" ? "ui.tool.rawDetails.formatJSON" : "ui.tool.rawDetails.formatXML")}
        </Button>
      </Show>
      <pre data-slot="raw-tool-details-body" data-scrollable tabIndex={0} role="region" aria-label={props.label}>
        {formatted() ?? formatRawToolValue(props.value) ?? i18n.t("ui.tool.rawDetails.unserializable")}
      </pre>
    </div>
  )
}

export function RawToolDetails(props: { tool: SessionMessageAssistantTool }) {
  const i18n = useI18n()
  const [state, setState] = createStore<{ request?: Formatted; response?: Formatted }>({})
  return (
    <div data-component="raw-tool-details">
      <RawSection label={i18n.t("ui.tool.rawDetails.request")}>
        <RawValue
          value={rawToolRequest(props.tool)}
          label={i18n.t("ui.tool.rawDetails.request")}
          incomplete={props.tool.state.status === "streaming"}
          formatted={state.request}
          onFormat={(value) => setState("request", value)}
        />
      </RawSection>
      <RawSection label={i18n.t("ui.tool.rawDetails.response")}>
        <Show
          when={rawToolResponse(props.tool)}
          fallback={<div data-slot="raw-tool-details-empty">{i18n.t("ui.tool.rawDetails.noResponse")}</div>}
        >
          {(response) => (
            <>
              <RawValue
                value={response().value}
                label={i18n.t("ui.tool.rawDetails.response")}
                formatted={state.response}
                onFormat={(value) => setState("response", value)}
              />
              <Show when={response().attachments || response().outputPaths}>
                <pre
                  data-slot="raw-tool-details-body"
                  data-scrollable
                  tabIndex={0}
                  role="region"
                  aria-label={i18n.t("ui.tool.rawDetails.response")}
                >
                  {formatRawToolValue({
                    ...(response().attachments ? { attachments: response().attachments } : {}),
                    ...(response().outputPaths ? { outputPaths: response().outputPaths } : {}),
                  })}
                </pre>
              </Show>
            </>
          )}
        </Show>
      </RawSection>
    </div>
  )
}
