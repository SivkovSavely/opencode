import { describe, expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { Effect, Option, Stdio } from "effect"
import { TestConsole } from "effect/testing"
import { tmpdir } from "../../../core/test/fixture/tmpdir"
import { isolatedEnv } from "../../test/fixture/environment"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { Spec } from "../framework/spec"
import { catalog, type ApiInput } from "./commands"
import { buildCatalog, catalogDifferences, catalogSource } from "./catalog"
import { complete, zshWrapper } from "./completion"
import { prepare, requestHeaders, safePath, safeServer } from "./request"
import { coerce, inputOptions, validate } from "./schema"
import { execute } from "./transport"
import type { ApiDocument, Catalog, JsonSchema, Operation } from "./types"

async function parse(args: readonly string[]) {
  const parsed: ApiInput[] = []
  const root = Spec.make("opencode", { commands: [Commands.commands.api] })
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Runtime.run(
        root,
        Runtime.handlers(root, {
          api: async () => ({
            default: (input) =>
              Effect.sync(() => {
                parsed.push(input)
              }),
          }),
        }),
        { version: "test" },
      )
      return { input: parsed[0], help: (yield* TestConsole.logLines).join("\n") }
    }).pipe(
      Effect.provide(TestConsole.layer),
      Effect.provide(Stdio.layerTest({ args: Effect.succeed(args) })),
      Effect.provide(NodeServices.layer),
    ),
  )
}

function document(paths: ApiDocument["paths"]): ApiDocument {
  return { paths, components: { schemas: {} } }
}

const synthetic: Operation = {
  operationId: "example.create",
  command: ["example", "create"],
  method: "POST",
  path: "/api/example/{id}",
  transport: "http",
  parameters: [
    { in: "path", name: "id", required: true, schema: { type: "string" } },
    { in: "query", name: "mode", required: true, schema: { type: "string", enum: ["fast", "safe"] } },
    { in: "query", name: "tags", schema: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 } },
  ],
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" }, count: { type: "integer", minimum: 1, maximum: 5 } },
          additionalProperties: false,
        },
      },
    },
  },
}

async function baseInput() {
  return (await parse(["api", "request", "GET", "/unmodeled"])).input
}

function isolatedApiEnv(root: string) {
  const env: Record<string, string | undefined> = isolatedEnv(root, {
    USERPROFILE: root,
    APPDATA: `${root}/appdata`,
    LOCALAPPDATA: `${root}/localappdata`,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_TELEMETRY: "true",
    DO_NOT_TRACK: "1",
  })
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "OPENCODE_TEST_HOME",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_DB",
      "OPENCODE_DISABLE_FILEWATCHER",
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_TELEMETRY",
      "DO_NOT_TRACK",
      "CI",
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
    ].map((key) => [key, env[key]]),
  )
}

