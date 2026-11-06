import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { ServerFetch } from "@opencode/server/fetch"
import { importTranscriptFixture } from "../../../core/test/fixture/transcript-import"

const home = process.env.OPENCODE_TEST_HOME!
const path = `${home}/transcript.db`
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Database.Service
      // Keep the imported turn outside the first native history window.
      yield* importTranscriptFixture(database.db, home, 80)
    }).pipe(
      Effect.provide(Database.layer({ path })),
      Effect.provideService(Global.Service, Global.make({ data: home })),
    ),
  ),
)

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const handler = yield* ServerFetch.make({
        app: { version: "f002-fixture" },
        database: { path },
        password: "synthetic-f002",
        config: { directory: home, project: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      })
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request), idleTimeout: 0 }),
        ),
        (server) =>
          Effect.promise(async () => {
            await server.stop(true)
          }),
      )
      console.log(`F002_READY http://127.0.0.1:${server.port}`)
      yield* Effect.callback<void>((resume) => {
        const stop = () => resume(Effect.void)
        process.once("SIGTERM", stop)
        return Effect.sync(() => process.removeListener("SIGTERM", stop))
      })
    }),
  ),
)
