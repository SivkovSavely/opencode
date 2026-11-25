import { ProjectAppearance } from "@opencode-ai/schema/project-appearance"
import { Schema } from "effect"
import { createSignal, onCleanup } from "solid-js"
import type { LocalProject } from "./layout"
import type { ProjectMeta } from "./global-sync/types"
import type { ServerSDK } from "./server-sdk"
import { pathKey } from "@/utils/path-key"
import { authTokenFromCredentials } from "@/utils/server"

export const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
export const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"

export function applyProjectAppearance(
  project: LocalProject,
  appearance?: ProjectAppearance.Fields,
  legacy?: ProjectMeta,
  legacyIcon?: string,
): LocalProject {
  const base = { ...project.icon, ...legacy?.icon }
  const override = appearance?.icon === undefined ? legacyIcon || base.override : (appearance.icon ?? undefined)
  // Empty URL also suppresses the built-in OpenCode logo in avatar consumers.
  const url = appearance?.icon !== undefined || appearance?.color ? "" : base.url
  const color = appearance?.color === undefined ? base.color : (appearance.color ?? undefined)
  const automatic = !override && !url && !(url === undefined && project.id === OPENCODE_PROJECT_ID)
  const hash = () => Array.from(pathKey(project.worktree)).reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) | 0, 0)
  return {
    ...project,
    name: appearance?.name === undefined ? (legacy?.name ?? project.name) : (appearance.name ?? undefined),
    commands: legacy?.commands ?? project.commands,
    icon: {
      override,
      url,
      color: color || (automatic ? AVATAR_COLOR_KEYS[Math.abs(hash()) % AVATAR_COLOR_KEYS.length] : undefined),
    },
  }
}

export function createProjectAppearance(remote: {
  list: () => Promise<ProjectAppearance.Snapshot>
  update: (patch: ProjectAppearance.Patch) => Promise<ProjectAppearance.Snapshot>
}) {
  const [snapshot, setSnapshot] = createSignal<ProjectAppearance.Snapshot>()
  let disposed = false
  onCleanup(() => (disposed = true))

  function apply(next: ProjectAppearance.Snapshot) {
    if (disposed) return
    // A GET or a mutation response can arrive after a newer event-triggered GET.
    setSnapshot((current) => (!current || next.revision > current.revision ? next : current))
  }

  return {
    get(directory: string) {
      const entries = snapshot()?.entries
      const key = pathKey(directory)
      if (entries && Object.hasOwn(entries, key)) return entries[key]
    },
    async refresh() {
      apply(await remote.list())
    },
    async update(directory: string, appearance: ProjectAppearance.Fields) {
      apply(await remote.update({ directory, appearance }))
    },
  }
}

export function createServerProjectAppearance(sdk: ServerSDK, fetch: typeof globalThis.fetch) {
  const abort = new AbortController()
  const decode = Schema.decodeUnknownSync(ProjectAppearance.Snapshot)
  const server = sdk.server.http
  const url = `${sdk.url.replace(/\/+$/, "")}${ProjectAppearance.path}`
  const authorization = server.password
    ? `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`
    : undefined

  async function request(patch?: ProjectAppearance.Patch) {
    const headers = new Headers()
    if (authorization) headers.set("Authorization", authorization)
    if (patch) headers.set("Content-Type", "application/json")
    const result = await fetch(url, {
      method: patch ? "PATCH" : "GET",
      signal: abort.signal,
      cache: "no-store",
      headers,
      body: patch ? JSON.stringify(patch) : undefined,
    })
    if (!result.ok) throw new Error(`Project appearance: HTTP ${result.status}`)
    return decode(await result.json())
  }

  const state = createProjectAppearance({ list: () => request(), update: request })
  // Old servers do not have this Web endpoint. Keep rendering existing metadata.
  const refresh = () => void state.refresh().catch(() => {})
  onCleanup(() => abort.abort())
  onCleanup(
    sdk.event.on("global", (event: { type: string }) => {
      if (event.type === ProjectAppearance.updated || event.type === "server.connected") refresh()
    }),
  )
  refresh()
  return state
}
