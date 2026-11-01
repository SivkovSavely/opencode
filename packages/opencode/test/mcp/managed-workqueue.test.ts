import { describe, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import path from "node:path"
import { ManagedWorkQueue } from "../../src/mcp/managed-workqueue"
import { tmpdir } from "../fixture/fixture"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"

const tools: Tool[] = [
  { name: "wq_ping", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  {
    name: "wq_claim_work",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        checkoutPath: { type: "string" },
        expectedGeneration: { type: "integer" },
      },
      required: ["issueId", "checkoutPath", "expectedGeneration"],
      additionalProperties: false,
    },
  },
]

// Gateway profile: JSON-RPC initialization, opaque project-bound session, inline JSON or buffered SSE POST replies.
function gateway(
  options: {
    catalog?: Tool[]
    call?: () => Response | Promise<Response>
    sse?: boolean
    redirect?: string
  } = {},
) {
  const calls: Record<string, unknown>[] = []
  const methods: string[] = []
  const seen = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).search).toBe("?project=BAILA")
      methods.push(request.method)
      if (options.redirect) return Response.redirect(options.redirect, 307)
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const body = await request.json()
      if (body.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "workqueue-gateway", version: "0.1.0" },
            },
          },
          { headers: { "mcp-session-id": "project-bound-test-session" } },
        )
      expect(request.headers.get("mcp-session-id")).toBe("project-bound-test-session")
      expect(request.headers.get("mcp-protocol-version")).toBe("2025-03-26")
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "tools/list")
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: options.catalog ?? tools } })
      expect(body.method).toBe("tools/call")
      calls.push(body.params)
      seen.resolve()
      if (options.call) return options.call()
      const reply = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "completed" }] } }
      if (options.sse)
        return new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      return Response.json(reply)
    },
  })
  return {
    calls,
    methods,
    seen: seen.promise,
    policy: (directory: string, changes: Record<string, unknown> = {}) =>
      ManagedWorkQueue.loadPolicy(
        JSON.stringify({
          url: `http://127.0.0.1:${server.port}/mcp?project=BAILA`,
          project: "BAILA",
          directory,
          tools: ["wq_ping", "wq_claim_work"],
          ...changes,
        }),
      ).then((policy) => policy!),
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}

const authorize = async (open: () => void) => {
  open()
  return true
}

describe("managed WorkQueue operator policy", () => {
  test("rejects URLs outside the exact loopback project binding", async () => {
    await using tmp = await tmpdir()
    await using server = gateway()
    for (const url of [
      "https://127.0.0.1/mcp?project=BAILA",
      "http://localhost/mcp?project=BAILA",
      "http://127.0.0.2/mcp?project=BAILA",
      "http://user:pass@127.0.0.1/mcp?project=BAILA",
      "http://127.0.0.1/mcp?project=OTHER",
      "http://127.0.0.1/mcp?project=BAILA&project=BAILA",
      "http://127.0.0.1/mcp?project=BAILA&x=1",
      "http://127.0.0.1/mcp?project=BAILA#x",
      "http://127.0.0.1/other?project=BAILA",
    ])
      await expect(server.policy(tmp.path, { url })).rejects.toThrow()
    for (const names of [[], ["wq_ping", "wq_ping"], ["wq_unknown"], ["shell"]])
      await expect(server.policy(tmp.path, { tools: names })).rejects.toThrow()
    await expect(server.policy(tmp.path, { command: ["sh"] })).rejects.toThrow()
    const file = path.join(tmp.path, "not-a-directory")
    await Bun.write(file, "")
    await expect(server.policy(file)).rejects.toThrow("must be a directory")
    expect(server.methods).toEqual([])
  })

  test("canonicalizes aliases, rejects other workspaces and scoped arguments", async () => {
    await using tmp = await tmpdir()
    await using other = await tmpdir()
    await using server = gateway()
    const alias = path.join(other.path, "alias")
    await symlink(tmp.path, alias)
    const policy = await server.policy(alias)
    expect(policy.directory).toBe(tmp.path)
    await expect(ManagedWorkQueue.discover(policy, other.path)).rejects.toThrow("workspace")
    for (const args of [
      { projectKey: "BAILA" },
      { issueId: "OTHER-1" },
      { issueId: "BAILAX-1" },
      { issueId: "BAILA-1 trailing" },
      { checkoutPath: other.path },
      { prerequisiteIssueId: "OTHER-1" },
      { dependencies: ["OTHER-1"] },
    ])
      await expect(ManagedWorkQueue.prepare(policy, alias, "wq_claim_work", args, authorize)).rejects.toThrow()
    expect(server.methods).toEqual([])
  })
})

