import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { GlobalProjectList } from "../../src/server/global-project-list"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"
import { transcriptSearchHandlers } from "../../src/server/routes/instance/httpapi/handlers/transcript-search"
import { TranscriptSearch } from "@opencode-ai/core/session/transcript-search"
import { Database } from "@opencode-ai/core/database/database"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, transcriptSearchHandlers]),
    Layer.provide(TranscriptSearch.layer),
    Layer.provide(Database.layerFromPath(":memory:")),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(GlobalProjectList.Service)({
      list: () => Effect.succeed(["/repo"]),
      apply: (operation) =>
        Effect.succeed(
          operation.type === "add"
            ? [operation.directory, "/repo"]
            : GlobalProjectList.applyOperation(["/repo"], operation),
        ),
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("exposes global transcript readiness, search and historical facets", () =>
    Effect.gen(function* () {
      const status = yield* HttpClientRequest.get("/global/transcript/search/status").pipe(HttpClient.execute)
      expect(status.status).toBe(200)
      expect(yield* status.json).toEqual({ ready: false, backfillCursor: "" })
      const search = yield* HttpClientRequest.post("/global/transcript/search").pipe(
        HttpClientRequest.bodyJsonUnsafe({ query: "literal.*", limit: 5, projectID: "absent" }),
        HttpClient.execute,
      )
      expect([search.status, yield* search.json]).toEqual([
        200,
        {
          hits: [],
          nextCursor: null,
          scanned: 0,
          complete: false,
          scanLimit: 500,
          contentLimit: 65536,
          scanLimited: false,
          truncatedDocuments: 0,
          status: { ready: false, backfillCursor: "" },
        },
      ])
      const backfill = yield* HttpClientRequest.post("/global/transcript/search/backfill").pipe(HttpClient.execute)
      expect(backfill.status).toBe(200)
      expect(yield* backfill.json).toEqual({ ready: true, backfillCursor: "" })
      const indexed = yield* HttpClientRequest.get("/global/transcript/search/status").pipe(HttpClient.execute)
      expect(yield* indexed.json).toEqual({ ready: true, backfillCursor: "" })
      const facets = yield* HttpClientRequest.get("/global/transcript/search/facets").pipe(HttpClient.execute)
      expect(facets.status).toBe(200)
      expect(yield* facets.json).toEqual({
        projects: [],
        agents: [],
        providers: [],
        models: [],
        tools: [],
        agentDetails: [],
        providerDetails: [],
        modelDetails: [],
        toolDetails: [],
        modelIdentities: [],
        projectDetails: [],
        truncated: false,
      })
    }),
  )

  it.live("rejects unsafe regex with a typed public error", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/global/transcript/search").pipe(
        HttpClientRequest.bodyJsonUnsafe({ query: "(a+)+$", mode: "regex" }),
        HttpClient.execute,
      )
      expect(response.status).toBe(400)
      expect(yield* response.json).toMatchObject({
        _tag: "InvalidRequestError",
        message: expect.stringContaining("quantifiers"),
      })
    }),
  )

  it.live("rejects unbounded transcript search payloads", () =>
    Effect.gen(function* () {
      for (const payload of [
        { query: "" },
        { query: "x", limit: 101 },
        { query: "x".repeat(257) },
        { query: "x", mode: "unknown" },
      ]) {
        const response = yield* HttpClientRequest.post("/global/transcript/search").pipe(
          HttpClientRequest.bodyJsonUnsafe(payload),
          HttpClient.execute,
        )
        expect(response.status).toBe(400)
      }
    }),
  )

  it.live("upgrades to the requested version", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "9.9.9" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects invalid upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: 1 }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects invalid upgrade target versions", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "latest" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("serves the added project list", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.projects).pipe(HttpClient.execute)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ projects: ["/repo"] })
    }),
  )

  it.live("applies semantic project list mutations", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch(GlobalPaths.projects).pipe(
        HttpClientRequest.bodyJsonUnsafe({ type: "add", directory: "/added" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ projects: ["/added", "/repo"] })
    }),
  )

  it.live("rejects invalid project list mutations", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch(GlobalPaths.projects).pipe(
        HttpClientRequest.bodyJsonUnsafe({ type: "move", directory: "/repo", toIndex: "first" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects unsupported upgrade content types", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text('{"target":"1.0.0"}', "text/plain")),
        HttpClient.execute,
      )

      expect(response.status).toBe(415)
    }),
  )
})
