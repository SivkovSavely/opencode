import { Argument, Flag, Param, Primitive, type GlobalFlag } from "effect/cli"
import { Effect } from "effect"
import { Spec } from "../framework/spec"
import data from "./catalog.generated.json"
import type { Catalog, Operation } from "./types"
import { choices, inputOptions, scalar, variants } from "./schema"

export const catalog = data as unknown as Catalog

function remotePath(name: string, pathType: Primitive.PathType = "either") {
  // Keep native path completion metadata, but interpret paths only on the backend.
  return Param.makeSingle({
    name,
    kind: Param.flagKind,
    primitiveType: { ...Primitive.Path(pathType), parse: Primitive.String.parse },
  })
}

function params(operation?: Operation, tool = "") {
  return {
    request: Argument.String("path parameters / operation | method path").pipe(
      Argument.withDescription(
        operation?.parameters
          .filter((param) => param.in === "path")
          .map((param) => `${param.name} (required)`)
          .join(", ") || "Operation ID or HTTP method and path",
      ),
      Argument.variadic({ min: 0 }),
      Argument.map((args) => ({ args, operation: operation?.operationId, tool })),
    ),
    values: {
      directory: remotePath("directory", "directory").pipe(
        Flag.withDescription("Native declared location directory (query or JSON body)"),
        Flag.atMost(1),
      ),
      ...Object.fromEntries(
        (operation ? inputOptions(operation, catalog) : []).map((option) => {
          const shape = scalar(option.schema, catalog)
          const allowed = choices(shape?.items ?? option.schema, catalog)
          const enumsOnly = variants(shape?.items ?? option.schema, catalog).every(
            (branch) => branch.type === "null" || branch.enum || "const" in branch,
          )
          const flag: Flag.Flag<unknown> =
            shape?.type === "boolean"
              ? Flag.Boolean(option.flag)
              : allowed.length && enumsOnly
                ? Flag.Literals(option.flag, allowed)
                : shape?.type === "integer"
                  ? Flag.Int(option.flag)
                  : shape?.type === "number"
                    ? Flag.Finite(option.flag)
                    : /(?:directory|path|file)$/.test(option.flag)
                      ? remotePath(option.flag)
                      : Flag.String(option.flag)
          return [
            option.flag,
            flag.pipe(
              Flag.withDescription(
                `${option.scope} ${option.name}${option.required ? " (required)" : ""}${allowed.length ? `; choices: ${allowed.join(", ")}` : ""}. ${option.description ?? ""}`,
              ),
              Flag.atMost(100),
            ),
          ]
        }),
      ),
    },
    body: Flag.String("body").pipe(
      Flag.withAlias("data"),
      Flag.withAlias("d"),
      Flag.withDescription("JSON request body (or text/binary for declared media)"),
      Flag.optional,
    ),
    bodyFile: Param.makeSingle({
      name: "body-file",
      kind: Param.flagKind,
      primitiveType: {
        ...Primitive.Path("either"),
        parse: (value) => (value === "-" ? Effect.succeed(value) : Primitive.Path("either").parse(value)),
      },
    }).pipe(Flag.withDescription("Read request body from a file, or - for stdin"), Flag.optional),
    header: Flag.String("header").pipe(
      Flag.withAlias("H"),
      Flag.withDescription("Custom name:value header; repeatable"),
      Flag.atMost(100),
    ),
    param: Flag.KeyValuePair("param").pipe(
      Flag.withDescription("Raw/operation-ID path or query parameters"),
      Flag.optional,
    ),
    password: Flag.Redacted("password").pipe(
      Flag.withDescription("Server Basic password (prefer --password-stdin)"),
      Flag.optional,
    ),
    passwordStdin: Flag.Boolean("password-stdin").pipe(
      Flag.withDescription("Read the server password from stdin without echo"),
      Flag.withDefault(false),
    ),
    username: Flag.Literals("username", ["opencode"]).pipe(
      Flag.withDescription("Native Basic username is fixed to opencode"),
      Flag.optional,
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("Request deadline in milliseconds (default 30000; includes streaming)"),
      Flag.withDefault(30000),
    ),
    workspace: Flag.String("workspace").pipe(
      Flag.withDescription(
        "Use the experimental host-authorized workspace dispatch adapter (requires host registration)",
      ),
      Flag.optional,
    ),
    compact: Flag.Boolean("compact").pipe(Flag.withDescription("Compact JSON output"), Flag.withDefault(false)),
    raw: Flag.Boolean("raw").pipe(
      Flag.withDescription("Unmodified response bytes, including SSE frames"),
      Flag.withDefault(false),
    ),
    output: Flag.Path("output").pipe(Flag.withDescription("Write response to this file"), Flag.optional),
    schema: Flag.Boolean("schema").pipe(
      Flag.withDescription("Print this operation and its schema definitions offline"),
      Flag.withDefault(false),
    ),
    remote: Flag.Boolean("remote").pipe(
      Flag.withDescription("For spec only: explicitly retrieve server OpenAPI"),
      Flag.withDefault(false),
    ),
  }
}

