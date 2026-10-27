import type { TranscriptSearchFacetsResponse } from "@opencode-ai/sdk/v2"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { sessionHref } from "@/utils/session-route"
import {
  appendTranscriptHits,
  sortTranscriptHits,
  transcriptPreview,
  transcriptQuery,
  transcriptSearchComplete,
  transcriptServersToFetch,
  toggleTranscriptFilter,
  type TranscriptHit,
  type TranscriptResult,
} from "./transcript-search"
import "./dialog-transcript-search.css"

type ModelIdentity = { providerID: string; modelID: string }
type FilterOption = { key: string; label: string }
type SearchResult = { server: string; hit: TranscriptHit }
type DatePreset = "all" | "24h" | "7d" | "30d" | "custom"
type RoleFilter = "user" | "assistant"
type ContentFilter = "user-text" | "assistant-text" | "tool-input" | "tool-output" | "errors"
type ToolStatusFilter = "succeeded" | "failed" | "running" | "interrupted"

const emptyFilters = {
  projects: [] as string[],
  models: [] as string[],
  agents: [] as string[],
  roles: [] as RoleFilter[],
  content: [] as ContentFilter[],
  toolStatuses: [] as ToolStatusFilter[],
  tools: [] as string[],
  sessionKind: "all" as "all" | "root" | "subagent",
  archived: "all" as "all" | "active" | "archived",
  sort: "newest" as "newest" | "oldest" | "session-title",
  datePreset: "all" as DatePreset,
  sinceEnabled: false,
  since: "",
  untilEnabled: false,
  until: "",
  servers: [] as string[],
}

const selectedLabel = (server: string, value: string) => `${server}\0${value}`
const selectedModelLabel = (server: string, value: ModelIdentity) => `${server}\0${value.providerID}\0${value.modelID}`

function FilterSelect(props: {
  label: string
  options: FilterOption[]
  selected: string[]
  onChange: (value: string[]) => void
  searchPlaceholder: string
  empty: string
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ open: false, search: "" })
  const options = createMemo(() => {
    const query = state.search.trim().toLocaleLowerCase()
    const values = props.options
    return query ? values.filter((option) => option.label.toLocaleLowerCase().includes(query)) : values
  })
  const toggle = (key: string) => {
    props.onChange(toggleTranscriptFilter(props.selected, key))
  }

  return (
    <details
      class="transcript-search-filter"
      onToggle={(event) => {
        const open = event.currentTarget.open
        setState({ open, search: open ? "" : state.search })
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !state.open) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.open = false
      }}
    >
      <summary>
        <span>{props.label}</span>
        <Show when={props.selected.length > 0}>
          <span
            class="transcript-search-count"
            aria-label={language.t("transcriptSearch.selectedCount", { count: props.selected.length })}
          >
            {props.selected.length}
          </span>
        </Show>
      </summary>
      <div class="transcript-search-filter-menu">
        <input
          type="search"
          value={state.search}
          placeholder={props.searchPlaceholder}
          aria-label={props.searchPlaceholder}
          onInput={(event) => setState("search", event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.closest("details")!.open = false
              return
            }
            event.stopPropagation()
          }}
        />
        <Show when={options().length > 0} fallback={<p class="transcript-search-note">{props.empty}</p>}>
          <div class="transcript-search-filter-options">
            <For each={options()}>
              {(option) => (
                <label>
                  <input
                    type="checkbox"
                    checked={props.selected.includes(option.key)}
                    disabled={!props.selected.includes(option.key) && props.selected.length >= 100}
                    onChange={() => toggle(option.key)}
                  />
                  <span>{option.label}</span>
                </label>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.selected.length >= 100}>
          <p class="transcript-search-note">{language.t("transcriptSearch.selectionLimit")}</p>
        </Show>
      </div>
    </details>
  )
}