describe("managed WorkQueue gateway protocol", () => {
  test("discovers only explicitly allowed tools and uses fixed write classification", async () => {
    await using tmp = await tmpdir()
    await using server = gateway()
    const policy = await server.policy(tmp.path, { tools: ["wq_ping"] })
    const catalog = await ManagedWorkQueue.discover(policy, tmp.path)
    expect(catalog.map((tool) => tool.name)).toEqual(["wq_ping"])
    expect(catalog[0].annotations?.readOnlyHint).toBe(true)
    expect(ManagedWorkQueue.isReadOnly("wq_claim_work")).toBe(false)
    await expect(ManagedWorkQueue.prepare(policy, tmp.path, "wq_claim_work", {}, authorize)).rejects.toThrow(
      "operator policy",
    )
    expect(server.calls).toEqual([])
    expect(server.methods.every((method) => method === "POST")).toBe(true)
  })

  test("rejects unexpected catalogs, projectKey schemas and missing allowed tools", async () => {
    await using tmp = await tmpdir()
    for (const catalog of [
      [{ ...tools[0], name: "shell" }],
      [tools[0]],
      [tools[0], tools[0], tools[1]],
      [
        {
          ...tools[0],
          inputSchema: {
            type: "object" as const,
            properties: { projectKey: { type: "string" } },
            additionalProperties: false,
          },
        },
        tools[1],
      ],
      [{ ...tools[0], inputSchema: { type: "object" as const, properties: {}, additionalProperties: true } }, tools[1]],
      [{ ...tools[0], execution: { taskSupport: "required" as const } }, tools[1]],
    ]) {
      await using server = gateway({ catalog })
      await expect(ManagedWorkQueue.discover(await server.policy(tmp.path), tmp.path)).rejects.toThrow()
      expect(server.calls).toEqual([])
    }
  })

  test("validates arguments before requesting dispatch authorization", async () => {
    await using tmp = await tmpdir()
    await using server = gateway()
    const policy = await server.policy(tmp.path)
    await expect(
      ManagedWorkQueue.prepare(
        policy,
        tmp.path,
        "wq_claim_work",
        {
          issueId: "BAILA-1",
          checkoutPath: tmp.path,
          expectedGeneration: "not-an-integer",
        },
        () => {
          throw new Error("must not authorize")
        },
      ),
    ).rejects.toThrow("Invalid WorkQueue arguments")
    expect(server.calls).toEqual([])
  })

  for (const sse of [false, true])
    test(`inline ${sse ? "SSE" : "JSON"} completion confirms cleanup`, async () => {
      await using tmp = await tmpdir()
      await using server = gateway({ sse })
      const handle = await ManagedWorkQueue.prepare(
        await server.policy(tmp.path),
        tmp.path,
        "wq_claim_work",
        {
          issueId: "BAILA-1",
          checkoutPath: tmp.path,
          expectedGeneration: 0,
        },
        authorize,
      )
      const result = await handle.start()
      expect(result.cleanup).toBe("confirmed")
      expect(result.result?.content).toEqual([{ type: "text", text: "completed" }])
      expect(await handle.cancel()).toBe(result)
      expect(server.calls).toHaveLength(1)
      expect(server.calls[0].arguments).toEqual({ issueId: "BAILA-1", checkoutPath: tmp.path, expectedGeneration: 0 })
    })

  test("never follows redirects", async () => {
    await using tmp = await tmpdir()
    await using destination = gateway()
    const destinationPolicy = await destination.policy(tmp.path)
    await using server = gateway({ redirect: destinationPolicy.url })
    await expect(ManagedWorkQueue.discover(await server.policy(tmp.path), tmp.path)).rejects.toThrow()
    expect(destination.methods).toEqual([])
  })

  for (const status of [503, 404])
    test(`HTTP ${status} leaves dispatched outcome unknown without retry`, async () => {
      await using tmp = await tmpdir()
      await using server = gateway({ call: () => Response.json({ error: "unknown mutation outcome" }, { status }) })
      const handle = await ManagedWorkQueue.prepare(
        await server.policy(tmp.path),
        tmp.path,
        "wq_claim_work",
        {
          issueId: "BAILA-1",
          checkoutPath: tmp.path,
          expectedGeneration: 0,
        },
        authorize,
      )
      expect(await handle.start()).toMatchObject({ cleanup: "failed", error: expect.stringContaining("unknown") })
      expect(await handle.cancel()).toMatchObject({ cleanup: "failed" })
      expect(server.calls).toHaveLength(1)
    })

  test("ambiguous MCP errors and oversized replies do not confirm cleanup", async () => {
    await using tmp = await tmpdir()
    for (const reply of [
      { jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "partial write" }] } },
      { jsonrpc: "2.0", id: 2, error: { code: -32001, message: "unknown" } },
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "x".repeat(1024 * 1024) }] } },
    ]) {
      await using server = gateway({ call: () => Response.json(reply) })
      const handle = await ManagedWorkQueue.prepare(await server.policy(tmp.path), tmp.path, "wq_ping", {}, authorize)
      expect((await handle.start()).cleanup).toBe("failed")
      expect(server.calls).toHaveLength(1)
    }
  })

  test("a broken response body after dispatch leaves cleanup unknown", async () => {
    await using tmp = await tmpdir()
    await using server = gateway({
      call: () =>
        new Response('{"jsonrpc":"2.0","id":2,"result":', { headers: { "content-type": "application/json" } }),
    })
    const handle = await ManagedWorkQueue.prepare(await server.policy(tmp.path), tmp.path, "wq_ping", {}, authorize)
    expect(await handle.start()).toMatchObject({ cleanup: "failed", error: expect.stringContaining("unknown") })
    expect(server.calls).toHaveLength(1)
  })
})

