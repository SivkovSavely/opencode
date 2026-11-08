# HTTP API CLI

The single native `opencode api` command contains the generated public V2 API tree.
Names follow operation IDs, split into recursive kebab-case groups. Small explicit
overrides live in `catalog.ts` (`server.info` is `health`, for example). The bundled
catalog includes every declared operation, including explicit unsupported
WebSocket boundaries. `opencode api catalog` reports the generated current surface.
It does not expose private implementation services.

```sh
opencode api --help
opencode api session message --help
opencode api session list --help
opencode api session create --schema
opencode api spec
opencode api catalog
opencode api health --server http://127.0.0.1:4096
opencode api session list --order desc --experimental-bookmarked true
opencode api session get ses_example
opencode api session create --title Example --directory /absolute/project
opencode api session create --body-file request.json
opencode api request GET /unmodeled --param key=value
opencode api server.info
opencode api spec --remote --server http://127.0.0.1:4096
```

Help, schema, bundled spec/catalog and static completion are offline. They do not
resolve a server or initialize the provider/plugin runtime. Execution uses native
`ServerConnection`: explicit `--server`, a private `--standalone` server, or the
managed-service policy. Offline commands never start either kind of server.
Known operation IDs use the bundled schema; an unknown operation ID explicitly
retrieves the selected server's spec and resolves that deployed operation.
Raw requests remain available when a deployed contract cannot be modeled.

## Inputs And Context

Path parameters are ordered positionals. Primitive query/body flags are typed and
validated locally; repeat array flags for each element. Dotted wire names such as
`experimental.bookmarked` become `--experimental-bookmarked`. Reserved flag names
are disambiguated (`--query-body`, `--body-timeout`), and unresolved collisions
fail generation. Use `--body` (aliases `--data`, `-d`) or `--body-file` for nested
objects/unions; do not combine JSON bodies with primitive body flags. `--body-file
-` reads stdin, but cannot be combined with `--password-stdin`.

Context follows each native schema, not the old V1 shape. Session creation sends
`--directory` in `body.location.directory`; location-scoped queries use
`location[directory]`; session listing uses its declared `directory` filter.
Operations without an appropriate routing field reject context flags locally.
Remote directory/path flags retain their exact strings, including relative and
Windows paths, without normalization or filesystem checks on the CLI host.
Native path completion metadata remains available. `--body-file` and `--output`
remain local paths; the explicit `--body-file -` stdin sentinel is preserved.

The stable `Location.PublicRef` remains directory-only. `--workspace ID` instead
uses the declared experimental workspace-dispatch endpoint on the selected host.
It works with named commands, operation IDs and raw METHOD/path requests. Hosts
must explicitly register `ServerOptions.experimental.workspaceTargets`, each with
an ID, HTTP(S) origin, independent backend Basic password, backend-local directory
and an operation allowlist. Registration is programmatic host authority, not
public project configuration or caller-supplied URLs. The host must also enable
native Basic authentication. There are no registered targets by default.

Dispatch matches the live Protocol declarations using the native HTTP router,
not a fixed list of six operations. Each operation needs its exact public
operation ID in the host's allowlist. This includes PATCH/PUT/DELETE mutations,
session admission and execution, and other declared ordinary HTTP families.
No operation, including global account/config/policy APIs, is granted by default.
Undeclared method/path pairs, recursive dispatch and interactive upgrade routes
are denied even if their names appear in the allowlist. Native backend handlers perform the work, with their
normal filesystem semantics; registration does not confine filesystem list/write
to the location directory. Session creation selects the registered backend-local
location, and follow-up session/parent/adoption requests must match that placement.
Session references in paths, queries and JSON bodies are checked before dispatch;
session-owned resources exposed by native JSON GETs are checked through their owner.
An explicit directory must match the registration exactly. Unknown/denied targets,
conflicting resources/context and unavailable backends never fall back to the
host's local APIs. Backend credentials never travel to the CLI. Original file
bytes, request media/query/headers and streamed response status/media are retained;
transport/credential headers and backend cookies/redirect locations are not forwarded.