export function DialogTranscriptSearch() {
  const global = useGlobal()
  const server = useServer()
  const layout = useLayout()
  const tabs = useTabs()
  const navigate = useNavigate()
  const dialog = useDialog()
  const language = useLanguage()
  const route = layout.route()
  const displayServer = (key: string) => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
    return conn ? `${serverName(conn)} · ${key}` : key
  }
  const [state, setState] = createStore({
    query: "",
    caseSensitive: false,
    filters: {
      ...emptyFilters,
      servers: [String((route.type === "home" ? layout.home.selection().server : route.server) ?? server.key)],
    },
    hits: [] as TranscriptResult[],
    facets: {} as Record<string, TranscriptSearchFacetsResponse | undefined>,
    ready: {} as Record<string, boolean | undefined>,
    active: 0,
    loading: false,
    error: false,
    failedServers: [] as string[],
    errorMessage: "",
    visibleCount: 40,
    complete: false,
    scanLimited: false,
    truncatedDocuments: 0,
    cursors: {} as Record<string, string | null | undefined>,
    refresh: 0,
  })

  const selectedServers = createMemo(() =>
    state.filters.servers.filter((key) => global.servers.list().some((conn) => ServerConnection.key(conn) === key)),
  )
  const search = createMemo(() => transcriptQuery(state.query, state.caseSensitive))
  const allFacets = createMemo(() =>
    global.servers.list().flatMap((conn) => {
      const key = ServerConnection.key(conn)
      const facets = state.facets[key]
      return facets ? [{ key, facets }] : []
    }),
  )
  const projectOptions = createMemo<FilterOption[]>(() => {
    const options = new Map<string, string>()
    for (const { key, facets } of allFacets()) {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      const serverLabel = displayServer(key)
      for (const project of facets.projectDetails) {
        const identity = selectedLabel(key, project.id)
        options.set(identity, `${serverLabel}${project.path ? ` · ${project.path}` : ""} · ${project.id}`)
      }
      if (!conn) continue
      const ctx = global.ensureServerCtx(conn)
      for (const project of ctx.sync.data.project) {
        options.set(selectedLabel(key, project.id), `${serverName(conn)} · ${project.worktree} · ${project.id}`)
      }
    }
    return Array.from(options, ([key, label]) => ({ key, label }))
  })
  const modelOptions = createMemo<FilterOption[]>(() => {
    const options = new Map<string, string>()
    for (const { key, facets } of allFacets()) {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      const serverLabel = displayServer(key)
      for (const model of facets.modelIdentities) {
        const identity = selectedModelLabel(key, model)
        options.set(identity, `${serverLabel} · ${model.providerID}/${model.modelID}`)
      }
      if (!conn) continue
      const providers = global.ensureServerCtx(conn).sync.data.provider?.all
      if (!providers) continue
      for (const [providerID, provider] of providers) {
        for (const model of Object.values(provider.models)) {
          const identity = selectedModelLabel(key, { providerID, modelID: model.id })
          options.set(identity, `${serverLabel} · ${providerID}/${model.id}`)
        }
      }
    }
    return Array.from(options, ([key, label]) => ({ key, label }))
  })
  const agentOptions = createMemo<FilterOption[]>(() => {
    const options = new Map<string, string>()
    for (const { key, facets } of allFacets()) {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      const serverLabel = displayServer(key)
      for (const value of facets.agents) options.set(selectedLabel(key, value), `${serverLabel} · ${value}`)
      if (!conn) continue
      for (const name of Object.keys(global.ensureServerCtx(conn).sync.data.config.agent ?? {}))
        options.set(selectedLabel(key, name), `${serverLabel} · ${name}`)
    }
    return Array.from(options, ([key, label]) => ({ key, label }))
  })
  const toolOptions = createMemo<FilterOption[]>(() => {
    const options = new Map<string, string>()
    for (const { key, facets } of allFacets()) {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      const serverLabel = displayServer(key)
      for (const value of facets.tools) options.set(selectedLabel(key, value), `${serverLabel} · ${value}`)
      if (!conn) continue
      for (const agent of Object.values(global.ensureServerCtx(conn).sync.data.config.agent ?? {}))
        for (const value of Object.keys(agent?.tools ?? {}))
          options.set(selectedLabel(key, value), `${serverLabel} · ${value}`)
    }
    return Array.from(options, ([key, label]) => ({ key, label }))
  })
  const serverOptions = createMemo(() =>
    global.servers
      .list()
      .map((conn) => ({ key: ServerConnection.key(conn), label: displayServer(ServerConnection.key(conn)) })),
  )
  const queryFilters = createMemo(() => {
    const filters = state.filters
    const textContent = filters.content.filter((value) => value === "user-text" || value === "assistant-text")
    const contentRoles = [
      ...(filters.content.includes("user-text") ? ["user" as const] : []),
      ...(filters.content.includes("assistant-text") || filters.content.some((value) => value !== "user-text")
        ? ["assistant" as const]
        : []),
    ]
    const roles = filters.roles.length ? filters.roles : contentRoles
    const constrainedRoles =
      filters.roles.length && contentRoles.length ? roles.filter((role) => contentRoles.includes(role)) : roles
    const contradictory =
      filters.roles.length > 0 && filters.content.length > 0 && contentRoles.length > 0 && constrainedRoles.length === 0
    const categories = [
      ...(textContent.length ? ["text" as const] : []),
      ...(filters.content.includes("tool-input") ? ["tool-input" as const] : []),
      ...(filters.content.includes("tool-output") ? ["tool-output" as const] : []),
      ...(filters.content.includes("errors") ? (["tool-error", "assistant-error"] as const) : []),
    ]
    const now = Date.now()
    const presetFrom =
      filters.datePreset === "24h"
        ? now - 24 * 60 * 60 * 1000
        : filters.datePreset === "7d"
          ? now - 7 * 24 * 60 * 60 * 1000
          : filters.datePreset === "30d"
            ? now - 30 * 24 * 60 * 60 * 1000
            : undefined
    const dateFrom =
      filters.datePreset === "custom"
        ? filters.sinceEnabled && filters.since
          ? new Date(`${filters.since}T00:00:00`).getTime()
          : undefined
        : presetFrom
    const dateTo =
      filters.datePreset === "custom" && filters.untilEnabled && filters.until
        ? new Date(`${filters.until}T23:59:59.999`).getTime()
        : undefined
    const serverRequests = selectedServers().map((key) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      const ctx = conn && global.ensureServerCtx(conn)
      const selectedModels = filters.models.flatMap((value) => {
        const [serverKey, providerID, ...modelParts] = value.split("\0")
        const modelID = modelParts.join("\0")
        return serverKey === key && providerID && modelID ? [{ providerID, modelID }] : []
      })
      const projectIDs = filters.projects.flatMap((value) => {
        const [serverKey, projectID] = value.split("\0")
        return serverKey === key && projectID ? [projectID] : []
      })
      const agents = filters.agents.flatMap((value) => {
        const [serverKey, ...agentParts] = value.split("\0")
        const agent = agentParts.join("\0")
        return serverKey === key && agent ? [agent] : []
      })
      const toolNames = filters.tools.flatMap((value) => {
        const [serverKey, ...toolParts] = value.split("\0")
        const tool = toolParts.join("\0")
        return serverKey === key && tool ? [tool] : []
      })
      return {
        key,
        skip:
          (filters.projects.length > 0 && projectIDs.length === 0) ||
          (filters.models.length > 0 && selectedModels.length === 0) ||
          (filters.agents.length > 0 && agents.length === 0) ||
          (filters.tools.length > 0 && toolNames.length === 0),
        request: {
          ...search().parameters,
          projectIDs,
          models: selectedModels.length ? selectedModels : undefined,
          agents,
          roles: constrainedRoles.length ? constrainedRoles : undefined,
          categories: categories.length ? categories : undefined,
          toolNames,
          toolStatuses: filters.toolStatuses.map((value) =>
            value === "succeeded" ? ("completed" as const) : value === "failed" ? ("error" as const) : value,
          ),
          dateFrom,
          dateTo,
          sessionKind: filters.sessionKind,
          archived: filters.archived,
          sort: filters.sort,
        },
      }
    })
    return { requests: serverRequests.filter((item) => !item.skip), contradictory }
  })
  const sort = createMemo(() => state.filters.sort)
  const hasMore = createMemo(
    () =>
      Object.values(state.cursors).some((cursor) => typeof cursor === "string" && cursor.length > 0) ||
      state.failedServers.length > 0,
  )
  const visibleHits = createMemo(() => state.hits.slice(0, state.visibleCount))
  let resultsViewport: HTMLDivElement | undefined
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLButtonElement>({
    get count() {
      return visibleHits().length
    },
    getScrollElement: () => resultsViewport ?? null,
    initialRect: { width: 0, height: 360 },
    estimateSize: () => 112,
    overscan: 8,
    get getItemKey() {
      const current = visibleHits()
      return (index: number) => {
        const result = current[index]
        return result ? `${result.server}\0${result.hit.documentID}:${result.hit.offset}` : index
      }
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      if (!visibleHits().length) return indexes
      if (indexes.includes(state.active)) return indexes
      return [...indexes, state.active].sort((a, b) => a - b)
    },
  })
  let loadMore = () => {}

  createEffect(
    on(
      () => selectedServers().join("\0"),
      () => {
        const keys = selectedServers()
        const controller = new AbortController()
        const timers = new Map<string, ReturnType<typeof setTimeout>>()
        for (const key of keys) {
          let hasFacets = state.facets[key] !== undefined
          let wasIndexing = false
          const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
          if (!conn) continue
          const api = global.ensureServerCtx(conn).sdk.client.transcriptSearch
          const options = { signal: controller.signal, throwOnError: true as const }
          const facets = () =>
            api.facets(options).then((result) => {
              if (!controller.signal.aborted) {
                hasFacets = true
                setState("facets", key, result.data)
              }
            })
          const poll = async () => {
            try {
              const result = await api.status(options)
              if (controller.signal.aborted) return
              setState("ready", key, result.data.ready)
              if (!result.data.ready) {
                wasIndexing = true
                await api.backfill(options)
                if (controller.signal.aborted) return
                timers.set(
                  key,
                  setTimeout(() => void poll(), 25),
                )
                return
              }
              if (wasIndexing || !hasFacets) {
                setState("refresh", (value) => value + 1)
                await facets()
              }
            } catch {
              if (!controller.signal.aborted)
                setState("failedServers", (values) => Array.from(new Set([...values, key])))
            }
          }
          void facets().catch(() => {
            if (!controller.signal.aborted) setState("failedServers", (values) => Array.from(new Set([...values, key])))
          })
          void poll()
        }
        onCleanup(() => {
          controller.abort()
          for (const timer of timers.values()) clearTimeout(timer)
        })
      },
    ),
  )

  createEffect(
    on([() => JSON.stringify(queryFilters()), () => state.refresh], () => {
      const { requests, contradictory } = queryFilters()
      const controller = new AbortController()
      const cursors: Record<string, string | null | undefined> = {}
      const failures = new Set<string>()
      let busy = false
      setState({
        hits: [],
        cursors: {},
        error: false,
        errorMessage: "",
        failedServers: [],
        active: 0,
        visibleCount: 40,
        complete: false,
        scanLimited: false,
        truncatedDocuments: 0,
        loading: false,
      })
      const fetch = async (more: boolean) => {
        if (busy || controller.signal.aborted || !search().parameters || contradictory) return
        busy = true
        setState("loading", true)
        const available = transcriptServersToFetch(requests, cursors, failures, more)
        const results = await Promise.allSettled(
          available.map(async ({ key, request }) => {
            const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
            if (!conn) throw new Error(key)
            const result = await global
              .ensureServerCtx(conn)
              .sdk.client.transcriptSearch.search(
                { ...request, cursor: more ? (cursors[key] ?? undefined) : undefined, limit: 40 },
                { signal: controller.signal, throwOnError: true },
              )
            return { key, data: result.data }
          }),
        )
        if (controller.signal.aborted) return
        const incoming: SearchResult[] = []
        const failed: string[] = []
        let complete = true
        let scanLimited = false
        let truncatedDocuments = 0
        let firstError = ""
        results.forEach((result, index) => {
          const key = available[index]?.key
          if (!key) return
          if (result.status === "rejected") {
            failures.add(key)
            firstError ||= result.reason instanceof Error ? result.reason.message : String(result.reason)
            return
          }
          failures.delete(key)
          const { data } = result.value
          cursors[key] = data.nextCursor
          setState("cursors", key, data.nextCursor)
          incoming.push(...data.hits.map((hit) => ({ server: key, hit })))
          scanLimited ||= data.scanLimited
          truncatedDocuments += Number(data.truncatedDocuments)
          setState("ready", key, data.status.ready)
        })
        failed.push(...failures)
        complete = transcriptSearchComplete(requests, cursors, failures, state.ready)
        setState("hits", (existing) => sortTranscriptHits(appendTranscriptHits(more ? existing : [], incoming), sort()))
        if (more) setState("visibleCount", (count) => count + 40)
        setState({
          failedServers: failed,
          error: failed.length > 0 && incoming.length === 0 && state.hits.length === 0,
          errorMessage: firstError,
          complete,
          scanLimited,
          truncatedDocuments,
        })
        busy = false
        setState("loading", false)
      }
      loadMore = () => {
        if (hasMore()) {
          void fetch(true)
          return
        }
        setState("visibleCount", (count) => count + 40)
      }
      const timer = setTimeout(() => void fetch(false), 250)
      onCleanup(() => {
        controller.abort()
        clearTimeout(timer)
      })
    }),
  )

  const select = (result: TranscriptResult) => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === result.server)
    if (!conn) return
    const ctx = global.ensureServerCtx(conn)
    ctx.projects.open(result.hit.directory)
    ctx.projects.touch(result.hit.directory)
    const tab = tabs.addSessionTab({
      server: ServerConnection.Key.make(result.server),
      sessionId: result.hit.sessionID,
    })
    tabs.remember(tab)
    const target = encodeURIComponent(
      JSON.stringify({
        messageID: result.hit.navigationMessageID ?? result.hit.messageID,
        partID: result.hit.partID ?? null,
      }),
    )
    navigate(`${sessionHref(ServerConnection.Key.make(result.server), result.hit.sessionID)}#search:${target}`)
    dialog.close()
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || !visibleHits().length) return
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return
    event.preventDefault()
    if (event.key === "Enter") {
      const result = state.hits[state.active]
      if (result) select(result)
      return
    }
    const index = (state.active + (event.key === "ArrowDown" ? 1 : -1) + visibleHits().length) % visibleHits().length
    setState("active", index)
    virtualizer.scrollToIndex(index, { align: "auto" })
  }
  const reset = () =>
    setState({ query: "", caseSensitive: false, filters: { ...emptyFilters, servers: selectedServers().slice() } })
  const toggle = <T extends string>(values: T[], value: T) =>
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
  const filterOptions = (entries: readonly [string, string][]) => entries.map(([key, label]) => ({ key, label }))
  const roleOptions = filterOptions([
    ["user", language.t("transcriptSearch.user")],
    ["assistant", language.t("transcriptSearch.assistant")],
  ])
  const contentOptions = filterOptions([
    ["user-text", language.t("transcriptSearch.userText")],
    ["assistant-text", language.t("transcriptSearch.assistantText")],
    ["tool-input", language.t("transcriptSearch.toolInput")],
    ["tool-output", language.t("transcriptSearch.toolOutput")],
    ["errors", language.t("transcriptSearch.errors")],
  ])
  const statusOptions = filterOptions([
    ["succeeded", language.t("transcriptSearch.succeeded")],
    ["failed", language.t("transcriptSearch.failedStatus")],
    ["running", language.t("transcriptSearch.running")],
    ["interrupted", language.t("transcriptSearch.interrupted")],
  ])

  return (
    <Dialog size="large" class="transcript-search" containerClass="transcript-search-container">
      <DialogHeader>
        <DialogTitle>{language.t("transcriptSearch.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="transcript-search-body">
        <TextInputV2
          autofocus
          appearance="large"
          value={state.query}
          autocomplete="off"
          spellcheck={false}
          placeholder={language.t("transcriptSearch.placeholder")}
          aria-label={language.t("transcriptSearch.title")}
          role="combobox"
          aria-expanded={visibleHits().length > 0}
          aria-controls="transcript-results"
          aria-autocomplete="list"
          aria-activedescendant={visibleHits().length ? `transcript-result-${state.active}` : undefined}
          leadingIcon={<Icon name="magnifying-glass" />}
          invalid={search().invalid}
          showClearButton={!!state.query}
          clearLabel={language.t("common.clear")}
          onClearClick={() => setState("query", "")}
          onInput={(event) => setState("query", event.currentTarget.value)}
          onKeyDown={keydown}
        />
        <div class="transcript-search-filters" aria-label={language.t("transcriptSearch.filters")}>
          <FilterSelect
            label={language.t("transcriptSearch.project")}
            options={projectOptions()}
            selected={state.filters.projects}
            onChange={(value) => setState("filters", "projects", value)}
            searchPlaceholder={language.t("transcriptSearch.filterOptions")}
            empty={language.t("transcriptSearch.noFilterOptions")}
          />
          <FilterSelect
            label={language.t("transcriptSearch.model")}
            options={modelOptions()}
            selected={state.filters.models}
            onChange={(value) => setState("filters", "models", value)}
            searchPlaceholder={language.t("transcriptSearch.filterOptions")}
            empty={language.t("transcriptSearch.noFilterOptions")}
          />
          <FilterSelect
            label={language.t("transcriptSearch.agent")}
            options={agentOptions()}
            selected={state.filters.agents}
            onChange={(value) => setState("filters", "agents", value)}
            searchPlaceholder={language.t("transcriptSearch.filterOptions")}
            empty={language.t("transcriptSearch.noFilterOptions")}
          />
          <FilterSelect
            label={language.t("transcriptSearch.role")}
            options={roleOptions}
            selected={state.filters.roles}
            onChange={(value) => setState("filters", "roles", value as RoleFilter[])}
            searchPlaceholder={language.t("transcriptSearch.filterOptions")}
            empty={language.t("transcriptSearch.noFilterOptions")}
          />
          <FilterSelect
            label={language.t("transcriptSearch.content")}
            options={contentOptions}
            selected={state.filters.content}
            onChange={(value) => setState("filters", "content", value as ContentFilter[])}
            searchPlaceholder={language.t("transcriptSearch.filterOptions")}
            empty={language.t("transcriptSearch.noFilterOptions")}
          />
          <FilterSelect
            label={language.t("transcriptSearch.toolStatus")}
            options={statusOptions}
            selected={state.filters.toolStatuses}
            onChange={(value) => setState("filters", "toolStatuses", value as ToolStatusFilter[])}
            searchPlaceholder={language.t("transcriptSearch.filterOptions")}
            empty={language.t("transcriptSearch.noFilterOptions")}
          />
          <details
            class="transcript-search-filter transcript-search-date"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.open = false
            }}
          >
            <summary>{language.t("transcriptSearch.date")}</summary>
            <div class="transcript-search-filter-menu">
              <label>
                <input
                  type="radio"
                  name="transcript-date"
                  checked={state.filters.datePreset === "24h"}
                  onChange={() => setState("filters", "datePreset", "24h")}
                />
                {language.t("transcriptSearch.last24Hours")}
              </label>
              <label>
                <input
                  type="radio"
                  name="transcript-date"
                  checked={state.filters.datePreset === "7d"}
                  onChange={() => setState("filters", "datePreset", "7d")}
                />
                {language.t("transcriptSearch.last7Days")}
              </label>
              <label>
                <input
                  type="radio"
                  name="transcript-date"
                  checked={state.filters.datePreset === "30d"}
                  onChange={() => setState("filters", "datePreset", "30d")}
                />
                {language.t("transcriptSearch.last30Days")}
              </label>
              <label>
                <input
                  type="radio"
                  name="transcript-date"
                  checked={state.filters.datePreset === "all"}
                  onChange={() => setState("filters", "datePreset", "all")}
                />
                {language.t("transcriptSearch.allTime")}
              </label>
              <label>
                <input
                  type="radio"
                  name="transcript-date"
                  checked={state.filters.datePreset === "custom"}
                  onChange={() => setState("filters", "datePreset", "custom")}
                />
                {language.t("transcriptSearch.customRange")}
              </label>
              <Show when={state.filters.datePreset === "custom"}>
                <label>
                  <input
                    type="checkbox"
                    checked={state.filters.sinceEnabled}
                    onChange={(event) => setState("filters", { sinceEnabled: event.currentTarget.checked })}
                  />
                  {language.t("transcriptSearch.since")}
                  <input
                    type="date"
                    value={state.filters.since}
                    disabled={!state.filters.sinceEnabled}
                    onInput={(event) => setState("filters", "since", event.currentTarget.value)}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={state.filters.untilEnabled}
                    onChange={(event) => setState("filters", { untilEnabled: event.currentTarget.checked })}
                  />
                  {language.t("transcriptSearch.until")}
                  <input
                    type="date"
                    value={state.filters.until}
                    disabled={!state.filters.untilEnabled}
                    onInput={(event) => setState("filters", "until", event.currentTarget.value)}
                  />
                </label>
              </Show>
            </div>
          </details>
          <details
            class="transcript-search-filter transcript-search-more"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.open = false
            }}
          >
            <summary>{language.t("transcriptSearch.more")}</summary>
            <div class="transcript-search-more-menu">
              <FilterSelect
                label={language.t("transcriptSearch.toolName")}
                options={toolOptions()}
                selected={state.filters.tools}
                onChange={(value) => setState("filters", "tools", value)}
                searchPlaceholder={language.t("transcriptSearch.filterOptions")}
                empty={language.t("transcriptSearch.noFilterOptions")}
              />
              <label class="transcript-search-field">
                {language.t("transcriptSearch.sessionType")}
                <select
                  value={state.filters.sessionKind}
                  onChange={(event) =>
                    setState("filters", "sessionKind", event.currentTarget.value as typeof emptyFilters.sessionKind)
                  }
                >
                  <option value="all">{language.t("transcriptSearch.all")}</option>
                  <option value="root">{language.t("transcriptSearch.mainSession")}</option>
                  <option value="subagent">{language.t("transcriptSearch.subagent")}</option>
                </select>
              </label>
              <Show when={serverOptions().length > 1}>
                <FilterSelect
                  label={language.t("transcriptSearch.server")}
                  options={serverOptions()}
                  selected={state.filters.servers}
                  onChange={(value) => setState("filters", "servers", value)}
                  searchPlaceholder={language.t("transcriptSearch.filterOptions")}
                  empty={language.t("transcriptSearch.noFilterOptions")}
                />
              </Show>
              <label class="transcript-search-field">
                {language.t("transcriptSearch.archive")}
                <select
                  value={state.filters.archived}
                  onChange={(event) =>
                    setState("filters", "archived", event.currentTarget.value as typeof emptyFilters.archived)
                  }
                >
                  <option value="all">{language.t("transcriptSearch.all")}</option>
                  <option value="archived">{language.t("transcriptSearch.archivedOnly")}</option>
                  <option value="active">{language.t("transcriptSearch.excludeArchived")}</option>
                </select>
              </label>
              <label class="transcript-search-field">
                {language.t("transcriptSearch.sort")}
                <select
                  value={state.filters.sort}
                  onChange={(event) =>
                    setState("filters", "sort", event.currentTarget.value as typeof emptyFilters.sort)
                  }
                >
                  <option value="newest">{language.t("transcriptSearch.newest")}</option>
                  <option value="oldest">{language.t("transcriptSearch.oldest")}</option>
                  <option value="session-title">{language.t("transcriptSearch.sessionTitle")}</option>
                </select>
              </label>
            </div>
          </details>
        </div>
        <div class="transcript-search-actions">
          <label>
            <input
              type="checkbox"
              checked={state.caseSensitive}
              disabled={search().parameters?.mode === "regex"}
              onChange={(event) => setState("caseSensitive", event.currentTarget.checked)}
            />
            {language.t("transcriptSearch.caseSensitive")}
          </label>
          <button type="button" onClick={reset}>
            {language.t("transcriptSearch.reset")}
          </button>
        </div>
        <Show when={search().invalid}>
          <p role="alert">
            {search().short
              ? language.t("transcriptSearch.minimumLength")
              : language.t("transcriptSearch.invalidRegex")}
          </p>
        </Show>
        <Show when={state.error}>
          <p role="alert">
            {language.t("transcriptSearch.failed")}
            <Show when={state.errorMessage}>
              <span> {state.errorMessage}</span>
            </Show>{" "}
            <button type="button" onClick={() => setState("refresh", (value) => value + 1)}>
              {language.t("transcriptSearch.retry")}
            </button>
          </p>
        </Show>
        <Show when={state.failedServers.length > 0 && !state.error}>
          <p role="status">
            {language.t("transcriptSearch.serverFailures", {
              servers: state.failedServers.map(displayServer).join(", "),
            })}
          </p>
        </Show>
        <Show when={allFacets().some(({ facets }) => facets.truncated)}>
          <p role="status">{language.t("transcriptSearch.facetsTruncated")}</p>
        </Show>
        <Show when={selectedServers().some((key) => state.ready[key] === false)}>
          <p role="status">{language.t("transcriptSearch.backfill")}</p>
        </Show>
        <Show when={queryFilters().contradictory}>
          <p role="status">{language.t("transcriptSearch.noResults")}</p>
        </Show>
        <Show when={state.loading}>
          <p role="status">{language.t("transcriptSearch.loading")}</p>
        </Show>
        <Show when={!state.query.trim()}>
          <p role="status">{language.t("transcriptSearch.enterQuery")}</p>
        </Show>
        <Show when={state.query.trim()}>
          <p role="status" class="transcript-search-note">
            {language.t("transcriptSearch.contentLimitWarning")}
          </p>
        </Show>
        <Show when={state.scanLimited}>
          <p role="status">{language.t("transcriptSearch.scanLimited")}</p>
        </Show>
        <Show when={state.truncatedDocuments > 0}>
          <p role="status">{language.t("transcriptSearch.truncatedPage", { count: state.truncatedDocuments })}</p>
        </Show>
        <Show
          when={
            !state.loading && !state.error && state.query.trim() && !queryFilters().contradictory && !state.hits.length
          }
        >
          <p role="status">
            {state.failedServers.length
              ? language.t("transcriptSearch.partialFailure")
              : language.t("transcriptSearch.noResults")}
          </p>
        </Show>
        <div
          id="transcript-results"
          class="transcript-search-results"
          ref={(el) => (resultsViewport = el)}
          role="listbox"
          aria-label={language.t("transcriptSearch.title")}
          aria-busy={state.loading}
        >
          <div class="transcript-search-result-space" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <For each={virtualizer.getVirtualItems()}>
              {(item) => {
                const result = visibleHits()[item.index]!
                const hit = result.hit
                return (
                  <button
                    id={`transcript-result-${item.index}`}
                    type="button"
                    role="option"
                    aria-selected={state.active === item.index}
                    class="transcript-search-result"
                    data-index={item.index}
                    ref={(el) => virtualizer.measureElement(el)}
                    style={{
                      position: "absolute",
                      top: "0",
                      left: "0",
                      width: "100%",
                      transform: `translateY(${item.start}px)`,
                    }}
                    onFocus={() => setState("active", item.index)}
                    onClick={() => select(result)}
                    onKeyDown={keydown}
                  >
                    <strong>{hit.title}</strong>
                    <span class="transcript-search-meta">
                      {hit.projectPath || hit.directory} · {displayServer(result.server)}
                      {hit.parentID
                        ? ` · ${language.t("transcriptSearch.subagent")}`
                        : ` · ${language.t("transcriptSearch.mainSession")}`}
                    </span>
                    <span class="transcript-search-meta">
                      {language.t(hit.role === "user" ? "transcriptSearch.user" : "transcriptSearch.assistant")} ·{" "}
                      {language.t(`transcriptSearch.category.${hit.category}`)} ·{" "}
                      {new Date(Number(hit.timeCreated)).toLocaleString(language.intl())}
                      <Show when={hit.agent}>
                        {" "}
                        · {language.t("transcriptSearch.agentValue", { agent: hit.agent ?? "" })}
                      </Show>
                      <Show when={hit.providerID && hit.modelID}>
                        {" "}
                        · {hit.providerID}/{hit.modelID}
                      </Show>
                      <Show when={hit.toolName}>
                        {" "}
                        · {language.t("transcriptSearch.toolValue", { tool: hit.toolName ?? "" })}
                      </Show>
                      <Show when={hit.toolStatus}> · {language.t(`transcriptSearch.status.${hit.toolStatus}`)}</Show>
                      <Show when={hit.archived}> · {language.t("transcriptSearch.archivedOnly")}</Show>
                    </span>
                    <span class="transcript-search-excerpt">
                      <For each={transcriptPreview(hit)}>
                        {(segment) => (
                          <Show when={segment.match} fallback={segment.text}>
                            <mark>{segment.text}</mark>
                          </Show>
                        )}
                      </For>
                    </span>
                    <Show when={hit.truncated}>
                      <span class="transcript-search-note">{language.t("transcriptSearch.truncated")}</span>
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
        <Show when={hasMore() || state.hits.length > state.visibleCount}>
          <button type="button" disabled={state.loading} onClick={() => loadMore()}>
            {language.t("common.loadMore")}
          </button>
        </Show>
        <Show when={state.complete && state.hits.length > 0}>
          <p role="status" class="transcript-search-note">
            {language.t("transcriptSearch.complete")}
          </p>
        </Show>
        <p class="transcript-search-note">{language.t("transcriptSearch.navigation")}</p>
      </DialogBody>
    </Dialog>
  )
}