describe("API catalog", () => {
  test("native TRACE and additional QUERY operations remain representable", async () => {
    const generated = buildCatalog({
      paths: {
        "/trace": { trace: { operationId: "example.trace" } },
        "/query": { "x-oai-additionalOperations": { QUERY: { operationId: "example.query" } } },
      },
    })
    expect(generated.operations.map((operation) => operation.method).sort()).toEqual(["QUERY", "TRACE"])
    for (const method of ["QUERY", "TRACE"]) {
      const prepared = await prepare(
        (await parse(["api", "request", method, "/api/example", "--workspace", "A"])).input,
        catalog,
      )
      expect(JSON.parse(String(prepared.body)).method).toBe(method)
    }
  })
  test("the bundled native API is complete, deterministic and drift-sensitive", async () => {
    const spec = (await Bun.file(new URL("../../../protocol/openapi.json", import.meta.url)).json()) as ApiDocument
    const generated = buildCatalog(spec)
    expect(generated.operations.map((operation) => operation.operationId)).toContain("experimental.workspace.dispatch")
    expect(catalogSource(generated)).toBe(await Bun.file(new URL("catalog.generated.json", import.meta.url)).text())
    expect(catalogSource(buildCatalog(spec))).toBe(catalogSource(generated))
    const changed = structuredClone(spec)
    changed.paths["/new"] = { get: { operationId: "newRoute.list" } }
    expect(catalogDifferences(generated, buildCatalog(changed))).toContain("added newRoute.list")
    const parameterChange = structuredClone(generated)
    parameterChange.operations[0].parameters.push({ in: "query", name: "newParameter", schema: { type: "string" } })
    expect(catalogDifferences(generated, parameterChange).join("\n")).toContain("changed ")
    expect(catalogDifferences(parameterChange, generated).join("\n")).toContain("route/parameters/body")
    expect(
      catalogDifferences(generated, { ...generated, operations: generated.operations.slice(1) }).join("\n"),
    ).toContain("removed ")
    expect(catalogDifferences(generated, { ...generated, components: { schemas: {} } })).toContain(
      "changed schema definitions",
    )
    expect(
      generated.operations.find((operation) => operation.operationId === "experimental.projects.update")?.path,
    ).toBe("/api/experimental/projects")
  })

  test.each([
    [
      "command collision",
      { "/a": { get: { operationId: "a.fooBar" } }, "/b": { get: { operationId: "a.foo_bar" } } },
      "collision",
    ],
    [
      "leaf/group collision",
      { "/a": { get: { operationId: "a" } }, "/b": { get: { operationId: "a.list" } } },
      "leaf/group",
    ],
    [
      "unknown WebSocket",
      { "/a": { get: { operationId: "unknown.connect", "x-websocket": true } } },
      "unsupported WebSocket",
    ],
    [
      "media",
      { "/a": { post: { operationId: "a.create", requestBody: { content: { "multipart/form-data": {} } } } } },
      "unsupported request media",
    ],
    [
      "missing ref",
      {
        "/a": {
          post: {
            operationId: "a.create",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } },
          },
        },
      },
      "Missing schema reference",
    ],
    [
      "object serialization",
      {
        "/a": {
          get: { operationId: "a.list", parameters: [{ in: "query", name: "bad", schema: { type: "object" } }] },
        },
      },
      "serialization",
    ],
    [
      "deepObject map",
      {
        "/a": {
          get: {
            operationId: "a.list",
            parameters: [
              {
                in: "query",
                name: "filter",
                style: "deepObject",
                schema: { type: "object", additionalProperties: { type: "string" } },
              },
            ],
          },
        },
      },
      "unsupported deepObject",
    ],
    [
      "deepObject array",
      {
        "/a": {
          get: {
            operationId: "a.list",
            parameters: [
              {
                in: "query",
                name: "filter",
                style: "deepObject",
                schema: { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
              },
            ],
          },
        },
      },
      "unsupported deepObject",
    ],
    [
      "flag collision",
      {
        "/a": {
          get: {
            operationId: "a.list",
            parameters: [
              { in: "query", name: "fooBar", schema: { type: "string" } },
              { in: "query", name: "foo_bar", schema: { type: "string" } },
            ],
          },
        },
      },
      "flag collision",
    ],
  ] as const)("rejects %s", (_name, paths, message) => {
    expect(() => buildCatalog(document(paths))).toThrow(message)
  })

  test("common, body/query and dotted flags are unambiguous", () => {
    const operation: Operation = {
      ...synthetic,
      parameters: [
        ...synthetic.parameters,
        { in: "query", name: "body", schema: { type: "string" } },
        { in: "query", name: "experimental.bookmarked", schema: { type: "boolean" } },
      ],
    }
    const options = inputOptions(operation, catalog)
    expect(options.map((option) => option.flag)).toContain("query-body")
    expect(options.find((option) => option.flag === "experimental-bookmarked")?.name).toBe("experimental.bookmarked")
  })
})

