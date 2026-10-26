import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { GetPromptRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { Command } from "../src/command"
import { Config } from "../src/config/config"
import { MCP } from "../src/mcp"
import { Skill } from "../src/skill"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Command.node, MCP.node, Config.node, Skill.node])))

function promptServer() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "command-test", version: "1.0.0" }, { capabilities: { prompts: {} } })
      protocol.setRequestHandler(ListPromptsRequestSchema, () =>
        Promise.resolve({ prompts: [{ name: "review", description: "Review source code" }] }),
      )
      protocol.setRequestHandler(GetPromptRequestSchema, () =>
        Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "review prompt" } }] }),
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const http = Bun.serve({
        port: 0,
        fetch: (request) => transport.handleRequest(request),
      })
      return {
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

it.instance("exposes lazy MCP prompt commands only to activated sessions", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const commands = yield* Command.Service
    const server = yield* promptServer()
    yield* mcp.add("lazy-prompts", { type: "remote", url: server.url, oauth: false, enabled: false })
    yield* mcp.ensureConnected("lazy-prompts")

    expect(yield* commands.get("lazy-prompts:review")).toBeUndefined()
    expect((yield* commands.list()).some((item) => item.name === "lazy-prompts:review")).toBe(false)

    const prompt = yield* commands.get("lazy-prompts:review", ["lazy-prompts"])
    expect(prompt?.source).toBe("mcp")
    expect(prompt?.template).toBeInstanceOf(Promise)
    expect(yield* Effect.promise(() => prompt!.template as Promise<string>)).toBe("review prompt")
  }),
)
