import { createMemo, createUniqueId, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionDcpV1 } from "@opencode-ai/schema/v1/session-dcp"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { createSessionDcp } from "./session-dcp"

export function SessionDcpSection(props: { sessionID?: string; workspaceID?: string }) {
  const language = useLanguage()
  const sdk = useSDK()
  const title = createUniqueId()
  const [state, setState] = createStore({ visible: !document.hidden })
  const visibility = () => setState("visible", !document.hidden)
  document.addEventListener("visibilitychange", visibility)
  onCleanup(() => document.removeEventListener("visibilitychange", visibility))
  const reader = createSessionDcp({
    source: sdk,
    sessionID: () => props.sessionID,
    workspaceID: () => props.workspaceID,
    visible: () => state.visible,
  })
  const snapshot = reader.snapshot
  const available = createMemo(() => {
    const value = snapshot()
    return value?.state === "available" ? value : undefined
  })
  const number = (value: number | undefined) =>
    value === undefined ? language.t("context.dcp.unrecorded") : value.toLocaleString(language.intl())
  const active = createMemo(
    () => available()?.blocks.filter((block) => block.active || block.status === "active") ?? [],
  )
  const historical = createMemo(
    () => available()?.blocks.filter((block) => !block.active && block.status !== "active") ?? [],
  )
  return (
    <section aria-labelledby={title} data-component="session-dcp" class="min-w-0 flex flex-col gap-3 text-12-regular">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id={title} class="text-12-medium text-text-strong">
          {language.t("context.dcp.title")}
        </h2>
        <Button
          size="small"
          variant="ghost"
          disabled={reader.loading() || !state.visible || !props.sessionID}
          onClick={reader.refresh}
        >
          {language.t("context.dcp.refresh")}
        </Button>
      </div>
      <p class="text-text-weak">{language.t("context.dcp.note")}</p>
      <Show when={reader.loading() && !snapshot()}>
        <p role="status">{language.t("common.loading")}</p>
      </Show>
      <Show when={reader.error()}>
        <p role="alert">{language.t("context.dcp.error")}</p>
      </Show>
      <Switch>
        <Match when={snapshot()?.state === "absent"}>
          <p>{language.t("context.dcp.absent")}</p>
        </Match>
        <Match when={snapshot()?.state === "invalid"}>
          <p role="status">{language.t("context.dcp.invalid")}</p>
        </Match>
        <Match when={snapshot()?.state === "too-large"}>
          <p role="status">{language.t("context.dcp.tooLarge")}</p>
        </Match>
        <Match when={snapshot()?.state === "unavailable"}>
          <p role="status">{language.t("context.dcp.unavailable")}</p>
        </Match>
        <Match when={available()}>
          {(info) => (
            <>
              <dl class="grid grid-cols-1 @[24rem]:grid-cols-2 gap-3">
                <DcpStat
                  label={language.t("context.dcp.activeSummaryTokens")}
                  value={number(info().stats.activeSummaryTokens)}
                />
                <DcpStat
                  label={language.t("context.dcp.historicalRemovedTokens")}
                  value={number(info().stats.historicalRemovedTokens)}
                />
                <DcpStat label={language.t("context.dcp.prunedTools")} value={number(info().stats.prunedToolCount)} />
                <DcpStat
                  label={language.t("context.dcp.prunedMessages")}
                  value={number(info().stats.prunedMessageCount)}
                />
                <DcpStat
                  label={language.t("context.dcp.lastUpdated")}
                  value={dcpTime(
                    Date.parse(info().lastUpdated ?? ""),
                    language.intl(),
                    language.t("context.dcp.unrecorded"),
                  )}
                />
              </dl>
              <Show when={!info().blocks.length}>
                <p>{language.t("context.dcp.empty")}</p>
              </Show>
              <Show when={active().length}>
                <h3 class="text-12-medium text-text-strong">{language.t("context.dcp.activeBlocks")}</h3>
                <For each={active()}>{(block) => <DcpBlock block={block} />}</For>
              </Show>
              <Show when={historical().length}>
                <h3 class="text-12-medium text-text-strong">{language.t("context.dcp.historicalBlocks")}</h3>
                <For each={historical()}>{(block) => <DcpBlock block={block} />}</For>
              </Show>
              <h3 class="text-12-medium text-text-strong">{language.t("context.dcp.operations")}</h3>
              <Show
                when={info().operations !== undefined}
                fallback={<p>{language.t("context.dcp.historyUnrecorded")}</p>}
              >
                <Show when={info().operations?.length} fallback={<p>{language.t("context.dcp.historyEmpty")}</p>}>
                  <ol class="flex flex-col gap-3">
                    <For each={info().operations}>
                      {(operation) => (
                        <li class="border border-border-base rounded-md p-3 flex flex-col gap-2">
                          <div class="flex flex-wrap justify-between gap-2">
                            <bdi dir="auto">{operation.topic ?? operation.type}</bdi>
                            <span>
                              {dcpTime(operation.timestamp, language.intl(), language.t("context.dcp.unrecorded"))}
                            </span>
                          </div>
                          <dl class="grid grid-cols-1 @[24rem]:grid-cols-2 gap-3">
                            <DcpStat label={language.t("context.dcp.operation")} value={operation.type} />
                            <DcpStat
                              label={language.t("context.dcp.blocks")}
                              value={operation.blockIds?.join(", ") ?? language.t("context.dcp.unrecorded")}
                            />
                            <DcpStat
                              label={language.t("context.dcp.signedSavings")}
                              value={
                                operation.savings?.saved === undefined
                                  ? language.t("context.dcp.unrecorded")
                                  : `${operation.savings.saved > 0 ? "+" : ""}${number(operation.savings.saved)}`
                              }
                            />
                            <DcpStat
                              label={language.t("context.dcp.beforeAfter")}
                              value={language.t("context.dcp.pair", {
                                before: number(operation.savings?.before),
                                after: number(operation.savings?.after),
                              })}
                            />
                          </dl>
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </section>
  )
}

function DcpBlock(props: { block: SessionDcpV1.Block }) {
  const language = useLanguage()
  const [state, setState] = createStore({ open: false })
  const unrecorded = () => language.t("context.dcp.unrecorded")
  const number = (value: number | undefined) =>
    value === undefined ? unrecorded() : value.toLocaleString(language.intl())
  const ids = (value: readonly number[] | undefined) =>
    value === undefined ? unrecorded() : value.join(", ") || language.t("context.dcp.none")
  return (
    <details
      class="border border-border-base rounded-md min-w-0"
      onToggle={(event) => setState("open", event.currentTarget.open)}
    >
      <summary class="cursor-pointer px-3 py-2 break-words">
        <span class="text-text-strong">{language.t("context.dcp.block", { id: props.block.blockId })}</span>{" "}
        <bdi dir="auto">{props.block.topic}</bdi>{" "}
        <span class="text-text-weak">{language.t(`context.dcp.status.${props.block.status}`)}</span>
      </summary>
      <Show when={state.open}>
        <div class="border-t border-border-base p-3 flex flex-col gap-3 min-w-0">
          <dl class="grid grid-cols-1 @[24rem]:grid-cols-2 gap-3">
            <DcpStat
              label={language.t("context.dcp.boundaries")}
              value={language.t("context.dcp.pair", {
                before: props.block.startId ?? unrecorded(),
                after: props.block.endId ?? unrecorded(),
              })}
            />
            <DcpStat
              label={language.t("context.dcp.created")}
              value={dcpTime(props.block.createdAt, language.intl(), unrecorded())}
            />
            <DcpStat
              label={language.t("context.dcp.deactivated")}
              value={dcpTime(props.block.deactivatedAt, language.intl(), unrecorded())}
            />
            <DcpStat label={language.t("context.dcp.duration")} value={number(props.block.durationMs)} />
            <DcpStat label={language.t("context.dcp.compressedTokens")} value={number(props.block.compressedTokens)} />
            <DcpStat label={language.t("context.dcp.summaryTokens")} value={number(props.block.summaryTokens)} />
            <DcpStat label={language.t("context.dcp.directMessages")} value={number(props.block.directMessageCount)} />
            <DcpStat
              label={language.t("context.dcp.effectiveMessages")}
              value={number(props.block.effectiveMessageCount)}
            />
            <DcpStat label={language.t("context.dcp.directTools")} value={number(props.block.directToolCount)} />
            <DcpStat label={language.t("context.dcp.effectiveTools")} value={number(props.block.effectiveToolCount)} />
            <DcpStat label={language.t("context.dcp.included")} value={ids(props.block.includedBlockIds)} />
            <DcpStat label={language.t("context.dcp.consumed")} value={ids(props.block.consumedBlockIds)} />
            <DcpStat label={language.t("context.dcp.parents")} value={ids(props.block.parentBlockIds)} />
            <DcpStat label={language.t("context.dcp.replacedBy")} value={number(props.block.deactivatedByBlockId)} />
            <DcpStat label={language.t("context.dcp.mode")} value={props.block.mode ?? unrecorded()} />
            <DcpStat label={language.t("context.dcp.run")} value={number(props.block.runId)} />
          </dl>
          <Show when={props.block.batchTopic}>
            <p dir="auto">{props.block.batchTopic}</p>
          </Show>
          <h4 class="text-12-medium">{language.t("context.dcp.summary")}</h4>
          <pre
            dir="auto"
            class="whitespace-pre-wrap break-words [overflow-wrap:anywhere] min-w-0 max-w-full font-sans select-text"
          >
            {props.block.summary ?? unrecorded()}
          </pre>
        </div>
      </Show>
    </details>
  )
}

function DcpStat(props: { label: string; value: string }) {
  return (
    <div class="min-w-0 flex flex-col gap-1">
      <dt class="text-text-weak">{props.label}</dt>
      <dd class="text-text-strong break-words [overflow-wrap:anywhere]">
        <bdi dir="auto">{props.value}</bdi>
      </dd>
    </div>
  )
}

function dcpTime(value: number | undefined, locale: string, fallback: string) {
  if (value === undefined || !Number.isFinite(new Date(value).getTime())) return fallback
  return new Date(value).toLocaleString(locale)
}
