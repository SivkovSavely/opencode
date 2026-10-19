# API CLI catalog

`opencode api` is generated from the raw `OpenCodeHttpApi` declaration in `src/server/routes/instance/httpapi/api.ts`. Legacy protocol groups are composed in `packages/protocol/src/api.ts`; newer route declarations live in `packages/protocol/src/groups/` and `src/server/routes/instance/httpapi/groups/`. The generator uses the raw API because the public OpenAPI compatibility transform intentionally changes some legacy nullability and requiredness.

From `packages/opencode`, regenerate and verify the bundled catalog with:

```sh
bun run api:generate
bun run api:check
bun test test/cli/api/api.test.ts
```

The deterministic command manifest is `src/cli/cmd/api/catalog.generated.ts`; its request-schema components are limited to schemas reachable from operation inputs so ordinary CLI startup stays small. The full offline specification is bundled separately in `src/cli/cmd/api/spec.generated.ts` and loaded only by `api spec`. `api:check` compares both generated artifacts with a freshly derived API; it reports added or removed routes and tells you how to regenerate. The regression test also checks method/path coverage, command uniqueness, parameter metadata, generated help, and option choices. `/doc` is a separate server route and is available through `opencode api request GET /doc` or `opencode api spec --remote`.

Command names normally come from each operation ID, split into nested kebab-case words. Keep exceptional names in the small `commandOverrides` map in `script/api-cli.ts`. The manifest drives the nested command tree, endpoint help, schema validation, option choices, and static completion. New ordinary JSON/query/path endpoints need no per-route request implementation. Add a narrow transport adapter in `src/cli/cmd/api/transport.ts` for a new wire protocol; the generator rejects unknown WebSocket routes and unsupported request media types rather than advertising them as ordinary JSON operations. SSE and PTY WebSocket routes are marked in the generated catalog.

`--body`, `--body-file`, and endpoint-specific simple field flags share the request schema. Complex and discriminated bodies remain available as JSON, and `--schema` prints the operation schema with its component definitions. API command and enum completion is offline; resource ID completion uses bounded read-only lookups and silently falls back when unavailable. The generated zsh script uses zsh file completion for path options while leaving other OpenCode shell completions unchanged.

Install zsh completion with `opencode completion >> ~/.zshrc`; ensure `autoload -Uz compinit` and `compinit` are enabled in that file. For example, keep those lines before the generated script. Bash and other yargs-supported shell completion behavior continues to use yargs' generated script.
