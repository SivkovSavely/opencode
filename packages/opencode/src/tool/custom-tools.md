# Optional custom-tool loading

V1 discovers JavaScript and TypeScript modules under `tool/` and `tools/` in
configured OpenCode directories. Discovery and imports happen before model tool
selection, including for tools disabled by configuration.

## V2 migration incident

Read-only inspection on November 5, 2026 established this chain:

```text
/home/savochek/ExternalProjects/opencode-v2.2.5/.opencode/tool/github-pr-search.ts:2
  import { tool } from "@opencode/plugin"
  -> node_modules/@opencode/plugin -> ../../packages/plugin
  -> packages/plugin/package.json (name @opencode/plugin, version 2.2.5)
  -> exports["."] = ./src/promise/index.ts
  -> no named tool export
```

This is a module-linking incompatibility with the V1-style `tool(...)` and
`tool.schema` usage in that file, not a JSON parsing error. It enters V1 through
custom-tool discovery, not the configured external-plugin loader. The local
configuration disables `github-pr-search`, but that does not prevent importing
it. No migration-checkout modules were executed for diagnosis.

Previously, `Effect.promise(import(...))` made the rejected import a defect in
`ToolRegistry.state`. Its per-directory scoped cache retained that failure, so
new sessions could fail during tool preparation before reaching model streaming.
The older production build did not finalize those empty assistant messages;
the separate terminal-finalization fixes at `f927c60b98` remain responsible for
genuinely fatal preparation failures. The original interrupted migration
session's recovery `SyntaxError` plausibly has the same cause, but its original
log does not contain the exception message needed to prove that connection.

## Isolation and diagnostics

The optional boundary now handles directory scanning, module import/link/evaluation,
and individual tool-definition conversion separately. A rejected module contributes
no exports. A failed definition contributes no registry entry; valid sibling
exports remain available. Ordinary helper exports are ignored. Compatible tools
retain their naming, ordering, collision and execution behavior, including legacy
JSON Schema and Zod conversion. Configured plugins retain their hooks and valid
tools; tool-registration warnings identify their plugin source.

Each skip logs `optional custom tool skipped` with source, stage, optional tool ID,
error type and bounded message. Error accessors, arbitrary thrown-object payloads,
causes and source contents are not rendered. Recognized missing-export messages
retain the missing name and resolved module, with an API-version hint. Bun's
accessor-only `ResolveMessage` gets dependency-check guidance instead of invoking
its message accessor. A directory-routed `tui.toast.show` warning surfaces the
skip to connected clients supporting that event. This is not `session.error`:
the model response can succeed. Logs remain available without an interactive client.
Notification observer failures are logged without making the registry fail;
interruption is preserved.

Managed-profile custom-tool rejection stays fatal and happens before import.
Required configuration, dependency waiting, built-in initialization and actual
tool execution remain outside the optional-error recovery boundary.

## Cache and reload

The existing `InstanceState` policy is unchanged. Concurrent callers share one
complete initialization per directory; skips produce a successful registry rather
than a cached failure. Consequently, warnings do not repeat on every model turn
or new session. Directory disposal/reload rescans tools without invalidating
healthy directories. Cancellation and scoped cleanup retain their existing rules.

OpenCode instance invalidation does **not** clear Bun's module cache. A module
that failed import/evaluation, or a corrected definition already evaluated under
the same URL, may still require a server-process restart. Adding/removing files
or loading a new module URL can be picked up after directory reload. There is no
automatic retry or query-string cache busting.

## Configuration side effects

V1 configuration initialization ensures each discovered config directory exists
and creates `.gitignore` if missing. Outside the managed profile it also schedules
`Npm.install` with `@opencode-ai/plugin` at the V1 installation version (unversioned
for local builds). Writable directories with missing `node_modules` or incomplete
package-lock declarations can be reified through Arborist with `save: true` and
`ignoreScripts: true`, changing manifests, locks and installed dependencies.

The migration checkout currently has an ignored `.opencode/package.json` declaring
`@opencode-ai/plugin: 1.18.29`. This is consistent with V1 configuration setup, but
does not prove when it was created. It is a separate package from the import above:
installing it cannot add `tool` to `@opencode/plugin`. There is no evidence that a
dependency-install redesign is required to fix this import failure. This patch
does not change configuration installation and does not make V1 project access
read-only. Protect foreign checkouts separately when that is required. The migration
checkout was inspected statically only and left unchanged throughout this work.

## Carry-forward to V2

V2 uses `PluginSourceDirectory` discovery under `plugin/` and `plugins/`,
`PluginModule` loading and `PluginSupervisor` activation/failure reporting, rather
than the V1 registry scanner. Its `ToolEditor` and core tool registry already record
invalid registrations without adding them. Carry forward the behavior at those
boundaries: individual optional-extension failures must not abort healthy model
preparation, registration must not advertise invalid tools, diagnostics must be
bounded and visible, and interruption/policy/core failures must remain distinct.
Use V2's existing generation/reload and plugin-status mechanisms. Do not transplant
V1 instance caching/runtime architecture or add a fake V1 `tool` export to V2.
