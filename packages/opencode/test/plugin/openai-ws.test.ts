import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http"
import net, { type AddressInfo, type Socket } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import { APICallError } from "ai"
import { ProviderError } from "../../src/provider/error"
import { OpenAIWebSocket } from "../../src/plugin/openai/ws"
import { OpenAIWebSocketPool, TITLE_HEADER } from "../../src/plugin/openai/ws-pool"
import { DispatchTransport } from "../../src/provider/dispatch-transport"

describe("plugin.openai.ws", () => {
  test("controlled busy-lane fallback keeps concurrent request intents separate", async () => {
    const received = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const frames: unknown[] = []
    await using server = await createWebSocketServer((socket) => {
      socket.on("message", async (data) => {
        frames.push(JSON.parse(data.toString()))
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
        received.resolve()
        await release.promise
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp-concurrent" } }))
      })
    })
    const pool = OpenAIWebSocketPool.createWebSocketFetch()
    const bun = await import("bun")
    const prepared: string[] = []
    const request = (model: string, effort: string) => {
      const state: { ready?: Promise<void> } = {}
      const validate = (serialized: unknown) => {
        const body: unknown = JSON.parse(String(serialized))
        expect(body).toMatchObject({ model, reasoning: { effort } })
      }
      return pool.controlled(
        {
          validateHttp: validate,
          validateFrame: validate,
          prepared: () =>
            (state.ready ??= Promise.resolve().then(() => {
              prepared.push(model)
            })),
        },
        bun.fetch,
      )(server.url, {
        method: "POST",
        headers: { "session-id": "same-lane" },
        body: JSON.stringify({ stream: true, model, reasoning: { effort } }),
      })
    }
    try {
      const first = await request("gpt-6.1-sol", "xhigh")
      await received.promise
      const second = await request("gpt-6.1-terra", "max")
      expect(await second.text()).toBe("http")
      expect(server.httpRequests).toHaveLength(1)
      expect(JSON.parse(await server.httpBodies[0])).toMatchObject({
        model: "gpt-6.1-terra",
        reasoning: { effort: "max" },
      })
      release.resolve()
      expect(await first.text()).toContain("data: [DONE]")
      expect(frames).toEqual([{ type: "response.create", model: "gpt-6.1-sol", reasoning: { effort: "xhigh" } }])
      expect(prepared).toEqual(["gpt-6.1-sol", "gpt-6.1-terra"])
    } finally {
      release.resolve()
      pool.close()
    }
  })

  test("controlled send is cancelled while its prepared callback is pending", async () => {
    const frames: unknown[] = []
    await using server = await createWebSocketServer((socket) => {
      socket.on("message", (data) => frames.push(JSON.parse(data.toString())))
    })
    const socket = await OpenAIWebSocket.connectResponsesWebSocket({ url: server.wsUrl, headers: {} })
    const started = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const abort = new AbortController()
    const sends: unknown[] = []
    const send = socket.send
    Object.defineProperty(socket, "send", {
      value(...args: Parameters<typeof send>) {
        sends.push(args[0])
        return Reflect.apply(send, socket, args)
      },
    })
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, model: "target", reasoning: { effort: "xhigh" } },
      signal: abort.signal,
      boundary: {
        validateHttp() {},
        validateFrame() {},
        prepared() {
          started.resolve()
          return ready.promise
        },
      },
    })
    const text = readTextError(response.text())
    await started.promise
    abort.abort()
    ready.resolve()
    await ready.promise
    expect((await text).name).toBe("AbortError")
    expect(sends).toHaveLength(0)
    expect(frames).toHaveLength(0)
  })

  test("controlled HTTP fallback is cancelled after awaiting prepared", async () => {
    await using server = await createHttpServer()
    const pool = OpenAIWebSocketPool.createWebSocketFetch()
    const started = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const abort = new AbortController()
    const bun = await import("bun")
    const calls: unknown[] = []
    const request = pool.controlled(
      {
        validateHttp() {},
        validateFrame() {},
        prepared() {
          started.resolve()
          return ready.promise
        },
      },
      (input, init) => {
        calls.push(input)
        return bun.fetch(input, init)
      },
    )(server.url, {
      method: "POST",
      signal: abort.signal,
      body: JSON.stringify({ stream: true, model: "target", reasoning: { effort: "max" } }),
    })
    await started.promise
    abort.abort()
    ready.resolve()
    await expect(request).rejects.toHaveProperty("name", "AbortError")
    expect(calls).toHaveLength(0)
    expect(server.httpRequests).toHaveLength(0)
    pool.close()
  })

  test("controlled frame rejection is fatal before handshake and never uses HTTP fallback", async () => {
    const connections: unknown[] = []
    await using server = await createWebSocketServer((socket) => connections.push(socket))
    const pool = OpenAIWebSocketPool.createWebSocketFetch({ streamRetries: 0 })
    const calls: unknown[] = []
    const prepared: unknown[] = []
    const boundary: DispatchTransport.Boundary = {
      validateHttp() {},
      validateFrame() {
        throw new DispatchTransport.UnsupportedDispatch()
      },
      prepared: async () => {
        prepared.push(true)
      },
    }
    await expect(
      pool.controlled(boundary, async (input) => {
        calls.push(input)
        return new Response("unexpected")
      })(server.url, streamRequest()),
    ).rejects.toBeInstanceOf(DispatchTransport.UnsupportedDispatch)
    expect(connections).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(prepared).toHaveLength(0)
    pool.close()
  })

  test("controlled final frame rejection suppresses enabled retries and releases its lane", async () => {
    const connections: WebSocket[] = []
    const frames: unknown[] = []
    const closed = Promise.withResolvers<void>()
    await using server = await createWebSocketServer((socket) => {
      connections.push(socket)
      if (connections.length === 1) socket.once("close", () => closed.resolve())
      socket.on("message", (data) => {
        frames.push(JSON.parse(data.toString()))
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp-recovered-lane" } }))
      })
    })
    const pool = OpenAIWebSocketPool.createWebSocketFetch({ streamRetries: 3 })
    const bun = await import("bun")
    const failure = new DispatchTransport.UnsupportedDispatch()
    const state: { checks: number; prepared: number; ready?: Promise<void> } = { checks: 0, prepared: 0 }
    try {
      const boundary: DispatchTransport.Boundary = {
        validateHttp() {},
        validateFrame() {
          state.checks++
          if (state.checks !== 2) return
          expect(connections).toHaveLength(1)
          throw failure
        },
        prepared: () =>
          (state.ready ??= Promise.resolve().then(() => {
            state.prepared++
          })),
      }
      await expect(pool.controlled(boundary, bun.fetch)(server.url, streamRequest())).rejects.toBe(failure)
      await closed.promise
      expect(failure).toMatchObject({ _tag: "UnsupportedDispatch" })
      expect(failure.message).toBe("unsupported_dispatch: controlled model/effort could not be verified")
      expect(state.checks).toBe(2)
      expect(state.prepared).toBe(1)
      expect(connections).toHaveLength(1)
      expect(frames).toHaveLength(0)
      expect(server.httpRequests).toHaveLength(0)

      const recovered = { prepared: 0, ready: undefined as Promise<void> | undefined }
      const response = await pool.controlled(
        {
          validateHttp() {},
          validateFrame() {},
          prepared: () =>
            (recovered.ready ??= Promise.resolve().then(() => {
              recovered.prepared++
            })),
        },
        bun.fetch,
      )(server.url, streamRequest())
      expect(await response.text()).toContain("data: [DONE]")
      expect(recovered.prepared).toBe(1)
      expect(state.prepared).toBe(1)
      expect(connections).toHaveLength(2)
      expect(frames).toHaveLength(1)
      expect(server.httpRequests).toHaveLength(0)
    } finally {
      pool.close()
    }
  })

  test("derives websocket URLs and sends auth plus protocol headers", async () => {
    let headers: IncomingMessage["headers"] | undefined
    await using server = await createWebSocketServer((_socket, request) => {
      headers = request.headers
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({
      url: server.wsUrl,
      headers: {
        authorization: "Bearer test",
        "content-length": "123",
        "x-openai-internal-codex-residency": "eu",
      },
    })

    expect(OpenAIWebSocket.toWebSocketUrl("http://example.com/v1/responses")).toBe("ws://example.com/v1/responses")
    expect(OpenAIWebSocket.toWebSocketUrl("https://example.com/v1/responses")).toBe("wss://example.com/v1/responses")
    expect(headers?.authorization).toBe("Bearer test")
    expect(headers?.["openai-beta"]).toBe(OpenAIWebSocket.PROTOCOL_HEADER)
    expect(headers?.["x-openai-internal-codex-residency"]).toBe("eu")
    expect(headers?.["content-length"]).toBeUndefined()
    socket.terminate()
  })

  test("enforces websocket connect timeout", async () => {
    await using server = await createHangingTcpServer()

    await expect(
      OpenAIWebSocket.connectResponsesWebSocket({
        url: server.wsUrl,
        headers: {},
        timeout: 20,
      }),
    ).rejects.toThrow("WebSocket connect timed out")
  })

  test("surfaces websocket upgrade rejection messages", async () => {
    await using server = await createRejectingWebSocketServer(() => {})
    // Bun versions differ in upgrade error wording; preserve the native diagnostic.
    const error = await new Promise<Error>((resolve, reject) => {
      const socket = new WebSocket(server.wsUrl)
      socket.once("error", resolve)
      socket.once("open", () => reject(new Error("Expected websocket upgrade rejection")))
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.message.length).toBeGreaterThan(0)

    await expect(
      OpenAIWebSocket.connectResponsesWebSocket({
        url: server.wsUrl,
        headers: {},
      }),
    ).rejects.toMatchObject({ name: error.name, message: error.message })
  })

  test("enforces websocket send idle timeout", async () => {
    const socket = new (class extends EventEmitter {
      send(_data: string, _callback: (error?: Error) => void) {}
    })() as unknown as WebSocket
    const invalid: string[] = []
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, input: "hi" },
      idleTimeout: 20,
      onConnectionInvalid: (error) => invalid.push(error.message),
    })

    expect((await readTextError(response.text())).message).toContain("idle timeout sending websocket request")
    expect(invalid).toEqual(["idle timeout sending websocket request"])
  })

  test("streams websocket events as SSE and handles response.done", async () => {
    let requestBody: unknown
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", (data) => {
        requestBody = JSON.parse(data.toString())
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "hello" }))
        socket.send(JSON.stringify({ type: "response.done", response: { id: "resp_123" } }))
        socket.close(1000, "done")
      })
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({
      url: server.wsUrl,
      headers: { authorization: "Bearer test", "content-length": "123" },
    })
    const completed: Record<string, unknown>[] = []
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, background: true, input: "hi" },
      onComplete: (event) => completed.push(event),
    })

    expect(await response.text()).toBe(
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.done","response":{"id":"resp_123"}}\n\ndata: [DONE]\n\n',
    )
    expect(requestBody).toEqual({ type: "response.create", input: "hi" })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.type).toBe("response.done")
  })

  test("errors the SSE stream when the server closes before a terminal event", async () => {
    const invalid: Error[] = []
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.close(1009, "payload too large")
      })
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({ url: server.wsUrl, headers: {} })
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, input: "hi" },
      onConnectionInvalid: (error) => invalid.push(error),
    })

    expect((await readTextError(response.text())).message).toContain(
      "WebSocket closed before response.completed (code 1009: message too big: payload too large)",
    )
    expect(invalid[0]).toBeInstanceOf(ProviderError.ResponseStreamError)
    expect(invalid.map((error) => error.message)).toEqual([
      "WebSocket closed before response.completed (code 1009: message too big: payload too large)",
    ])
  })

  test("rejects unexpected binary websocket frames", async () => {
    const invalid: string[] = []
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(Buffer.from("not json text"))
      })
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({ url: server.wsUrl, headers: {} })
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, input: "hi" },
      onConnectionInvalid: (error) => invalid.push(error.message),
    })

    expect((await readTextError(response.text())).message).toContain("Unexpected binary WebSocket frame")
    expect(invalid).toEqual(["Unexpected binary WebSocket frame"])
  })
})

