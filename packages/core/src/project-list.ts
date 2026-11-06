export * as ProjectList from "./project-list.js"

import path from "node:path"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { ProjectList } from "@opencode/schema/project-list"
import { NonNegativeInt } from "@opencode/schema/schema"
import { comparablePath } from "@opencode/util/path"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "./kv.js"
import { Bus } from "./bus.js"

const key = "global:projects"
// Existing directory-only KV records start at revision zero; the next change persists the revision with the list.
const Stored = Schema.Struct({
  projects: ProjectList.Snapshot.fields.projects,
  revision: Schema.optional(NonNegativeInt),
})
const Legacy = Schema.Struct({ projects: ProjectList.Snapshot.fields.projects })

export class StorageError extends Schema.TaggedError<StorageError>()("ProjectList.StorageError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<ProjectList.Snapshot, StorageError>
  readonly apply: (operation: ProjectList.Operation) => Effect.Effect<ProjectList.Snapshot, StorageError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectList") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const bus = yield* Bus.Service
    const lock = yield* Semaphore.make(1)
    const legacy = path.join(global.data, "storage", "global", "projects.json")
    const unsafe = () =>
      new StorageError({
        message: `Cannot read the added project list. Preserve and repair ${legacy} or KV ${key} before retrying; no list data was overwritten.`,
      })
    const read = Effect.fn("ProjectList.read")(function* () {
      const stored = yield* kv.get(key)
      if (stored !== undefined) {
        const decoded = yield* Schema.decodeUnknownEffect(Stored)(stored).pipe(Effect.mapError(unsafe))
        return {
          projects: applyOperation(decoded.projects, { type: "merge", projects: [] }),
          revision: decoded.revision ?? 0,
        }
      }
      const text = yield* fs.readFileString(legacy).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
        Effect.mapError(unsafe),
      )
      if (text === undefined) return { projects: [], revision: 0 }
      const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Legacy))(text).pipe(
        Effect.mapError(unsafe),
      )
      return { projects: applyOperation(decoded.projects, { type: "merge", projects: [] }), revision: 0 }
    })
    return Service.of({
      list: () => lock.withPermit(read()),
      apply: (operation) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = yield* read()
            const projects = applyOperation(current.projects, operation)
            const changed =
              projects.length !== current.projects.length ||
              projects.some((value, index) => value !== current.projects[index])
            const snapshot = { projects, revision: current.revision + Number(changed) }
            // Even a no-op acknowledges a validated legacy import, without touching the original file.
            yield* kv.set(key, snapshot)
            if (changed) {
              yield* bus.publish(ProjectList.Events.Updated, snapshot, { global: true })
            }
            return snapshot
          }).pipe(Effect.uninterruptible),
        ),
    })
  }),
)

function applyOperation(current: readonly string[], operation: ProjectList.Operation): string[] {
  if (operation.type === "merge") {
    const seen = new Set<string>()
    return [...current, ...operation.projects].filter((directory) => {
      const identity = comparablePath(directory)
      if (!identity || seen.has(identity)) return false
      seen.add(identity)
      return true
    })
  }
  const identity = comparablePath(operation.directory)
  if (operation.type === "add") {
    if (!identity || current.some((directory) => comparablePath(directory) === identity)) return [...current]
    return [operation.directory, ...current]
  }
  if (operation.type === "remove") return current.filter((directory) => comparablePath(directory) !== identity)
  const from = current.findIndex((directory) => comparablePath(directory) === identity)
  if (from === -1) return [...current]
  const next = [...current]
  const item = next.splice(from, 1)[0]!
  next.splice(Math.max(0, Math.min(operation.toIndex, next.length)), 0, item)
  return next
}

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, FSUtil.node, Global.node, Bus.node] })