describe("native API commands and inputs", () => {
  test("the native parser preserves backend paths without inspecting the client filesystem", async () => {
    await using local = await tmpdir()
    const collision = `${local.path}/not-a-directory`
    await Bun.write(collision, "local file")
    const results = []
    for (const directory of ["relative/backend", "C:\\remote\\project", collision]) {
      const result = await parse(["api", "session", "list", "--directory", directory])
      results.push({ expected: directory, actual: result.input?.values.directory?.[0] })
      const create = await parse(["api", "session", "create", "--directory", directory])
      results.push({ expected: directory, actual: create.input?.values.directory?.[0] })
    }
    for (const path of ["relative/file.txt", "C:\\remote\\file.txt", collision]) {
      const result = await parse(["api", "fs", "list", "--path", path])
      results.push({ expected: path, actual: result.input?.values.path?.[0] })
    }
    expect(results.map((result) => result.actual)).toEqual(results.map((result) => result.expected))
  })

  test("the native parser keeps local file handling and the explicit stdin sentinel", async () => {
    const local = (
      await parse(["api", "session", "create", "--body-file", "src/api/api.test.ts", "--output", "relative/output"])
    ).input
    expect(Option.getOrUndefined(local.bodyFile)).toBe(`${process.cwd()}/src/api/api.test.ts`)
    expect(Option.getOrUndefined(local.output)).toBe(`${process.cwd()}/relative/output`)
    const stdin = (await parse(["api", "session", "create", "--body-file", "-"])).input
    expect(Option.getOrUndefined(stdin.bodyFile)).toBe("-")
  })

  test("offline arbitrary-depth help and a single native root", async () => {
    expect(Object.keys(Commands.commands).filter((name) => name === "api")).toHaveLength(1)
    for (const args of [
      ["api"],
      ["api", "session"],
      ["api", "session", "message"],
      ["api", "experimental", "session", "instructions", "entry"],
    ]) {
      const result = await parse([...args, "--help"])
      expect(result.help).toContain("SUBCOMMANDS")
      expect(result.input).toBeUndefined()
    }
    const leaf = await parse(["api", "session", "list", "--help"])
    for (const text of ["GET /api/session", "--order", "asc", "--server", "Example:"]) expect(leaf.help).toContain(text)
    const path = await parse(["api", "session", "get", "--help"])
    expect(path.help).toContain("sessionID (required)")
  })

  test("native parser flags, required path, dotted query and body context", async () => {
    const list = (
      await parse([
        "api",
        "session",
        "list",
        "--order",
        "desc",
        "--experimental-bookmarked",
        "true",
        "--directory",
        "/tmp/project space",
      ])
    ).input
    const op = catalog.operations.find((operation) => operation.operationId === "session.list")
    expect(
      new URL((await prepare(list, catalog, op)).path, "http://test").searchParams.get("experimental.bookmarked"),
    ).toBe("true")
    expect(new URL((await prepare(list, catalog, op)).path, "http://test").searchParams.get("directory")).toBe(
      "/tmp/project space",
    )
    const location = (await parse(["api", "location", "get", "--directory", "/tmp/project space"])).input
    expect(
      (
        await prepare(
          location,
          catalog,
          catalog.operations.find((operation) => operation.operationId === "location.get"),
        )
      ).path,
    ).toContain("location%5Bdirectory%5D")
    const get = (await parse(["api", "session", "get"])).input
    await expect(
      prepare(
        get,
        catalog,
        catalog.operations.find((operation) => operation.operationId === "session.get"),
      ),
    ).rejects.toThrow("Missing path parameter")
    const create = (
      await parse(["api", "session", "create", "--title", "hello", "--directory", "/tmp/another project"])
    ).input
    expect(
      JSON.parse(
        String(
          (
            await prepare(
              create,
              catalog,
              catalog.operations.find((operation) => operation.operationId === "session.create"),
            )
          ).body,
        ),
      ),
    ).toEqual({ title: "hello", location: { directory: "/tmp/another project" } })
    const routed = await prepare(
      { ...create, workspace: Option.some("unsupported") },
      catalog,
      catalog.operations.find((operation) => operation.operationId === "session.create"),
    )
    expect(routed.path).toBe("/api/experimental/workspace/unsupported/dispatch")
    expect(JSON.parse(String(routed.body))).toMatchObject({ method: "POST", path: "/api/session" })
  })

  test("required query, typed primitive/repeated flags, enum and range fail locally", async () => {
    const input = await baseInput()
    const request = {
      ...input,
      request: { ...input.request, args: ["a/b ?é"] },
      values: { mode: ["fast"], tags: [1, 2], enabled: [true], count: [3] },
    }
    const result = await prepare(request, catalog, synthetic)
    expect(result.path).toBe("/api/example/a%2Fb%20%3F%C3%A9?mode=fast&tags=1&tags=2")
    expect(JSON.parse(String(result.body))).toEqual({ enabled: true, count: 3 })
    await expect(prepare({ ...request, values: { enabled: [true] } }, catalog, synthetic)).rejects.toThrow(
      "--mode is required",
    )
    await expect(
      prepare({ ...request, values: { ...request.values, mode: ["wrong"] } }, catalog, synthetic),
    ).rejects.toThrow("--mode")
    await expect(
      prepare({ ...request, values: { ...request.values, count: [7] } }, catalog, synthetic),
    ).rejects.toThrow("--count")
    await expect(
      prepare({ ...request, request: { ...request.request, args: [".."] } }, catalog, synthetic),
    ).rejects.toThrow("dot path")
  })

  test("complex JSON body/file and unreadable input", async () => {
    await using dir = await tmpdir()
    const input = await baseInput()
    const operation = catalog.operations.find((operation) => operation.operationId === "session.create")
    await Bun.write(
      `${dir.path}/body.json`,
      JSON.stringify({ title: "fixture", model: { providerID: "fake", id: "fixture" } }),
    )
    const file = { ...input, request: { ...input.request, args: [] }, bodyFile: Option.some(`${dir.path}/body.json`) }
    expect(JSON.parse(String((await prepare(file, catalog, operation)).body)).model.providerID).toBe("fake")
    await expect(
      prepare({ ...file, bodyFile: Option.some(`${dir.path}/missing`) }, catalog, operation),
    ).rejects.toThrow("Cannot read --body-file")
    await expect(
      prepare({ ...file, bodyFile: Option.none(), body: Option.some("{ secret: invalid }") }, catalog, operation),
    ).rejects.toThrow("Invalid JSON")
  })

  test("schema validation covers unions, arrays, formats and constraints", () => {
    const empty: Catalog = { operations: [], components: { schemas: {} } }
    const cases: [unknown, JsonSchema, string][] = [
      ["x", { type: "integer" }, "integer"],
      [0, { minimum: 1 }, ">= 1"],
      [6, { maximum: 5 }, "<= 5"],
      ["wrong", { pattern: "^ses_" }, "pattern"],
      [[], { minItems: 1 }, "few items"],
      [[1, 1], { uniqueItems: true }, "unique"],
      ["no", { format: "uuid" }, "uuid"],
      ["not-an-ip", { format: "ipv4" }, "ipv4"],
      ["2026-02-30", { format: "date" }, "date"],
      ["2026-11-06", { format: "date-time" }, "date-time"],
      ["forbidden", { not: {} }, "forbidden"],
      [[1], { type: "array", prefixItems: [{ type: "string" }] }, "string"],
      [
        { key: "wrong" },
        { type: "object", patternProperties: { "^key$": { type: "number" } }, additionalProperties: false },
        "number",
      ],
      ["x", { enum: ["yes"] }, "one of"],
      [
        { kind: "c" },
        { oneOf: [{ properties: { kind: { const: "a" } } }, { properties: { kind: { const: "b" } } }] },
        "oneOf",
      ],
    ]
    cases.forEach(([value, schema, message]) =>
      expect(validate(value, schema, empty).join("\n")).toContain(message === "pattern" ? "does not match" : message),
    )
    expect(coerce(["1", "2"], { type: "array", items: { type: "integer" } }, empty)).toEqual([1, 2])
    expect(validate({ kind: "b" }, cases.at(-1)?.[1], empty)).toEqual([])
  })

  test("URLs and headers cannot redirect credentials or smuggle a request", () => {
    for (const value of ["https://user:secret@test", "file:///tmp/test", "http://test?password=x"])
      expect(() => safeServer(value)).toThrow()
    for (const value of ["//evil/path", "/../secret", "/%2e%2e/secret", "/\\evil"])
      expect(() => safePath(value)).toThrow()
    for (const value of ["broken", "x:y\r\nsecret:bad", "Authorization: Basic fake", "Host: evil"])
      expect(() => requestHeaders([value])).toThrow()
    expect(requestHeaders(["x-fixture: first", "x-fixture: second"]).get("x-fixture")).toBe("first, second")
  })
})