describe("plugin.openai.ws-pool", () => {
  test("reuses one healthy websocket for sequential requests", async () => {
    let connections = 0
    let messages = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.on("message", () => {
        messages += 1
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${messages}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain("data: [DONE]")

    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(1)
    expect(messages).toBe(2)
    fetch.close()
  })

  test("rotates a socket that exceeds max connection age", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${connections}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      maxConnectionAge: 0,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain("data: [DONE]")

    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    fetch.close()
  })

  test("falls back to HTTP after websocket setup retries are exhausted", async () => {
    const attempts: string[] = []
    await using server = await createRejectingWebSocketServer(() => attempts.push("websocket"))
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 100,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "false" }))
    expect(await readTextError(first.text())).toBeInstanceOf(ProviderError.ResponseStreamError)
    const second = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "false" }))
    const third = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "false" }))

    expect(await second.text()).toBe("http")
    expect(await third.text()).toBe("http")
    expect(attempts).toEqual(["websocket", "websocket"])
    expect(server.httpRequests).toHaveLength(2)
    expect(server.httpRequests[0]?.headers[TITLE_HEADER]).toBeUndefined()
    expect(server.httpRequests[1]?.headers[TITLE_HEADER]).toBeUndefined()
    fetch.close()
  })

  test("keeps HTTP fallback active after its idle timeout", async () => {
    let websocketAttempts = 0
    await using server = await createRejectingWebSocketServer(() => websocketAttempts++)
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 100,
      idleTimeout: 20,
      streamRetries: 0,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toBe("http")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(websocketAttempts).toBe(1)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("falls back immediately to HTTP when a websocket request is too large", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => socket.close(1009, "payload too large"))
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    const second = await fetch(server.url, streamRequest())

    expect(await first.text()).toBe("http")
    expect(await second.text()).toBe("http")
    expect(connections).toBe(1)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("removes HTTP fallback when its session is deleted", async () => {
    let websocketAttempts = 0
    await using server = await createRejectingWebSocketServer(() => websocketAttempts++)
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 100,
      streamRetries: 0,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toBe("http")
    fetch.remove("session-1")
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(websocketAttempts).toBe(2)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("terminates active websocket connections when their session is deleted", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_after_remove" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    const firstText = first.text()
    fetch.remove("session-1")
    expect((await readTextError(firstText)).message).toContain("WebSocket closed before response.completed")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    fetch.close()
  })

  test("prunes idle websocket connections after completed responses", async () => {
    let connections = 0
    let closed = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("close", () => closed++)
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${connections}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      idleTimeout: 20,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain("data: [DONE]")
    await waitFor(() => closed === 1, "idle websocket was not pruned")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    fetch.close()
  })

  test("invalidates but does not reuse a socket after terminal failure frames", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: connections === 1 ? "response.failed" : "response.completed" }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain('data: {"type":"response.failed"}')

    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain('data: {"type":"response.completed"}')
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("returns initial websocket error frames as HTTP-style API errors", async () => {
    const error = {
      type: "invalid_request_error",
      message: "The model is not supported when using Codex with a ChatGPT account.",
    }
    const event = {
      type: "error",
      status: 400,
      error,
      headers: {
        "x-codex-primary-window-minutes": 15,
        ignored: { nested: true },
      },
    }
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify(event))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const response = await fetch(server.url, streamRequest())

    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("x-codex-primary-window-minutes")).toBe("15")
    expect(response.headers.get("ignored")).toBeNull()
    expect(await response.json()).toEqual(event)
    fetch.close()
  })

  test("fails mid-stream wrapped websocket errors as HTTP-style API errors", async () => {
    const event = {
      type: "error",
      status_code: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
      },
      headers: {
        "x-codex-primary-used-percent": "100.0",
      },
    }
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
        socket.send(JSON.stringify(event))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const response = await fetch(server.url, streamRequest())
    const error = await readTextError(response.text())

    expect(APICallError.isInstance(error)).toBe(true)
    if (!APICallError.isInstance(error)) throw new Error("Expected APICallError")
    expect(error.statusCode).toBe(429)
    expect(error.responseHeaders).toEqual({ "x-codex-primary-used-percent": "100.0" })
    expect(error.responseBody).toBe(JSON.stringify(event))
    fetch.close()
  })

  test("retries websocket connection limit errors on the next stream attempt", async () => {
    let connections = 0
    let messages = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        messages += 1
        if (connections === 1) {
          socket.send(
            JSON.stringify({
              type: "error",
              status: 400,
              error: {
                type: "invalid_request_error",
                code: "websocket_connection_limit_reached",
                message: "Responses websocket connection limit reached",
              },
            }),
          )
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_retry" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("Responses websocket connection limit reached")
    const second = await fetch(server.url, streamRequest())
    const text = await second.text()

    expect(text).not.toContain("websocket_connection_limit_reached")
    expect(text).toContain('data: {"type":"response.completed","response":{"id":"resp_retry"}}')
    expect(text).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(messages).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("falls back to HTTP after websocket connection limit retries are exhausted", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            type: "error",
            status: 400,
            error: {
              type: "invalid_request_error",
              code: "websocket_connection_limit_reached",
              message: "Responses websocket connection limit reached",
            },
          }),
        )
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 2,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("Responses websocket connection limit reached")
    const second = await fetch(server.url, streamRequest())
    expect((await readTextError(second.text())).message).toContain("Responses websocket connection limit reached")
    const third = await fetch(server.url, streamRequest())
    const fourth = await fetch(server.url, streamRequest())

    expect(await third.text()).toBe("http")
    expect(await fourth.text()).toBe("http")
    expect(connections).toBe(3)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("shares the websocket retry budget across stream and connection limit failures", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          socket.terminate()
          return
        }
        socket.send(
          JSON.stringify({
            type: "error",
            error: {
              code: "websocket_connection_limit_reached",
              message: "Responses websocket connection limit reached",
            },
          }),
        )
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("retries websocket idle failures before first event then falls back to HTTP", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {})
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      idleTimeout: 20,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("idle timeout waiting for websocket")
    const second = await fetch(server.url, streamRequest())
    const third = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(await third.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("keeps websocket retry state until the failed stream becomes idle", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {})
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      idleTimeout: 500,
      streamRetries: 1,
    })

    await new Promise((resolve) => setTimeout(resolve, 250))
    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("idle timeout waiting for websocket")
    await new Promise((resolve) => setTimeout(resolve, 300))

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("retries failed websocket streams before using HTTP fallback", async () => {
    const attempts: Array<(socket: WebSocket) => void> = []
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
        attempts.shift()?.(socket)
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const firstAttempt = new Promise<WebSocket>((resolve) => attempts.push(resolve))
    const first = await fetch(server.url, streamRequest())
    const firstSocket = await firstAttempt
    firstSocket.terminate()
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const secondAttempt = new Promise<WebSocket>((resolve) => attempts.push(resolve))
    const second = await fetch(server.url, streamRequest())
    const secondSocket = await secondAttempt
    secondSocket.terminate()
    expect((await readTextError(second.text())).message).toContain("WebSocket closed before response.completed")
    const third = await fetch(server.url, streamRequest())

    expect(await third.text()).toBe("http")
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("resets websocket stream failures after a completed response", async () => {
    let connections = 0
    let requests = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.on("message", () => {
        requests += 1
        if (requests === 1 || requests === 3) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          socket.terminate()
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${requests}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain("data: [DONE]")
    const third = await fetch(server.url, streamRequest())
    expect((await readTextError(third.text())).message).toContain("WebSocket closed before response.completed")
    const fourth = await fetch(server.url, streamRequest())

    expect(await fourth.text()).toContain("data: [DONE]")
    expect(connections).toBe(3)
    expect(requests).toBe(4)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("falls back to HTTP for missing session and title requests", async () => {
    await using server = await createWebSocketServer(() => {})
    const fetch = OpenAIWebSocketPool.createWebSocketFetch()

    const missingSession = await fetch(server.url, {
      method: "POST",
      headers: { [TITLE_HEADER]: "false" },
      body: JSON.stringify({ stream: true }),
    })
    const title = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "true" }))

    expect(await missingSession.text()).toBe("http")
    expect(await title.text()).toBe("http")
    expect(server.httpRequests).toHaveLength(2)
    expect(server.httpRequests[0]?.headers[TITLE_HEADER]).toBeUndefined()
    expect(server.httpRequests[1]?.headers[TITLE_HEADER]).toBeUndefined()
    fetch.close()
  })

  test("falls back to HTTP while a websocket lane is busy", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
      })
    })
    const abort = new AbortController()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest({}, abort.signal))
    const firstText = first.text()
    await waitFor(() => connections === 1, "websocket did not connect")
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(server.httpRequests).toHaveLength(1)
    expect(connections).toBe(1)
    abort.abort(new Error("stop"))
    expect((await readTextError(firstText)).message).toContain("stop")
    fetch.close()
  })

  test("reserves a websocket lane while its socket is connecting", async () => {
    await using server = await createHangingTcpServer()
    await using fallback = await createHttpServer()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 20,
      streamRetries: 0,
    })

    const first = fetch(fallback.url, streamRequest())
    await waitFor(() => server.connections() === 1, "first websocket did not begin connecting")
    const second = fetch(fallback.url, streamRequest())

    expect(await (await second).text()).toBe("http")
    expect(await (await first).text()).toBe("http")
    expect(server.connections()).toBe(1)
    expect(fallback.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("retries unexpected closes before first event then falls back to HTTP", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.close(1001, "server shutdown")
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const second = await fetch(server.url, streamRequest())
    const third = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(await third.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("does not keep HTTP fallback active after aborting a websocket response", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_456" } }))
      })
    })
    const abort = new AbortController()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest({}, abort.signal))
    const firstText = first.text()
    await waitFor(() => connections === 1, "first websocket did not connect")
    abort.abort(new Error("stop"))
    expect((await readTextError(firstText)).message).toContain("stop")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("releases the websocket lane when the response body is cancelled", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_after_cancel" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    await waitFor(() => connections === 1, "first websocket did not connect")
    await first.body!.cancel("stop")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })
})

