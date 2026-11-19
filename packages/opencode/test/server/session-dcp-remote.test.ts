import { expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { mkdir, rm } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { registerAdapter } from "../../src/control-plane/adapters"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(httpApiLayer, AppNodeBuilderV1.build(Session.node)).pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          OPENCODE_EXPERIMENTAL_WORKSPACES: true,
        }),
      ),
    ),
  ),
)

it.live("DCP uses recorded remote placement and rejects conflicting scope before proxying", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const other = yield* tmpdirScoped()
    const requests: { url: string; headers: Record<string, string> }[] = []
    // The secondary Effect server stands in for the selected session host.
    const context = yield* Layer.build(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
    const remote = Context.get(context, HttpServer.HttpServer)
    yield* remote.serve(
      HttpServerRequest.HttpServerRequest.use((request) =>
        Effect.sync(() => {
          const url = new URL(request.url, "http://localhost")
          if (url.pathname === "/base/global/event")
            return HttpServerResponse.text('data: {"payload":{"type":"server.connected","properties":{}}}\n\n', {
              contentType: "text/event-stream",
            })
          if (url.pathname === "/base/sync/history") return HttpServerResponse.jsonUnsafe([])
          requests.push({ url: url.toString(), headers: { ...request.headers } })
          return HttpServerResponse.jsonUnsafe({
            sessionID: url.pathname.split("/").at(-2),
            state: "available",
            blocks: [],
            stats: { historicalRemovedTokens: 321 },
          })
        }),
      ),
    )
    const projectResponse = yield* requestInDirectory("/project/current", directory)
    const project = Schema.decodeUnknownSync(Project.Info)(yield* projectResponse.json)
    const type = "dcp-remote-test"
    registerAdapter(project.id, type, {
      name: "DCP test",
      description: "DCP remote placement fixture",
      configure: (info) => ({ ...info, name: "dcp-remote", directory: path.join(directory, ".remote") }),
      create: async () => {},
      remove: async () => {},
      target: () => ({
        type: "remote",
        url: `${HttpServer.formatAddress(remote.address)}/base`,
        headers: { authorization: "Bearer remote-credential" },
      }),
    })
    const workspaceResponse = yield* requestInDirectory("/experimental/workspace", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, branch: null }),
    })
    expect(workspaceResponse.status).toBe(200)
    const workspace = Schema.decodeUnknownSync(Schema.Struct({ id: WorkspaceV2.ID }))(yield* workspaceResponse.json)
    yield* Effect.addFinalizer(() =>
      requestInDirectory(`/experimental/workspace/${workspace.id}`, directory, { method: "DELETE" }).pipe(
        Effect.ignore,
      ),
    )
    const created = yield* requestInDirectory("/session", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Remote DCP", workspaceID: workspace.id }),
    })
    expect(created.status).toBe(200)
    const session = (yield* created.json) as { id: string }
    const sessions = yield* Session.Service
    yield* sessions.setWorkspace({ sessionID: SessionID.make(session.id), workspaceID: workspace.id })
    expect((yield* sessions.get(SessionID.make(session.id))).workspaceID).toBe(workspace.id)
    const file = path.join(process.env.XDG_DATA_HOME ?? "", "opencode/storage/plugin/dcp", `${session.id}.json`)
    yield* Effect.promise(() => mkdir(path.dirname(file), { recursive: true }))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
    yield* Effect.promise(() => Bun.write(file, '{"prune":{},"stats":{"totalPruneTokens":111}}'))
    const response = yield* requestInDirectory(`/session/${session.id}/dcp`, directory)
    expect(response.status).toBe(200)
    expect(yield* response.json).toMatchObject({ sessionID: session.id, stats: { historicalRemovedTokens: 321 } })
    expect(requests).toHaveLength(1)
    expect(requests[0].headers).toMatchObject({ authorization: "Bearer remote-credential" })
    expect(requests[0].headers).not.toHaveProperty("x-opencode-directory")
    expect(new URL(requests[0].url).searchParams.has("workspace")).toBe(false)
    const foreign = yield* requestInDirectory(`/session/${session.id}/dcp`, other)
    expect(foreign.status).toBe(403)
    const mixed = yield* HttpClientRequest.get(
      `/session/${session.id}/dcp?directory=${encodeURIComponent(directory)}&workspace=wrk_wrong`,
    ).pipe(HttpClientRequest.setHeader("x-opencode-directory", directory), HttpClient.execute)
    expect(mixed.status).toBe(403)
    expect(requests).toHaveLength(1)
  }),
)
