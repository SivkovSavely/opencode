import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { ProjectList } from "@opencode/core/project-list"
import { KV } from "@opencode/core/kv"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

it.live("persists server-first merges, identity, concurrent adds and clamped moves across graph reopen", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const graph = AppNodeBuilder.build(LayerNode.group([ProjectList.node, FSUtil.node, KV.node]), [
      Database.node.replace(Database.configured({ path: path.join(tmp.path, "list.sqlite") })),
      Global.node.replace(Global.layerWith({ data: tmp.path })),
    ])
    yield* Effect.gen(function* () {
      const list = yield* ProjectList.Service
      expect(yield* list.list()).toEqual({ projects: [], revision: 0 })
      expect(
        yield* list.apply({ type: "merge", projects: ["/S1/", "/S2", "C:\\Code\\One", "/Case", "/case"] }),
      ).toEqual({ projects: ["/S1/", "/S2", "C:\\Code\\One", "/Case", "/case"], revision: 1 })
      expect(
        (yield* list.apply({ type: "merge", projects: ["/S2/", "/L1", "C:/Code/One/", "/L2", ""] })).projects,
      ).toEqual(["/S1/", "/S2", "C:\\Code\\One", "/Case", "/case", "/L1", "/L2"])
      yield* list.apply({ type: "add", directory: "/S2/" })
      yield* list.apply({ type: "add", directory: "" })
      expect((yield* list.list()).projects[0]).toBe("/S1/")
      expect((yield* list.list()).revision).toBe(2)
      yield* Effect.forEach(["/A", "/B", "/C"], (directory) => list.apply({ type: "add", directory }), {
        concurrency: "unbounded",
      })
      const added = (yield* list.list()).projects
      expect(added.slice(0, 3).toSorted()).toEqual(["/A", "/B", "/C"])
      expect(added).toHaveLength(10)
      expect((yield* list.apply({ type: "move", directory: "/L2", toIndex: -100 })).projects[0]).toBe("/L2")
      expect((yield* list.apply({ type: "move", directory: "/L2", toIndex: 100 })).projects.at(-1)).toBe("/L2")
      const previous = yield* list.list()
      expect(yield* list.apply({ type: "move", directory: "/missing", toIndex: 0 })).toEqual(previous)
      yield* list.apply({ type: "remove", directory: "/S1" })
    }).pipe(Effect.provide(Layer.fresh(graph)), Effect.scoped)
    yield* Effect.gen(function* () {
      const list = yield* ProjectList.Service
      const result = (yield* list.list()).projects
      expect(result).toHaveLength(9)
      expect(result).not.toContain("/S1/")
      expect(result.at(-1)).toBe("/L2")
      expect(result).toContain("C:\\Code\\One")
      expect((yield* list.list()).revision).toBe(8)
      expect((yield* list.apply({ type: "add", directory: "/after-reopen" })).revision).toBe(9)
    }).pipe(Effect.provide(Layer.fresh(graph)), Effect.scoped)
  }),
)

it.live(
  "imports the original directory file without modifying its bytes and fails closed on malformed or unreadable storage",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const graph = AppNodeBuilder.build(LayerNode.group([ProjectList.node, FSUtil.node, KV.node]), [
        Database.node.replace(Database.configured({ path: path.join(tmp.path, "list.sqlite") })),
        Global.node.replace(Global.layerWith({ data: tmp.path })),
      ])
      yield* Effect.gen(function* () {
        const list = yield* ProjectList.Service
        const fs = yield* FSUtil.Service
        const kv = yield* KV.Service
        const filename = path.join(tmp.path, "storage/global/projects.json")
        yield* fs.writeWithDirs(filename, '{"projects":["/legacy","/unresolved"]}')
        expect(yield* list.list()).toEqual({ projects: ["/legacy", "/unresolved"], revision: 0 })
        yield* list.apply({ type: "add", directory: "/new" })
        expect(yield* fs.readFileString(filename)).toBe('{"projects":["/legacy","/unresolved"]}')
        yield* kv.remove("global:projects")
        for (const bytes of ['{"projects":', '{"projects":[13]}', "null"]) {
          yield* fs.writeWithDirs(filename, bytes)
          expect((yield* Effect.result(list.list()))._tag).toBe("Failure")
          expect((yield* Effect.result(list.apply({ type: "add", directory: "/unsafe" })))._tag).toBe("Failure")
          expect(yield* fs.readFileString(filename)).toBe(bytes)
          expect(yield* kv.get("global:projects")).toBeUndefined()
        }
        yield* fs.remove(filename)
        yield* fs.makeDirectory(filename)
        expect((yield* Effect.result(list.apply({ type: "remove", directory: "/legacy" })))._tag).toBe("Failure")
        yield* fs.remove(filename, { recursive: true })
        yield* kv.set("global:projects", { projects: ["/unversioned"] })
        expect(yield* list.list()).toEqual({ projects: ["/unversioned"], revision: 0 })
        expect(yield* list.apply({ type: "add", directory: "/unversioned/" })).toEqual({
          projects: ["/unversioned"],
          revision: 0,
        })
        expect(yield* kv.get("global:projects")).toEqual({ projects: ["/unversioned"], revision: 0 })
        yield* kv.set("global:projects", { projects: ["/unsafe"], revision: -1 })
        expect((yield* Effect.result(list.apply({ type: "add", directory: "/new" })))._tag).toBe("Failure")
        expect(yield* kv.get("global:projects")).toEqual({ projects: ["/unsafe"], revision: -1 })
        yield* kv.set("global:projects", { projects: [false] })
        expect((yield* Effect.result(list.apply({ type: "add", directory: "/unsafe" })))._tag).toBe("Failure")
        expect(yield* kv.get("global:projects")).toEqual({ projects: [false] })
      }).pipe(Effect.provide(graph), Effect.scoped)
    }),
)
