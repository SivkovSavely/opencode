import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { make } from "../src/promise/generated/client"
import { OpenCode } from "../src/effect/index"

const input = { workspaceID: "synthetic", method: "GET" as const, path: "/api/info", headers: {} }

for (const transport of ["Promise", "Effect"]) {
  for (const status of [200, 201, 204, 206]) {
    for (const media of ["application/octet-stream", "application/json", "text/plain"]) {
      test(`generated ${transport} preserves raw workspace bytes for ${status} ${media}`, async () => {
        const bytes = status === 204 ? new Uint8Array() : new Uint8Array([0, 255, 10])
        const response = () =>
          new Response(status === 204 ? null : bytes, {
            status,
            headers: { "content-type": media, ...(status === 206 ? { "content-range": "bytes 0-2/10" } : {}) },
          })
        const client = make({ baseUrl: "http://synthetic.invalid", fetch: async () => response() })
        if (transport === "Promise") {
          expect(await client.experimental.workspace.dispatch(input)).toEqual(bytes)
          return
        }
        const result = await Effect.gen(function* () {
          const client = yield* OpenCode.make({ baseUrl: "http://synthetic.invalid" })
          return yield* client.experimental.workspace.dispatch(input)
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response()))),
          ),
          Effect.runPromise,
        )
        expect(result).toEqual(bytes)
      })
    }
  }
}

for (const [status, tag] of [
  [400, "InvalidRequestError"],
  [401, "UnauthorizedError"],
  [403, "ForbiddenError"],
  [409, "ConflictError"],
  [503, "ServiceUnavailableError"],
  [418, undefined],
  [500, undefined],
] as const) {
  test(`generated workspace clients reject error status ${status}`, async () => {
    const response = () => Response.json({ _tag: tag ?? "UnknownError", message: "synthetic" }, { status })
    const client = make({ baseUrl: "http://synthetic.invalid", fetch: async () => response() })
    await expect(client.experimental.workspace.dispatch(input)).rejects.toMatchObject(
      tag ? { _tag: tag, message: "synthetic" } : { reason: "UnexpectedStatus" },
    )
    const result = await Effect.gen(function* () {
      const client = yield* OpenCode.make({ baseUrl: "http://synthetic.invalid" })
      return yield* client.experimental.workspace.dispatch(input)
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response()))),
      ),
      Effect.result,
      Effect.runPromise,
    )
    expect(result._tag).toBe("Failure")
    expect(result).toMatchObject({ failure: tag ? { _tag: tag, message: "synthetic" } : { _tag: "ClientError" } })
  })
}

for (const status of [201, 204, 206]) {
  test(`ordinary generated JSON clients still reject unexpected ${status}`, async () => {
    const response = () =>
      new Response(
        status === 204 ? null : JSON.stringify({ version: "synthetic", pid: 1, urls: [], paths: { tmp: "/tmp" } }),
        { status, headers: { "content-type": "application/json" } },
      )
    const client = make({ baseUrl: "http://synthetic.invalid", fetch: async () => response() })
    await expect(client.server.info()).rejects.toMatchObject({ reason: "UnexpectedStatus" })
    const result = await Effect.gen(function* () {
      const client = yield* OpenCode.make({ baseUrl: "http://synthetic.invalid" })
      return yield* client.server.info()
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response()))),
      ),
      Effect.result,
      Effect.runPromise,
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ClientError" } })
  })
}

test("ordinary Effect JSON schema decoding remains strict", async () => {
  const result = await Effect.gen(function* () {
    const client = yield* OpenCode.make({ baseUrl: "http://synthetic.invalid" })
    return yield* client.server.info()
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: 123 }))),
      ),
    ),
    Effect.result,
    Effect.runPromise,
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ClientError" } })
})
