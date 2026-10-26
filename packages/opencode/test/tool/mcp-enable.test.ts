import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { McpEnableTool } from "@/tool/mcp-enable"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"

const ctx = (ask: Tool.Context["ask"], abort = new AbortController().signal): Tool.Context => ({
  sessionID: SessionID.make("ses_mcp-enable"),
  messageID: MessageID.make("msg_mcp-enable"),
  agent: "build",
  abort,
  callID: "call_mcp-enable",
  messages: [],
  metadata: () => Effect.void,
  ask,
})

function layer(input: {
  status: MCP.Status
  activated: string[]
  ensureConnected?: () => Effect.Effect<MCP.Status>
  addMcpActivation?: (input: { sessionID: SessionID; name: string; signal?: AbortSignal }) => Effect.Effect<boolean>
}) {
  return Layer.mergeAll(
    Layer.mock(MCP.Service, {
      configuredServer: () => Effect.succeed(true),
      ensureConnected: input.ensureConnected ?? (() => Effect.succeed(input.status)),
    }),
    Layer.mock(Session.Service, {
      addMcpActivation: input.addMcpActivation ?? (({ name }) => Effect.sync(() => (input.activated.push(name), true))),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build", mode: "primary", options: {}, permission: [] } as Agent.Info),
    }),
    Layer.mock(Truncate.Service, {
      output: (content: string) => Effect.succeed({ content, truncated: false as const }),
    }),
  )
}

async function tool(services: ReturnType<typeof layer>) {
  return Effect.runPromise(McpEnableTool.pipe(Effect.flatMap(Tool.init), Effect.provide(services)))
}

describe("mcp_enable", () => {
  test("checks activation permission and persists only a successful connection", async () => {
    const activated: string[] = []
    const asks: unknown[] = []
    const initialized = await tool(layer({ status: { status: "connected" }, activated }))
    const result = await Effect.runPromise(
      initialized.execute(
        { name: "lazy" },
        ctx((request) => Effect.sync(() => void asks.push(request))),
      ),
    )

    expect(asks).toEqual([
      {
        permission: "mcp_enable",
        patterns: ["lazy"],
        always: ["=lazy"],
        metadata: { server: "lazy" },
      },
    ])
    expect(activated).toEqual(["lazy"])
    expect(result.output).toContain("available on the next model step")
  })

  test("does not persist failed connections or denied activation", async () => {
    const activated: string[] = []
    const initialized = await tool(layer({ status: { status: "failed", error: "offline" }, activated }))
    const failed = await Effect.runPromise(
      initialized.execute(
        { name: "lazy" },
        ctx(() => Effect.void),
      ),
    )
    expect(failed.output).toContain("could not connect")
    expect(activated).toEqual([])

    let attempts = 0
    const denied = await tool(
      layer({
        status: { status: "connected" },
        activated,
        ensureConnected: () => {
          attempts++
          return Effect.succeed({ status: "connected" })
        },
      }),
    )
    await expect(
      Effect.runPromise(
        denied.execute(
          { name: "lazy" },
          ctx(() => Effect.die(new Error("denied"))),
        ),
      ),
    ).rejects.toThrow("denied")
    expect(attempts).toBe(0)
    expect(activated).toEqual([])
  })

  test("reports the durable activation outcome when aborted during persistence", async () => {
    const activated: string[] = []
    const controller = new AbortController()
    let entered!: () => void
    let complete!: () => void
    const persistenceStarted = new Promise<void>((resolve) => (entered = resolve))
    const continuePersistence = new Promise<void>((resolve) => (complete = resolve))
    const initialized = await tool(
      layer({
        status: { status: "connected" },
        activated,
        addMcpActivation: ({ name }) =>
          Effect.promise(async () => {
            entered()
            await continuePersistence
            activated.push(name)
            return true
          }),
      }),
    )

    const execution = Effect.runPromise(
      initialized.execute(
        { name: "lazy" },
        ctx(() => Effect.void, controller.signal),
      ),
    )
    await persistenceStarted
    controller.abort()
    complete()
    const result = await execution

    expect(result.title).toBe("Activated MCP server: lazy")
    expect(activated).toEqual(["lazy"])
  })
})
