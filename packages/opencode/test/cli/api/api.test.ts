import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import yargs from "yargs"
import { OpenApi } from "effect/unstable/httpapi"
import { buildCatalog, source, sourceSpec } from "../../../script/api-cli"
import { OpenCodeHttpApi } from "../../../src/server/routes/instance/httpapi/api"
import { catalog } from "../../../src/cli/cmd/api/catalog.generated"
import { spec as bundledSpec } from "../../../src/cli/cmd/api/spec.generated"
import { apiCompletion, completionSuggestions } from "../../../src/cli/cmd/api/completion"
import { normalizeApiArgs } from "../../../src/cli/cmd/api/args"
import { commandPaths, makeApiCommand } from "../../../src/cli/cmd/api"
import { dynamicResources } from "../../../src/cli/cmd/api/completion"
import { choices, schemaOptions, validate, valueSchema } from "../../../src/cli/cmd/api/schema"
import type { ApiArgs } from "../../../src/cli/cmd/api/transport"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const cwd = process.cwd()
const temporary = mkdtempSync(path.join(tmpdir(), "opencode-api-cli-"))
let server: ReturnType<typeof Bun.serve>
let base = ""
let authRequired = false
let delayLists = false
const received: Array<{ method: string; path: string; query: Record<string, string>; body: string; authorization?: string }> = []
let ticketHeader = ""
let websocketTicket = ""
const terminalInput: string[] = []
let websocketOpened: Promise<void> = Promise.resolve()
let signalWebsocketOpen = () => {}
let eventStreamStarted: Promise<void> = Promise.resolve()
let signalEventStreamStarted = () => {}
let largeEventStarted: Promise<void> = Promise.resolve()
let signalLargeEventStarted = () => {}
let largeEvent = false
let websocketHandshakeStarted: Promise<void> = Promise.resolve()
let signalWebsocketHandshakeStarted = () => {}
let ticketRequestStarted: Promise<void> = Promise.resolve()
let signalTicketRequestStarted = () => {}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text()
      received.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        authorization: request.headers.get("authorization") ?? undefined,
      })
      if (authRequired && request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:completion-secret").toString("base64")}`) {
        return Response.json({ message: "Unauthorized" }, { status: 401 })
      }
      if (delayLists && url.pathname === "/session") await Bun.sleep(500)
      if (url.pathname === "/global/health") {
        return Response.json({ healthy: true, nested: { count: 0 }, values: [false, null] })
      }
      if (url.pathname === "/doc") return Response.json({ openapi: "3.1.0", paths: {} })
      if (["/pty/pty_test/connect-token", "/api/pty/pty_test/connect-token"].includes(url.pathname)) {
        ticketHeader = request.headers.get("x-opencode-ticket") ?? ""
        return Response.json({ ticket: "single-use-ticket", expiresAt: "2099-01-01T00:00:00Z" })
      }
      if (url.pathname === "/pty/pty_hang/connect-token") return Response.json({ ticket: "hang-ticket" })
      if (url.pathname === "/pty/pty_ticket_hang/connect-token") {
        signalTicketRequestStarted()
        return new Promise<Response>(() => {})
      }
      if (url.pathname === "/pty/pty_hang/connect") {
        signalWebsocketHandshakeStarted()
        return new Promise<Response>(() => {})
      }
      if (["/pty/pty_test/connect", "/api/pty/pty_test/connect"].includes(url.pathname)) {
        websocketTicket = url.searchParams.get("ticket") ?? ""
        if (server.upgrade(request, { data: {} })) return undefined
        return new Response("WebSocket upgrade required", { status: 400 })
      }
      if (url.pathname === "/session" && request.method === "POST") return Response.json(JSON.parse(body))
      if (url.pathname === "/session/ses_example/retry") return Response.json(JSON.parse(body))
      if (url.pathname === "/api/session" && request.method === "POST") return Response.json(JSON.parse(body))
      if (url.pathname === "/config" && request.method === "PATCH") return Response.json(JSON.parse(body))
      if (url.pathname === "/file/content") return Response.json({ path: url.searchParams.get("path") })
      if (url.pathname === "/api/fs/read/folder/a%20b.txt") return new Response("file bytes", { headers: { "content-type": "text/plain" } })
      if (url.pathname === "/api/fs/list") return Response.json({ directory: url.searchParams.get("location[directory]"), workspace: url.searchParams.get("location[workspace]") })
      if (url.pathname === "/event") {
        if (largeEvent) {
          signalLargeEventStarted()
          return new Response(`data: ${"x".repeat(2 * 1024 * 1024)}\n\n`, { headers: { "content-type": "text/event-stream" } })
        }
        return new Response(': ping\nid: 1\nevent: update\ndata: {"ok":true}\n\ndata: last\n\n', { headers: { "content-type": "text/event-stream" } })
      }
      if (url.pathname === "/global/event") {
        signalEventStreamStarted()
        return new Response(new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode(": keepalive\n\n")),
        }), { headers: { "content-type": "text/event-stream" } })
      }
      if (url.pathname === "/binary") return new Response(new Uint8Array([0, 255, 1]), { headers: { "content-type": "application/octet-stream" } })
      if (url.pathname === "/empty") return new Response(null, { status: 204 })
      if (url.pathname === "/error") return Response.json({ message: "request rejected", detail: { code: "invalid" } }, { status: 422 })
      if (url.pathname === "/echo-error") return Response.json({ body, authorization: request.headers.get("authorization") }, { status: 401 })
      if (url.pathname === "/project") return Response.json([{ id: "prj_dynamic" }])
      if (url.pathname === "/agent") return Response.json([{ name: "build-agent" }])
      if (url.pathname === "/session" && request.method === "GET") return Response.json([{ id: "ses_dynamic" }])
      if (url.pathname === "/api/session" && request.method === "GET") return Response.json({ data: [{ id: "ses_v2_dynamic" }] })
      if (url.pathname === "/api/session/ses_dynamic/permission") return Response.json([{ id: "per_dynamic" }])
      return Response.json({ message: "not found" }, { status: 404 })
    },
    websocket: {
      open: (socket) => {
        signalWebsocketOpen()
        socket.send(new Uint8Array([0, ...new TextEncoder().encode('{"cursor":"cursor-1"}')]))
        socket.send(new Uint8Array([65, 0, 255, 66]))
        setTimeout(() => socket.close(1000, "complete"), 50)
      },
      message: (_socket, message) => {
        terminalInput.push(String(message))
      },
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
  rmSync(temporary, { recursive: true, force: true })
})