describe("HTTP, SSE and completion transports", () => {
  test("real native handler retains project, raw, operation-ID, live-spec and context execution", async () => {
    await using dir = await tmpdir()
    const seen: { method: string; path: string; body: unknown }[] = []
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const path = new URL(request.url).pathname
        seen.push({ method: request.method, path, body: request.method === "POST" ? await request.json() : undefined })
        return Response.json(
          path === "/openapi.json" ? document({ "/new": { get: { operationId: "newly.deployed" } } }) : { ok: true },
        )
      },
    })
    const root = Spec.make("opencode", { commands: [Commands.commands.api] })
    const handlers = Runtime.handlers(root, { api: () => import("../commands/handlers/api") })
    for (const args of [
      ["project", "list"],
      ["request", "GET", "/unmodeled"],
      ["server.info"],
      ["newly.deployed"],
      ["spec", "--remote"],
      ["session", "create", "--title", "fixture", "--directory", "/tmp/fixture"],
      ["session", "create", "--schema"],
      ["catalog"],
      ["spec", "--compact"],
    ]) {
      await Effect.runPromise(
        Runtime.run(root, handlers, { version: "test" }).pipe(
          Effect.provide(
            Stdio.layerTest({
              args: Effect.succeed(["api", ...args, "--server", server.url.origin, "--output", `${dir.path}/out`]),
            }),
          ),
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        ),
      )
    }
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/project",
      "GET /unmodeled",
      "GET /api/info",
      "GET /openapi.json",
      "GET /new",
      "GET /openapi.json",
      "POST /api/session",
    ])
    expect(seen.at(-1)?.body).toEqual({ title: "fixture", location: { directory: "/tmp/fixture" } })
    expect((await Bun.file(`${dir.path}/out`).json()).paths["/api/info"]).toBeDefined()
    expect(await Bun.file(`${dir.path}/out`).text()).not.toContain("\n  ")
  })

  test("synthetic Basic auth, headers, JSON/raw/file, errors and redirect refusal", async () => {
    await using dir = await tmpdir()
    const seen: { url: string; authorization: string | null; header: string | null }[] = []
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          header: request.headers.get("x-fixture"),
        })
        const path = new URL(request.url).pathname
        if (/^\/(401|404|500)$/.test(path)) return new Response("failure", { status: Number(path.slice(1)) })
        if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "/must-not-follow" } })
        if (path === "/raw") return new Response(new Uint8Array([0, 255, 10]))
        return Response.json({ ok: true })
      },
    })
    const endpoint = {
      url: server.url.origin,
      auth: { type: "basic", username: "opencode", password: "synthetic-only" },
    } as const
    const output = `${dir.path}/response`
    const request = {
      method: "GET",
      path: "/api/server",
      headers: requestHeaders(["x-fixture: a", "x-fixture: b"]),
      transport: "http",
    } as const
    await execute(endpoint, request, { timeout: 1000, output })
    expect(await Bun.file(output).text()).toBe('{\n  "ok": true\n}\n')
    expect(seen[0].authorization).toBe(`Basic ${Buffer.from("opencode:synthetic-only").toString("base64")}`)
    expect(seen[0].header).toBe("a, b")
    await execute(endpoint, request, { timeout: 1000, output, compact: true })
    expect(await Bun.file(output).text()).toBe('{"ok":true}\n')
    await execute(endpoint, { ...request, path: "/raw" }, { timeout: 1000, output, raw: true })
    expect([...new Uint8Array(await Bun.file(output).arrayBuffer())]).toEqual([0, 255, 10])
    for (const status of [401, 404, 500, 302])
      await expect(
        execute(endpoint, { ...request, path: status === 302 ? "/redirect" : `/${status}` }, { timeout: 1000, output }),
      ).rejects.toThrow(`HTTP ${status}`)
    expect(seen.some((request) => request.url.includes("must-not-follow"))).toBe(false)
  })

  test("real endless SSE writes immediately and aborts cleanly; PTY fails honestly", async () => {
    await using dir = await tmpdir()
    const cancelled = Promise.withResolvers<void>()
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: fixture\ndata: {"ok":true}\n\n'))
            },
            cancel() {
              cancelled.resolve()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const controller = new AbortController()
    const output = `${dir.path}/events`
    const running = execute(
      { url: server.url.origin },
      { method: "GET", path: "/events", headers: new Headers(), transport: "sse" },
      { timeout: 2000, output, signal: controller.signal },
    )
    // Synchronize with actual file output, not an arbitrary production-stream delay.
    const deadline = Date.now() + 1000
    while (!(await Bun.file(output).exists()) || !(await Bun.file(output).text()).includes("fixture")) {
      if (Date.now() > deadline) throw new Error("SSE did not write its first event")
      await Bun.sleep(1)
    }
    controller.abort()
    await expect(running).rejects.toThrow()
    await cancelled.promise
    expect(await Bun.file(output).text()).toContain('"data":"{\\"ok\\":true}"')
    const input = await baseInput()
    await expect(
      prepare(
        input,
        catalog,
        catalog.operations.find((operation) => operation.operationId === "pty.connect"),
      ),
    ).rejects.toThrow("WebSocket transport is not supported")
    await expect(
      execute(
        { url: server.url.origin },
        { method: "GET", path: "/events", headers: new Headers(), transport: "sse" },
        { timeout: 20, output: `${dir.path}/timeout` },
      ),
    ).rejects.toThrow()
  })

  test("recursive static, enum and equals-cursor completion is offline and bounded lookup is GET-only", async () => {
    expect(await complete(["session", "message", ""])).toContain("list")
    expect(await complete(["experimental", "session", "instructions", "entry", ""])).toContain("put")
    expect(await complete(["session", "list", "--order", ""])).toEqual(["asc", "desc"])
    expect(await complete(["session", "list", "--order=d"])).toEqual(["--order=desc"])
    expect(await complete(["session", "list", "--password", ""])).toEqual([])
    expect(zshWrapper()).toContain("compset -P '*='")
    expect(zshWrapper()).toContain("_files; return")
    const seen: { method: string; url: string; auth: string | null }[] = []
    const envelope = { key: "data" }
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push({ method: request.method, url: request.url, auth: request.headers.get("authorization") })
        const items = [{ id: "ses_fixture" }, ...Array.from({ length: 100 }, (_, index) => ({ id: `ses_${index}` }))]
        return Response.json(envelope.key === "bare" ? items : { [envelope.key]: items })
      },
    })
    const options = { server: server.url.origin, password: "fixture-only", directory: "/tmp/fixture" }
    expect(await complete(["session", "get", "ses_fixture"], options)).toEqual(["ses_fixture"])
    expect(new URL(seen[0].url).pathname).toBe("/api/session")
    expect(new URL(seen[0].url).searchParams.get("directory")).toBe("/tmp/fixture")
    expect(seen[0].auth).toBe(`Basic ${Buffer.from("opencode:fixture-only").toString("base64")}`)
    expect(await complete(["session", "get", ""], options)).toHaveLength(50)
    for (const key of ["items", "bare"]) {
      envelope.key = key
      expect(await complete(["session", "get", "ses_fixture"], options)).toEqual(["ses_fixture"])
    }
    expect(seen.every((request) => request.method === "GET")).toBe(true)
    const beforeWorkspace = seen.length
    expect(await complete(["session", "get", "--workspace=A", ""], options)).toEqual([])
    expect(await complete(["session", "get", ""], { ...options, workspace: "A" })).toEqual([])
    expect(seen).toHaveLength(beforeWorkspace)
    using oversized = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x".repeat(262145)) })
    expect(await complete(["session", "get", ""], { server: oversized.url.origin })).toEqual([])
    expect(await complete(["session", "get", ""], { server: "http://127.0.0.1:1" })).toEqual([])
    expect(await complete(["session", "get", ""])).toEqual([])
  })

  test("native completion retains non-API commands and filesystem descriptors", async () => {
    const rendered = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Runtime.run(Commands, [], { version: "test" })
        return (yield* TestConsole.logLines).join("\n")
      }).pipe(
        Effect.provide(TestConsole.layer),
        Effect.provide(Stdio.layerTest({ args: Effect.succeed(["--completions", "zsh"]) })),
        Effect.provide(NodeServices.layer),
      ),
    )
    for (const command of [
      "_opencode_run",
      "_opencode_auth_login",
      "_opencode_api_session_list",
      "_opencode_api_experimental_session_instructions_entry_put",
    ])
      expect(rendered).toContain(command)
    expect(rendered).toContain("_files")
  })

  test.skipIf(!Bun.which("zsh"))("Zsh wrapper executes equals-cursor, path and non-API dispatch", async () => {
    await using dir = await tmpdir()
    await Bun.write(`${dir.path}/wrapper.zsh`, zshWrapper())
    await Bun.write(
      `${dir.path}/opencode`,
      `#!/bin/sh
if [ "$1" = "--server" ]; then [ "$2" = "http://127.0.0.1:1" ] || exit 21; shift 2; fi
if [ "$1" = "--print-logs" ]; then [ "$2" = "false" ] && [ "$3" = "--server=http://127.0.0.1:1" ] || exit 23; shift 3; fi
[ "$1" = "api" ] && [ "$2" = "complete" ] && [ "$3" = "--" ] && [ "$4" = "session" ] && [ "$5" = "list" ] && [ "$6" = "--order=d" ] && [ "$#" = 6 ] || { printf '%s\\n' 'invalid completion argv' >&2; exit 22; }
printf '%s\\n' '--order=desc'
`,
    )
    await chmod(`${dir.path}/opencode`, 0o700)
    // Capture the shell completion primitives while executing the real generated wrapper in Zsh.
    const script = `
      _opencode() { print native; }
      compadd() { print -r -- "$@"; }
      compset() { print -r -- "prefix:$*"; }
      _files() { print files; }
      source "$1/wrapper.zsh"
      words=("$1/opencode" api session list --order=d); CURRENT=5; _opencode
      words=("$1/opencode" --server http://127.0.0.1:1 api session list --order=d); CURRENT=7; _opencode
      words=("$1/opencode" --print-logs false --server=http://127.0.0.1:1 api session list --order=d); CURRENT=8; _opencode
      words=("$1/opencode" api session list --body-file=./); CURRENT=5; _opencode
      words=("$1/opencode" run ""); CURRENT=3; _opencode
    `
    const child = Bun.spawn(["zsh", "-fc", script, "fixture", dir.path], {
      env: isolatedApiEnv(dir.path),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(stdout).toContain("prefix:-P *=\n-- desc")
    expect(stdout).toContain("files")
    expect(stdout).toEndWith("native\n")
  })
})

