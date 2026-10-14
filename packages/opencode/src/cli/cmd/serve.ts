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
