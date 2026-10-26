import { Effect, Schema } from "effect"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import * as Tool from "./tool"
import DESCRIPTION from "./mcp-enable.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The configured MCP server name from the system prompt catalog" }),
})

export const McpEnableTool = Tool.define(
  "mcp_enable",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!(yield* mcp.configuredServer(params.name))) {
            return {
              title: "MCP server not found",
              metadata: { server: params.name },
              output: `MCP server "${params.name}" is not configured.`,
            }
          }

          yield* ctx.ask({
            permission: "mcp_enable",
            patterns: [params.name],
            always: [`=${params.name}`],
            metadata: { server: params.name },
          })

          if (ctx.abort.aborted) {
            return {
              title: "MCP activation cancelled",
              metadata: { server: params.name },
              output: "MCP activation was cancelled.",
            }
          }

          const aborted = Effect.callback<"cancelled">((resume) => {
            if (ctx.abort.aborted) return resume(Effect.succeed("cancelled"))
            const cancel = () => resume(Effect.succeed("cancelled"))
            ctx.abort.addEventListener("abort", cancel, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", cancel))
          })
          const result = yield* Effect.raceFirst(
            mcp.ensureConnected(params.name).pipe(
              Effect.catchTag("MCP.NotFoundError", () =>
                Effect.succeed({ status: "failed", error: `MCP server "${params.name}" is not configured.` } as const),
              ),
              Effect.map((status) => ({ status })),
            ),
            aborted.pipe(Effect.map(() => ({ cancelled: true as const }))),
          )

          if ("cancelled" in result) {
            return {
              title: "MCP activation cancelled",
              metadata: { server: params.name },
              output: "MCP activation was cancelled.",
            }
          }
          if (result.status.status !== "connected") {
            const output =
              result.status.status === "needs_auth"
                ? `MCP server "${params.name}" requires authentication. Run: opencode mcp auth ${params.name}`
                : result.status.status === "needs_client_registration"
                  ? `MCP server "${params.name}" requires OAuth client registration. ${result.status.error}`
                  : result.status.status === "failed"
                    ? `MCP server "${params.name}" could not connect: ${result.status.error}`
                    : `MCP server "${params.name}" is unavailable.`
            return { title: "MCP activation failed", metadata: { server: params.name }, output }
          }
          if (ctx.abort.aborted) {
            return {
              title: "MCP activation cancelled",
              metadata: { server: params.name },
              output: "MCP activation was cancelled.",
            }
          }

          const persisted = yield* sessions.addMcpActivation({
            sessionID: ctx.sessionID,
            name: params.name,
            signal: ctx.abort,
          })
          if (!persisted) {
            return {
              title: "MCP activation cancelled",
              metadata: { server: params.name },
              output: "MCP activation was cancelled.",
            }
          }
          return {
            title: `Activated MCP server: ${params.name}`,
            metadata: { server: params.name },
            output: `MCP server "${params.name}" is active for this session. Its tools will be available on the next model step.`,
          }
        }),
    }
  }),
)