An explicit host grant delegates the backend's normal native API authority, not
an alternative runner or permission policy. Admit-only prompts retain native
`resume: false`; approved execution uses normal backend execution and permissions.
Hosts must not treat this adapter as a managed-mode policy boundary: F031 remains
separate, and no managed-isolation guarantee, model lease or F027 restriction is
claimed. Interactive WebSockets remain explicitly unsupported.

```sh
opencode api fs read README.md --workspace example --server http://host:4096 --raw
opencode api session create --workspace example --title Example --server http://host:4096
opencode api request session.get ses_example --workspace example --server http://host:4096
```

Authentication follows native Basic auth with username fixed to `opencode`.
Use native `OPENCODE_PASSWORD`, `--password`, or piped `--password-stdin`; stdin
password mode refuses a TTY and never echoes its input. `--username opencode` is
accepted, other usernames are not. Explicit API requests skip an extra health
probe. OpenAPI's generated `security: []` does not disable native authentication.
Request/credential values are not included in API argv logs. Custom `--header`
(`-H`) may repeat; authorization, host and framing headers are transport-owned.
Credentials in URLs, non-HTTP(S) URLs, authority-changing paths, dot segments,
header injection and redirects are rejected.

## Output And Transports

JSON is pretty-printed by default; `--compact` produces compact JSON. `--raw`
preserves response bytes, and `--output path` writes to an explicit file. HTTP,
auth, transport, validation, cancellation and timeout errors fail the command.
`--timeout` is a positive millisecond deadline, default 30000, including stream
consumption. Interrupting the request cancels its body reader and closes output.

SSE is streamed as newline-delimited `{event?,data}` JSON, without collecting the
stream; an individual decoded frame is bounded to 1 MiB. Use `--raw` to retain SSE
frames byte-for-byte. Known PTY/persistent-PTY/MCP WebSocket operations remain in
help/catalog but fail locally with an explicit unsupported-interactive-transport
diagnostic. Use their native interactive clients; no JSON success is fabricated.
Unknown WebSockets, ambiguous media and unhandled request media fail generation
until an adapter or an explicit unsupported boundary is declared.

## Completion

Native `opencode --completions zsh` (also bash/fish and the other native supported
shells) includes the recursive API tree, typed flags, enums and path descriptors.
For API-only Zsh dynamic IDs, source that native script first, then source the
output of `opencode api completion`. The wrapper handles `--flag=value` cursor
prefixes and path-valued flags; non-API commands delegate to native completion.

`opencode api complete -- session list --order=d` exposes the same candidate
logic for integrations. Static candidates never need a server. Dynamic lookup
only runs with an explicit `--server`, uses allowlisted GET endpoints, a 400 ms
deadline, a 256 KiB response limit and at most 50 results, and returns the static
fallback on failure. It never discovers/starts a service, reads credential stores,
mutates data, follows redirects, pages indefinitely or suggests secret values.
Workspace completion is static-only: dispatch uses POST, whereas dynamic
completion stays GET-only. It never substitutes host-local resource suggestions.

## Maintenance

After changing the public Protocol/Server API, generate Protocol OpenAPI and the
client using their existing workflows, then run from `packages/cli`:

```sh
bun run api:generate
bun run api:check
bun test --timeout 30000 src/api/api.test.ts src/commands/handlers/api.test.ts
bun typecheck
bun run typecheck:tsc
```

Do not edit `catalog.generated.json` manually. The generator compares the live
native `ClientApi` with bundled OpenAPI, checks references, command/flag
collisions, serialization and transport/media boundaries, then writes stable
catalog data. The checker reports added/removed/changed operations and schema
drift with regeneration instructions. Root lint/check enforces `api:check`, so
new routes and parameter/schema changes cannot quietly leave this CLI stale.
No SDK, Protocol route, lockfile or runtime dependency changes are needed merely
to regenerate this catalog.
