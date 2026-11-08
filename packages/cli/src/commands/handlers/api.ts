import { Effect, Option, Redacted } from "effect"
import { Commands, Server } from "../commands"
import { Runtime } from "../../framework/runtime"
import { catalog, type ApiInput } from "../../api/commands"
import { interpolate, passwordValue, prepare, safeServer } from "../../api/request"
import { Env } from "../../env"

export default Runtime.handler(
  Commands.commands.api,
  Effect.fn("cli.api")(function* (input: ApiInput) {
    const tool = input.request.tool
    if (tool === "completion") {
      const { zshWrapper } = yield* Effect.promise(() => import("../../api/completion"))
      process.stdout.write(zshWrapper())
      return
    }
    if (tool === "complete") {
      const { complete } = yield* Effect.promise(() => import("../../api/completion"))
      const server = yield* Effect.serviceOption(Server).pipe(Effect.map(Option.flatten))
      const password = yield* Env.password
      const result = yield* Effect.promise(() =>
        complete(input.request.args, {
          server: Option.getOrUndefined(server),
          password: Option.getOrUndefined(passwordValue(input)) ?? (password && Redacted.value(password)),
          directory: input.values.directory?.length ? String(input.values.directory[0]) : undefined,
          workspace: Option.getOrUndefined(input.workspace),
        }),
      )
      if (result.length) process.stdout.write(result.join("\n") + "\n")
      return
    }
    const operation = catalog.operations.find(
      (operation) =>
        operation.operationId === input.request.operation ||
        (!input.request.operation && input.request.args[0] === operation.operationId),
    )
    if (tool === "catalog" || input.schema) {
      if (input.schema && !operation) return yield* Effect.fail(new Error("Select an operation before --schema"))
      yield* Effect.tryPromise(() =>
        writeDocument(input.schema ? { operation, components: catalog.components } : catalog, input),
      )
      return
    }
    if (tool === "spec" && !input.remote) {
      const { default: spec } = yield* Effect.promise(() => import("../../../../protocol/openapi.json"))
      yield* Effect.tryPromise(() => writeDocument(spec, input))
      return
    }
    if (tool === "group") return yield* Effect.fail(new Error("Select an API subcommand; use --help to list commands"))
    if (input.remote && tool !== "spec") return yield* Effect.fail(new Error("--remote is only valid for api spec"))
    const liveID =
      !tool && !operation && input.request.args.length === 1 && /^[a-zA-Z][\w.-]*$/.test(input.request.args[0])
        ? input.request.args[0]
        : undefined
    const prepared = yield* Effect.tryPromise(() =>
      prepare(
        tool === "spec" || liveID
          ? { ...input, request: { ...input.request, args: [liveID ? "POST" : "GET", "/openapi.json"] } }
          : operation && !input.request.operation
            ? { ...input, request: { ...input.request, args: input.request.args.slice(1) } }
            : input,
        catalog,
        operation,
      ),
    )
    const serverFlag = yield* Effect.serviceOption(Server).pipe(Effect.map(Option.flatten))
    const explicit = Option.getOrUndefined(serverFlag)
    if (explicit !== undefined) yield* Effect.try(() => safeServer(explicit))
    const password = input.passwordStdin
      ? yield* Effect.tryPromise(async () => {
          if (process.stdin.isTTY) throw new Error("--password-stdin requires piped input (no terminal echo)")
          return (await Bun.stdin.text()).replace(/\r?\n$/, "")
        })
      : Option.getOrUndefined(passwordValue(input))
    const { ServerConnection } = yield* Effect.promise(() => import("../../services/server-connection"))
    const server = yield* ServerConnection.resolve({ mismatch: "ignore", password, probe: false })
    const { execute, readSpec } = yield* Effect.promise(() => import("../../api/transport"))
    const request = liveID
      ? yield* Effect.tryPromise(async (signal) => {
          const document = await readSpec(server.endpoint, input.timeout, signal)
          const { buildCatalog, operationEntries } = await import("../../api/catalog")
          const entries = Object.entries(document.paths).flatMap(([path, methods]) =>
            operationEntries(methods)
              .filter(
                ([, value]) =>
                  value && typeof value === "object" && "operationId" in value && value.operationId === liveID,
              )
              .map(([method, value]) => ({ path, method, value })),
          )
          if (entries.length !== 1) throw new Error(`Operation not found or ambiguous: ${liveID}`)
          const found = entries[0]
          const remote = buildCatalog({
            components: document.components,
            paths: {
              [found.path]: {
                ...(document.paths[found.path].parameters ? { parameters: document.paths[found.path].parameters } : {}),
                [found.method]: found.value,
              },
            },
          })
          return prepare({ ...input, request: { ...input.request, args: [] } }, remote, remote.operations[0])
        })
      : prepared
    yield* Effect.tryPromise({
      try: (signal) =>
        execute(server.endpoint, request, {
          compact: input.compact,
          raw: input.raw,
          output: Option.getOrUndefined(input.output),
          timeout: input.timeout,
          signal,
        }),
      catch: (cause) =>
        new Error(
          cause instanceof Error ? cause.message.replaceAll(password || "\0", "[redacted]") : "API request failed",
        ),
    })
  }),
)

async function writeDocument(value: unknown, input: ApiInput) {
  const text = JSON.stringify(value, null, input.compact ? undefined : 2) + "\n"
  if (Option.isSome(input.output)) {
    await Bun.write(input.output.value, text)
    return
  }
  process.stdout.write(text)
}

export function resolveOperation(
  spec: { paths?: Record<string, Record<string, { operationId?: string }>> },
  operationID: string,
  params: Record<string, string>,
) {
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (
        !["get", "post", "put", "patch", "delete", "head", "options"].includes(method) ||
        operation.operationId !== operationID
      )
        continue
      return { method: method.toUpperCase(), path: interpolate(path, params) }
    }
  }
  throw new Error(`Operation not found: ${operationID}`)
}

export function rawRequest(input: readonly string[]) {
  if (
    input.length !== 2 ||
    !["get", "post", "put", "patch", "delete", "head", "options"].includes(input[0].toLowerCase()) ||
    !input[1].startsWith("/")
  )
    return
  return { method: input[0].toUpperCase(), path: input[1] }
}
