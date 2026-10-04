import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option, Schema, SynchronizedRef } from "effect"
import { Storage } from "@/storage/storage"

export * as GlobalProjectList from "./global-project-list"

const KEY = ["global", "projects"]

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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GlobalProjectList") {}

// Identity for dedup/lookup. Mirrors the web `pathKey` rules so separator and
// trailing-slash spellings from different clients collapse to one entry, while the
// first spelling seen stays in the stored list.
function identity(input: string) {
  const value = input[1] === ":" || input.startsWith("\\\\") ? input.replaceAll("\\", "/") : input
  const trimmed = value.replace(/\/+$/, "")
  if (!trimmed) return value.startsWith("/") ? "/" : trimmed
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + "/"
  return trimmed
}

function present(input: string) {
  return identity(input) !== ""
}

export function applyOperation(current: ReadonlyArray<string>, operation: Operation) {
  if (operation.type === "merge") {
    const seen = new Set(current.map(identity))
    const added = operation.projects.filter((directory) => {
      const key = identity(directory)
      if (!present(directory) || seen.has(key)) return false
      seen.add(key)
      return true
    })
    return [...current, ...added]
  }
  if (operation.type === "add") {
    const key = identity(operation.directory)
    if (!present(operation.directory)) return [...current]
    if (current.some((directory) => identity(directory) === key)) return [...current]
    // Match the web open() behavior: the newest project leads the list.
    return [operation.directory, ...current]
  }
  if (operation.type === "remove") {
    const key = identity(operation.directory)
    return current.filter((directory) => identity(directory) !== key)
  }
  const from = current.findIndex((directory) => identity(directory) === identity(operation.directory))
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
        return SynchronizedRef.makeUnsafe(Option.match(decode(content), {
          onNone: () => [] as Array<string>,
          onSome: (value) => applyOperation([], { type: "merge", projects: value.projects }),
        }))
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

    return Service.of({ list, apply })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Storage.node] })
