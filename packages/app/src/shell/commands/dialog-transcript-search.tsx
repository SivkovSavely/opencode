import type { TranscriptSearch } from "@opencode/schema/transcript-search"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { useDialog, useDialogLayer } from "@opencode/ui/context/dialog"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createUniqueId, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Match } from "effect"
import { useLanguage } from "@/runtime/i18n/language"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { sessionHref } from "@/shell/routes/session"
import { uuid } from "@opencode/util/uuid"
import {
  createTranscriptPagination,
  localDateBounds,
  rankTranscriptFacets,
  transcriptPreview,
  transcriptQuery,
  type TranscriptResult,
} from "./transcript-search"
import "./transcript-search.css"

type Qualified = { server: string; value: string; label: string; lastUsed?: number; configured?: boolean }

type Filter = "projects" | "models" | "agents" | "tools"

export function DialogTranscriptSearch() {
  const language = useLanguage()
  const dialog = useDialog()
  const global = useGlobal()
  const registry = useServers()
  const layout = useLayout()
  const tabs = useTabs()
  const navigate = useNavigate()
  const id = createUniqueId()
  const route = layout.route()
  const initial = route.type === "session" ? route.server : layout.home.selection().server

  // SAFETY: assertions widen empty initial collections and valid literal defaults to their mutable state types.
  const [state, setState] = createStore({
    query: "",
    caseSensitive: false,
    servers: initial
      ? [String(initial)]
      : [...registry.visible.filter(registry.current), ...registry.visible]
          .slice(0, 1)
          .map((conn) => String(ServerConnection.key(conn))),
    projects: [] as string[],
    models: [] as string[],
    agents: [] as string[],
    tools: [] as string[],
    roles: [] as string[],
    content: [] as string[],
    statuses: [] as string[],
    kind: "all" as NonNullable<TranscriptSearch.Request["sessionKind"]>,
    archived: "all" as NonNullable<TranscriptSearch.Request["archived"]>,
    sort: "newest" as NonNullable<TranscriptSearch.Request["sort"]>,
    from: "",
    to: "",
    preset: "all",
    presetFrom: undefined as number | undefined,
    filterQuery: "",
    results: [] as TranscriptResult[],
    failed: [] as string[],
    error: "",
    metadataErrors: [] as string[],
    indexErrors: [] as string[],
    statusesByServer: {} as Record<string, TranscriptSearch.Status | undefined>,
    facets: {} as Record<string, TranscriptSearch.Facets | undefined>,
    loading: false,
    more: false,
    complete: false,
    truncated: 0,
    scanLimited: false,
    active: 0,
    scrollTop: 0,
    revision: 0,
    metadataRevision: 0,
  })

  let field: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined
  let filters: HTMLDetailsElement | undefined
  useDialogLayer()?.setEscapeHandler(() => {
    if (!filters?.open) return false
    filters.open = false
    field?.focus()

    return true
  })
  let generation = 0
  let more: (() => Promise<void>) | undefined
  const key = (item: Qualified) => JSON.stringify([item.server, item.value])
  const selected = () => registry.list.filter((conn) => state.servers.includes(ServerConnection.key(conn)))

  const toggle = (dimension: "servers" | Filter | "roles" | "content" | "statuses", value: string) =>
    setState(dimension, (items) =>
      items.includes(value) ? items.filter((item) => item !== value) : items.length >= 100 ? items : [...items, value],
    )

  const serverName = (key: string) => {
    const conn = registry.list.find((conn) => ServerConnection.key(conn) === key)

    return conn ? registry.label(conn) : key
  }

  const contentOptions = ["user-text", "assistant-text", "tool-input", "tool-output", "errors"]

  const contentPairs = () =>
    state.content.flatMap<NonNullable<TranscriptSearch.Request["content"]>[number]>((value) => {
      if (value === "user-text") return [{ role: "user" as const, category: "text" as const }]

      if (value === "assistant-text") return [{ role: "assistant" as const, category: "text" as const }]

      if (value === "errors")
        return [
          { role: "assistant" as const, category: "tool-error" as const },
          { role: "assistant" as const, category: "assistant-error" as const },
        ]

      if (value === "tool-input" || value === "tool-output") return [{ role: "assistant" as const, category: value }]

      return []
    })

  const options = (dimension: Filter): Qualified[] => {
    const values = selected().flatMap((conn) => {
      const server = ServerConnection.key(conn)
      const ctx = global.ensureServerCtx(conn)
      const facets = state.facets[server]

      const configured = Match.value(dimension).pipe(
        Match.when("projects", () =>
          ctx.projects.list().map((item) => ({ server, value: item.id, label: item.worktree, configured: true })),
        ),
        Match.when("agents", () =>
          Object.keys(ctx.sync.data.config.agent ?? {}).map((value) => ({
            server,
            value,
            label: value,
            configured: true,
          })),
        ),
        Match.when("models", () =>
          Object.entries(ctx.sync.data.config.provider ?? {}).flatMap(([providerID, provider]) =>
            Object.keys(provider.models ?? {}).map((modelID) => ({
              server,
              value: JSON.stringify([providerID, modelID]),
              label: `${providerID} / ${modelID}`,
              configured: true,
            })),
          ),
        ),
        Match.orElse(() =>
          Object.keys(ctx.sync.data.config.tools ?? {}).map((value) => ({
            server,
            value,
            label: value,
            configured: true,
          })),
        ),
      )

      const historical = Match.value(dimension).pipe(
        Match.when("projects", () =>
          (facets?.projects ?? []).map((item) => ({
            server,
            value: item.id,
            label: item.path,
            lastUsed: item.lastUsed,
          })),
        ),
        Match.when("models", () =>
          (facets?.models ?? []).map((item) => ({
            server,
            value: JSON.stringify([item.providerID, item.modelID]),
            label: `${item.providerID} / ${item.modelID}`,
            lastUsed: item.lastUsed,
          })),
        ),
        Match.orElse((dimension) =>
          (dimension === "agents" ? (facets?.agents ?? []) : (facets?.tools ?? [])).map((item) => ({
            server,
            value: item.value,
            label: item.value,
            lastUsed: item.lastUsed,
          })),
        ),
      )

      const loaded = Match.value(dimension).pipe(
        Match.when("models", () =>
          (ctx.data.location.model.list() ?? []).map((model) => ({
            server,
            value: JSON.stringify([model.providerID, model.id]),
            label: `${model.providerID} / ${model.name}`,
            configured: true,
          })),
        ),
        Match.when("agents", () =>
          (ctx.data.location.agent.list() ?? []).map((agent) => ({
            server,
            value: agent.id,
            label: agent.name ?? agent.id,
            configured: true,
          })),
        ),
        Match.orElse(() => []),
      )

      return [...configured, ...historical, ...loaded]
    })

    const byKey = new Map(values.map((item) => [key(item), item]))

    return rankTranscriptFacets(values.map((item) => ({ ...item, key: key(item) }))).map((item) => ({
      ...byKey.get(item.key)!,
      ...item,
    }))
  }

  const selectedValues = (dimension: Filter, server: string) =>
    state[dimension].flatMap((value) => {
      // SAFETY: selection keys are constructed exclusively by key() from qualified facet options in this opening.
      const parsed = JSON.parse(value) as [string, string]

      return parsed[0] === server ? [parsed[1]] : []
    })

  // Metadata and indexing have their own cancellation scope and failure states. A
  // facet failure never excludes an otherwise searchable authenticated server.
  createEffect(() => {
    const connections = selected()
    state.metadataRevision
    const controller = new AbortController()
    const failed = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    setState({ metadataErrors: [], indexErrors: [] })

    const poll = async () => {
      let pending = false
      await Promise.all(
        connections.map(async (conn) => {
          const server = ServerConnection.key(conn)

          if (failed.has(server)) return
          const api = global.ensureServerCtx(conn).sdk.api.experimental.transcript

          try {
            const status = await api.status({ signal: controller.signal })

            if (controller.signal.aborted) return
            const previous = state.statusesByServer[server]?.ready
            setState("statusesByServer", server, status)

            if (status.ready) {
              if (previous === false) setState("revision", (value) => value + 1)

              return
            }

            const updated = await api.backfill({}, { signal: controller.signal })

            if (controller.signal.aborted) return
            setState("statusesByServer", server, updated)

            if (updated.ready) setState("revision", (value) => value + 1)

            if (!updated.ready) pending = true
          } catch {
            if (!controller.signal.aborted) {
              failed.add(server)
              setState("indexErrors", (values) => [...new Set([...values, server])])
            }
          }
        }),
      )

      if (pending && !controller.signal.aborted) timer = setTimeout(() => void poll(), 25)
    }

    connections.forEach((conn) => {
      const server = ServerConnection.key(conn)
      void global
        .ensureServerCtx(conn)
        .sdk.api.experimental.transcript.facets({ signal: controller.signal })
        .then((facets) => {
          if (!controller.signal.aborted) setState("facets", server, facets)
        })
        .catch(() => {
          if (!controller.signal.aborted) setState("metadataErrors", (values) => [...values, server])
        })
    })
    void poll()
    onCleanup(() => {
      controller.abort()
      clearTimeout(timer)
    })
  })

  createEffect(() => {
    const query = transcriptQuery(state.query, state.caseSensitive)
    const connections = selected()
    const paired = contentPairs()

    const dates = localDateBounds(state.from, state.to)

    const requests = connections.flatMap((conn) => {
      const server = ServerConnection.key(conn)

      if (
        (["projects", "models", "agents", "tools"] as const).some(
          (dimension) => state[dimension].length && !selectedValues(dimension, server).length,
        )
      )
        return []

      // SAFETY: role/status selections come exclusively from the fixed native controls below.
      return [
        {
          server,
          api: global.ensureServerCtx(conn).sdk.api.experimental.transcript,
          request: {
            ...query,
            ...dates,
            dateFrom: state.presetFrom ?? dates.dateFrom,
            projectIDs: selectedValues("projects", server),
            models: selectedValues("models", server).map((value) => {
              // SAFETY: model option values are encoded provider/model tuples from configured or historical facets.
              const [providerID, modelID] = JSON.parse(value) as [string, string]

              return { providerID, modelID }
            }),
            agents: selectedValues("agents", server),
            toolNames: selectedValues("tools", server),
            content: paired,
            roles: state.roles as TranscriptSearch.Request["roles"],
            toolStatuses: state.statuses as TranscriptSearch.Request["toolStatuses"],
            sessionKind: state.kind,
            archived: state.archived,
            sort: state.sort,
            limit: 40,
          },
        },
      ]
    })

    const sort = state.sort
    state.revision
    const current = ++generation
    const controller = new AbortController()
    setState({
      results: [],
      failed: [],
      error: "",
      loading: false,
      more: false,
      complete: false,
      scanLimited: false,
      truncated: 0,
      active: 0,
      scrollTop: 0,
    })

    if (list) list.scrollTop = 0

    const next = createTranscriptPagination(
      requests.map((item) => item.server),
      sort,
      controller.signal,
      async (server, cursor) => {
        const item = requests.find((item) => item.server === server)!

        return item.api.search({ ...item.request, ...query!, cursor }, { signal: controller.signal })
      },
    )

    more = async () => {
      if (current !== generation || controller.signal.aborted || state.loading) return
      setState("loading", true)
      const page = await next()

      if (current !== generation || controller.signal.aborted || !page) return
      setState({
        loading: false,
        failed: page.failed,
        error: page.error instanceof Error ? page.error.message : page.error ? String(page.error) : "",
        more: page.more,
        complete: page.complete,
        truncated: page.truncatedDocuments,
        scanLimited: page.scanLimited,
      })
      setState("results", (values) => [...values, ...page.hits])
    }

    const timer = query && connections.length ? setTimeout(() => void more?.(), 250) : undefined
    onCleanup(() => {
      controller.abort()
      clearTimeout(timer)
      more = undefined
    })
  })
  onCleanup(() => {
    generation++
  })
  onMount(() => field?.focus())

  const choose = (result: TranscriptResult | undefined) => {
    if (!result) return
    const conn = registry.list.find((conn) => ServerConnection.key(conn) === result.server)

    if (!conn) return
    global.ensureServerCtx(conn).projects.touch(result.hit.directory)
    const target = { messageID: result.hit.messageID, partID: result.hit.partID }
    tabs.select(tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: result.hit.sessionID }))
    navigate(
      `${sessionHref(ServerConnection.key(conn), result.hit.sessionID)}#search:${encodeURIComponent(JSON.stringify(target))}`,
      { state: { transcriptSearch: uuid() } },
    )
    dialog.close()
  }

  const visible = createMemo(() => {
    const start = Math.max(0, Math.floor(state.scrollTop / 112) - 3)
    const indices = Array.from({ length: Math.min(state.results.length - start, 12) }, (_, index) => start + index)

    if (state.results[state.active] && !indices.includes(state.active)) indices.push(state.active)

    return indices.sort((a, b) => a - b)
  })

  const reset = () =>
    setState({
      query: "",
      caseSensitive: false,
      projects: [],
      models: [],
      agents: [],
      tools: [],
      roles: [],
      content: [],
      statuses: [],
      kind: "all",
      archived: "all",
      sort: "newest",
      from: "",
      to: "",
      preset: "all",
      presetFrom: undefined,
      filterQuery: "",
    })

  // SAFETY: callers supply only the fixed filter/control identifiers with transcript.* English keys below.
  const label = (value: string) => language.t(`transcript.${value}` as "transcript.query")

  return (
    <Dialog class="transcript-dialog" containerClass="transcript-dialog-container">
      <DialogHeader>
        <DialogTitle>{language.t("transcript.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody data-scrollable>
        <div class="transcript-controls">
          <input
            ref={field}
            role="combobox"
            aria-label={language.t("transcript.query")}
            aria-controls={id}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={state.results[state.active] ? `${id}-${state.active}` : undefined}
            value={state.query}
            maxLength={256}
            placeholder={language.t("transcript.placeholder")}
            onInput={(event) => setState("query", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.isComposing || event.keyCode === 229) return

              if (event.key === "Enter") {
                event.preventDefault()
                choose(state.results[state.active])

                return
              }

              if (!state.results.length || !["ArrowDown", "ArrowUp"].includes(event.key)) return
              event.preventDefault()

              const index =
                (state.active + (event.key === "ArrowDown" ? 1 : -1) + state.results.length) % state.results.length

              setState("active", index)

              if (list) list.scrollTop = index * 112
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={state.caseSensitive}
              disabled={transcriptQuery(state.query, false)?.mode === "regex"}
              onChange={(event) => setState("caseSensitive", event.currentTarget.checked)}
            />
            {language.t("transcript.case")}
          </label>
          <details ref={filters}>
            <summary>{language.t("transcript.filters")}</summary>
            <div class="transcript-filter-grid">
              <fieldset>
                <legend>{language.t("transcript.servers")}</legend>
                <For each={registry.list}>
                  {(conn) => (
                    <label>
                      <input
                        type="checkbox"
                        checked={state.servers.includes(ServerConnection.key(conn))}
                        onChange={() => toggle("servers", ServerConnection.key(conn))}
                      />
                      {registry.label(conn)}
                    </label>
                  )}
                </For>
              </fieldset>
              <label>
                {language.t("transcript.filterSearch")}
                <input
                  value={state.filterQuery}
                  onInput={(event) => setState("filterQuery", event.currentTarget.value)}
                />
              </label>
              <For each={["projects", "models", "agents", "tools"] as const}>
                {(dimension) => (
                  <fieldset>
                    <legend>{label(dimension)}</legend>
                    <div class="transcript-options" data-scrollable>
                      <For
                        each={options(dimension).filter(
                          (item) =>
                            state[dimension].includes(key(item)) ||
                            `${item.label} ${serverName(item.server)}`
                              .toLowerCase()
                              .includes(state.filterQuery.toLowerCase()),
                        )}
                      >
                        {(item) => (
                          <label>
                            <input
                              type="checkbox"
                              checked={state[dimension].includes(key(item))}
                              disabled={state[dimension].length >= 100 && !state[dimension].includes(key(item))}
                              onChange={() => toggle(dimension, key(item))}
                            />
                            {item.label} · {serverName(item.server)}
                          </label>
                        )}
                      </For>
                    </div>
                  </fieldset>
                )}
              </For>
              <For
                each={[
                  { dimension: "roles" as const, values: ["user", "assistant"] },
                  { dimension: "content" as const, values: contentOptions },
                  { dimension: "statuses" as const, values: ["running", "completed", "error", "interrupted"] },
                ]}
              >
                {(group) => (
                  <fieldset>
                    <legend>{label(group.dimension)}</legend>
                    <For each={group.values}>
                      {(value) => (
                        <label>
                          <input
                            type="checkbox"
                            checked={state[group.dimension].includes(value)}
                            onChange={() => toggle(group.dimension, value)}
                          />
                          {label(value)}
                        </label>
                      )}
                    </For>
                  </fieldset>
                )}
              </For>
              <label>
                {language.t("transcript.kind")}
                <select
                  value={state.kind}
                  onChange={(event) => {
                    const value = event.currentTarget.value

                    if (value === "all" || value === "root" || value === "subagent") setState("kind", value)
                  }}
                >
                  <For each={["all", "root", "subagent"]}>
                    {(value) => <option value={value}>{label(value)}</option>}
                  </For>
                </select>
              </label>
              <label>
                {language.t("transcript.archive")}
                <select
                  value={state.archived}
                  onChange={(event) => {
                    const value = event.currentTarget.value

                    if (value === "all" || value === "active" || value === "archived") setState("archived", value)
                  }}
                >
                  <For each={["all", "active", "archived"]}>
                    {(value) => <option value={value}>{label(value)}</option>}
                  </For>
                </select>
              </label>
              <label>
                {language.t("transcript.dates")}
                <select
                  value={state.preset}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    setState("preset", value)

                    if (value === "custom") {
                      setState("presetFrom", undefined)

                      return
                    }

                    setState({
                      from: "",
                      to: "",
                      presetFrom: value === "all" ? undefined : Date.now() - Number(value) * 86400000,
                    })
                  }}
                >
                  <For each={["all", "1", "7", "30", "custom"]}>
                    {(value) => <option value={value}>{label(`date.${value}`)}</option>}
                  </For>
                </select>
              </label>
              <label>
                {language.t("transcript.from")}
                <input
                  type="date"
                  value={state.from}
                  onInput={(event) =>
                    setState({ from: event.currentTarget.value, preset: "custom", presetFrom: undefined })
                  }
                />
              </label>
              <label>
                {language.t("transcript.to")}
                <input
                  type="date"
                  value={state.to}
                  onInput={(event) =>
                    setState({ to: event.currentTarget.value, preset: "custom", presetFrom: undefined })
                  }
                />
              </label>
            </div>
          </details>
          <label>
            {language.t("transcript.sort")}
            <select
              value={state.sort}
              onChange={(event) => {
                const value = event.currentTarget.value

                if (value === "newest" || value === "oldest" || value === "session-title") setState("sort", value)
              }}
            >
              <For each={["newest", "oldest", "session-title"]}>
                {(value) => <option value={value}>{label(value)}</option>}
              </For>
            </select>
          </label>
        </div>
        <div role="status" aria-live="polite" class="transcript-status">
          <Show when={!state.servers.length}>{language.t("transcript.noServers")}</Show>
          <Show when={!state.query.trim()}>{language.t("transcript.emptyQuery")}</Show>
          <Show when={state.query.trim() && !transcriptQuery(state.query, state.caseSensitive)}>
            {language.t("transcript.invalid")}
          </Show>
          <Show when={state.loading}>{language.t("transcript.loading")}</Show>
          <Show when={selected().some((conn) => !state.statusesByServer[ServerConnection.key(conn)]?.ready)}>
            {language.t("transcript.indexing")}
          </Show>
          <Show when={state.complete && !state.results.length}>{language.t("transcript.noResults")}</Show>
          <Show when={state.complete && state.results.length}>{language.t("transcript.complete")}</Show>
          <Show when={state.scanLimited}>{language.t("transcript.scanLimited")}</Show>
          <Show when={state.truncated}>
            {language.plural("transcript.truncated", state.truncated, { count: state.truncated })}
          </Show>
        </div>
        <Show when={state.metadataErrors.length}>
          <p role="alert">
            {language.t("transcript.facetsFailed")} {state.metadataErrors.map(serverName).join(", ")}
          </p>
        </Show>
        <Show when={state.indexErrors.length}>
          <p role="alert">
            {language.t("transcript.indexFailed")} {state.indexErrors.map(serverName).join(", ")}
          </p>
          <Button onClick={() => setState("metadataRevision", (value) => value + 1)}>
            {language.t("transcript.retryIndex")}
          </Button>
        </Show>
        <Show when={state.failed.length}>
          <p role="alert">
            {language.t("transcript.failed")} {state.failed.map(serverName).join(", ")}: {state.error}
          </p>
          <Button
            onClick={() =>
              setState(
                "servers",
                state.servers.filter((key) => !state.failed.includes(key)),
              )
            }
          >
            {language.t("transcript.availableOnly")}
          </Button>
        </Show>
        <div
          ref={list}
          id={id}
          role="listbox"
          aria-label={language.t("transcript.results")}
          class="transcript-results"
          data-scrollable
          onScroll={(event) => setState("scrollTop", event.currentTarget.scrollTop)}
        >
          <div style={{ height: `${state.results.length * 112}px`, position: "relative" }}>
            <For each={visible()}>
              {(index) => {
                const item = () => state.results[index]!

                return (
                  <div
                    role="option"
                    id={`${id}-${index}`}
                    aria-selected={state.active === index}
                    class="transcript-result"
                    style={{ top: `${index * 112}px` }}
                    onPointerMove={() => setState("active", index)}
                    onClick={() => choose(item())}
                  >
                    <div class="transcript-result-title">
                      {item().hit.title || item().hit.sessionID} · {serverName(item().server)}
                    </div>
                    <div class="transcript-result-meta">
                      {item().hit.projectPath} · {label(item().hit.parentID ? "subagent" : "root")} ·{" "}
                      {label(item().hit.role)} / {label(item().hit.category)} ·{" "}
                      {new Date(item().hit.timeCreated).toLocaleString()} {item().hit.archived ? label("archived") : ""}
                    </div>
                    <div class="transcript-result-meta">
                      {[
                        item().hit.agent,
                        item().hit.providerID,
                        item().hit.modelID,
                        item().hit.toolName,
                        item().hit.toolStatus,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    <pre>
                      <For each={transcriptPreview(item().hit)}>
                        {(segment) => (segment.match ? <mark>{segment.text}</mark> : segment.text)}
                      </For>
                    </pre>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
        <p class="transcript-bound">{language.t("transcript.bounds")}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={reset}>
          {language.t("transcript.reset")}
        </Button>
        <Button disabled={state.loading || !state.more} onClick={() => void more?.()}>
          {language.t(state.failed.length ? "transcript.retry" : "transcript.more")}
        </Button>
        <Button variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.close")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
