import { expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { OpenCode } from "@opencode/client"
import { Session } from "@opencode/schema/session"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Layer, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"
import { make } from "../../client/src/effect/generated/client"

const options = {
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
} as const
const basic = (password: string) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

it.live(
  "workspace dispatch affects only the authorized native backend and preserves resource affinity",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-workspace-dispatch-")))
      const directory = path.join(fixture.path, "same-directory")
      const completed: string[] = []
      yield* Effect.promise(() => Bun.write(path.join(directory, "marker.txt"), "HOST"))

      const backend = (id: string) =>
        Effect.gen(function* () {
          const root = path.join(fixture.path, id)
          yield* Effect.promise(() => Bun.write(path.join(root, "marker.txt"), id))
          yield* Effect.promise(() =>
            Bun.write(path.join(root, "large.bin"), new Uint8Array(16 * 1024 * 1024).fill(65)),
          )
          const map = (input: string) =>
            input === directory || input.startsWith(directory + path.sep) ? root + input.slice(directory.length) : input
          // Model independent host filesystems while using the real native FSUtil and FileSystem handlers.
          const filesystem = Layer.effect(
            FSUtil.Service,
            Effect.gen(function* () {
              const fs = yield* FSUtil.Service
              return {
                ...fs,
                realPath: (input) =>
                  fs
                    .realPath(map(input))
                    .pipe(
                      Effect.map((resolved) =>
                        resolved === root || resolved.startsWith(root + path.sep)
                          ? directory + resolved.slice(root.length)
                          : resolved,
                      ),
                    ),
                access: (input, opts) => fs.access(map(input), opts),
                stat: (input) => fs.stat(map(input)),
                readDirectoryEntries: (input) => fs.readDirectoryEntries(map(input)),
                writeWithDirs: (input, data, mode) => fs.writeWithDirs(map(input), data, mode),
                stream: (input, opts) =>
                  fs
                    .stream(map(input), opts)
                    .pipe(
                      Stream.schedule(Schedule.spaced(input.endsWith("large.bin") ? "5 millis" : "0 millis")),
                      Stream.ensuring(Effect.sync(() => completed.push(id + ":" + path.basename(input)))),
                    ),
              } satisfies FSUtil.Interface
            }),
          ).pipe(Layer.provide(FSUtil.layer), Layer.provide(NodeFileSystem.layer))
          const handler = yield* ServerFetch.make(
            {
              ...options,
              password: `backend-${id}`,
              config: {
                project: false,
                directory: path.join(fixture.path, `config-${id}`),
                content: '{"experimental":{"schedules":true}}',
              },
            },
            { overrides: [FSUtil.node.replace(filesystem)] },
          )
          const server = yield* Effect.acquireRelease(
            Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) })),
            (server) => Effect.promise(() => server.stop(true)),
          )
          return { handler, server, root, url: `http://127.0.0.1:${server.port}`, password: `backend-${id}` }
        })
      const a = yield* backend("A")
      const b = yield* backend("B")
      const targets = [a, b].map((item, i) => ({
        id: i === 0 ? "A" : "B",
        url: item.url,
        password: item.password,
        directory,
        operations: ["fs.read", "fs.list", "experimental.fs.write", "session.create", "session.list", "session.get"],
      }))
      const host = yield* ServerFetch.make({
        ...options,
        password: "host-only",
        config: { project: false, directory: path.join(fixture.path, "config-host") },
        experimental: {
          workspaceTargets: [
            ...targets,
            {
              ...targets[0]!,
              id: "approved",
              operations: [
                ...targets[0]!.operations,
                "session.update",
                "session.remove",
                "session.prompt",
                "session.inbox.list",
                "session.inbox.cancel",
                "session.environment",
                "session.move",
                "experimental.session.log",
                "location.get",
                "server.info",
                "experimental.workspace.dispatch",
                "pty.connect",
                "experimental.schedule.create",
                "experimental.schedule.pause",
                "experimental.schedule.delete",
              ],
            },
            { ...targets[0]!, id: "bad-auth", password: "not-the-backend-password" },
            { ...targets[1]!, id: "approved-B", operations: ["session.update", "session.get"] },
            { ...targets[0]!, id: "denied", operations: [] },
          ],
        },
      })
      const listener = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => host(request) })),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const cli = (args: string[]) =>
        Effect.gen(function* () {
          const home = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-workspace-cli-")))
          yield* Effect.promise(() => Bun.write(path.join(home.path, "config", "opencode.json"), "{}"))
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.spawn(
                [
                  process.execPath,
                  "run",
                  "src/index.ts",
                  "api",
                  ...args,
                  "--server",
                  listener.url.origin,
                  "--password-stdin",
                  "--timeout",
                  "5000",
                ],
                {
                  cwd: fileURLToPath(new URL("../../cli", import.meta.url)),
                  env: {
                    PATH: process.env.PATH,
                    CI: "true",
                    HOME: home.path,
                    USERPROFILE: home.path,
                    APPDATA: path.join(home.path, "appdata"),
                    LOCALAPPDATA: path.join(home.path, "localappdata"),
                    XDG_CONFIG_HOME: path.join(home.path, "config"),
                    XDG_DATA_HOME: path.join(home.path, "data"),
                    XDG_STATE_HOME: path.join(home.path, "state"),
                    XDG_CACHE_HOME: path.join(home.path, "cache"),
                    TMPDIR: home.path,
                    TMP: home.path,
                    TEMP: home.path,
                    OPENCODE_TEST_HOME: home.path,
                    OPENCODE_CONFIG_DIR: path.join(home.path, "config"),
                    OPENCODE_CONFIG_CONTENT: "{}",
                    OPENCODE_DISABLE_MODELS_FETCH: "true",
                    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
                    OPENCODE_DISABLE_TELEMETRY: "true",
                    DO_NOT_TRACK: "1",
                  },
                  stdin: "pipe",
                  stdout: "pipe",
                  stderr: "pipe",
                },
              ),
            ),
            (child) =>
              Effect.promise(async () => {
                if (child.exitCode === null) child.kill()
                await child.exited
              }),
          )
          child.stdin.write("host-only\n")
          child.stdin.end()
          const result = yield* Effect.promise(() =>
            Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
          ).pipe(Effect.timeout("10 seconds"))
          expect(result[1]).not.toContain("host-only")
          expect(result[1]).not.toContain("backend-A")
          return { stdout: result[0], stderr: result[1], code: result[2] }
        })
      const dispatch = (
        id: string,
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
        route: string,
        body?: string,
        headers: Record<string, string> = {},
        signal?: AbortSignal,
        password = "host-only",
      ) =>
        Effect.promise(() =>
          host(
            new Request(`http://host/api/experimental/workspace/${id}/dispatch`, {
              method: "POST",
              signal,
              headers: { authorization: basic(password), "content-type": "application/json" },
              body: JSON.stringify({
                method,
                path: route,
                headers,
                ...(body === undefined ? {} : { body: Buffer.from(body).toString("base64") }),
              }),
            }),
          ),
        )
      const attackerRequests: string[] = []
      const attacker = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              attackerRequests.push(request.headers.get("authorization") ?? "no-auth")
              return new Response("owned-attacker")
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const traversal = yield* dispatch("A", "GET", `/api/fs/read/\t../\t../\t..//127.0.0.1:${attacker.port}/collect`)
      yield* Effect.promise(() => traversal.arrayBuffer())
      expect(attackerRequests).toEqual([])
      expect(traversal.status).toBe(400)
      for (const id of ["A", "B"]) {
        const read = yield* dispatch(id, "GET", "/api/fs/read/marker.txt")
        expect(read.status).toBe(200)
        expect(yield* Effect.promise(() => read.text())).toBe(id)
      }
      yield* Effect.promise(() => Bun.write(path.join(a.root, "encoded name.txt"), "ENCODED-A"))
      const encoded = yield* dispatch("A", "GET", "/api/fs/read/encoded%20name.txt?kept=%2F%3F%26", undefined, {
        accept: "application/octet-stream",
      })
      expect(encoded.status).toBe(200)
      expect(yield* Effect.promise(() => encoded.text())).toBe("ENCODED-A")
      yield* Effect.promise(() => Bun.write(path.join(a.root, "encoded;name.txt"), "SEMICOLON-A"))
      const semicolonFile = yield* dispatch("A", "GET", "/api/fs/read/encoded%3Bname.txt?kept=literal;query%3Bvalue")
      expect(semicolonFile.status).toBe(200)
      expect(yield* Effect.promise(() => semicolonFile.text())).toBe("SEMICOLON-A")
      const range = yield* dispatch("A", "GET", "/api/fs/read/marker.txt?kept=query", undefined, {
        range: "bytes=0-0",
        accept: "application/octet-stream",
      })
      expect(range.status).toBe(206)
      expect(range.headers.get("content-range")).toBe("bytes 0-0/1")
      expect(yield* Effect.promise(() => range.text())).toBe("A")
      const unchanged = yield* dispatch("A", "GET", "/api/fs/read/marker.txt", undefined, {
        "if-none-match": range.headers.get("etag")!,
      })
      expect(unchanged.status).toBe(304)
      expect(yield* Effect.promise(() => unchanged.text())).toBe("")
      const missingFile = yield* dispatch("B", "GET", "/api/fs/read/not-present.txt")
      expect(missingFile.status).toBe(404)
      expect(missingFile.headers.get("content-type")).toContain("application/json")
      yield* Effect.promise(() => missingFile.arrayBuffer())
      const write = yield* dispatch(
        "B",
        "POST",
        "/api/experimental/fs/write?path=selected.txt",
        "B-WRITTEN\u0000bytes",
        {
          "content-type": "application/octet-stream",
        },
      )
      expect(write.status).toBe(200)
      yield* Effect.promise(() => write.arrayBuffer())
      expect(yield* Effect.promise(() => Bun.file(path.join(b.root, "selected.txt")).text())).toBe(
        "B-WRITTEN\u0000bytes",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(a.root, "selected.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, "selected.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, "marker.txt")).text())).toBe("HOST")
      const list = yield* dispatch("B", "GET", "/api/fs/list?path=.")
      expect(list.status).toBe(200)
      expect(JSON.stringify(yield* Effect.promise(() => list.json()))).toContain("selected.txt")

      const created = yield* dispatch("A", "POST", "/api/session", JSON.stringify({ title: "A-ONLY" }), {
        "content-type": "application/json",
      })
      expect(created.status).toBe(200)
      const session = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
        yield* Effect.promise(() => created.json()),
      ).data
      expect(String(session.location.directory)).toBe(directory)
      const followup = yield* dispatch("A", "GET", `/api/session/${session.id}`)
      expect(followup.status).toBe(200)
      expect(JSON.stringify(yield* Effect.promise(() => followup.json()))).toContain("A-ONLY")
      const child = yield* dispatch(
        "A",
        "POST",
        "/api/session",
        JSON.stringify({ parentID: session.id, title: "A-CHILD" }),
        { "content-type": "application/json" },
      )
      expect(child.status).toBe(200)
      const ownedChild = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
        yield* Effect.promise(() => child.json()),
      ).data
      const ownedGrandchildCreated = yield* dispatch(
        "A",
        "POST",
        "/api/session",
        JSON.stringify({ parentID: ownedChild.id, title: "A-GRANDCHILD" }),
        { "content-type": "application/json" },
      )
      const ownedGrandchild = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
        yield* Effect.promise(() => ownedGrandchildCreated.json()),
      ).data
      const updated = yield* dispatch(
        "approved",
        "PATCH",
        `/api/session/${session.id}`,
        JSON.stringify({ title: "A-UPDATED" }),
        {
          "content-type": "application/json",
        },
      )
      expect(updated.status).toBe(204)
      yield* Effect.promise(() => updated.arrayBuffer())
      const updatedSession = yield* dispatch("A", "GET", `/api/session/${session.id}`)
      expect(JSON.stringify(yield* Effect.promise(() => updatedSession.json()))).toContain("A-UPDATED")
      const sdkInput = {
        workspaceID: "approved",
        method: "PATCH" as const,
        path: `/api/session/${session.id}`,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ title: "A-SDK-UPDATED" })).toString("base64"),
      }
      const promiseClient = OpenCode.make({
        baseUrl: listener.url.origin,
        headers: { authorization: basic("host-only") },
        fetch: Object.assign((input: URL | RequestInfo, init?: RequestInit) => host(new Request(input, init)), {
          preconnect() {},
        }),
      })
      expect(yield* Effect.promise(() => promiseClient.experimental.workspace.dispatch(sdkInput))).toEqual(
        new Uint8Array(),
      )
      const promiseUpdated = yield* dispatch("A", "GET", `/api/session/${session.id}`)
      expect(JSON.stringify(yield* Effect.promise(() => promiseUpdated.json()))).toContain("A-SDK-UPDATED")
      const effectClient = yield* make({ baseUrl: listener.url.origin }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.promise(async () =>
              HttpClientResponse.fromWeb(
                request,
                await host(
                  new Request(request.url, {
                    method: request.method,
                    headers: { ...request.headers, authorization: basic("host-only") },
                    body: request.body._tag === "Uint8Array" ? new Uint8Array(request.body.body) : undefined,
                  }),
                ),
              ),
            ),
          ),
        ),
      )
      expect(
        yield* effectClient.experimental.workspace.dispatch({
          ...sdkInput,
          body: Buffer.from(JSON.stringify({ title: "A-UPDATED" })).toString("base64"),
        }),
      ).toEqual(new Uint8Array())
      const effectUpdated = yield* dispatch("A", "GET", `/api/session/${session.id}`)
      expect(JSON.stringify(yield* Effect.promise(() => effectUpdated.json()))).toContain("A-UPDATED")
      for (const [method, suffix, payload] of [
        ["PATCH", "", { title: "DENIED" }],
        ["POST", "/prompt", { text: "DENIED", resume: false }],
        ["DELETE", "", undefined],
      ] as const) {
        const denied = yield* dispatch("A", method, `/api/session/${session.id}${suffix}`, JSON.stringify(payload), {
          "content-type": "application/json",
        })
        expect(denied.status).toBe(403)
        yield* Effect.promise(() => denied.arrayBuffer())
      }
      const unchangedSession = yield* dispatch("A", "GET", `/api/session/${session.id}`)
      expect(JSON.stringify(yield* Effect.promise(() => unchangedSession.json()))).toContain("A-UPDATED")
      const admitted = yield* dispatch(
        "approved",
        "POST",
        `/api/session/${session.id}/prompt`,
        JSON.stringify({ text: "ADMIT-ONLY", resume: false }),
        {
          "content-type": "application/json",
        },
      )
      expect(admitted.status).toBe(200)
      yield* Effect.promise(() => admitted.arrayBuffer())
      const inbox = yield* dispatch("approved", "GET", `/api/session/${session.id}/inbox`)
      const pending = Schema.decodeUnknownSync(
        Schema.Struct({
          data: Schema.Array(Schema.Struct({ id: Schema.String, payload: Schema.Struct({ text: Schema.String }) })),
        }),
      )(yield* Effect.promise(() => inbox.json())).data
      expect(pending.map((item) => item.payload.text)).toEqual(["ADMIT-ONLY"])
      const canceled = yield* dispatch("approved", "DELETE", `/api/session/${session.id}/inbox/${pending[0]!.id}`)
      expect(canceled.status).toBe(204)
      yield* Effect.promise(() => canceled.arrayBuffer())
      const emptyInbox = yield* dispatch("approved", "GET", `/api/session/${session.id}/inbox`)
      expect(yield* Effect.promise(() => emptyInbox.json())).toEqual({ data: [] })
      const environment = yield* dispatch(
        "approved",
        "PUT",
        `/api/session/${session.id}/environment`,
        JSON.stringify({ variables: { F021: "A-ONLY" } }),
        {
          "content-type": "application/json",
        },
      )
      expect(environment.status).toBe(204)
      yield* Effect.promise(() => environment.arrayBuffer())
      const location = yield* dispatch("approved", "GET", "/api/location")
      expect(location.status).toBe(200)
      expect(JSON.stringify(yield* Effect.promise(() => location.json()))).toContain(directory)
      const info = yield* dispatch("approved", "GET", "/api/info")
      expect(info.status).toBe(200)
      yield* Effect.promise(() => info.arrayBuffer())
      const logController = new AbortController()
      const log = yield* dispatch(
        "approved",
        "GET",
        `/api/experimental/session/${session.id}/log?follow=true`,
        undefined,
        {},
        logController.signal,
      )
      expect(log.status).toBe(200)
      expect(log.headers.get("content-type")).toContain("text/event-stream")
      const logReader = log.body!.getReader()
      expect((yield* Effect.promise(() => logReader.read())).done).toBe(false)
      logController.abort()
      yield* Effect.promise(() => logReader.cancel().catch(() => undefined))
      yield* Effect.sync(() => a.server.pendingRequests === 0).pipe(
        Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("10 millis") }),
        Effect.timeout("3 seconds"),
      )
      yield* Effect.promise(() => Bun.write(path.join(fixture.path, "foreign-location", "marker.txt"), "FOREIGN"))
      const foreignCreated = yield* Effect.promise(() =>
        a.handler(
          new Request("http://backend/api/session", {
            method: "POST",
            headers: { authorization: basic(a.password), "content-type": "application/json" },
            body: JSON.stringify({
              location: { directory: path.join(fixture.path, "foreign-location") },
              title: "FOREIGN",
            }),
          }),
        ),
      )
      expect(foreignCreated.status).toBe(200)
      const foreign = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
        yield* Effect.promise(() => foreignCreated.json()),
      ).data
      const semicolonList = yield* dispatch(
        "A",
        "GET",
        `/api/session;directory=${encodeURIComponent(foreign.location.directory)}&ignored=`,
      )
      const semicolonBody = yield* Effect.promise(() => semicolonList.text())
      expect({ status: semicolonList.status, disclosedForeign: semicolonBody.includes(foreign.id) }).toEqual({
        status: 400,
        disclosedForeign: false,
      })
      for (const media of [
        "Application/JSON",
        "aPpLiCaTiOn/JsOn; Charset=UTF-8",
        "application/json; charset=utf-8",
        "",
      ]) {
        const moved = yield* dispatch(
          "approved",
          "POST",
          `/api/session/${session.id}/move`,
          JSON.stringify({ directory: path.join(fixture.path, "foreign-location") }),
          media ? { "content-type": media } : {},
        )
        yield* Effect.promise(() => moved.arrayBuffer())
        expect(moved.status).toBe(409)
        const state = yield* Effect.promise(() =>
          a.handler(
            new Request(`${a.url}/api/session/${session.id}`, {
              headers: { authorization: basic(a.password) },
            }),
          ),
        )
        expect(
          String(
            Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(yield* Effect.promise(() => state.json()))
              .data.location.directory,
          ),
        ).toBe(directory)
        const deniedParent = yield* dispatch(
          "A",
          "POST",
          "/api/session",
          JSON.stringify({ parentID: foreign.id }),
          media ? { "content-type": media } : {},
        )
        expect(deniedParent.status).toBe(409)
        yield* Effect.promise(() => deniedParent.arrayBuffer())
        const foreignAdmission = yield* dispatch(
          "approved",
          "POST",
          `/api/session/${foreign.id}/prompt`,
          JSON.stringify({ text: "FOREIGN-DENIED", resume: false }),
          media ? { "content-type": media } : {},
        )
        expect(foreignAdmission.status).toBe(409)
        yield* Effect.promise(() => foreignAdmission.arrayBuffer())
        const sameWorkspace = yield* dispatch(
          "approved",
          "PATCH",
          `/api/session/${session.id}`,
          JSON.stringify({ title: "A-UPDATED" }),
          media ? { "content-type": media } : {},
        )
        expect(sameWorkspace.status).toBe(204)
        yield* Effect.promise(() => sameWorkspace.arrayBuffer())
      }
      const foreignInbox = yield* Effect.promise(() =>
        a.handler(
          new Request(`${a.url}/api/session/${foreign.id}/inbox`, { headers: { authorization: basic(a.password) } }),
        ),
      )
      expect(yield* Effect.promise(() => foreignInbox.json())).toEqual({ data: [] })
      const foreignSchedule = yield* Effect.promise(() =>
        a.handler(
          new Request("http://backend/api/experimental/schedule", {
            method: "POST",
            headers: { authorization: basic(a.password), "content-type": "application/json" },
            body: JSON.stringify({ sessionID: foreign.id, when: { in: "1 day" }, prompt: "NOT-DUE-DURING-FIXTURE" }),
          }),
        ),
      )
      const scheduleBody = yield* Effect.promise(() => foreignSchedule.json())
      expect({ status: foreignSchedule.status, body: scheduleBody }).toMatchObject({ status: 200 })
      const schedule = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))(
        scheduleBody,
      ).data
      const foreignScheduleMutation = yield* dispatch(
        "approved",
        "POST",
        `/api/experimental/schedule/${schedule.id}/pause`,
      )
      expect(foreignScheduleMutation.status).toBe(409)
      yield* Effect.promise(() => foreignScheduleMutation.arrayBuffer())
      for (const [id, method, route, body, headers] of [
        ["B", "GET", `/api/session/${session.id}`, undefined, {}],
        ["B", "POST", "/api/session", JSON.stringify({ parentID: session.id }), { "content-type": "application/json" }],
        [
          "A",
          "POST",
          "/api/session",
          JSON.stringify({ location: { directory: "/foreign" } }),
          { "content-type": "application/json" },
        ],
        ["A", "GET", "/api/fs/read/marker.txt?location%5Bdirectory%5D=%2Fforeign", undefined, {}],
        ["A", "GET", "/api/fs/read/marker.txt", undefined, { "x-opencode-directory": "%2Fforeign" }],
        ["A", "GET", "/api/fs/read/marker.txt", undefined, { "x-opencode-workspace": "B" }],
        ["A", "GET", "/api/fs/read/marker.txt?location%5BworkspaceID%5D=B", undefined, {}],
        ["A", "GET", `/api/session/${foreign.id}`, undefined, {}],
        ["A", "POST", "/api/session", JSON.stringify({ parentID: foreign.id }), { "content-type": "application/json" }],
        ["A", "POST", "/api/session", JSON.stringify({ id: foreign.id }), { "content-type": "application/json" }],
        [
          "approved",
          "PATCH",
          `/api/session/${foreign.id}`,
          JSON.stringify({ title: "WRONG" }),
          { "content-type": "application/json" },
        ],
        [
          "approved",
          "POST",
          `/api/session/${foreign.id}/prompt`,
          JSON.stringify({ text: "WRONG", resume: false }),
          { "content-type": "application/json" },
        ],
        [
          "approved",
          "POST",
          `/api/session/${session.id}/move`,
          JSON.stringify({ directory: "/foreign" }),
          { "content-type": "application/json" },
        ],
        [
          "approved",
          "POST",
          `/api/session/${session.id}missing/prompt`,
          JSON.stringify({ text: "WRONG", resume: false }),
          { "content-type": "application/json" },
        ],
      ] as const) {
        const response = yield* dispatch(id, method, route, body, headers)
        expect({ route, status: response.status }).toEqual({ route, status: 409 })
        yield* Effect.promise(() => response.arrayBuffer())
      }
      const hostSessions = yield* Effect.promise(() =>
        host(
          new Request(`http://host/api/session?directory=${encodeURIComponent(directory)}`, {
            headers: { authorization: basic("host-only") },
          }),
        ),
      )
      expect(JSON.stringify(yield* Effect.promise(() => hostSessions.json()))).not.toContain("A-ONLY")
      const bSessions = yield* dispatch("B", "GET", "/api/session")
      expect(JSON.stringify(yield* Effect.promise(() => bSessions.json()))).not.toContain("A-ONLY")
      for (const [handler, password] of [
        [host, "host-only"],
        [b.handler, b.password],
      ] as const) {
        const missing = yield* Effect.promise(() =>
          handler(
            new Request(`http://backend/api/session/${session.id}`, {
              headers: { authorization: basic(password) },
            }),
          ),
        )
        expect(missing.status).toBe(404)
        yield* Effect.promise(() => missing.arrayBuffer())
      }
      const cursorChecks: { status: number; disclosedForeign: boolean }[] = []
      for (const order of ["asc", "desc"] as const) {
        const first = yield* dispatch("A", "GET", `/api/session?limit=1&order=${order}&search=A-`)
        expect(first.status).toBe(200)
        const page = Schema.decodeUnknownSync(
          Schema.Struct({ data: Schema.Array(Session.Info), cursor: Schema.Struct({ next: Session.ListCursor }) }),
        )(yield* Effect.promise(() => first.json()))
        const next = yield* dispatch(
          "A",
          "GET",
          `/api/session?limit=1&cursor=${encodeURIComponent(page.cursor.next)}&search=NOT-THE-EFFECTIVE-FILTER`,
        )
        expect(next.status).toBe(200)
        const nextPage = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Session.Info) }))(
          yield* Effect.promise(() => next.json()),
        )
        expect(nextPage.data).toHaveLength(1)
        expect(nextPage.data[0]!.id).not.toBe(page.data[0]!.id)
        expect(nextPage.data.every((item) => item.location.directory === directory && item.title?.includes("A-"))).toBe(
          true,
        )
      }
      for (const scope of [{}, { directory: foreign.location.directory }, { project: session.projectID }]) {
        const cursor = Session.ListCursor.make({
          ...scope,
          order: "asc",
          anchor: { id: session.id, time: 0, direction: "next" },
        })
        const listed = yield* dispatch("A", "GET", `/api/session?cursor=${encodeURIComponent(cursor)}`)
        cursorChecks.push({
          status: listed.status,
          disclosedForeign: (yield* Effect.promise(() => listed.text())).includes(foreign.id),
        })
      }
      const invalidCursor = yield* dispatch("A", "GET", "/api/session?cursor=not-a-native-cursor")
      expect(invalidCursor.status).toBe(400)
      yield* Effect.promise(() => invalidCursor.arrayBuffer())
      const treeCreated = yield* dispatch("A", "POST", "/api/session", JSON.stringify({ title: "TREE-ROOT" }), {
        "content-type": "application/json",
      })
      const tree = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
        yield* Effect.promise(() => treeCreated.json()),
      ).data
      const childCreated = yield* dispatch(
        "A",
        "POST",
        "/api/session",
        JSON.stringify({ parentID: tree.id, title: "TREE-CHILD" }),
        { "content-type": "application/json" },
      )
      const treeChild = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
        yield* Effect.promise(() => childCreated.json()),
      ).data
      const grandchildCreated = yield* dispatch(
        "A",
        "POST",
        "/api/session",
        JSON.stringify({ parentID: treeChild.id, title: "TREE-FOREIGN" }),
        { "content-type": "application/json" },
      )
      const grandchild = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
        yield* Effect.promise(() => grandchildCreated.json()),
      ).data
      const movedChild = yield* Effect.promise(() =>
        a.handler(
          new Request(`${a.url}/api/session/${grandchild.id}/move`, {
            method: "POST",
            headers: { authorization: basic(a.password), "content-type": "application/json" },
            body: JSON.stringify({ directory: foreign.location.directory }),
          }),
        ),
      )
      expect(movedChild.status).toBe(204)
      yield* Effect.promise(() => movedChild.arrayBuffer())
      for (const index of Array.from({ length: 51 }, (_, index) => index)) {
        const sibling = yield* Effect.promise(() =>
          a.handler(
            new Request(`${a.url}/api/session`, {
              method: "POST",
              headers: { authorization: basic(a.password), "content-type": "application/json" },
              body: JSON.stringify({ parentID: treeChild.id, title: `TREE-OWNED-${index}` }),
            }),
          ),
        )
        expect(sibling.status).toBe(200)
        yield* Effect.promise(() => sibling.arrayBuffer())
      }
      const nativeChildren = yield* Effect.promise(() =>
        a.handler(
          new Request(`${a.url}/api/session?parentID=${treeChild.id}&limit=50`, {
            headers: { authorization: basic(a.password) },
          }),
        ),
      )
      const nativePage = Schema.decodeUnknownSync(
        Schema.Struct({ data: Schema.Array(Session.Info), cursor: Schema.Struct({ next: Session.ListCursor }) }),
      )(yield* Effect.promise(() => nativeChildren.json()))
      expect(nativePage.data).toHaveLength(50)
      expect(nativePage.data.some((item) => item.id === grandchild.id)).toBe(false)
      const nativeNext = yield* Effect.promise(() =>
        a.handler(
          new Request(`${a.url}/api/session?cursor=${encodeURIComponent(nativePage.cursor.next)}`, {
            headers: { authorization: basic(a.password) },
          }),
        ),
      )
      expect((yield* Effect.promise(() => nativeNext.text())).includes(grandchild.id)).toBe(true)
      const nestedBeforeDelete = yield* dispatch("A", "GET", `/api/session?parentID=${treeChild.id}`)
      expect(nestedBeforeDelete.status).toBe(200)
      expect((yield* Effect.promise(() => nestedBeforeDelete.text())).includes(grandchild.id)).toBe(false)
      const deniedTreeDelete = yield* dispatch("approved", "DELETE", `/api/session/${tree.id}`)
      const treeDeleteBody = yield* Effect.promise(() => deniedTreeDelete.text())
      expect(deniedTreeDelete.status, treeDeleteBody).toBe(409)
      const treeState: number[] = []
      for (const id of [tree.id, treeChild.id, grandchild.id]) {
        const state = yield* Effect.promise(() =>
          a.handler(new Request(`${a.url}/api/session/${id}`, { headers: { authorization: basic(a.password) } })),
        )
        treeState.push(state.status)
        yield* Effect.promise(() => state.arrayBuffer())
      }
      expect({ cursorChecks, deleteStatus: deniedTreeDelete.status, treeState }).toEqual({
        cursorChecks: [
          { status: 409, disclosedForeign: false },
          { status: 409, disclosedForeign: false },
          { status: 409, disclosedForeign: false },
        ],
        deleteStatus: 409,
        treeState: [200, 200, 200],
      })
      const removed = yield* dispatch("approved", "DELETE", `/api/session/${session.id}`)
      expect(removed.status).toBe(204)
      yield* Effect.promise(() => removed.arrayBuffer())
      const nativeRemoved = yield* Effect.promise(() =>
        a.handler(
          new Request(`http://backend/api/session/${session.id}`, {
            headers: { authorization: basic(a.password) },
          }),
        ),
      )
      expect(nativeRemoved.status).toBe(404)
      yield* Effect.promise(() => nativeRemoved.arrayBuffer())
      for (const id of [ownedChild.id, ownedGrandchild.id]) {
        const absent = yield* Effect.promise(() =>
          a.handler(new Request(`${a.url}/api/session/${id}`, { headers: { authorization: basic(a.password) } })),
        )
        expect(absent.status).toBe(404)
        yield* Effect.promise(() => absent.arrayBuffer())
      }
      for (const [method, route] of [
        ["POST", "/api/experimental/workspace/B/dispatch"],
        ["GET", "/api/pty/pty_example/connect"],
        ["OPTIONS", "/api/session"],
        ["GET", "/api/not-declared"],
        ["HEAD", "/api/session"],
      ] as const) {
        const denied = yield* dispatch("approved", method, route)
        expect({ method, route, status: denied.status }).toEqual({ method, route, status: 403 })
        yield* Effect.promise(() => denied.arrayBuffer())
      }

      const cliRead = yield* cli(["fs", "read", "marker.txt", "--workspace", "A", "--raw"])
      expect(cliRead).toEqual({ stdout: "A", stderr: "", code: 0 })
      const cliWrite = yield* cli([
        "request",
        "POST",
        "/api/experimental/fs/write?path=cli-selected.txt",
        "--workspace",
        "B",
        "--body",
        "CLI-B",
        "--header",
        "content-type:application/octet-stream",
        "--compact",
      ])
      expect(cliWrite.code).toBe(0)
      expect(cliWrite.stderr).toBe("")
      expect(yield* Effect.promise(() => Bun.file(path.join(b.root, "cli-selected.txt")).text())).toBe("CLI-B")
      expect(yield* Effect.promise(() => Bun.file(path.join(a.root, "cli-selected.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, "cli-selected.txt")).exists())).toBe(false)
      const cliCreated = yield* cli(["session", "create", "--workspace", "B", "--title", "B-CLI", "--compact"])
      expect(cliCreated.code).toBe(0)
      expect(cliCreated.stderr).toBe("")
      const cliSession = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(
        JSON.parse(cliCreated.stdout),
      ).data
      const cliFollowup = yield* cli([
        "request",
        "session.update",
        cliSession.id,
        "--workspace",
        "approved-B",
        "--body",
        JSON.stringify({ title: "B-CLI-UPDATED" }),
        "--compact",
      ])
      expect(cliFollowup.stderr).toBe("")
      expect(cliFollowup.code).toBe(0)
      const cliUpdated = yield* dispatch("B", "GET", `/api/session/${cliSession.id}`)
      expect(JSON.stringify(yield* Effect.promise(() => cliUpdated.json()))).toContain("B-CLI-UPDATED")
      const cliForeign = yield* cli(["session", "get", cliSession.id, "--workspace", "A"])
      expect(cliForeign.code).not.toBe(0)
      expect(cliForeign.stderr).toContain("HTTP 409")
      const hostMissing = yield* Effect.promise(() =>
        host(
          new Request(`http://host/api/session/${cliSession.id}`, { headers: { authorization: basic("host-only") } }),
        ),
      )
      expect(hostMissing.status).toBe(404)
      yield* Effect.promise(() => hostMissing.arrayBuffer())

      for (const [id, route, headers, status] of [
        ["unknown", "/api/fs/read/marker.txt", {}, 403],
        ["denied", "/api/fs/read/marker.txt", {}, 403],
        ["A", "/api/provider", {}, 403],
        ["A", "/api/session/abc/prompt", {}, 403],
        ["A", "/api/fs/read/marker.txt", { authorization: basic("caller-injected") }, 400],
        ["A", "http://untrusted.invalid/api/fs/read/marker.txt", {}, 400],
        ["A", "/api/fs/read/marker.txt", { "x-invalid": "bad\r\nheader" }, 400],
        ["bad-auth", "/api/fs/read/marker.txt", {}, 401],
        ["bad-auth", `/api/session/${cliSession.id}`, {}, 401],
      ] as const) {
        const response = yield* dispatch(id, "GET", route, undefined, headers)
        expect({ id, route, status: response.status }).toEqual({ id, route, status })
        const text = yield* Effect.promise(() => response.text())
        expect(text).not.toContain("backend-A")
        expect(text).not.toContain("backend-B")
        expect(text).not.toContain(a.url)
      }
      const wrongHostAuth = yield* dispatch(
        "A",
        "GET",
        "/api/fs/read/marker.txt",
        undefined,
        {},
        undefined,
        "backend-A",
      )
      expect(wrongHostAuth.status).toBe(401)
      yield* Effect.promise(() => wrongHostAuth.arrayBuffer())
      const noAuthority = yield* ServerFetch.make({ ...options, password: "host-only" })
      const defaultDenied = yield* Effect.promise(() =>
        noAuthority(
          new Request("http://host/api/experimental/workspace/A/dispatch", {
            method: "POST",
            headers: { authorization: basic("host-only"), "content-type": "application/json" },
            body: JSON.stringify({ method: "GET", path: "/api/fs/read/marker.txt", headers: {} }),
          }),
        ),
      )
      expect(defaultDenied.status).toBe(403)
      yield* Effect.promise(() => defaultDenied.arrayBuffer())

      const controller = new AbortController()
      const streamed = yield* dispatch("A", "GET", "/api/fs/read/large.bin", undefined, {}, controller.signal)
      expect(streamed.status).toBe(200)
      const reader = streamed.body!.getReader()
      expect((yield* Effect.promise(() => reader.read())).done).toBe(false)
      controller.abort()
      yield* Effect.promise(() => reader.cancel().catch(() => undefined))
      yield* Effect.sync(() => completed.includes("A:large.bin")).pipe(
        Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("10 millis") }),
        Effect.timeout("3 seconds"),
      )
      yield* Effect.promise(() => b.server.stop(true))
      const unavailable = yield* dispatch("B", "GET", "/api/fs/read/marker.txt")
      expect(unavailable.status).toBe(503)
      expect(yield* Effect.promise(() => unavailable.text())).not.toContain("backend-B")
    }),
  // Three real native HTTP graphs and six owned CLI subprocesses also run on Windows CI.
  { timeout: 30_000 },
)
