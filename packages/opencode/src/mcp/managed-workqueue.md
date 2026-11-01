# Managed WorkQueue Gateway

This is a narrow native adapter, not generic MCP support. It never reads workspace
MCP entries, launches local servers, invokes plugins, or handles YouTrack credentials.
The existing generic MCP configuration rejection must remain enabled.

## Operator Policy

Set `OPENCODE_MANAGED_WORK_QUEUE` in the trusted server launch environment, outside
the workspace. The module snapshots that environment variable at import time.
Do not source it from project configuration, `.env` files, model arguments, or
per-request HTTP headers. Import this module before project-controlled bootstrap.

```json
{
  "url": "http://127.0.0.1:8765/mcp?project=BAILA",
  "project": "BAILA",
  "directory": "/absolute/canonical/workspace",
  "issueId": "BAILA-123",
  "tools": [
    "wq_ping",
    "wq_get_work",
    "wq_get_checkout_work",
    "wq_claim_work",
    "wq_update_progress",
    "wq_ready_to_integrate"
  ]
}
```

Omission disables the adapter. Invalid policy fails closed. Every permitted read
and lifecycle write must be explicitly listed; the list is restricted to the 24
known WorkQueue gateway tools. The canonical directory binds the actual workspace,
not all repositories with a matching project name. Symlink aliases resolve to the
same directory; unrelated directories, including other worktrees, are rejected.
In dedicated `OPENCODE_MANAGED_WORKSPACE` mode, `issueId` is mandatory and the
directory must match that workspace. Issue-bearing arguments must match the bound
issue, and mutations require its exact `issueId`; read-only calls without an issue
argument can still return project data. Runtime ancestor authorization remains
mandatory. Use separate Serve processes and private endpoints per slot as described
in `../server/managed-baila-workflow.md`; do not share a policy across assignments.
Phase-specific grants require draining and restarting the process, since policy is
captured at import time. Preparation must not grant Ready or Done.

Only exact HTTP URLs on numeric `127.0.0.1`, path `/mcp`, and one matching project
parameter are accepted. No credentials, extra parameters, fragments, redirects,
OAuth, alternate transport fallback, or automatic tool replay are supported.
The configured endpoint is an **operator trust assertion**, not a cryptographically
authenticated gateway identity. Another local process able to impersonate that
endpoint is inside this trust boundary. Catalog/profile checks cannot prove identity.

## Integration API

Import `ManagedWorkQueue` from `@/mcp/managed-workqueue`.

1. `SessionTools.resolve` calls `loadPolicy()` in the managed branch, using the
   module's trusted import-time environment snapshot. Do not pass untrusted strings
   to its explicit test/operator override. No policy means no WorkQueue tools; an
   enabled policy without a managed runtime and captured fence fails closed.
2. Under the caller's execution lease, call `discover(policy, directory)` to obtain
   MCP tool definitions with validated input schemas and authoritative read/write
   classification. Only policy-listed definitions are returned. Discovery performs
   initialization and catalog HTTP requests, but no remote tool operations.
3. SessionTools advertises native `wq_*` AI SDK tools using provider schema
   transforms, inherited agent/session visibility filtering, normal permission asks,
   and output truncation. The permission key is the **exact tool name**, not `read`,
   `edit`, or a generic MCP key. Operator allowlisting is a ceiling, not a grant.
   Named managed read-only identities and effective edit-deny policies impose an
   unconditional mutation ceiling, even against broad WorkQueue permissions.
   Mutations are hidden and rejected before dispatch. Also configure explicit
   inherited write denies (for example, deny `wq_*` and explicitly allow
   `wq_ping`, `wq_get_work`, and other approved read names). Parent session denies
   are inherited by shared workers. `isReadOnly(name)` is fixed locally, supplies
   both the ceiling and permission metadata, and never grants approval.
4. After normal permission approval, invoke the existing runtime API:

```ts
const outcome =
  yield *
  runtime.runManagedCommand(
    sessionID,
    (authorize) => ManagedWorkQueue.prepare(policy, directory, name, args, authorize, toolAbortSignal),
    capturedExecutionFence,
    { preparation: "process-free" },
  )
```

`prepare` snapshots and validates arguments, initializes a fresh MCP connection,
validates the catalog again and returns a `ManagedHandle<Result>`. The final
synchronous HTTP dispatch occurs **inside** `authorize(open)`. Pass the execution
fence captured for the actual provider/tool owner, not a fresh replacement fence.
Preparation is process-free and tool-operation-free; its HTTP requests are metadata.
The existing runtime retains the operation promise and durable permit after caller
interruption, and settles from the handle's `cleanup` field. The optional final
`AbortSignal` is wired by SessionTools before preparation's first await. It closes
only the local dispatch gate, including while metadata is pending; it is never
forwarded to remote HTTP. Its listener is removed after preparation failure or
the retained operation joins. Do not abort or detach that retained HTTP operation.

`Result` is `{ cleanup: "confirmed" | "failed", result?: CallToolResult,
error?: string }`. Forward bounded `result` content through the standard tool output
path; surface `error` prominently, including when `result.isError` is present.
The adapter creates no output files; SessionTools uses normal truncation storage
for large tool output and records `project`, `cleanup`, `isError`, and truncation
metadata. Responses are limited to 1 MiB before SDK parsing. Managed WorkQueue
does not run generic MCP/plugin hooks or activate arbitrary MCP servers.

## Completion And Uncertainty

Gateway calls are inline MCP `tools/call` operations, not detached jobs. MCP
initialization, initialized notification, opaque session IDs, negotiated protocol
headers, JSON replies and buffered SSE replies use the installed SDK. The adapter
does not subscribe to standalone SSE or automatically recover/replay expired
sessions. It never sends DELETE or remote cancellation as an operation join.

Before dispatch, cancellation or retirement means confirmed no-operation. After
dispatch, cancellation joins the same real HTTP reply; it does not abort it or
settle early. A valid successful inline response from the trusted gateway confirms
completion. HTTP 503 (including the gateway's `UnknownMutationOutcomeError` and
mutation fence), transport failure, deadline, invalid response, oversized response,
JSON-RPC error, or MCP tool error after dispatch leaves cleanup failed/unknown.
There is no automatic retry. Inspect queue state before retrying; reconcile a
gateway mutation fence through its operator procedure. A timeout does not establish
that a remote mutation stopped, and the gateway offers no operation join/cancel API.

The adapter uses a 39-second HTTP deadline and a 40-second SDK request deadline.
Failed/unknown cleanup must remain a durable runtime recovery blocker, not be
converted to successful cancellation or root drain. Retirement fences new dispatch;
late completion returns only to the retained permit and must not restart a root.
SDK terminal failures synchronously close the dispatch gate before classifying
cleanup, so an authorization callback released after the SDK deadline cannot send
a late HTTP operation after confirmed no-operation.

Tests use isolated local protocol fixtures and synthetic mutations only. The
production contract was checked read-only against gateway commit
`2d5a93fe7b4d5ccaff91e0f03346bfb80a3ce7da`; no production requests are needed.