describe("generated API CLI catalog", () => {
  test("normalizes stdin body syntax only for API arguments before the terminator", () => {
    expect(normalizeApiArgs(["run", "--", "--body-file", "-"])).toEqual({ args: ["run", "--", "--body-file", "-"], api: false })
    expect(normalizeApiArgs(["api", "session", "create", "--body-file", "-"])).toEqual({ args: ["api", "session", "create", "--body-file=-"], api: true })
    expect(normalizeApiArgs(["api", "--body-file", "-", "--", "--body-file", "-"])).toEqual({
      args: ["api", "--body-file=-", "--", "--body-file", "-"],
      api: true,
    })
    expect(normalizeApiArgs(["--url", "api", "api", "session"])).toEqual({ args: ["--url", "api", "api", "session"], api: true })
    expect(normalizeApiArgs(["--pure", "false", "api", "session", "create", "--body-file", "-"])).toEqual({
      args: ["--pure=false", "api", "session", "create", "--body-file=-"],
      api: true,
    })
  })

  test("preserves nullable flag types and reserves root options from request fields", async () => {
    const operation = catalog.operations.find((item) => item.method === "PATCH" && item.path === "/config")!
    expect(schemaOptions(operation, catalog).find((option) => option.name === "logLevel")?.flag).toBe("body-log-level")
    const response = await cli(["--log-level", "DEBUG", "api", "config", "update", "--url", base, "--snapshot", "false"])
    expect(response.code).toBe(0)
    expect(JSON.parse(response.stdout)).toEqual({ snapshot: false })
    expect(JSON.parse(received.at(-1)!.body)).toEqual({ snapshot: false })
  })

  test("matches every currently declared HTTP operation and its metadata", async () => {
    const current = buildCatalog(OpenApi.fromApi(OpenCodeHttpApi) as unknown as Record<string, unknown>)
    expect(current.operations).toEqual(catalog.operations)
    expect(source(current)).toBe(await Bun.file("src/cli/cmd/api/catalog.generated.ts").text())
    expect(sourceSpec(current.spec ?? {})).toBe(await Bun.file("src/cli/cmd/api/spec.generated.ts").text())
    const spec = current.spec?.paths as Record<string, Record<string, unknown>>
    const inventory = Object.entries(spec).flatMap(([route, item]) =>
      Object.keys(item).filter((method) => ["get", "post", "put", "patch", "delete", "options", "head"].includes(method)).map((method) => `${method.toUpperCase()} ${route}`),
    )
    expect(inventory).toHaveLength(current.operations.length)
    expect(new Set(inventory)).toEqual(new Set(current.operations.map((operation) => `${operation.method} ${operation.path}`)))
    expect(current.operations.some((operation) => operation.path === "/doc")).toBe(false)
    expect(current.operations.filter((operation) => operation.transport === "sse").map((operation) => operation.path).sort()).toEqual([
      "/api/event",
      "/api/session/{sessionID}/event",
      "/event",
      "/global/event",
    ])
    expect(current.operations.filter((operation) => operation.transport === "websocket").map((operation) => operation.path).sort()).toEqual([
      "/api/pty/{ptyID}/connect",
      "/pty/{ptyID}/connect",
    ])
    expect(Object.keys(current.components.schemas)).toContain("Model.Ref")
    expect(Object.keys(current.components.schemas)).toContain("Location.Ref")
    expect(Object.keys(current.components.schemas)).toContain("PromptInput")
    const auth = current.operations.find((operation) => operation.method === "PUT" && operation.path === "/auth/{providerID}")!
    expect(validate({ type: "api", key: "example-key" }, auth.requestBody?.content?.["application/json"]?.schema, current, "body")).toEqual([])
    const model = current.operations.find((operation) => operation.method === "POST" && operation.path === "/api/session/{sessionID}/model")!
    expect(validate({ model: "not-an-object" }, model.requestBody?.content?.["application/json"]?.schema, current, "body").join("\n")).toContain("body.model must be an object")
    expect(commandPaths()).toHaveLength(current.operations.length)
    expect(new Set(commandPaths()).size).toBe(commandPaths().length)
    const newerForkOperations = current.operations.map((operation) => operation.operationId)
    expect(newerForkOperations).toContain("session.queueList")
    expect(newerForkOperations).toContain("session.queueSubmit")
    expect(newerForkOperations).toContain("session.queueUpdate")
    expect(newerForkOperations).toContain("session.queueFlush")
    expect(newerForkOperations).toContain("session.retry")
    for (const operation of current.operations) {
      for (let depth = 0; depth < operation.command.length; depth++) {
        let suggestions: string[] = []
        const prefix = operation.command.slice(0, depth)
        const token = operation.command[depth]
        apiCompletion(token, { _: ["api", ...prefix, token] }, () => {}, (values) => (suggestions = values))
        expect(suggestions.some((value) => value === token || value.startsWith(`${token}:`))).toBe(true)
      }
    }
    for (const operation of current.operations) {
      let suggestions: string[] = []
      apiCompletion("--", { _: ["api", ...operation.command] }, () => {}, (values) => (suggestions = values))
      for (const option of schemaOptions(operation, current)) {
        expect(suggestions.some((value) => value === `--${option.flag}` || value.startsWith(`--${option.flag}:`))).toBe(true)
      }
    }
  })

  test("new operations generate commands, schema flags, help metadata and enum completions", async () => {
    const synthetic = buildCatalog({
      openapi: "3.1.0",
      paths: {
        "/api/new/{resourceID}": {
          post: {
            operationId: "newResource.create",
            summary: "Create a resource",
            parameters: [{ name: "resourceID", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", properties: { mode: { type: "string", enum: ["safe", "fast"] } }, required: ["mode"] },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    })
    const operation = synthetic.operations[0]
    expect(operation.command).toEqual(["new-resource", "create"])
    const noIdentifier = buildCatalog({ paths: { "/api/numbers/{value}": { get: { parameters: [{ name: "value", in: "path", required: true, schema: { type: "string" } }] } } } })
    expect(noIdentifier.operations[0].command).toEqual(["v2", "numbers", "get"])
    expect(noIdentifier.operations[0].operationId).toContain("auto.get")
    expect((await completionSuggestions(synthetic, "new", ["api"], { _: ["api"] })).some((value) => value.startsWith("new-resource"))).toBe(true)
    const flags = await completionSuggestions(synthetic, "--", ["api", "new-resource", "create"], { _: ["api", "new-resource", "create"] })
    expect(flags.some((value) => value.startsWith("--mode"))).toBe(true)
    expect(completionSuggestions(synthetic, "s", ["api", "new-resource", "create"], { _: ["api", "new-resource", "create"] }, ["api", "new-resource", "create", "--mode", "s"])).toEqual(["safe"])
    expect(operation.parameters[0].name).toBe("resourceID")
    expect(schemaOptions(operation, synthetic).map((item) => item.flag)).toContain("mode")
    expect(choices(schemaOptions(operation, synthetic).find((item) => item.flag === "mode")?.schema, synthetic)).toEqual(["safe", "fast"])
    expect(validate({}, operation.requestBody?.content?.["application/json"]?.schema, synthetic, "body")).toContain("body.mode is required")
    expect(validate(123, { type: "null" }, synthetic, "body")).toContain("body must be null")
    const nestedRefs = buildCatalog({
      components: {
        schemas: {
          Outer: { type: "object", properties: { inner: { $ref: "#/components/schemas/Inner" } } },
          Inner: { type: "object", properties: { value: { type: "string" } } },
        },
      },
      paths: {
        "/references": {
          post: {
            operationId: "references.create",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { value: { $ref: "#/components/schemas/Outer" } } },
                },
              },
            },
          },
        },
      },
    })
    expect(Object.keys(nestedRefs.components.schemas).sort()).toEqual(["Inner", "Outer"])
    let help = ""
    const parser = yargs()
      .scriptName("opencode")
      .command(makeApiCommand(synthetic))
      .help()
      .exitProcess(false)
    await parser.parse(
      ["api", "new-resource", "create", "resource-1", "--help"],
      (_error: Error | undefined, _argv: { _: Array<string | number>; $0: string; [key: string]: unknown }, output: string) => {
      help = output
      },
    )
    expect(help).toContain("POST /api/new/{resourceID}")
    expect(help).toContain("--mode")
    expect(help).toContain("safe")

    const removed = structuredClone(synthetic.spec) as Record<string, unknown>
    removed.paths = {}
    expect(source(buildCatalog(removed))).not.toBe(source(synthetic))
  })

  test("rejects command collisions and unsupported body encodings with the route named", () => {
    const collision = {
      paths: {
        "/one": { get: { operationId: "thing.get" } },
        "/two": { get: { operationId: "thing.get" } },
      },
    }
    expect(() => buildCatalog(collision)).toThrow("API CLI command collision: 'thing get'")
    expect(() => buildCatalog({ paths: { "/upload": { post: { operationId: "upload", requestBody: { content: { "application/xml": {} } } } } } })).toThrow(
      "POST /upload uses unsupported request content type",
    )
    expect(() => buildCatalog({ paths: { "/trace": { trace: {} } } })).toThrow("unsupported OpenAPI path-item field 'trace'")
    const unsupportedStyle = {
      paths: {
        "/search": {
          get: {
            operationId: "search",
            parameters: [{ name: "tags", in: "query", style: "pipeDelimited", schema: { type: "array", items: { type: "string" } } }],
          },
        },
      },
    }
    expect(() => buildCatalog(unsupportedStyle)).toThrow("GET /search uses unsupported query parameter style 'pipeDelimited'")
  })

  test("completes options after boolean and equals-form values in Bash and zsh token layouts", async () => {
    const afterRootBoolean = await completionSuggestions(catalog, "ses", ["api", "ses"], { _: ["api", "ses"] }, ["api", "--compact", "ses"])
    expect(afterRootBoolean.some((value) => value.startsWith("session"))).toBe(true)
    const afterRootEquals = await completionSuggestions(
      catalog,
      "ses",
      ["api", "ses"],
      { _: ["api", "ses"] },
      ["api", "--url=http://localhost:4096", "ses"],
    )
    expect(afterRootEquals.some((value) => value.startsWith("session"))).toBe(true)
    const afterBoolean = await completionSuggestions(catalog, "--u", ["api", "session", "create", "--compact", "--u"], { _: ["api", "session", "create"] }, ["api", "session", "create", "--compact", "--u"])
    expect(afterBoolean.some((value) => value.startsWith("--url"))).toBe(true)
    const afterEquals = await completionSuggestions(
      catalog,
      "--b",
      ["api", "session", "create", "--url=http://localhost:4096", "--b"],
      { _: ["api", "session", "create"] },
      ["api", "session", "create", "--url=http://localhost:4096", "--b"],
    )
    expect(afterEquals.some((value) => value.startsWith("--body"))).toBe(true)
    const splitEnum = await completionSuggestions(
      catalog,
      "d",
      ["api", "v2", "session", "list", "--order", "=", "d"],
      { _: ["api", "v2", "session", "list"] },
      ["api", "v2", "session", "list", "--order", "=", "d"],
    )
    expect(splitEnum).toContain("desc")
    const joinedEnum = await completionSuggestions(
      catalog,
      "--order=d",
      ["api", "v2", "session", "list", "--order=d"],
      { _: ["api", "v2", "session", "list"] },
      ["api", "v2", "session", "list", "--order=d"],
    )
    expect(joinedEnum).toContain("--order=desc")
  })
})

describe("API CLI HTTP and stream transports", () => {
  test("serves the bundled specification offline and fetches the separate /doc endpoint on request", async () => {
    const bundled = await cli(["api", "spec"])
    expect(bundled.code).toBe(0)
    if (!bundled.stdout.endsWith("}\n")) throw new Error(`spec bytes ${bundled.stdout.length}, end ${bundled.stdout.slice(-80)}`)
    expect(JSON.parse(bundled.stdout).paths).toEqual(bundledSpec.paths)
    const remote = await cli(["api", "spec", "--remote", "--url", base])
    expect(remote.code).toBe(0)
    expect(JSON.parse(remote.stdout)).toEqual({ openapi: "3.1.0", paths: {} })
  })

  test("preserves JSON, typed inputs, encoding, binary, text, empty and error responses", async () => {
    const health = await cli(["api", "health", "--url", base])
    expect(health.code).toBe(0)
    expect(health.stdout).toBe(`${JSON.stringify({ healthy: true, nested: { count: 0 }, values: [false, null] }, null, 2)}\n`)
    expect(health.stderr).toBe("")

    const created = await cli(["api", "session", "create", "--url", base, "--title", "Test", "--directory", "/tmp/project"])
    expect(created.code).toBe(0)
    expect(JSON.parse(created.stdout)).toEqual({ title: "Test" })
    expect(received.at(-1)?.query.directory).toBe("/tmp/project")

    const createdV2 = await cli(["api", "v2", "session", "create", "--url", base, "--directory", "/tmp/project", "--workspace", "wrk_test"])
    expect(JSON.parse(createdV2.stdout)).toEqual({ location: { directory: "/tmp/project", workspaceID: "wrk_test" } })
    expect(received.at(-1)?.query).toEqual({})

    const retry = catalog.operations.find((operation) => operation.path.endsWith("/retry"))!
    const attempt = schemaOptions(retry, catalog).find((option) => option.name === "attempt")!
    expect(valueSchema(attempt.schema, catalog).type).toBe("number")
    expect(choices(attempt.schema, catalog)).toBeUndefined()
    expect(completionSuggestions(catalog, "Na", ["api", "session", "retry", "ses_example", "Na"], {
      _: ["api", "session", "retry", "ses_example", "Na"],
    }, ["api", "session", "retry", "ses_example", "--attempt", "Na"])).toContain("NaN")
    const retried = await cli(["api", "session", "retry", "ses_example", "--url", base, "--attempt", "1", "--next", "2"])
    expect(JSON.parse(retried.stdout)).toEqual({ attempt: 1, next: 2 })

    const query = await cli(["api", "file", "read", "--url", base, "--path", "a b/é"])
    expect(JSON.parse(query.stdout)).toEqual({ path: "a b/é" })

    const wildcard = await cli(["api", "v2", "fs", "read", "folder/a b.txt", "--url", base])
    expect(wildcard.stdout).toBe("file bytes")
    expect(received.at(-1)?.path).toBe("/api/fs/read/folder/a%20b.txt")

    const location = await cli(["api", "v2", "fs", "list", "--url", base, "--directory", "/tmp/a", "--workspace", "wrk_test"])
    expect(JSON.parse(location.stdout)).toEqual({ directory: "/tmp/a", workspace: "wrk_test" })
    expect(received.at(-1)?.query).toEqual({ "location[directory]": "/tmp/a", "location[workspace]": "wrk_test" })

    const binary = await cli(["api", "request", "GET", "/binary", "--url", base, "--raw"])
    expect(Array.from(binary.stdoutBytes)).toEqual([0, 255, 1])
    const empty = await cli(["api", "request", "DELETE", "/empty", "--url", base])
    expect(empty.code).toBe(0)
    expect(empty.stdout).toBe("")
    const failure = await cli(["api", "request", "GET", "/error", "--url", base])
    expect(failure.code).toBe(1)
    expect(failure.stdout).toBe("")
    expect(failure.stderr).toContain("HTTP 422")
    expect(failure.stderr).toContain('"code": "invalid"')
    const genericRouting = await cli(["api", "request", "GET", "/global/health", "--url", base, "--directory", "/tmp/project"])
    expect(genericRouting.code).not.toBe(0)
    expect(genericRouting.stderr).toContain("does not infer route-specific directory/workspace routing")

    const beforeMalformed = received.length
    const malformedBody = await cli(["api", "request", "POST", "/session", "--url", base, "--body", "{"])
    expect(malformedBody.code).not.toBe(0)
    expect(malformedBody.stderr).toContain("Request body must contain valid JSON")
    expect(received.length).toBe(beforeMalformed)
    const beforeInvalidSessionBody = received.length
    const invalidSessionBody = await cli(["api", "session", "create", "--url", base, "--body", "123"])
    expect(invalidSessionBody.code).not.toBe(0)
    expect(received.length).toBe(beforeInvalidSessionBody)

    const beforeUnsafePath = received.length
    const unsafePath = await cli(["api", "request", "POST", "//other-host/collect", "--url", base, "--password", "must-not-leak", "--body", "{}"])
    expect(unsafePath.code).not.toBe(0)
    expect(received.length).toBe(beforeUnsafePath)
    expect(unsafePath.stderr).not.toContain("must-not-leak")

    const stdinAuth = await cli(["api", "request", "POST", "/echo-error", "--url", base, "--password-stdin", "--body", "{}"], "stdin-password\n")
    expect(stdinAuth.code).toBe(1)
    expect(stdinAuth.stderr).not.toContain("stdin-password")
    expect(stdinAuth.stderr).not.toContain(Buffer.from("opencode:stdin-password").toString("base64"))
    const stdinKey = await cli(["api", "request", "POST", "/echo-error", "--url", base, "--body-file", "-"], '{"key":"stdin-api-key"}')
    expect(stdinKey.code).toBe(1)
    expect(stdinKey.stderr).not.toContain("stdin-api-key")
    const quotedKey = 'a"b\\c'
    const escapedKey = await cli(["api", "request", "POST", "/echo-error", "--url", base, "--body", JSON.stringify({ key: quotedKey })])
    expect(escapedKey.code).toBe(1)
    expect(escapedKey.stderr).not.toContain(quotedKey)
    expect(escapedKey.stderr).not.toContain(JSON.stringify(quotedKey).slice(1, -1))
  }, 60_000)

  test("reads JSON body files and stdin, and writes output bytes to files", async () => {
    const bodyPath = path.join(temporary, "request body.json")
    writeFileSync(bodyPath, JSON.stringify({ title: "from file" }))
    const file = await cli(["api", "session", "create", "--url", base, "--body-file", bodyPath])
    expect(file.code).toBe(0)
    expect(JSON.parse(file.stdout)).toEqual({ title: "from file" })

    const stdin = await cli(["api", "session", "create", "--url", base, "--body-file", "-"], '{"title":"from stdin"}')
    if (stdin.code !== 0) throw new Error(stdin.stderr)
    expect(JSON.parse(stdin.stdout)).toEqual({ title: "from stdin" })

    const explicitBoolean = await cli(["--pure", "false", "api", "session", "create", "--body-file", "-", "--url", base], '{"title":"with boolean"}')
    expect(explicitBoolean.code).toBe(0)
    expect(JSON.parse(explicitBoolean.stdout)).toEqual({ title: "with boolean" })

    const output = path.join(temporary, "response.json")
    const written = await cli(["api", "health", "--url", base, "--output", output])
    expect(written.code).toBe(0)
    expect(written.stdout).toBe("")
    expect(JSON.parse(await Bun.file(output).text()).healthy).toBe(true)
  }, 30_000)

  test("validates required inputs and redacts authentication failures", async () => {
    const missing = await cli(["api", "session", "queue", "submit", "ses_example", "--url", base])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("Request body is required")

    const enumFailure = await cli(["api", "v2", "session", "list", "--url", base, "--order", "sideways"])
    expect(enumFailure.code).not.toBe(0)
    expect(enumFailure.stderr).toContain("sideways")

    authRequired = true
    const auth = await cli(["api", "health", "--url", base], undefined, { OPENCODE_SERVER_PASSWORD: "completion-secret" })
    expect(auth.code).toBe(0)
    const rejected = await cli(["api", "health", "--url", base], undefined, { OPENCODE_SERVER_PASSWORD: "wrong-secret" })
    expect(rejected.code).toBe(1)
    expect(rejected.stdout).toBe("")
    expect(rejected.stderr).not.toContain("wrong-secret")
    expect(rejected.stderr).not.toContain("Authorization")
    authRequired = false
  }, 30_000)

  test("streams SSE as NDJSON or raw SSE and completes resource IDs read-only", async () => {
    const ndjson = await cli(["api", "event", "subscribe", "--url", base])
    expect(ndjson.code).toBe(0)
    expect(ndjson.stdout).toContain('{"event":"update","id":"1","data":{"ok":true}}')
    expect(ndjson.stdout).toContain('{"id":"1","data":"last"}')

    const raw = await cli(["api", "event", "subscribe", "--url", base, "--event-format", "sse"])
    expect(raw.stdout).toContain("event: update\ndata: {\"ok\":true}")
    const interrupted = await cli(["api", "global", "event", "subscribe", "--url", base, "--timeout", "50ms"])
    expect(interrupted.code).toBe(124)
    expect(interrupted.stderr).toBe("")
    eventStreamStarted = new Promise((resolve) => (signalEventStreamStarted = resolve))
    const child = Bun.spawn([process.execPath, "src/index.ts", "api", "global", "event", "subscribe", "--url", base], {
      cwd,
      env: globalThis.process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    await eventStreamStarted
    child.kill("SIGINT")
    const [stdout, stderr, code] = await Promise.all([output, errors, child.exited])
    expect(code).toBe(130)
    expect(stdout).toBe("")
    expect(stderr).toBe("")

    largeEvent = true
    largeEventStarted = new Promise((resolve) => (signalLargeEventStarted = resolve))
    const blocked = spawn(process.execPath, ["src/index.ts", "api", "event", "subscribe", "--url", base], {
      cwd,
      env: globalThis.process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const blockedErrors: Buffer[] = []
    blocked.stderr.on("data", (chunk: Buffer) => blockedErrors.push(chunk))
    const blockedExit = new Promise<number | null>((resolve) => blocked.once("exit", (code) => resolve(code)))
    await largeEventStarted
    await Bun.sleep(100)
    blocked.kill("SIGINT")
    const exit = await Promise.race([blockedExit, Bun.sleep(3_000).then(() => undefined)])
    if (exit === undefined) blocked.kill("SIGKILL")
    const blockedCode = exit ?? await blockedExit
    const blockedStdout = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      blocked.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
      blocked.stdout.on("end", () => resolve(Buffer.concat(chunks)))
    })
    const blockedStderr = Buffer.concat(blockedErrors).toString("utf8")
    largeEvent = false
    expect(blockedCode).toBe(130)
    expect(blockedStderr).toBe("")
    expect(blockedStdout.length).toBeLessThan(2 * 1024 * 1024)

    const dynamic = await dynamicResources("ses_", { _: ["api", "session", "get", "ses_"], url: base } as ApiArgs)
    expect(dynamic).toEqual(["ses_dynamic"])
    expect(received.at(-1)?.method).toBe("GET")
    expect(await dynamicResources("ses_", { _: ["api", "v2", "session", "get", "ses_"], url: base } as ApiArgs)).toEqual(["ses_v2_dynamic"])
  }, 30_000)

  test("uses the one-time ticket flow and preserves binary PTY output", async () => {
    terminalInput.length = 0
    const commands = [["api", "pty", "connect"], ["api", "v2", "pty", "connect"], ["api", "v2", "pty", "connect"]]
    for (const [index, command] of commands.entries()) {
      websocketOpened = new Promise((resolve) => (signalWebsocketOpen = resolve))
      const outputFile = path.join(temporary, `pty-${index}.bin`)
      const routing = index === 1
        ? ["--location-directory", "/tmp/pty-project", "--location-workspace", "wrk_test"]
        : index === 2
          ? ["--directory", "/tmp/pty-project", "--workspace", "wrk_test"]
          : []
      const child = Bun.spawn([
        process.execPath,
        "src/index.ts",
        ...command,
        "pty_test",
        "--url",
        base,
        ...(index === 0 ? ["--output", outputFile] : routing),
      ], {
        cwd,
        env: globalThis.process.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = new Response(child.stdout).arrayBuffer()
      const errors = new Response(child.stderr).text()
      await websocketOpened
      await child.stdin?.write("hello terminal")
      child.stdin?.end()
      const [stdoutBytes, stderr, code] = await Promise.all([output, errors, child.exited])
      const result = { code, stdoutBytes: new Uint8Array(stdoutBytes), stderr }
      if (result.code !== 0) throw new Error(result.stderr)
      if (index === 0) {
        expect(Array.from(result.stdoutBytes)).toEqual([])
        expect(Array.from(await Bun.file(outputFile).bytes())).toEqual([65, 0, 255, 66])
      } else {
        expect(Array.from(result.stdoutBytes)).toEqual([65, 0, 255, 66])
      }
    }
    expect(ticketHeader).toBe("1")
    expect(websocketTicket).toBe("single-use-ticket")
    expect(terminalInput).toContain("hello terminal")
    expect(received.filter((item) => item.path === "/api/pty/pty_test/connect-token").slice(-2).map((item) => item.query)).toEqual([
      { "location[directory]": "/tmp/pty-project", "location[workspace]": "wrk_test" },
      { "location[directory]": "/tmp/pty-project", "location[workspace]": "wrk_test" },
    ])
  }, 15_000)

  test("bounds an explicit WebSocket handshake timeout and cancels a stalled handshake on SIGINT", async () => {
    ticketRequestStarted = new Promise((resolve) => (signalTicketRequestStarted = resolve))
    const ticketTimeout = Bun.spawn([process.execPath, "src/index.ts", "api", "pty", "connect", "pty_ticket_hang", "--url", base, "--timeout", "50ms"], {
      cwd,
      env: globalThis.process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const ticketOutput = new Response(ticketTimeout.stdout).text()
    const ticketErrors = new Response(ticketTimeout.stderr).text()
    await ticketRequestStarted
    const [ticketStdout, ticketStderr, ticketCode] = await Promise.all([ticketOutput, ticketErrors, ticketTimeout.exited])
    expect(ticketCode).toBe(124)
    expect(ticketStdout).toBe("")
    expect(ticketStderr).toBe("")

    websocketHandshakeStarted = new Promise((resolve) => (signalWebsocketHandshakeStarted = resolve))
    const timed = Bun.spawn([process.execPath, "src/index.ts", "api", "pty", "connect", "pty_hang", "--url", base, "--timeout", "100ms"], {
      cwd,
      env: globalThis.process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timedOutput = new Response(timed.stdout).text()
    const timedErrors = new Response(timed.stderr).text()
    await websocketHandshakeStarted
    const [timedStdout, timedStderr, timedCode] = await Promise.all([timedOutput, timedErrors, timed.exited])
    expect(timedCode).toBe(124)
    expect(timedStdout).toBe("")
    expect(timedStderr).toBe("")

    websocketHandshakeStarted = new Promise((resolve) => (signalWebsocketHandshakeStarted = resolve))
    const interrupted = Bun.spawn([process.execPath, "src/index.ts", "api", "pty", "connect", "pty_hang", "--url", base], {
      cwd,
      env: globalThis.process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = new Response(interrupted.stdout).text()
    const errors = new Response(interrupted.stderr).text()
    await websocketHandshakeStarted
    interrupted.kill("SIGINT")
    const [stdout, stderr, code] = await Promise.all([output, errors, interrupted.exited])
    expect(code).toBe(130)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
  }, 15_000)
})

describe("API CLI offline help and zsh completion", () => {
  test("all nested help examples work without required arguments or server access", async () => {
    for (const command of [
      ["api"],
      ["api", "session"],
      ["api", "session", "message"],
      ["api", "session", "message", "part"],
      ["api", "session", "message", "part", "delete"],
      ["api", "experimental", "workspace", "adapter"],
      ["api", "v2", "session", "revert"],
      ["api", "v2", "session", "revert", "stage"],
      ["api", "v2", "integration", "attempt", "complete"],
      ["api", "v2", "fs", "read"],
    ]) {
      const result = await cli([...command, "--help"], undefined, { OPENCODE_API_URL: "http://127.0.0.1:1" })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe("")
    }
    const help = await cli(["api", "v2", "integration", "attempt", "complete", "--help"])
    expect(help.stderr).toContain("POST /api/integration/attempt/{attemptID}/complete")
    const schema = await cli(["api", "session", "queue", "submit", "--schema"])
    expect(schema.code).toBe(0)
    expect(JSON.parse(schema.stdout).schema).toBeDefined()
  }, 60_000)

  test("completes deep commands, flags, enum values and performs real zsh dispatch", async () => {
    const root = await cli(["--get-yargs-completions", "api", ""], undefined, { SHELL: "/bin/bash", ZSH_NAME: "" })
    expect(root.code).toBe(0)
    expect(root.stdout).toContain("session")
    expect(root.stdout).toContain("v2")
    expect(root.stdout).toContain("spec")

    const deep = await cli(["--get-yargs-completions", "api", "v2", "session", "revert", "stage", "--"])
    expect(deep.code).toBe(0)
    expect(deep.stdout).toContain("--body")
    expect(deep.stdout).toContain("--url")

    const enumValue = await cli(["--get-yargs-completions", "api", "v2", "session", "list", "--order", "d"])
    expect(enumValue.stdout.trim()).toBe("desc")
    const equalValue = await cli(["--get-yargs-completions", "api", "v2", "session", "list", "--order=d"])
    expect(equalValue.stdout.trim()).toBe("--order=desc")
    const method = await cli(["--get-yargs-completions", "api", "request", "G"])
    expect(method.stdout.trim()).toBe("GET")
    const route = await cli(["--get-yargs-completions", "api", "request", "GET", "/glob"])
    expect(route.stdout).toContain("/global/health")
    const existingCommand = await cli(["--get-yargs-completions", "session", ""], undefined, { SHELL: "/bin/bash", ZSH_NAME: "" })
    expect(existingCommand.stdout).toContain("list")
    const runText = await cli(["--get-yargs-completions", "opencode", "run", "api", "--m"], undefined, { SHELL: "/bin/bash", ZSH_NAME: "" })
    expect(runText.stdout).toContain("--model")
    expect(runText.stdout).not.toContain("--body-file")
    const beforeDynamic = received.length
    const dynamicCli = await cli(["--get-yargs-completions", "api", "session", "get", "--url", base, "ses_"])
    expect(dynamicCli.code).toBe(0)
    expect(dynamicCli.stdout.trim()).toBe("ses_dynamic")
    expect(received.slice(beforeDynamic).every((item) => item.method === "GET")).toBe(true)
    const splitUrl = await completionSuggestions(
      catalog,
      "ses_",
      ["api", "session", "get", "http", "://127.0.0.1", `:${server.port}`, "ses_"],
      { _: ["api", "session", "get", "http", "://127.0.0.1", `:${server.port}`, "ses_"], url: "http" },
      ["api", "session", "get", "--url", "http", "://127.0.0.1", `:${server.port}`, "ses_"],
    )
    expect(splitUrl).toContain("ses_dynamic")
    const bashSplitEqualsUrl = await completionSuggestions(
      catalog,
      "ses_",
      ["api", "session", "get", "=", "http", ":", "//127.0.0.1", ":", String(server.port), "ses_"],
      { _: ["api", "session", "get", "=", "http", ":", "//127.0.0.1", ":", String(server.port), "ses_"], url: "=" },
      ["api", "session", "get", "--url", "=", "http", ":", "//127.0.0.1", ":", String(server.port), "ses_"],
    )
    expect(bashSplitEqualsUrl).toContain("ses_dynamic")
    const dynamicAgent = await cli(["--get-yargs-completions", "api", "session", "create", "--url", base, "--agent", "build"])
    expect(dynamicAgent.stdout.trim()).toBe("build-agent")
    expect(received.at(-1)?.method).toBe("GET")
    const dynamicPermission = await cli([
      "--get-yargs-completions",
      "api",
      "v2",
      "session",
      "permission",
      "reply",
      "ses_dynamic",
      "--url",
      base,
      "per_",
    ])
    expect(dynamicPermission.stdout.trim()).toBe("per_dynamic")
    expect(received.at(-1)?.path).toBe("/api/session/ses_dynamic/permission")
    authRequired = true
    const beforeStdinPassword = received.length
    const stdinPasswordCompletion = await cli(
      ["--get-yargs-completions", "api", "session", "get", "--url", base, "--password-stdin", "ses_"],
      undefined,
      { OPENCODE_SERVER_PASSWORD: "completion-secret" },
    )
    expect(stdinPasswordCompletion.stdout).toBe("")
    expect(received.length).toBe(beforeStdinPassword)
    const unauthorized = await cli(["--get-yargs-completions", "api", "session", "get", "--url", base, "ses_"])
    expect(unauthorized.stdout).toBe("")
    expect(unauthorized.stderr).toBe("")
    authRequired = false
    delayLists = true
    expect(await dynamicResources("ses_", { _: ["api", "session", "get", "ses_"], url: base } as ApiArgs)).toEqual([])
    delayLists = false
    expect(await dynamicResources("ses_", { _: ["api", "session", "get", "ses_"], url: "http://127.0.0.1:1" } as ApiArgs)).toEqual([])

    if (!Bun.which("zsh")) return
    const scriptPath = path.join(temporary, "opencode completion.zsh")
    const script = await cli(["completion"], undefined, { SHELL: "/usr/bin/zsh" })
    expect(script.code).toBe(0)
    expect(script.stdout).toContain("_files -/")
    writeFileSync(scriptPath, script.stdout)
    const shell = await runZsh(scriptPath)
    expect(shell.exitCode).toBe(0)
    expect(Buffer.from(shell.stdout).toString()).toContain("session:session API command")
    expect(Buffer.from(shell.stdout).toString()).toContain("list:list API command")
    expect(Buffer.from(shell.stdout).toString()).toContain("FILE-COMPLETION")
    expect(Buffer.from(shell.stdout).toString()).toContain("FILE-COMPLETION:--body-file=:src/in")
    expect(Buffer.from(shell.stderr).toString()).toBe("")
  }, 60_000)
})

async function cli(argv: string[], stdin?: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "src/index.ts", ...argv], {
    cwd,
    env: { ...globalThis.process.env, ...env },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (stdin !== undefined && child.stdin) {
    await child.stdin.write(stdin)
    child.stdin.end()
  }
  const [stdoutBytes, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited])
  return { stdout: Buffer.from(stdoutBytes).toString("utf8"), stdoutBytes: new Uint8Array(stdoutBytes), stderr, code }
}

async function runZsh(scriptPath: string) {
  const script = `
compdef() { : }
_describe() { print -rl -- "\${reply[@]}" }
_default() { print -r -- DEFAULT-FILES }
_files() { print -r -- "FILE-COMPLETION:\${IPREFIX}:\${PREFIX}" }
compadd() { print -r -- STDIN-COMPLETION }
opencode() { bun run src/index.ts "$@" }
source "${scriptPath}"
words=(opencode api "")
CURRENT=3
BUFFER="opencode api "
CURSOR=\${#BUFFER}
_opencode_yargs_completions
words=(opencode api session "")
CURRENT=4
BUFFER="opencode api session "
CURSOR=\${#BUFFER}
_opencode_yargs_completions
words=(opencode api v2 session revert stage "")
CURRENT=7
BUFFER="opencode api v2 session revert stage "
CURSOR=\${#BUFFER}
_opencode_yargs_completions
words=(opencode api v2 fs read "")
CURRENT=5
BUFFER="opencode api v2 fs read "
CURSOR=\${#BUFFER}
_opencode_yargs_completions
words=(opencode api session --body-file "")
CURRENT=5
BUFFER="opencode api session --body-file "
CURSOR=\${#BUFFER}
_opencode_yargs_completions
words=(opencode api session --body-file=src/in)
CURRENT=4
BUFFER="opencode api session --body-file=src/in"
CURSOR=\${#BUFFER}
_opencode_yargs_completions
`
  const escaped = script
  return Bun.spawnSync(["zsh", "-fc", escaped], { cwd, env: { ...globalThis.process.env, SHELL: "/usr/bin/zsh" } })
}
