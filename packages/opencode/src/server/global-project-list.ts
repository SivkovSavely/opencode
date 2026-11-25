import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option, Schema, SynchronizedRef } from "effect"
import { directoryKey, ProjectAppearance } from "@opencode-ai/schema/project-appearance"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"

export * as GlobalProjectList from "./global-project-list"

const KEY = ["global", "projects"]
const APPEARANCE_KEY = ["global", "project-appearance"]

const File = Schema.Struct({ projects: Schema.Array(Schema.String) })
const decode = Schema.decodeUnknownOption(File, { onExcessProperty: "preserve" })

export const Operation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("merge"), projects: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("add"), directory: Schema.String }),
  Schema.Struct({ type: Schema.Literal("remove"), directory: Schema.String }),
  Schema.Struct({ type: Schema.Literal("move"), directory: Schema.String, toIndex: Schema.Int }),
])
export type Operation = Schema.Schema.Type<typeof Operation>

export interface Interface {
  readonly list: () => Effect.Effect<Array<string>, Storage.Error>
  readonly apply: (operation: Operation) => Effect.Effect<Array<string>, Storage.Error>
  readonly getAppearance: () => Effect.Effect<ProjectAppearance.Snapshot, Storage.Error | Schema.SchemaError>
  readonly patchAppearance: (
    patch: ProjectAppearance.Patch,
  ) => Effect.Effect<ProjectAppearance.Snapshot, Storage.Error | Schema.SchemaError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GlobalProjectList") {}

function present(input: string) {
  return directoryKey(input) !== ""
}

export function applyOperation(current: ReadonlyArray<string>, operation: Operation) {
  if (operation.type === "merge") {
    const seen = new Set(current.map(directoryKey))
    const added = operation.projects.filter((directory) => {
      const key = directoryKey(directory)
      if (!present(directory) || seen.has(key)) return false
      seen.add(key)
      return true
    })
    return [...current, ...added]
  }
  if (operation.type === "add") {
    const key = directoryKey(operation.directory)
    if (!present(operation.directory)) return [...current]
    if (current.some((directory) => directoryKey(directory) === key)) return [...current]
    // Match the web open() behavior: the newest project leads the list.
    return [operation.directory, ...current]
  }
  if (operation.type === "remove") {
    const key = directoryKey(operation.directory)
    return current.filter((directory) => directoryKey(directory) !== key)
  }
  const from = current.findIndex((directory) => directoryKey(directory) === directoryKey(operation.directory))
  if (from === -1) return [...current]
  const next = [...current]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(operation.toIndex, next.length)), 0, item)
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    // Loaded once per process. SynchronizedRef serializes the effectful
    // read-modify-write so concurrent mutations from different clients cannot lose
    // each other's updates.
    const state = yield* Effect.cached(
      Effect.gen(function* () {
        const content = yield* storage.read<unknown>(KEY)
        return SynchronizedRef.makeUnsafe(
          Option.match(decode(content), {
            onNone: () => [] as Array<string>,
            onSome: (value) => applyOperation([], { type: "merge", projects: value.projects }),
          }),
        )
      }).pipe(Effect.catch(() => Effect.succeed(SynchronizedRef.makeUnsafe<Array<string>>([])))),
    )

    const list: Interface["list"] = Effect.fn("GlobalProjectList.list")(function* () {
      return yield* SynchronizedRef.get(yield* state)
    })

    const apply: Interface["apply"] = Effect.fn("GlobalProjectList.apply")(function* (operation: Operation) {
      return yield* SynchronizedRef.updateAndGetEffect(yield* state, (current) =>
        Effect.gen(function* () {
          const next = applyOperation(current, operation)
          if (next.length === current.length && next.every((value, index) => value === current[index])) return current
          yield* storage.write(KEY, { projects: next })
          return next
        }),
      )
    })

    const appearanceState = yield* Effect.cached(
      storage.read<unknown>(APPEARANCE_KEY).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ProjectAppearance.Snapshot)),
        Effect.catchTag("NotFoundError", () => Effect.succeed({ revision: 0, entries: {} })),
        Effect.flatMap(SynchronizedRef.make<ProjectAppearance.Snapshot>),
      ),
    )

    const getAppearance = Effect.fn("GlobalProjectList.getAppearance")(function* () {
      return yield* SynchronizedRef.get(yield* appearanceState)
    })

    const patchAppearance = Effect.fn("GlobalProjectList.patchAppearance")(function* (patch: ProjectAppearance.Patch) {
      const directory = directoryKey(patch.directory)
      const ref = yield* appearanceState
      return yield* SynchronizedRef.updateAndGetEffect(ref, (current) =>
        Effect.gen(function* () {
          const revision = current.revision + 1
          if (!Number.isSafeInteger(revision))
            return yield* Effect.die(new Error("Project appearance revision exhausted"))
          const previous = Object.hasOwn(current.entries, directory) ? current.entries[directory] : undefined
          const next = {
            revision,
            entries: { ...current.entries, [directory]: { ...previous, ...patch.appearance } },
          }
          yield* storage.writeAtomic(APPEARANCE_KEY, next)
          return next
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            GlobalBus.emit("event", {
              directory: "global",
              payload: { type: ProjectAppearance.updated, properties: {} },
            })
          }),
        ),
        // A disconnected client must not interrupt us between persistence and invalidation.
        Effect.uninterruptible,
      )
    })

    return Service.of({ list, apply, getAppearance, patchAppearance })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Storage.node] })
