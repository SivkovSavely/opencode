import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    const { AppRuntime } = yield* Effect.promise(() => import("../../effect/app-runtime"))
    const { InstanceStore } = yield* Effect.promise(() => import("../../project/instance-store"))
    const { SessionPrompt } = yield* Effect.promise(() => import("../../session/prompt"))
    const { SessionID } = yield* Effect.promise(() => import("../../session/schema"))
    const { RuntimeLifecycle } = yield* Effect.promise(() => import("../../server/runtime-lifecycle"))
    const runtime = RuntimeLifecycle.current()
    if (runtime) {
      yield* Effect.logInfo("restart diagnostic recovery invocation beginning", {
        lineage: runtime.identity.lineage,
        instance: runtime.identity.instance,
        restartSupported: runtime.identity.restartSupported,
      })
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* InstanceStore.Service
            const prompt = yield* SessionPrompt.Service
            yield* runtime.recover((record) =>
              store.provide(
                { directory: record.directory },
                prompt.loop({ sessionID: SessionID.make(record.sessionID) }),
              ),
            )
          }),
        ),
      )
      yield* Effect.logInfo("restart diagnostic recovery scheduling complete", {
        lineage: runtime.identity.lineage,
        instance: runtime.identity.instance,
        note: "recover scheduled recovery fibers; asynchronous recovery may still be running",
      })
    }

    const requestShutdown = () => {
      AppRuntime.runPromise(server.lifecycle.request("shutdown")).catch(() => {})
    }
    process.once("SIGTERM", requestShutdown)
    process.once("SIGINT", requestShutdown)
    yield* server.lifecycle.awaitStop
    process.off("SIGTERM", requestShutdown)
    process.off("SIGINT", requestShutdown)
    yield* Effect.promise(() => server.stop(true))
    if (server.lifecycle.identity.restartSupported && server.lifecycle.identity.lineage) {
      const status = yield* server.lifecycle.status()
      if (status.action === "restart") process.exitCode = 75
    }
  }),
})
