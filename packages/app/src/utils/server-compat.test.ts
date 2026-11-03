import { describe, expect, test } from "bun:test"
import { createApiForServer, createSdkForServer } from "./server"
import { createCompatibleApi } from "./server-compat"
import { ClientError } from "@opencode-ai/client/promise"

function setup(
  protocol: "v1" | "v2" | Promise<"v1" | "v2"> | (() => Promise<"v1" | "v2">),
  responses?: {
    vcs?: { branch: string; default_branch: string }
    sessions?: unknown[]
    response?: Response
    error?: Error
    server?: { url: string; username?: string; password?: string }
  },
) {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (responses?.error) throw responses.error
      if (responses?.response) return responses.response.clone()
      if (request.method === "PATCH") {
        return Response.json({
          id: "ses_1",
          slug: "ses_1",
          projectID: "project",
          directory: "/repo",
          title: "Session",
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      if (request.method === "POST" && request.url.endsWith("/prompt_async"))
        return new Response(undefined, { status: 204 })
      if (request.method === "POST" && ["/prompt", "/command"].some((path) => request.url.endsWith(path))) {
        return Response.json({
          data: {
            admittedSeq: 1,
            id: "msg_1",
            sessionID: "ses_1",
            timeCreated: 1,
            prompt: { text: "hello" },
            delivery: "steer",
          },
        })
      }
      if (request.method === "GET" && new URL(request.url).pathname === "/vcs")
        return Response.json(responses?.vcs ?? {})
      if (request.method === "GET" && new URL(request.url).pathname === "/session")
        return Response.json(responses?.sessions ?? [])
      if (request.method === "GET") return Response.json([])
      return new Response(undefined, { status: 204 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = responses?.server ?? { url: "http://localhost:4096" }
  const createApi = (directory: string) =>
    createCompatibleApi({
      protocol: typeof protocol === "string" ? Promise.resolve(protocol) : protocol,
      current: createApiForServer({ server, fetch: fetcher }),
      legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
      directory,
    })
  return { api: createApi("/repo"), apiForDirectory: createApi, requests }
}

describe("createCompatibleApi", () => {
  test("preserves per-message selection and skill MIME on the legacy wire", async () => {
    const { api, requests } = setup("v1")
    const selection = { inheritActive: true, model: { providerID: "p", modelID: "m" }, variant: "high" }
    await api.session.prompt({ sessionID: "ses_1", id: "msg_1", text: "hello", selection })
    expect(await requests[0]!.json()).toMatchObject({ selection })
    await api.session.command({
      sessionID: "ses_1",
      id: "msg_2",
      command: "review",
      arguments: " x",
      selection,
      files: [{ uri: "skill:review", name: "review" }],
    })
    expect(await requests[1]!.json()).toMatchObject({
      selection,
      parts: [{ type: "file", mime: "application/x-opencode-skill", url: "skill:review" }],
    })
  })

  /*
  test("routes V1 archive through the legacy session update", async () => {
    const { api, requests } = setup("v1")
    await api.session.archive({ sessionID: "ses_1", directory: "/repo" })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/session/ses_1")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[0]!.method).toBe("PATCH")
    expect(await requests[0]!.json()).toMatchObject({ time: { archived: expect.any(Number) } })
  })
  */

  test("converts current prompts to the V1 prompt contract", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello @src/index.ts",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      files: [
        { uri: "file:///repo/src/index.ts", name: "index.ts", mention: { text: "@src/index.ts", start: 6, end: 19 } },
        { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
      ],
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/prompt_async")
    const body = await requests[0]!.json()
    expect(body).toMatchObject({
      messageID: "msg_1",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      parts: [
        { type: "text", text: "hello @src/index.ts" },
        {
          type: "file",
          mime: "text/plain",
          url: "file:///repo/src/index.ts",
          filename: "index.ts",
          source: {
            type: "file",
            text: { value: "@src/index.ts", start: 6, end: 19 },
            path: "file:///repo/src/index.ts",
          },
        },
        {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGVsbG8=",
          filename: "notes.txt",
        },
      ],
    })
    expect(body.parts[2]).not.toHaveProperty("source")
  })

  test("preserves session bookmarks when projecting legacy session lists", async () => {
    const { api } = setup("v1", {
      sessions: [
        {
          id: "ses_1",
          projectID: "project",
          directory: "/repo",
          bookmarked: true,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          title: "Bookmarked",
        },
      ],
    })

    await expect(api.session.list()).resolves.toMatchObject({ data: [{ id: "ses_1", bookmarked: true }] })
  })

  test("preserves original parts for V1 optimistic reconciliation", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "look",
      files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }],
      legacyParts: [
        { id: "prt_text", type: "text", text: "look" },
        { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
      ],
    })

    expect((await requests[0]!.json()).parts).toEqual([
      { id: "prt_text", type: "text", text: "look" },
      { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
    ])
  })

  test("uses the requested directory for V1 session prompts", async () => {
    const { apiForDirectory, requests } = setup("v1")
    await apiForDirectory("/repo/worktree").session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "write a file",
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/prompt_async")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe("%2Frepo%2Fworktree")
  })

  test("keeps V2 prompts on the current session route", async () => {
    const { apiForDirectory, requests } = setup("v2")
    await apiForDirectory("/repo/worktree").session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello",
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/prompt")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBeNull()
    expect(await requests[0]!.json()).toEqual({ id: "msg_1", prompt: { text: "hello" } })
  })

  test("serializes V2 prompt controls and attachments using the current contract", async () => {
    const { api, requests } = setup("v2")
    const mention = { text: "@review", start: 6, end: 13 }
    const selection = { inheritActive: false, model: { providerID: "p", modelID: "m" }, variant: "high" }
    const admitted = await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello @review",
      agent: "build",
      model: { providerID: "p", modelID: "m" },
      variant: "high",
      selection,
      files: [{ uri: "skill:review", name: "review", mention }],
      agents: [{ name: "review", mention }],
      legacyParts: [{ type: "text", text: "legacy only" }],
    })
    expect(await requests[0]!.json()).toEqual({
      id: "msg_1",
      prompt: {
        text: "hello @review",
        agent: "build",
        model: { providerID: "p", id: "m", variant: "high" },
        selection,
        files: [{ uri: "skill:review", name: "review", source: mention }],
        agents: [{ name: "review", source: mention }],
      },
    })
    expect(admitted).toEqual(
      expect.objectContaining({
        admittedSeq: 1,
        id: "msg_1",
        sessionID: "ses_1",
        timeCreated: 1,
        prompt: { text: "hello" },
        delivery: "steer",
      }),
    )
  })

  test("preserves queued V2 prompt and command snapshots without adding overrides", async () => {
    const { api, requests } = setup("v2")
    const selection = { inheritActive: false, model: { providerID: "p", modelID: "m" }, variant: "" }
    await api.session.prompt({
      sessionID: "ses_1",
      text: "queued",
      selection,
      delivery: "queue",
      resume: false,
    })
    expect(await requests[0]!.json()).toEqual({
      prompt: { text: "queued", selection },
      delivery: "queue",
      resume: false,
    })
    await api.session.command({
      sessionID: "ses_1",
      id: "msg_2",
      command: "review",
      arguments: " x",
      agent: "build",
      model: { providerID: "p", id: "m", variant: "high" },
      selection,
      files: [{ uri: "skill:review", name: "review" }],
      agents: [{ name: "review", mention: { text: "@review", start: 0, end: 7 } }],
      delivery: "queue",
      resume: false,
    })
    expect(new URL(requests[1]!.url).pathname).toBe("/api/session/ses_1/command")
    expect(await requests[1]!.json()).toEqual({
      id: "msg_2",
      command: "review",
      arguments: " x",
      agent: "build",
      model: { providerID: "p", id: "m", variant: "high" },
      selection,
      files: [{ uri: "skill:review", name: "review" }],
      agents: [{ name: "review", source: { text: "@review", start: 0, end: 7 } }],
      delivery: "queue",
      resume: false,
    })
    await api.session.command({ sessionID: "ses_1", command: "review" })
    expect(await requests[2]!.json()).toEqual({ command: "review" })
  })

  test("forwards configured V2 authentication and request options without directory headers", async () => {
    const { apiForDirectory, requests } = setup("v2", {
      server: { url: "http://localhost:4096", username: "kit", password: "secret" },
    })
    const controller = new AbortController()
    const api = apiForDirectory("/other")
    await api.session.prompt(
      { sessionID: "ses_1", text: "hello" },
      {
        signal: controller.signal,
        headers: { "x-test": "prompt" },
      },
    )
    await api.session.command(
      { sessionID: "ses_1", command: "review" },
      {
        signal: controller.signal,
        headers: { "x-test": "command" },
      },
    )
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe(`Basic ${btoa("kit:secret")}`)
      expect(request.headers.get("content-type")).toBe("application/json")
      expect(request.headers.get("x-opencode-directory")).toBeNull()
      expect(new URL(request.url).search).toBe("")
      expect(request.signal.aborted).toBe(false)
    }
    expect(requests.map((request) => request.headers.get("x-test"))).toEqual(["prompt", "command"])
    controller.abort()
    expect(requests.every((request) => request.signal.aborted)).toBe(true)
  })

  test("retains declared V2 errors and normal client response errors", async () => {
    const error = { _tag: "ConflictError", message: "conflicting retry" }
    const conflict = setup("v2", { response: Response.json(error, { status: 409 }) })
    await expect(conflict.api.session.prompt({ sessionID: "ses_1", text: "hello" })).rejects.toEqual(error)
    await expect(conflict.api.session.command({ sessionID: "ses_1", command: "review" })).rejects.toEqual(error)
    const malformed = setup("v2", { response: new Response("{", { headers: { "content-type": "application/json" } }) })
    await expect(malformed.api.session.prompt({ sessionID: "ses_1", text: "hello" })).rejects.toBeInstanceOf(
      ClientError,
    )
    await expect(malformed.api.session.command({ sessionID: "ses_1", command: "review" })).rejects.toMatchObject({
      reason: "MalformedResponse",
    })
    const unexpected = setup("v2", { response: new Response(null, { status: 502 }) })
    await expect(unexpected.api.session.prompt({ sessionID: "ses_1", text: "hello" })).rejects.toMatchObject({
      reason: "UnexpectedStatus",
      cause: { status: 502 },
    })
    const cause = new Error("connection refused")
    const transport = setup("v2", { error: cause })
    await expect(transport.api.session.prompt({ sessionID: "ses_1", text: "hello" })).rejects.toMatchObject({
      reason: "Transport",
      cause,
    })
    await expect(transport.api.session.command({ sessionID: "ses_1", command: "review" })).rejects.toMatchObject({
      reason: "Transport",
      cause,
    })
  })

  test("resolves protocol detection once across implementation methods", async () => {
    let detections = 0
    const resolved = Promise.resolve<"v1" | "v2">("v2")
    const protocol = new Proxy(resolved, {
      get(target, property) {
        if (property !== "then") return Reflect.get(target, property, target)
        detections++
        return target.then.bind(target)
      },
    })
    const { api } = setup(protocol)

    await api.session.list()
    await api.session.list()

    expect(detections).toBe(1)
  })

  test("uses the current protocol after a server restart changes API generations", async () => {
    let protocol: "v1" | "v2" = "v1"
    const { api, requests } = setup(() => Promise.resolve(protocol))

    await api.session.list()
    protocol = "v2"
    await api.session.prompt({ sessionID: "ses_1", text: "hello" })
    protocol = "v1"
    await api.session.prompt({ sessionID: "ses_1", text: "hello again" })

    expect(new URL(requests[0]!.url).pathname).toBe("/session")
    expect(new URL(requests[1]!.url).pathname).toBe("/api/session/ses_1/prompt")
    expect(new URL(requests[2]!.url).pathname).toBe("/session/ses_1/prompt_async")
  })

  test("waits for protocol detection before issuing API requests", async () => {
    let resolve!: (protocol: "v1" | "v2") => void
    const protocol = new Promise<"v1" | "v2">((done) => (resolve = done))
    const { api, requests } = setup(protocol)

    const pending = api.session.list()
    await Promise.resolve()
    expect(requests).toEqual([])

    resolve("v2")
    await pending

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session")
  })

  /*
  test("keeps V2 session actions on the current API", async () => {
    const { api, requests } = setup("v2")
    await api.session.archive({ sessionID: "ses_1" })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/archive")
    expect(requests[0]!.method).toBe("POST")
  })
  */

  test("uses the global V1 session search endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.list({ parentID: null, search: "session", limit: 50 })

    expect(new URL(requests[0]!.url).pathname).toBe("/experimental/session")
  })

  /*
  test("projects the V1 default branch", async () => {
    const { api } = setup("v1", { vcs: { branch: "feature", default_branch: "dev" } })

    expect(await api.vcs.get({ location: { directory: "/repo" } })).toMatchObject({
      data: { branch: "feature", defaultBranch: "dev" },
    })
  })
  */

  test("translates current file searches to the V1 dirs parameter", async () => {
    const { api, requests } = setup("v1")
    await api.file.find({ location: { directory: "/repo" }, query: "src", type: "file", limit: 20 })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/find/file")
    expect(url.searchParams.get("dirs")).toBe("false")
    expect(url.searchParams.get("limit")).toBe("20")
  })

  test("routes V1 permission replies through the requested directory", async () => {
    const { api, requests } = setup("v1")
    await api.permission.reply({
      sessionID: "ses_1",
      requestID: "permission_1",
      reply: "once",
      location: { directory: "/other" },
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/permissions/permission_1")
    expect(new URL(requests[0]!.url).searchParams.get("directory")).toBe("/other")
  })

  test("disposes the V1 instance after connecting a provider", async () => {
    const { api, requests } = setup("v1")

    await api.integration.connect.key({
      integrationID: "openrouter",
      key: "secret",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/auth/openrouter",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[1]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[2]!.headers.get("x-opencode-directory")).toBeNull()
  })

  test("disposes the V1 instance after completing provider OAuth", async () => {
    const { api, requests } = setup("v1")

    await api.integration.oauth.complete({
      integrationID: "openrouter",
      attemptID: "openrouter:0",
      code: "code",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/provider/openrouter/oauth/callback",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[1]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[2]!.headers.get("x-opencode-directory")).toBeNull()
  })
})
