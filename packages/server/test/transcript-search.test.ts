import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { TranscriptSearch } from "@opencode/schema/transcript-search"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { importTranscriptFixture, transcriptIDs } from "../../core/test/fixture/transcript-import"
import { ServerFetch } from "../src/fetch"
import { OpenCode } from "@opencode/client/promise"

test("authenticated native API searches imported persisted history and returns actual destination message identity", async () => {
  await using directory = await tmpdir("f002-api-")
  const path = `${directory.path}/fixture.db`
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* importTranscriptFixture(database.db, directory.path)
      }).pipe(
        Effect.provide(Database.layer({ path })),
        Effect.provideService(Global.Service, Global.make({ data: directory.path })),
      ),
    ),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* ServerFetch.make({
          app: { version: "test" },
          database: { path },
          config: { directory: directory.path, project: false },
          models: { fetch: false },
          fs: { filewatcher: false },
          password: "synthetic-f002",
        })
        for (const [method, endpoint, body] of [
          ["GET", "status", undefined],
          ["GET", "facets", undefined],
          ["POST", "backfill", {}],
          ["POST", "search", { query: "sentinel" }],
        ] as const) {
          const response = yield* Effect.promise(() =>
            handler(
              new Request(`http://opencode.local/api/experimental/transcript/${endpoint}`, {
                method,
                headers: { "content-type": "application/json" },
                body: body ? JSON.stringify(body) : undefined,
              }),
            ),
          )
          expect(response.status).toBe(401)
        }
        const api = OpenCode.make({
          baseUrl: "http://opencode.local",
          headers: { authorization: `Basic ${btoa("opencode:synthetic-f002")}` },
          fetch: Object.assign(
            (request: RequestInfo | URL, init?: RequestInit) => handler(new Request(request, init)),
            { preconnect: fetch.preconnect },
          ),
        })
        expect((yield* Effect.promise(() => api.experimental.transcript.status())).ready).toBe(false)
        expect((yield* Effect.promise(() => api.experimental.transcript.search({ query: "sentinel" }))).complete).toBe(
          false,
        )
        expect(
          (yield* Effect.promise(() => api.experimental.transcript.facets())).agents.map((item) => item.value),
        ).toContain("retired-agent")
        yield* Effect.promise(() => api.experimental.transcript.backfill({}))
        yield* Effect.promise(() => api.experimental.transcript.backfill({}))
        const result = yield* Effect.promise(() =>
          api.experimental.transcript.search({ query: "public-output-sentinel" }),
        )
        expect(result.complete).toBe(true)
        expect(result.hits.map((hit) => [hit.sessionID, hit.messageID, hit.partID, hit.category])).toEqual([
          [transcriptIDs.session, transcriptIDs.assistant, transcriptIDs.call, "tool-output"],
        ])
        const destination = yield* Effect.promise(() =>
          api.session.message.get({ sessionID: result.hits[0]!.sessionID, messageID: result.hits[0]!.messageID }),
        )
        expect(destination.id).toBe(transcriptIDs.assistant)
        expect(
          destination.type === "assistant" &&
            destination.content.some((part) => part.type === "tool" && part.id === transcriptIDs.call),
        ).toBe(true)
        expect((yield* Effect.promise(() => api.experimental.transcript.search({ query: "excluded" }))).hits).toEqual(
          [],
        )
        const invalid = yield* Effect.promise(() =>
          handler(
            new Request("http://opencode.local/api/experimental/transcript/search", {
              method: "POST",
              headers: {
                authorization: `Basic ${btoa("opencode:synthetic-f002")}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ query: "hello+", mode: "regex" }),
            }),
          ),
        )
        expect(invalid.status).toBe(400)
        const status = yield* Effect.promise(() => api.experimental.transcript.status())
        expect(Schema.is(TranscriptSearch.Status)(status)).toBe(true)
      }),
    ),
  )
})