export type ApiInput = {
  [K in keyof ReturnType<typeof params>]: ReturnType<typeof params>[K] extends
    | Flag.Flag<infer A>
    | Argument.Argument<infer A>
    ? A
    : K extends "values"
      ? Record<string, readonly unknown[]>
      : never
}

export function apiCommands(globalFlags: readonly GlobalFlag.GlobalFlag<unknown>[]) {
  function tree(prefix: string[]): Spec.Any[] {
    return [
      ...new Set(
        catalog.operations
          .filter((operation) => prefix.every((part, index) => operation.command[index] === part))
          .map((operation) => operation.command[prefix.length])
          .filter((part) => part !== undefined),
      ),
    ]
      .sort()
      .map((name) => {
        const command = [...prefix, name]
        const operation = catalog.operations.find((operation) => operation.command.join(" ") === command.join(" "))
        const body = operation?.requestBody && JSON.stringify(operation.requestBody.content)
        return Spec.make(name, {
          description: operation
            ? `${operation.summary ?? operation.operationId}\n${operation.method} ${operation.path} (${operation.transport})\n${operation.description ?? ""}${operation.unsupported ? `\nUnsupported: ${operation.unsupported}` : ""}${body ? `\nBody schema: ${body}` : ""}\nExample: opencode api ${command.join(" ")}${operation.parameters
                .filter((param) => param.in === "path")
                .map((param) => ` <${param.name}>`)
                .join("")}${inputOptions(operation, catalog)
                .filter((option) => option.required && option.scope !== "body")
                .map((option) => ` --${option.flag} <value>`)
                .join(
                  "",
                )}${operation.requestBody?.required ? " --body-file request.json" : ""}\nUse --schema for referenced definitions.`
            : `API ${command.join(" ")} commands`,
          globalFlags,
          params: params(operation, operation ? "" : "group"),
          commands: operation ? [] : tree(command),
        })
      })
  }
  return Spec.make("api", {
    description: "Full HTTP API: offline nested help, schemas, catalog and completion; raw and operation-ID requests",
    globalFlags,
    params: params(),
    commands: [
      ...tree([]),
      ...["request", "spec", "catalog", "complete", "completion"].map((tool) =>
        Spec.make(tool, {
          description: {
            request: "Raw METHOD /path request",
            spec: "Bundled OpenAPI (offline; --remote explicitly fetches)",
            catalog: "Generated offline operation catalog",
            complete: "Completion candidates for words after api (offline unless --server supplied)",
            completion:
              "Print an optional API-aware Zsh completion wrapper; native --completions supports bash/fish/zsh",
          }[tool],
          globalFlags,
          params: params(undefined, tool),
        }),
      ),
    ],
  })
}
