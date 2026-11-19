import { expect } from "bun:test"
import { Effect } from "effect"
import { once } from "node:events"
import WebSocket from "ws"
import { createCodexServer } from "./codex-server"
import { awaitWithTimeout, testEffect } from "./effect"
import { reply, TestLLMServer } from "./llm-server"

const it = testEffect(TestLLMServer.layer)

for (const mode of ["refreshed-http", "refreshed-ws", "known-http", "unknown-http"] as const)
  it.live(`observes exact fabricated routing without exposing credentials: ${mode}`, () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const known = mode === "known-http"
      const websocket = mode === "refreshed-ws"
      const codex = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createCodexServer(
            llm.url,
            known ? { access: "fixture-fresh-test-access", accountId: "fixture-test-account" } : undefined,
          ),
        ),
        (server) => Effect.promise(() => server.close()),
      )
      const access = mode.startsWith("refreshed")
        ? yield* Effect.promise(async () => {
            const response = await fetch(`${codex.issuer}/oauth/token`, {
              method: "POST",
              body: "grant_type=refresh_token",
            })
            const body: unknown = await response.json()
            if (!body || typeof body !== "object" || !("access_token" in body) || typeof body.access_token !== "string")
              throw new Error("Missing fabricated access")
            return body.access_token
          })
        : "fixture-fresh-test-access"
      const account = known ? "fixture-test-account" : "fixture-account"
      const authorized = mode !== "unknown-http"
      const transport = websocket ? "ws" : "http"
      const cases: { headers: Record<string, string>; expected: (typeof codex.observations)[number] }[] = [
        {
          headers: { authorization: `Bearer ${access}`, "chatgpt-account-id": account },
          expected: { transport, authorized, accountMatched: true, internalHeaderPresent: false },
        },
        {
          headers: { authorization: "Bearer fixture-wrong-access", "chatgpt-account-id": account },
          expected: { transport, authorized: false, accountMatched: true, internalHeaderPresent: false },
        },
        {
          headers: { authorization: `Bearer ${access}`, "chatgpt-account-id": "fixture-wrong-account" },
          expected: { transport, authorized, accountMatched: false, internalHeaderPresent: false },
        },
        {
          headers: { authorization: `Bearer ${access}`, "chatgpt-account-id": account, "x-opencode-title": "true" },
          expected: { transport, authorized, accountMatched: true, internalHeaderPresent: true },
        },
      ]
      for (const scenario of cases) {
        yield* llm.push(reply().text("Synthetic routing result").stop())
        if (websocket) {
          const socket = yield* Effect.acquireRelease(
            Effect.sync(() => new WebSocket(codex.endpoint.replace("http:", "ws:"), { headers: scenario.headers })),
            (socket) => Effect.sync(() => socket.terminate()),
          )
          yield* Effect.promise(() => once(socket, "open"))
          const completed = Promise.withResolvers<void>()
          socket.on("message", (data) => {
            const event: unknown = JSON.parse(data.toString())
            if (event && typeof event === "object" && "type" in event && event.type === "response.completed")
              completed.resolve()
          })
          socket.send(JSON.stringify({ type: "response.create", model: "fixture-model", input: [] }))
          yield* awaitWithTimeout(
            Effect.promise(() => completed.promise),
            "Synthetic WS response did not complete",
            "2 seconds",
          )
          continue
        }
        yield* Effect.promise(async () => {
          const response = await fetch(codex.endpoint, {
            method: "POST",
            headers: { ...scenario.headers, "content-type": "application/json" },
            body: JSON.stringify({ model: "fixture-model", input: [] }),
            signal: AbortSignal.timeout(2000),
          })
          expect(response.status).toBe(200)
          await response.text()
        })
      }
      expect(codex.observations).toEqual(cases.map((scenario) => scenario.expected))
      expect(codex.frames).toHaveLength(cases.length)
      expect(codex.refreshes()).toBe(mode.startsWith("refreshed") ? 1 : 0)
    }),
  )
