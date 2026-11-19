import assert from "node:assert/strict"
import path from "node:path"

// This entrypoint deliberately uses the production listener and startup recovery.
// The parent owns its disposable environment and terminates only this process.
const directory = process.env.HANDOFF_DIRECTORY
const ready = process.env.HANDOFF_READY
assert(directory && ready)
assert.equal(process.env.HOME, directory)
assert.equal(process.env.OPENCODE_DB, path.join(directory, "handoff.sqlite"))
for (const [key, suffix] of Object.entries({
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
}))
  assert.equal(process.env[key], path.join(directory, suffix))
if (process.env.HANDOFF_CODEX_ISSUER) {
  assert.equal(new URL(process.env.HANDOFF_CODEX_ISSUER).hostname, "127.0.0.1")
  assert.equal(process.env.OPENCODE_AUTH_CONTENT, undefined)
  if (process.env.HANDOFF_OAUTH_SEED === "1") {
    const { Auth } = await import("../../../src/auth")
    const { Effect } = await import("effect")
    const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
    await Effect.runPromise(
      Auth.Service.use((auth) =>
        Effect.gen(function* () {
          assert.equal(yield* auth.get("openai"), undefined)
          yield* auth.set("openai", {
            type: "oauth",
            access: "fixture-expired-access",
            refresh: "fixture-expired-refresh",
            expires: 0,
            accountId: "fixture-account",
          })
        }),
      ).pipe(Effect.provide(LayerNode.compile(Auth.node))),
    )
  }
}
const { Database } = await import("@opencode-ai/core/database/database")
const { Server } = await import("../../../src/server/server")
assert.equal(Database.path(), path.join(directory, "handoff.sqlite"))
const listener = await Server.listen({ hostname: "127.0.0.1", port: Number(process.env.HANDOFF_PORT) })
await Bun.write(ready, JSON.stringify({ pid: process.pid, port: listener.port, database: Database.path() }))
await new Promise(() => {})