describe("managed WorkQueue dispatch lifecycle", () => {
  test("an SDK deadline closes a still-pending authorization callback before confirming no operation", async () => {
    await using tmp = await tmpdir()
    await using server = gateway()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const opened = Promise.withResolvers<void>()
    const handle = await ManagedWorkQueue.prepare(
      await server.policy(tmp.path),
      tmp.path,
      "wq_ping",
      {},
      async (open) => {
        entered.resolve()
        await gate.promise
        open()
        opened.resolve()
        return true
      },
    )
    const pending = handle.start()
    await entered.promise
    try {
      expect(await pending).toMatchObject({ cleanup: "confirmed", error: expect.stringContaining("timed out") })
      expect(server.calls).toEqual([])
    } finally {
      gate.resolve()
    }
    await opened.promise
    // Observe the late callback beyond the terminal result, not just while authorization is blocked.
    await Bun.sleep(50)
    expect(await handle.start()).toBe(await pending)
    expect(server.calls).toEqual([])
  }, 45_000)

  test("retirement at the final authorization boundary prevents dispatch", async () => {
    await using tmp = await tmpdir()
    await using server = gateway()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const handle = await ManagedWorkQueue.prepare(await server.policy(tmp.path), tmp.path, "wq_ping", {}, async () => {
      entered.resolve()
      await gate.promise
      return false
    })
    const pending = handle.start()
    await entered.promise
    const cancelled = handle.cancel()
    gate.resolve()
    expect((await pending).cleanup).toBe("confirmed")
    expect(await cancelled).toBe(await pending)
    expect(server.calls).toEqual([])
  })

  test("cancellation before start confirms no remote operation", async () => {
    await using tmp = await tmpdir()
    await using server = gateway()
    const handle = await ManagedWorkQueue.prepare(await server.policy(tmp.path), tmp.path, "wq_ping", {}, authorize)
    expect((await handle.cancel()).cleanup).toBe("confirmed")
    await handle.start()
    expect(server.calls).toEqual([])
  })

  test("after dispatch cancellation joins the real response and cannot restart the operation", async () => {
    await using tmp = await tmpdir()
    const response = Promise.withResolvers<Response>()
    await using server = gateway({ call: () => response.promise })
    const handle = await ManagedWorkQueue.prepare(await server.policy(tmp.path), tmp.path, "wq_ping", {}, authorize)
    const pending = handle.start()
    await server.seen
    const cancelled = handle.cancel()
    const settled = { value: false }
    void cancelled.then(() => {
      settled.value = true
    })
    await Promise.resolve()
    expect(settled.value).toBe(false)
    expect(server.methods.every((method) => method === "POST")).toBe(true)
    response.resolve(Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "done" }] } }))
    expect((await cancelled).cleanup).toBe("confirmed")
    expect(await pending).toBe(await cancelled)
    await handle.start()
    expect(server.calls).toHaveLength(1)
  })
})
