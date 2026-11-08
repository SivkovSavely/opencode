import { ConflictError, ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { WorkspaceDispatchInput } from "@opencode/protocol/groups/workspace"
import { Session } from "@opencode/schema/session"
import { Context, Effect, Option, Schema } from "effect"
import { FindMyWay, HttpRouter, HttpServerResponse } from "effect/http"
import { HttpApi, OpenApi } from "effect/http-api"
import { Api } from "./api"
import type { ServerOptions } from "./options"
import { ServerAuth } from "./auth"

export const WorkspaceTargets = Context.Reference<ServerOptions["experimental"]>("@opencode/WorkspaceTargets", {
  defaultValue: () => undefined,
})

export const makeWorkspaceDispatch = Effect.gen(function* () {
  const config = yield* WorkspaceTargets
  const auth = yield* ServerAuth.Config
  const router = FindMyWay.make<{ id: string; path: string; supported: boolean; sessionOwned: boolean }>(
    yield* HttpRouter.RouterConfig,
  )
  const document = OpenApi.fromApi(Api)
  const declarations = new Map(
    Object.values(document.paths).flatMap((item) =>
      [...Object.values(item), ...Object.values(item["x-oai-additionalOperations"] ?? {})]
        .filter(
          (operation): operation is OpenApi.OpenAPISpecOperation =>
            operation !== undefined && "operationId" in operation,
        )
        .map((operation) => [operation.operationId, operation] as const),
    ),
  )
  HttpApi.reflect(Api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, mergedAnnotations }) => {
      const id = Context.getOrElse(mergedAnnotations, OpenApi.Identifier, () => endpoint.identifier)
      const declaration = declarations.get(id)
      router.on(endpoint.method, endpoint.path as FindMyWay.PathInput, {
        id,
        path: endpoint.path,
        sessionOwned: Object.values(declaration?.responses ?? {}).some(
          (response) =>
            "sessionID" in
            (schemaProperties(
              schemaProperties(response.content?.["application/json"]?.schema, document)?.data,
              document,
            ) ?? {}),
        ),
        supported:
          id !== "experimental.workspace.dispatch" &&
          declaration !== undefined &&
          !("x-websocket" in declaration && declaration["x-websocket"]),
      })
    },
  })
  const targets = new Map(
    (config?.workspaceTargets ?? []).map((target) => {
      const url = new URL(target.url)
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !target.password ||
        !target.directory
      )
        throw new Error("Invalid host workspace target registration")
      return [target.id, { ...target, url }] as const
    }),
  )
  if (targets.size !== (config?.workspaceTargets?.length ?? 0)) throw new Error("Duplicate host workspace target")
  return (id: string, input: typeof WorkspaceDispatchInput.Type) =>
    Effect.gen(function* () {
      const target = targets.get(id)
      if (!target || !ServerAuth.required(auth))
        return yield* new ForbiddenError({ message: "Workspace target is unknown or denied" })
      if (
        !input.path.startsWith("/") ||
        input.path.startsWith("//") ||
        /[\\\x00-\x1f\x7f#]/.test(input.path) ||
        input.path
          .split("?")[0]
          .split("/")
          .some((part) => /^(?:\.|%2e){1,2}$/i.test(part))
      )
        return yield* new InvalidRequestError({
          message: "Expected a native API path without authority or dot segments",
        })
      const url = new URL(input.path, target.url)
      if (url.origin !== target.url.origin)
        return yield* new InvalidRequestError({ message: "Workspace path must retain the registered backend origin" })
      // Native FindMyWay also treats a literal semicolon as a query delimiter; WHATWG URL does not.
      if (url.pathname.includes(";"))
        return yield* new InvalidRequestError({ message: "Workspace pathname cannot contain a literal semicolon" })
      const route = yield* Effect.try({
        try: () => router.find(input.method, url.pathname + url.search),
        catch: () => new InvalidRequestError({ message: "Invalid native workspace route" }),
      })
      if (!route?.handler.supported || !target.operations.includes(route.handler.id))
        return yield* new ForbiddenError({
          message: "Workspace dispatch operation is unsupported or denied by the host",
        })
      const operation = route.handler.id
      const headers = yield* Effect.try({
        try: () => new Headers(input.headers),
        catch: () => new InvalidRequestError({ message: "Invalid workspace request headers" }),
      })
      if (
        [...headers.keys()].some((name) =>
          [
            "authorization",
            "cookie",
            "host",
            "connection",
            "transfer-encoding",
            "content-length",
            "upgrade",
            "proxy-authorization",
          ].includes(name),
        )
      )
        return yield* new InvalidRequestError({
          message: "Workspace request cannot supply credentials or transport headers",
        })
      const conflict = () =>
        new ConflictError({ message: "Workspace request conflicts with the registered backend location" })
      const directory = headers.get("x-opencode-directory")
      if (directory !== null && directory !== encodeURIComponent(target.directory)) return yield* conflict()
      if ([...headers.keys()].some((key) => key.startsWith("x-opencode-") && /workspace/i.test(key)))
        return yield* conflict()
      for (const key of ["directory", "location[directory]"]) {
        if (url.searchParams.getAll(key).some((value) => value !== target.directory)) return yield* conflict()
      }
      if ([...url.searchParams.keys()].some((key) => /workspace|workspaceID/i.test(key))) return yield* conflict()
      headers.set("authorization", `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`)
      headers.set("x-opencode-directory", encodeURIComponent(target.directory))
      const controller = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      const send = (url: URL, method = "GET", body?: Uint8Array, lookup = false) =>
        Effect.tryPromise({
          try: () =>
            fetch(url, {
              method,
              headers: lookup
                ? {
                    authorization: headers.get("authorization")!,
                    "x-opencode-directory": encodeURIComponent(target.directory),
                  }
                : headers,
              body: body === undefined ? undefined : new Uint8Array(body),
              redirect: "manual",
              signal: controller.signal,
            }),
          catch: () => new ServiceUnavailableError({ message: "Workspace backend is unavailable" }),
        })
      const readResource = Effect.fnUntraced(function* (url: URL) {
        const response = yield* send(url, "GET", undefined, true)
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) return yield* Effect.fail(response)
          yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
          if (response.status !== 404)
            return yield* new ServiceUnavailableError({ message: "Workspace backend resource lookup failed" })
          return yield* new ConflictError({ message: "Session does not belong to the selected workspace backend" })
        }
        return response
      })
      const requireSession = (id: string) =>
        Effect.gen(function* () {
          const response = yield* readResource(new URL(`/api/session/${encodeURIComponent(id)}`, target.url))
          const decoded = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: () => new ServiceUnavailableError({ message: "Invalid workspace backend response" }),
          })
          const session = Schema.decodeUnknownOption(Schema.Struct({ data: Session.Info }))(decoded)
          if (Option.isNone(session))
            return yield* new ServiceUnavailableError({ message: "Invalid workspace backend session" })
          if (session.value.data.location.directory !== target.directory || session.value.data.location.workspaceID)
            return yield* conflict()
        })
      if (operation === "session.list") {
        const cursors = url.searchParams.getAll("cursor")
        for (const cursor of cursors) {
          // Native Session.list replaces query filters with the decoded cursor, rather than merging them.
          const filter = yield* Session.ListCursor.parse(cursor).pipe(
            Effect.mapError(() => new InvalidRequestError({ message: "Invalid workspace session cursor" })),
          )
          if (!("directory" in filter) || filter.directory !== target.directory) return yield* conflict()
          if (filter.parentID) yield* requireSession(filter.parentID)
        }
        if (!cursors.length)
          for (const parentID of url.searchParams.getAll("parentID"))
            if (parentID !== "null") yield* requireSession(parentID)
      }
      const bytes = input.body === undefined ? undefined : Buffer.from(input.body, "base64")
      if (input.body !== undefined && bytes?.toString("base64") !== input.body)
        return yield* new InvalidRequestError({ message: "Workspace body must be canonical base64" })
      const createsSession = operation === "session.create" || operation === "experimental.session.import"
      // Match native HttpApi payload selection: JSON by default, case-insensitive, ignoring media parameters.
      const media = (headers.get("content-type") ?? "application/json").toLowerCase().split(";", 1)[0].trim()
      if (createsSession && media !== "application/json")
        return yield* new InvalidRequestError({ message: "Session creation requires application/json" })
      const record = Schema.Record(Schema.String, Schema.Unknown)
      const payload =
        media === "application/json" && (bytes || createsSession)
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(bytes?.toString() ?? "{}").pipe(
              Effect.map((json) => Option.getOrUndefined(Schema.decodeUnknownOption(record)(json))),
              Effect.mapError(() => new InvalidRequestError({ message: "Invalid workspace JSON body" })),
            )
          : undefined
      const info =
        operation === "experimental.session.import" && payload
          ? Option.getOrUndefined(Schema.decodeUnknownOption(record)(payload.info))
          : undefined
      // Only placement fields are interpreted here; native handlers still own payload validation and execution.
      for (const context of [payload, info]) {
        if (!context) continue
        if (context.workspaceID !== undefined || context.workspace !== undefined) return yield* conflict()
        if (context.directory !== undefined && context.directory !== target.directory) return yield* conflict()
        if (context.location !== undefined) {
          const location = Schema.decodeUnknownOption(record)(context.location)
          if (
            Option.isNone(location) ||
            location.value.directory !== target.directory ||
            Object.keys(location.value).some((key) => key !== "directory")
          )
            return yield* conflict()
        }
        for (const key of ["parentID", "sessionID"]) {
          if (context[key] === undefined) continue
          if (typeof context[key] !== "string")
            return yield* new InvalidRequestError({ message: "Invalid workspace session reference" })
          yield* requireSession(context[key])
        }
      }
      if (route.params.sessionID) yield* requireSession(route.params.sessionID)
      if (operation === "session.remove" && route.params.sessionID) {
        // Native removal follows parent links across locations. Validate every child page before any deletion.
        const parents = new Set([route.params.sessionID])
        for (const parentID of parents) {
          let cursor: Session.ListCursor | undefined
          do {
            const children = new URL("/api/session", target.url)
            children.searchParams.set("parentID", parentID)
            if (cursor) children.searchParams.set("cursor", cursor)
            const response = yield* readResource(children)
            const decoded = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: () => new ServiceUnavailableError({ message: "Invalid workspace backend child list" }),
            })
            const page = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                data: Schema.Array(Session.Info),
                cursor: Schema.Struct({ next: Schema.optional(Schema.NullOr(Session.ListCursor)) }),
              }),
            )(decoded).pipe(
              Effect.mapError(() => new ServiceUnavailableError({ message: "Invalid workspace backend child list" })),
            )
            for (const child of page.data) {
              if (child.location.directory !== target.directory || child.location.workspaceID) return yield* conflict()
              parents.add(child.id)
            }
            cursor = page.data.length ? (page.cursor.next ?? undefined) : undefined
          } while (cursor)
        }
      }
      for (const sessionID of url.searchParams.getAll("sessionID")) yield* requireSession(sessionID)
      // Session-owned resources such as schedules expose their owner on the declared native GET.
      // Location-scoped resources remain scoped by the native backend's location middleware.
      if (!route.params.sessionID) {
        for (const [key, value] of Object.entries(route.params)) {
          if (!key.endsWith("ID") || !value) continue
          const segments = url.pathname.split("/").filter(Boolean)
          const index = route.handler.path
            .split("/")
            .filter(Boolean)
            .indexOf(":" + key)
          if (index < 0) continue
          const resource = new URL("/" + segments.slice(0, index + 1).join("/"), target.url)
          const read = router.find("GET", resource.pathname)
          if (!read?.handler.supported || !read.handler.sessionOwned) continue
          resource.searchParams.set("location[directory]", target.directory)
          const response = yield* readResource(resource)
          const owner = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: () => new ServiceUnavailableError({ message: "Invalid workspace backend resource" }),
          })
          const session = Schema.decodeUnknownOption(
            Schema.Struct({ data: Schema.Struct({ sessionID: Schema.String }) }),
          )(owner)
          if (Option.isNone(session))
            return yield* new ServiceUnavailableError({ message: "Invalid workspace resource owner" })
          yield* requireSession(session.value.data.sessionID)
        }
      }
      const adoptedID = operation === "session.create" ? payload?.id : info?.id
      if (createsSession && adoptedID !== undefined) {
        if (typeof adoptedID !== "string") return yield* new InvalidRequestError({ message: "Invalid session ID" })
        const existing = yield* send(
          new URL(`/api/session/${encodeURIComponent(adoptedID)}`, target.url),
          "GET",
          undefined,
          true,
        )
        if (existing.status === 401 || existing.status === 403) return yield* Effect.fail(existing)
        yield* Effect.promise(() => existing.body?.cancel() ?? Promise.resolve())
        if (existing.ok) yield* requireSession(adoptedID)
        if (!existing.ok && existing.status !== 404)
          return yield* new ServiceUnavailableError({ message: "Workspace backend session lookup failed" })
      }
      const body =
        createsSession && payload
          ? Buffer.from(JSON.stringify({ ...payload, location: { directory: target.directory } }))
          : bytes
      // Query placement is declared by Protocol; header placement also covers native raw handlers.
      for (const parameter of declarations.get(operation)?.parameters ?? []) {
        if (parameter.in !== "query") continue
        if (["directory", "location[directory]"].includes(parameter.name))
          url.searchParams.set(parameter.name, target.directory)
        if (parameter.name === "location") url.searchParams.set("location[directory]", target.directory)
      }
      const response = yield* send(url, input.method, body)
      return backendResponse(response)
    }).pipe(
      Effect.catch((error) =>
        error instanceof Response ? Effect.succeed(backendResponse(error)) : Effect.fail(error),
      ),
    )
})

function backendResponse(response: Response) {
  const outgoing = new Headers(response.headers)
  // Backend cookies/redirects cannot establish authority on the host or expose another destination.
  outgoing.delete("set-cookie")
  outgoing.delete("location")
  outgoing.delete("content-encoding")
  outgoing.delete("content-length")
  return HttpServerResponse.fromWeb(
    new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing }),
  )
}

function schemaProperties(
  schema: object | undefined,
  document: OpenApi.OpenAPISpec,
): Record<string, object> | undefined {
  const value = schema as { $ref?: string; properties?: Record<string, object> } | undefined
  if (value?.$ref?.startsWith("#/components/schemas/"))
    return schemaProperties(document.components.schemas[value.$ref.slice("#/components/schemas/".length)], document)
  return value?.properties
}
