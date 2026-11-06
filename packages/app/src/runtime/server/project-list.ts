import { Schema } from "effect"
import { ProjectList } from "@opencode/schema/project-list"
import { comparablePath } from "@opencode/util/path"

export const PROJECT_LIST_MIGRATION = 1

/** Scoped to one server controller. Pending user intent is replayed over snapshots until acknowledged. */
export function createProjectListSync(input: {
  remote: {
    list: () => Promise<unknown>
    update: (operation: ProjectList.Operation) => Promise<unknown>
  }
  cache: () => readonly string[]
  replace: (projects: readonly string[]) => void
  migrated: () => boolean
  markMigrated: () => void
  onError: (error: unknown) => void
}) {
  let active = true
  let available = true
  let revision = -1
  let base = [...input.cache()]
  let visible = [...base]
  const pending: ProjectList.Operation[] = []
  const merge: ProjectList.Operation = { type: "merge", projects: [...base] }

  if (!input.migrated()) pending.push(merge)
  const replace = (projects: readonly string[]) => {
    visible = [...projects]
    // Persistence reconcile owns its input and may mutate it on cross-tab replication.
    input.replace([...visible])
  }
  const render = () => replace(pending.reduce(applyProjectListOperation, base))
  const decode = Schema.decodeUnknownSync(ProjectList.Snapshot)
  const accept = (snapshot: ProjectList.Snapshot) => {
    // HTTP and SSE can arrive in either order, including across a server graph reopen.
    if (snapshot.revision <= revision) return
    revision = snapshot.revision
    base = [...snapshot.projects]
  }

  let queue = Promise.resolve()
    .then(async () => {
      const response = decode(await (input.migrated() ? input.remote.list() : input.remote.update(merge)))

      if (!active) return

      accept(response)

      if (pending[0] === merge) pending.shift()
      input.markMigrated()
      render()
    })
    .catch(fail)

  function fail(error: unknown) {
    if (!active) return
    available = false
    pending.splice(0)
    // The optimistic cache survives unsupported endpoints, invalid responses, and network failures.
    input.onError(error)
  }

  return {
    send(operation: ProjectList.Operation) {
      if (!active) return Promise.resolve()
      replace(applyProjectListOperation(visible, operation))

      if (!available) return Promise.resolve()
      pending.push(operation)
      queue = queue
        .then(async () => {
          if (!active || !available) return
          const response = decode(await input.remote.update(operation))

          if (!active) return

          accept(response)
          pending.splice(pending.indexOf(operation), 1)
          render()
        })
        .catch(fail)

      return queue
    },
    refresh() {
      queue = queue
        .then(async () => {
          if (!active || !available) return
          const response = decode(await input.remote.list())
          if (!active) return
          accept(response)
          render()
        })
        .catch(fail)
      return queue
    },
    snapshot(snapshot: ProjectList.Snapshot) {
      if (!active || !available) return
      accept(snapshot)
      render()
    },
    settled: () => queue,
    dispose() {
      active = false
    },
  }
}

export function applyProjectListOperation(current: readonly string[], operation: ProjectList.Operation): string[] {
  if (operation.type === "merge") {
    const seen = new Set<string>()

    return [...current, ...operation.projects].filter((directory) => {
      const key = comparablePath(directory)

      if (!key || seen.has(key)) return false
      seen.add(key)

      return true
    })
  }

  const key = comparablePath(operation.directory)

  if (operation.type === "add") {
    if (!key || current.some((directory) => comparablePath(directory) === key)) return [...current]

    return [operation.directory, ...current]
  }

  if (operation.type === "remove") return current.filter((directory) => comparablePath(directory) !== key)
  const from = current.findIndex((directory) => comparablePath(directory) === key)

  if (from === -1) return [...current]
  const next = [...current]
  const item = next.splice(from, 1)[0]!
  next.splice(Math.max(0, Math.min(operation.toIndex, next.length)), 0, item)

  return next
}