function streamRequest(headers?: Record<string, string>, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: {
      "session-id": "session-1",
      authorization: "Bearer test",
      ...headers,
    },
    body: JSON.stringify({ stream: true, input: "hi" }),
    signal,
  }
}

async function readTextError(promise: Promise<string>) {
  // Bun 1.3.14 hangs on expect(response.text()).rejects for streams errored from ws callbacks.
  return promise.then(
    () => {
      throw new Error("Expected response text to reject")
    },
    (error) => {
      expect(error).toBeInstanceOf(Error)
      return error as Error
    },
  )
}

async function createWebSocketServer(onConnection: (socket: WebSocket, request: IncomingMessage) => void) {
  const http = await createHttpServer()
  const server = new WebSocketServer({ server: http.server })
  server.on("connection", onConnection)
  return websocketServerHandle(server, http)
}

async function createHangingTcpServer() {
  const sockets = new Set<Socket>()
  let connections = 0
  const server = net.createServer((socket) => {
    connections += 1
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    wsUrl: `ws://127.0.0.1:${address.port}/v1/responses`,
    connections: () => connections,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

async function createRejectingWebSocketServer(onAttempt: () => void) {
  const http = await createHttpServer()
  const server = new WebSocketServer({
    server: http.server,
    verifyClient(_info, callback) {
      onAttempt()
      callback(false, 401, "denied")
    },
  })
  return websocketServerHandle(server, http)
}

async function createHttpServer() {
  const httpRequests: IncomingMessage[] = []
  const httpBodies: Promise<string>[] = []
  const server = createServer((request, response) => {
    httpRequests.push(request)
    httpBodies.push(
      new Promise((resolve) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        request.on("end", () => resolve(Buffer.concat(chunks).toString()))
      }),
    )
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("http")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return {
    server,
    httpRequests,
    httpBodies,
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    async [Symbol.asyncDispose]() {
      await closeHttpServer(server)
    },
  }
}

function websocketServerHandle(server: WebSocketServer, http: Awaited<ReturnType<typeof createHttpServer>>) {
  return {
    url: http.url,
    wsUrl: http.url.replace(/^http/, "ws"),
    httpRequests: http.httpRequests,
    httpBodies: http.httpBodies,
    async [Symbol.asyncDispose]() {
      for (const socket of server.clients) socket.terminate()
      server.close()
      http.server.close()
    },
  }
}

function closeHttpServer(server: HttpServer) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function waitFor(predicate: () => boolean, message: string) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