test("isolated real CLI offline schema and authenticated request; invalid input makes no request", async () => {
  await using dir = await tmpdir()
  const requests: string[] = []
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      expect(request.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`,
      )
      return Response.json({ fixture: true }, { status: new URL(request.url).pathname === "/401" ? 401 : 200 })
    },
  })
  const clean = isolatedApiEnv(dir.path)
  // A native Bun loader guard makes accidental plugin-runtime loading fail in the real CLI process.
  await Bun.write(
    `${dir.path}/no-plugin-runtime.ts`,
    `Bun.plugin({ name: "offline-api-runtime-guard", setup(build) {
    build.onLoad({ filter: /[/\\\\]plugin[/\\\\]src[/\\\\]runtime\\.[cm]?[jt]s$/ }, () => { throw new Error("UNEXPECTED_PLUGIN_RUNTIME") })
  } })`,
  )
  const guarded = Bun.spawn(
    [
      process.execPath,
      "--preload",
      `${dir.path}/no-plugin-runtime.ts`,
      "--eval",
      'await import("@opencode/plugin/runtime")',
    ],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: clean,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const guardResult = await Promise.all([
    new Response(guarded.stdout).text(),
    new Response(guarded.stderr).text(),
    guarded.exited,
  ])
  expect(guardResult[2]).not.toBe(0)
  expect(guardResult[1]).toContain("UNEXPECTED_PLUGIN_RUNTIME")
  const run = async (args: string[], password = "") => {
    const child = Bun.spawn(
      [process.execPath, "run", "--preload", `${dir.path}/no-plugin-runtime.ts`, "src/index.ts", ...args],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: clean,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    child.stdin.write(password)
    child.stdin.end()
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).not.toContain("fixture-password")
    return { stdout, stderr, code }
  }
  const help = await run(["api", "--help"])
  expect(help.stderr).toBe("")
  expect(help.code).toBe(0)
  expect(help.stdout).toContain("session")
  const schema = await run(["api", "session", "create", "--schema"])
  expect(schema.stderr).toBe("")
  expect(schema.code).toBe(0)
  expect(JSON.parse(schema.stdout).operation.operationId).toBe("session.create")
  const spec = await run(["api", "spec"])
  expect(spec.stderr).toBe("")
  expect(spec.code).toBe(0)
  expect(JSON.parse(spec.stdout).paths["/api/info"]).toBeDefined()
  const completion = await run(["api", "complete", "--", "session", "list", "--order=d"])
  expect(completion.code).toBe(0)
  expect(completion.stderr).toBe("")
  expect(completion.stdout).toBe("--order=desc\n")
  const health = await run(
    ["api", "health", "--server", server.url.origin, "--password-stdin", "--compact"],
    "fixture-password\n",
  )
  expect(health.stderr).toBe("")
  expect(health.code).toBe(0)
  expect(health.stdout).toBe('{"fixture":true}\n')
  const bad = await run(["api", "session", "get", "--server", server.url.origin])
  expect(bad.stderr).toContain("Missing path parameter")
  expect(bad.code).not.toBe(0)
  const denied = await run([
    "api",
    "request",
    "GET",
    "/401",
    "--server",
    server.url.origin,
    "--password",
    "fixture-password",
  ])
  expect(denied.code).not.toBe(0)
  expect(denied.stderr).toContain("HTTP 401")
  expect(denied.stderr).not.toContain("fixture-password")
  expect(denied.stdout).toBe("")
  expect(requests).toEqual(["GET /api/info", "GET /401"])
  for (const [index, globals] of [
    ["--print-logs", "false"],
    ["--print-logs=false", "--server", server.url.origin],
    ["--server=" + server.url.origin],
  ].entries()) {
    const result = await run([
      ...globals,
      "api",
      ...(index === 0 ? ["health", "--server", server.url.origin, "--compact"] : ["session", "create", "--schema"]),
      "--password",
      "fixture-password",
    ])
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain("fixture-password")
    expect(result.stderr).not.toContain("fixture-password")
  }
  const malformed = await run(["--print-logs", "false", "api", "health", "--password=fixture-password", "--not-a-flag"])
  expect(malformed.code).not.toBe(0)
  expect(malformed.stdout + malformed.stderr).not.toContain("fixture-password")
  const logs = await Array.fromAsync(new Bun.Glob("**/*.log").scan({ cwd: dir.path, absolute: true }))
  expect(logs.length).toBeGreaterThan(0)
  const logged = (await Promise.all(logs.map((file) => Bun.file(file).text()))).join("\n")
  expect(logged).toContain("cli starting")
  expect(logged).not.toContain("fixture-password")
}, 30_000)
