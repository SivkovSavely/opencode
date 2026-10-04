import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { GlobalProjectList } from "@/server/global-project-list"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, GlobalProjectList.node])),
)

function remap(root: string, file: string) {
  if (file === Global.Path.data) return root
  if (file.startsWith(Global.Path.data + path.sep)) return path.join(root, path.relative(Global.Path.data, file))
  return file
}

function remappedFs(root: string) {
  return Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        isDir: (file) => fs.isDir(remap(root, file)),
        readJson: (file) => fs.readJson(remap(root, file)),
        writeWithDirs: (file, content, mode) => fs.writeWithDirs(remap(root, file), content, mode),
        readFileString: (file) => fs.readFileString(remap(root, file)),
        remove: (file) => fs.remove(remap(root, file)),
        glob: (pattern, options) =>
          fs.glob(pattern, options?.cwd ? { ...options, cwd: remap(root, options.cwd) } : options),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
}

// Layer.fresh forces a new GlobalProjectList (and Storage) so each build re-reads
// the persisted file from `root` instead of reusing an in-memory copy.
const service = (root: string) => Layer.fresh(LayerNode.compile(GlobalProjectList.node, [[FSUtil.node, remappedFs(root)]]))

const withService = <A, E>(root: string, run: (svc: GlobalProjectList.Interface) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* run(yield* GlobalProjectList.Service)
  }).pipe(Effect.provide(service(root)))

describe("GlobalProjectList", () => {
  it.live("starts empty and persists an additive migration merge", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const root = path.join(tmp, "data")

      yield* withService(root, (svc) =>
        Effect.gen(function* () {
          expect(yield* svc.list()).toEqual([])
          expect(yield* svc.apply({ type: "merge", projects: ["/a", "/b"] })).toEqual(["/a", "/b"])
        }),
      )

      yield* withService(root, (svc) =>
        Effect.gen(function* () {
          // A later client merges its own browser list; existing server order wins.
          expect(yield* svc.apply({ type: "merge", projects: ["/b", "/c", "/d"] })).toEqual(["/a", "/b", "/c", "/d"])
          expect(yield* svc.list()).toEqual(["/a", "/b", "/c", "/d"])
        }),
      )
    }),
  )

  it.live("deduplicates normalized paths while keeping the first spelling", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const root = path.join(tmp, "data")

      yield* withService(root, (svc) =>
        Effect.gen(function* () {
          expect(yield* svc.apply({ type: "merge", projects: ["/a/", "/b", "/a", "/b/", ""] })).toEqual([
            "/a/",
            "/b",
          ])
          expect(yield* svc.apply({ type: "add", directory: "/a" })).toEqual(["/a/", "/b"])
          expect(yield* svc.apply({ type: "add", directory: "/c" })).toEqual(["/c", "/a/", "/b"])
          expect(yield* svc.apply({ type: "add", directory: "C:\\repo" })).toEqual(["C:\\repo", "/c", "/a/", "/b"])
          expect(yield* svc.apply({ type: "add", directory: "C:/repo/" })).toEqual([
            "C:\\repo",
            "/c",
            "/a/",
            "/b",
          ])
          expect(yield* svc.apply({ type: "remove", directory: "/b/" })).toEqual(["C:\\repo", "/c", "/a/"])
          expect(yield* svc.apply({ type: "remove", directory: "C:/repo" })).toEqual(["/c", "/a/"])
        }),
      )
    }),
  )

  it.live("reorders with move and clamps out-of-range indexes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const root = path.join(tmp, "data")

      yield* withService(root, (svc) =>
        Effect.gen(function* () {
          yield* svc.apply({ type: "merge", projects: ["/a", "/b", "/c"] })
          expect(yield* svc.apply({ type: "move", directory: "/a", toIndex: 2 })).toEqual(["/b", "/c", "/a"])
          expect(yield* svc.apply({ type: "move", directory: "/a", toIndex: 99 })).toEqual(["/b", "/c", "/a"])
          expect(yield* svc.apply({ type: "move", directory: "/a", toIndex: -5 })).toEqual(["/a", "/b", "/c"])
          expect(yield* svc.apply({ type: "move", directory: "/missing", toIndex: 0 })).toEqual(["/a", "/b", "/c"])
        }),
      )
    }),
  )

  it.live("serializes concurrent mutations without losing updates", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const root = path.join(tmp, "data")

      yield* withService(root, (svc) =>
        Effect.gen(function* () {
          const directories = Array.from({ length: 20 }, (_, index) => `/project-${index}`)
          yield* Effect.all(
            directories.map((directory) => svc.apply({ type: "add", directory })),
            { concurrency: "unbounded" },
          )

          expect([...(yield* svc.list())].toSorted()).toEqual([...directories].toSorted())
        }),
      )

      yield* withService(root, (svc) =>
        Effect.gen(function* () {
          expect(yield* svc.list()).toHaveLength(20)
        }),
      )
    }),
  )
})
