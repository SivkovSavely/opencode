import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { OpenCodeHttpApi } from "@/server/routes/instance/httpapi/api"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const path = "/global/project-appearance"
const key = ["global", "project-appearance"]
const icon = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
const authorize = HttpClientRequest.setHeader("Authorization", `Basic ${btoa("opencode:appearance-test")}`)

// Keep an unregistered global route from falling through to the remote UI proxy.
const missing = HttpRouter.use((router) => router.add("*", "/global/*", HttpServerResponse.empty({ status: 404 })))
const routes = Layer.mergeAll(HttpApiApp.routes, missing).pipe(
  HttpRouter.provideRequest(Layer.succeedContext(HttpApiApp.context)),
)
const server = HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: "appearance-test" }))),
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const freshFile = Layer.effectDiscard(
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    yield* storage.remove(key)
    yield* Effect.addFinalizer(() => storage.remove(key).pipe(Effect.orDie))
  }),
).pipe(Layer.provideMerge(LayerNode.compile(Storage.node)))
const it = testEffect(freshFile)

const get = () => send(HttpClientRequest.get(path))
const patchRequest = (directory: string, appearance: unknown) =>
  HttpClientRequest.patch(path).pipe(HttpClientRequest.bodyJsonUnsafe({ directory, appearance }))
const patch = (directory: string, appearance: unknown) => send(patchRequest(directory, appearance))
const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(authorize(request))
    expect(response.status).toBe(200)
    return yield* response.json
  })

describe("internal project appearance HttpApi", () => {
  it.live("requires root credentials for both methods", () =>
    Effect.gen(function* () {
      for (const request of [HttpClientRequest.get(path), patchRequest("/repo", { name: "Private" })]) {
        expect((yield* HttpClient.execute(request)).status).toBe(401)
        expect(
          (yield* HttpClient.execute(request.pipe(HttpClientRequest.setHeader("Authorization", "Basic bad")))).status,
        ).toBe(401)
      }
      expect(yield* get()).toEqual({ revision: 0, entries: {} })
    }).pipe(Effect.provide(server)),
  )

  it.live("persists complete snapshots across server restarts and keeps null distinct from omission", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        expect(yield* get()).toEqual({ revision: 0, entries: {} })
        expect(yield* patch("C:\\repo\\", { name: "Mine", icon })).toEqual({
          revision: 1,
          entries: { "C:/repo": { name: "Mine", icon } },
        })
        expect(yield* patch("C:/repo/", { icon: null, color: "blue" })).toEqual({
          revision: 2,
          entries: { "C:/repo": { name: "Mine", icon: null, color: "blue" } },
        })
      }).pipe(Effect.provide(server), Effect.scoped)

      const storage = yield* Storage.Service
      expect(yield* storage.read(key)).toEqual({
        revision: 2,
        entries: { "C:/repo": { name: "Mine", icon: null, color: "blue" } },
      })

      yield* Effect.gen(function* () {
        expect(yield* get()).toEqual({
          revision: 2,
          entries: { "C:/repo": { name: "Mine", icon: null, color: "blue" } },
        })
        expect(yield* patch("/another/", { name: null })).toEqual({
          revision: 3,
          entries: { "C:/repo": { name: "Mine", icon: null, color: "blue" }, "/another": { name: null } },
        })
      }).pipe(Effect.provide(server), Effect.scoped)
    }),
  )

  it.live("serializes concurrent field changes against the same directory", () =>
    Effect.gen(function* () {
      const responses = yield* Effect.all(
        [patch("/repo/", { name: "My repo" }), patch("/repo", { color: null }), patch("/repo//", { icon })],
        { concurrency: "unbounded" },
      )
      expect(responses).toContainEqual({ revision: 3, entries: { "/repo": { name: "My repo", color: null, icon } } })
      expect(yield* get()).toEqual({ revision: 3, entries: { "/repo": { name: "My repo", color: null, icon } } })
    }).pipe(Effect.provide(server)),
  )

  it.live("invalidates global subscribers without broadcasting any appearance fields", () =>
    Effect.gen(function* () {
      const events: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => {
        if (event.directory === "global") events.push(event)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
      yield* get()
      yield* patch("/private", { name: "Private", icon })
      expect(events).toEqual([
        {
          directory: "global",
          payload: { id: expect.any(String), type: "server.project-appearance.updated", properties: {} },
        },
      ])
    }).pipe(Effect.provide(server)),
  )

  it.live("rejects invalid directories and icons without changing the snapshot", () =>
    Effect.gen(function* () {
      const before = yield* patch("/repo", { name: "Existing" })
      for (const request of [
        patchRequest("", { name: "invalid" }),
        patchRequest("  ", { name: "invalid" }),
        patchRequest("  //", { name: "invalid" }),
        patchRequest("__proto__/", { name: "invalid" }),
        patchRequest("/repo", { color: 4 }),
        patchRequest("/repo", { icon: "https://example.test/icon.png" }),
        patchRequest("/repo", { icon: "data:text/html;base64,WA==" }),
        patchRequest("/repo", { icon: "data:image/png;base64,X" }),
        patchRequest("/repo", { icon: "data:image/png;base64," + "AAAA".repeat(2 ** 21) }),
      ]) {
        const response = yield* HttpClient.execute(authorize(request))
        expect(response.status).toBe(400)
        expect(yield* response.json).toMatchObject({ name: "BadRequest" })
      }
      expect(yield* get()).toEqual(before)
      const storage = yield* Storage.Service
      expect(yield* storage.read(key)).toEqual(before)
    }).pipe(Effect.provide(server)),
  )

  it.live("treats inherited object names as ordinary own record keys", () =>
    Effect.gen(function* () {
      expect(yield* patch("constructor/", { name: "Constructor" })).toEqual({
        revision: 1,
        entries: { constructor: { name: "Constructor" } },
      })
      expect(yield* patch("toString", { color: "green" })).toEqual({
        revision: 2,
        entries: { constructor: { name: "Constructor" }, toString: { color: "green" } },
      })
    }).pipe(Effect.provide(server)),
  )

  it.live("keeps appearance when a project is closed and reopened without changing the project list", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const list = () => send(HttpClientRequest.get("/global/projects"))
      const project = (type: "add" | "remove") =>
        send(
          HttpClientRequest.patch("/global/projects").pipe(HttpClientRequest.bodyJsonUnsafe({ type, directory: dir })),
        )
      const initial = yield* list()
      yield* Effect.addFinalizer(() => project("remove").pipe(Effect.orDie))
      yield* project("add")
      const opened = yield* list()
      const appearance = yield* patch(`${dir}/`, { name: "Custom", icon })
      expect(yield* list()).toEqual(opened)
      expect(yield* project("remove")).toEqual(initial)
      expect(yield* get()).toEqual(appearance)
      expect(yield* project("add")).toEqual(opened)
      expect(yield* get()).toEqual(appearance)
    }).pipe(Effect.scoped, Effect.provide(server)),
  )

  it.live("does not publish the route in OpenAPI or the CLI catalog input", () =>
    Effect.gen(function* () {
      const doc = yield* send(HttpClientRequest.get("/doc"))
      expect(doc).toMatchObject({ paths: expect.objectContaining({ "/global/health": expect.any(Object) }) })
      expect(doc).not.toMatchObject({ paths: { [path]: expect.anything() } })
      expect(OpenApi.fromApi(OpenCodeHttpApi).paths[path]).toBeUndefined()
    }).pipe(Effect.provide(server)),
  )
})
