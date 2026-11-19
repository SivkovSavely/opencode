import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

const authenticated = testEffect(
  httpApiLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: "dcp-secret", OPENCODE_SERVER_USERNAME: "dcp-user" }),
      ),
    ),
  ),
)

authenticated.live("requires the server's existing authentication, not a dashboard token", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const denied = yield* requestInDirectory("/session/ses_missing_dcp/dcp", directory)
    expect(denied.status).toBe(401)
    const allowed = yield* requestInDirectory("/session/ses_missing_dcp/dcp", directory, {
      headers: { authorization: `Basic ${Buffer.from("dcp-user:dcp-secret").toString("base64")}` },
    })
    expect(allowed.status).toBe(404)
  }),
)

describe("session DCP HTTP endpoint", () => {
  it.live("returns absent state for an existing session without DCP installed", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const created = yield* requestInDirectory("/session", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "DCP isolation" }),
      })
      const session = (yield* created.json) as { id: string }
      const response = yield* requestInDirectory(`/session/${session.id}/dcp`, directory)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ sessionID: session.id, state: "absent" })
    }),
  )

  it.live("returns only the selected session snapshot and denies conflicting scope", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const other = yield* tmpdirScoped()
      const created = yield* requestInDirectory("/session", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "DCP scope" }),
      })
      const session = (yield* created.json) as { id: string }
      const file = path.join(process.env.XDG_DATA_HOME!, "opencode/storage/plugin/dcp", `${session.id}.json`)
      yield* Effect.promise(() => mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(file, { force: true })))
      yield* Effect.promise(() => Bun.write(file, JSON.stringify({ prune: {}, stats: { totalPruneTokens: 12 } })))
      const response = yield* requestInDirectory(`/session/${session.id}/dcp`, directory)
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        sessionID: session.id,
        state: "available",
        stats: { historicalRemovedTokens: 12 },
      })
      const foreign = yield* requestInDirectory(`/session/${session.id}/dcp`, other)
      expect(foreign.status).toBe(403)
      const header = yield* requestInDirectory(`/session/${session.id}/dcp`, directory, {
        headers: { "x-opencode-workspace": "wrk_foreign" },
      })
      expect(header.status).toBe(403)
      const missing = yield* requestInDirectory("/session/ses_missing_dcp/dcp", directory)
      expect(missing.status).toBe(404)
      const traversal = yield* requestInDirectory("/session/ses_%2e%2e%2fsecret/dcp", directory)
      expect(traversal.status).toBe(400)
    }),
  )
})
