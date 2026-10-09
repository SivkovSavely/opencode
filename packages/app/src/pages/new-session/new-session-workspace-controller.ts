import { createMemo, createSignal } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"

// const workspaceBarEnabled = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"
const workspaceBarEnabled = true

export function resolveNewSessionWorktree(input: {
  enabled: boolean
  selected?: string
  directory: string
  projectWorktree?: string
  workspaces?: string[]
}) {
  if (!input.enabled) return "main"
  if (input.selected) {
    if (input.selected === "create" || input.selected === input.projectWorktree) return input.selected
    if (input.workspaces && !input.workspaces.includes(input.selected)) return "main"
    return input.selected
  }
  if (input.projectWorktree && input.directory !== input.projectWorktree) return input.directory
  return "main"
}

export function normalizeNewSessionWorktree(value: string, directory: string, projectWorktree?: string) {
  if (value === "main" && projectWorktree !== directory) return projectWorktree
  return value
}

export function resolveNewSessionBranch(input: {
  worktree: string
  local?: string
  worktreeBranch: (worktree: string) => string | undefined
}) {
  if (input.worktree === "main" || input.worktree === "create") return input.local
  return input.worktreeBranch(input.worktree) ?? input.local
}

export function createNewSessionWorkspaceListController<Client extends object>(input: {
  current: () => {
    client: Client
    scope: string
    directory: string
    project?: { id: string; worktree: string; vcs?: string; sandboxes: string[] }
  }
  list: (client: Client) => Promise<string[]>
}) {
  const [discovered, setDiscovered] = createSignal<{ client: Client; key: string; directories: string[] }>()
  const inFlight = new Map<Client, Map<string, Promise<void>>>()
  const key = (context: ReturnType<typeof input.current>) =>
    [
      context.scope,
      context.directory,
      context.project?.id ?? "",
      context.project?.worktree ?? "",
      JSON.stringify(context.project?.sandboxes ?? []),
    ].join("\0")

  const workspaces = () => {
    const context = input.current()
    const result = discovered()
    if (result?.client !== context.client || result.key !== key(context)) return context.project?.sandboxes ?? []
    return result.directories
  }

  const refresh = () => {
    const context = input.current()
    if (context.project?.vcs !== "git") return Promise.resolve()
    const contextKey = key(context)
    const requests = inFlight.get(context.client) ?? new Map<string, Promise<void>>()
    const pending = requests.get(contextKey)
    if (pending) return pending

    const request = input
      .list(context.client)
      .then((directories) => {
        const current = input.current()
        if (current.client !== context.client || key(current) !== contextKey) return
        setDiscovered({ client: context.client, key: contextKey, directories })
      })
      .catch(() => undefined)
      .finally(() => {
        requests.delete(contextKey)
        if (requests.size === 0 && inFlight.get(context.client) === requests) inFlight.delete(context.client)
      })
    requests.set(contextKey, request)
    inFlight.set(context.client, requests)
    return request
  }

  return { workspaces, refresh }
}

export function createNewSessionWorkspaceController() {
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const [worktree, setWorktree] = createSignal<string>()
  const workspaceList = createNewSessionWorkspaceListController({
    current: () => {
      const client = sdk()
      return { client, scope: client.scope, directory: client.directory, project: sync().project }
    },
    list: async (client) => {
      const result = await client.client.worktree.list()
      if (result.data === undefined) throw new Error("Failed to list worktrees")
      return result.data
    },
  })
  const visible = createMemo(() => workspaceBarEnabled && sync().project?.vcs === "git")
  const value = createMemo(() =>
    resolveNewSessionWorktree({
      enabled: visible(),
      selected: worktree(),
      directory: sdk().directory,
      projectWorktree: sync().project?.worktree,
      workspaces: workspaceList.workspaces(),
    }),
  )
  const projectRoot = createMemo(() => sync().project?.worktree ?? sdk().directory)
  const localBranch = createMemo(() => serverSync().child(projectRoot())[0].vcs?.branch)
  const branch = createMemo(() =>
    resolveNewSessionBranch({
      worktree: value(),
      local: localBranch(),
      worktreeBranch: (worktree) => serverSync().child(worktree)[0].vcs?.branch,
    }),
  )

  return {
    selection: {
      value,
      reset: () => setWorktree(),
      set: (worktree: string) =>
        setWorktree(normalizeNewSessionWorktree(worktree, sdk().directory, sync().project?.worktree)),
    },
    project: {
      root: projectRoot,
      workspaces: workspaceList.workspaces,
      refreshWorkspaces: workspaceList.refresh,
      git: () => sync().project?.vcs === "git",
    },
    bar: {
      visible,
      branch,
    },
  }
}

export type NewSessionWorkspaceController = ReturnType<typeof createNewSessionWorkspaceController>
