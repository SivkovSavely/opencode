import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ManagedCommand } from "@opencode-ai/core/managed-command"
import { Effect, Fiber } from "effect"
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { ManagedWorkQueue } from "../../src/mcp/managed-workqueue"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node])))

describe("managed WorkQueue durable operation ownership", () => {
  for (const mode of [
    "complete",
    "retire",
    "interrupt",
    "unknown",
    "before-dispatch",
    "abort-metadata",
    "abort-dispatched",
  ] as const) {
    it.live(`retains the actual remote operation (${mode})`, () =>
      Effect.gen(function* () {
        const previous = process.env.OPENCODE_MANAGED_PROFILE
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.OPENCODE_MANAGED_PROFILE = "1"
          }),
          () =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.OPENCODE_MANAGED_PROFILE
              else process.env.OPENCODE_MANAGED_PROFILE = previous
            }),
        )
        const directory = (yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )).path
        const seen = Promise.withResolvers<void>()
        const finish = Promise.withResolvers<void>()
        const prepared = Promise.withResolvers<void>()
        const start = Promise.withResolvers<void>()
        const listed = Promise.withResolvers<void>()
        const metadata = Promise.withResolvers<void>()
        const controller = new AbortController()
        const noDispatch = mode === "before-dispatch" || mode === "abort-metadata"
        const calls: unknown[] = []
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              async fetch(request) {
                expect(new URL(request.url).search).toBe("?project=BAILA")
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
                    { headers: { "mcp-session-id": "bound-session" } },
                  )
                expect(request.headers.get("mcp-session-id")).toBe("bound-session")
                if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
                if (body.method === "tools/list") {
                  listed.resolve()
                  if (mode === "abort-metadata") await metadata.promise
                  return Response.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                      tools: [
                        {
                          name: "wq_update_progress",
                          inputSchema: {
                            type: "object",
                            properties: {
                              issueId: { type: "string" },
                            },
                            required: ["issueId"],
                            additionalProperties: false,
                          },
                        },
                      ],
                    },
                  })
                }
                expect(body.method).toBe("tools/call")
                calls.push(body.params)
                seen.resolve()
                await finish.promise
                if (mode === "unknown") return new Response("UnknownMutationOutcomeError: fenced", { status: 503 })
                return Response.json({
                  jsonrpc: "2.0",
                  id: body.id,
                  result: { content: [{ type: "text", text: "completed" }] },
                })
              },
            }),
          ),
          (server) =>
            Effect.promise(async () => {
              finish.resolve()
              start.resolve()
              metadata.resolve()
              await server.stop(true)
            }),
        )
        const policy = yield* Effect.promise(() =>
          ManagedWorkQueue.loadPolicy(
            JSON.stringify({
              url: `http://127.0.0.1:${server.port}/mcp?project=BAILA`,
              project: "BAILA",
              directory,
              tools: ["wq_update_progress"],
            }),
          ),
        )
        if (!policy) throw new Error("Missing policy")
        const database = yield* Database.Service
        const root = randomUUID()
        yield* database.db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
          VALUES (${root}, ${directory}, 0, 0, '[]')`)
        yield* database.db
          .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES (${root}, ${root}, ${root}, ${directory}, 'test', '1', 0, 0)`)
        yield* ManagedCommand.enrollCreatedRoot(database, root)
        const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope, database)
        const lease = yield* runtime.admit({ sessionID: root, directory })
        const operation = yield* runtime
          .runManagedCommand(
            root,
            async (authorize) => {
              const handle = await ManagedWorkQueue.prepare(
                policy,
                directory,
                "wq_update_progress",
                { issueId: "BAILA-1" },
                authorize,
                controller.signal,
              )
              prepared.resolve()
              if (mode === "before-dispatch") await start.promise
              return handle
            },
            lease.fence,
            { preparation: "process-free" },
          )
          .pipe(Effect.forkChild)
        yield* Effect.promise(() =>
          mode === "abort-metadata" ? listed.promise : mode === "before-dispatch" ? prepared.promise : seen.promise,
        )
        expect(yield* runtime.commandStatus(root)).toBe("draining")
        if (mode === "retire" || mode === "before-dispatch") yield* runtime.retireRoot(root)
        if (mode === "interrupt") yield* Fiber.interrupt(operation)
        if (mode === "abort-metadata" || mode === "abort-dispatched") controller.abort()
        yield* runtime.complete(root)
        yield* runtime.release(root, lease.fence)
        // The durable permit, not the released provider lease, owns the pending HTTP reply.
        expect(yield* runtime.commandStatus(root)).toBe("draining")
        start.resolve()
        metadata.resolve()
        finish.resolve()
        if (mode !== "interrupt") {
          const result = yield* Fiber.join(operation)
          expect(result.cleanup).toBe(mode === "unknown" ? "failed" : "confirmed")
          if (mode === "unknown") expect(result.error).toContain("unknown")
        }
        const expected = mode === "unknown" ? "unknown" : "drained"
        yield* pollWithTimeout(
          Effect.gen(function* () {
            return (yield* runtime.commandStatus(root)) === expected ? true : undefined
          }),
          "remote operation never settled its durable permit",
        )
        expect(calls).toHaveLength(noDispatch ? 0 : 1)
        const rows = yield* database.db.all<{ state: string }>(
          sql`SELECT state FROM managed_command WHERE session_id = ${root}`,
        )
        expect(rows.map((row) => row.state).toSorted()).toEqual([
          "confirmed",
          mode === "unknown" ? "unknown" : "confirmed",
        ])
        if (mode === "abort-metadata" || mode === "abort-dispatched") {
          const resumed = yield* runtime.admit({ sessionID: root, directory })
          yield* runtime.complete(root)
          yield* runtime.release(root, resumed.fence)
          expect(yield* runtime.commandStatus(root)).toBe("drained")
          expect(calls).toHaveLength(noDispatch ? 0 : 1)
        }
        if (mode === "retire" || mode === "before-dispatch") {
          expect(yield* runtime.admit({ sessionID: root, directory }).pipe(Effect.flip)).toMatchObject({
            reason: "retired",
          })
          expect(
            yield* runtime
              .runManagedCommand(
                root,
                (authorize) =>
                  ManagedWorkQueue.prepare(policy, directory, "wq_update_progress", { issueId: "BAILA-1" }, authorize),
                lease.fence,
                { preparation: "process-free" },
              )
              .pipe(Effect.flip),
          ).toBeInstanceOf(ManagedCommand.AdmissionError)
          yield* runtime.complete(root)
          expect(yield* runtime.commandStatus(root)).toBe("drained")
          expect(calls).toHaveLength(mode === "before-dispatch" ? 0 : 1)
        }
      }),
    )
  }
})
