import { expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { createServer, request } from "node:http"
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

it.live("DCP proxies a remote-only session directory and rejects every conflicting selector", () =>
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
    const sessionDirectory = path.join(directory, "remote project, feature")
    yield* Effect.promise(() => mkdir(sessionDirectory))
    const created = yield* requestInDirectory("/session", sessionDirectory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Remote DCP", workspaceID: workspace.id }),
    })
    expect(created.status).toBe(200)
    const session = (yield* created.json) as { id: string }
    const sessions = yield* Session.Service
    yield* sessions.setWorkspace({ sessionID: SessionID.make(session.id), workspaceID: workspace.id })
    expect((yield* sessions.get(SessionID.make(session.id))).workspaceID).toBe(workspace.id)
    // The admitted path is now present only on the remote host, not on the origin.
    yield* Effect.promise(() => rename(sessionDirectory, path.join(directory, "relocated session")))
    expect(
      yield* Effect.tryPromise({ try: () => stat(sessionDirectory), catch: (error) => error }).pipe(Effect.flip),
    ).toMatchObject({ code: "ENOENT" })
    expect((yield* sessions.get(SessionID.make(session.id))).directory).toBe(sessionDirectory)
    const file = path.join(process.env.XDG_DATA_HOME ?? "", "opencode/storage/plugin/dcp", `${session.id}.json`)
    yield* Effect.promise(() => mkdir(path.dirname(file), { recursive: true }))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
    yield* Effect.promise(() => Bun.write(file, '{"prune":{},"stats":{"totalPruneTokens":111}}'))
    const response = yield* requestInDirectory(`/session/${session.id}/dcp`, sessionDirectory)
    expect(response.status).toBe(200)
    expect(yield* response.json).toMatchObject({ sessionID: session.id, stats: { historicalRemovedTokens: 321 } })
    expect(requests).toHaveLength(1)
    expect(requests[0].headers).toMatchObject({ authorization: "Bearer remote-credential" })
    expect(requests[0].headers).not.toHaveProperty("x-opencode-directory")
    expect(new URL(requests[0].url).searchParams.has("workspace")).toBe(false)
    const encoded = encodeURIComponent(sessionDirectory)
    const queryOnly = yield* HttpClientRequest.get(`/session/${session.id}/dcp?directory=${encoded}`).pipe(
      HttpClient.execute,
    )
    expect(queryOnly.status).toBe(200)
    expect(yield* queryOnly.json).toMatchObject({ sessionID: session.id, stats: { historicalRemovedTokens: 321 } })
    for (const query of [
      `directory=${encoded}`,
      `directory=${encoded}&directory=${encoded}&workspace=${workspace.id}&workspace=${workspace.id}`,
    ]) {
      const repeated = yield* requestInDirectory(`/session/${session.id}/dcp?${query}`, encoded, {
        headers: { "x-opencode-workspace": workspace.id },
      })
      expect(repeated.status).toBe(200)
      expect(yield* repeated.json).toMatchObject({ sessionID: session.id, stats: { historicalRemovedTokens: 321 } })
    }
    expect(requests).toHaveLength(4)
    for (const input of [
      { query: "", directory: other },
      { query: `directory=${encoded}`, directory: other },
      { query: `directory=${encodeURIComponent(other)}`, directory: sessionDirectory },
      { query: `directory=${encoded}&directory=${encodeURIComponent(other)}`, directory: sessionDirectory },
      { query: `directory=${encodeURIComponent(other)}&directory=${encoded}`, directory: sessionDirectory },
      { query: `workspace=${workspace.id}&workspace=wrk_wrong`, directory: sessionDirectory },
      { query: `workspace=wrk_wrong&workspace=${workspace.id}`, directory: sessionDirectory },
      { query: `workspace=${workspace.id}`, directory: sessionDirectory, workspace: "wrk_wrong" },
      { query: "workspace=wrk_wrong", directory: sessionDirectory, workspace: workspace.id },
    ]) {
      const denied = yield* requestInDirectory(`/session/${session.id}/dcp?${input.query}`, input.directory, {
        headers: input.workspace === undefined ? {} : { "x-opencode-workspace": input.workspace },
      })
      expect(denied.status).toBe(403)
      expect(requests).toHaveLength(4)
    }
    const server = yield* HttpServer.HttpServer
    const rawRequest = (headers: string[], query = "") =>
      Effect.callback<number | undefined, Error>((resume) => {
        const url = new URL(`/session/${session.id}/dcp${query}`, HttpServer.formatAddress(server.address))
        const client = request(url, { headers: ["Host", url.host, ...headers], agent: false }, (response) => {
          response.once("error", (error) => resume(Effect.fail(error)))
          response.once("end", () => resume(Effect.succeed(response.statusCode)))
          response.resume()
        })
        client.once("error", (error) => resume(Effect.fail(error)))
        client.end()
        return Effect.sync(() => {
          client.destroy()
        })
      })
    for (const value of [sessionDirectory, encoded]) {
      expect(yield* rawRequest(["x-opencode-directory", value, "x-opencode-workspace", workspace.id])).toBe(200)
    }
    expect(requests).toHaveLength(6)
    for (const input of [
      { headers: ["X-OpenCode-Directory", path.join(directory, "remote project"), "x-opencode-directory", "feature"] },
      {
        headers: ["x-opencode-directory", path.join(directory, "remote project"), "X-OpenCode-Directory", "feature"],
        query: `?directory=${encoded}`,
      },
      { headers: ["x-opencode-directory", sessionDirectory, "x-opencode-directory", sessionDirectory] },
      { headers: ["x-opencode-directory", sessionDirectory, "x-opencode-directory", other] },
      {
        headers: [
          "x-opencode-directory",
          sessionDirectory,
          "x-opencode-workspace",
          workspace.id,
          "X-OpenCode-Workspace",
          workspace.id,
        ],
      },
      {
        headers: [
          "x-opencode-directory",
          sessionDirectory,
          "x-opencode-workspace",
          workspace.id,
          "X-OpenCode-Workspace",
          "wrk_wrong",
        ],
        query: `?workspace=${workspace.id}`,
      },
      { headers: ["x-opencode-directory", sessionDirectory], query: `?directory=${encodeURIComponent(other)}` },
      { headers: ["x-opencode-directory", other], query: `?directory=${encoded}` },
    ]) {
      expect(yield* rawRequest(input.headers, input.query)).toBe(403)
      expect(requests).toHaveLength(6)
    }
  }),
)
