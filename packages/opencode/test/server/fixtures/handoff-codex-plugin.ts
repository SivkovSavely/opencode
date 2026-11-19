import assert from "node:assert/strict"
import type { Plugin } from "@opencode-ai/plugin"
import { CodexAuthPlugin } from "../../../src/plugin/openai/codex"

const plugin: Plugin = (input) => {
  const issuer = process.env.HANDOFF_CODEX_ISSUER
  const endpoint = process.env.HANDOFF_CODEX_ENDPOINT
  assert(issuer && endpoint)
  assert.equal(new URL(issuer).hostname, "127.0.0.1")
  assert.equal(new URL(endpoint).origin, issuer)
  return CodexAuthPlugin(input, {
    issuer,
    codexApiEndpoint: endpoint,
    experimentalWebSockets: process.env.HANDOFF_CODEX_TRANSPORT === "ws",
  })
}

export default plugin
