# Managed Capabilities Validation

Run from `packages/opencode`:

```sh
bun test test/server/managed-ai-e2e.test.ts
bun test test/server/managed-capabilities-e2e.test.ts
bun typecheck
```

Both E2E tests start the source `serve` CLI, not an in-process replacement API.
The capabilities test uses a disposable toy workspace and deterministic local
OpenAI-compatible SSE provider. Its only MCP peer is a synthetic loopback gateway
bound to `?project=STAGING`, with `wq_get_work` and `wq_update_progress` explicitly
allowed by `OPENCODE_MANAGED_WORK_QUEUE`. No production WorkQueue or external
provider is contacted. The gateway exercises SDK initialization, initialized
notification, catalog discovery, JSON read replies and SSE mutation replies.

## Isolation Evidence

Each capabilities run prints `/tmp/opencode/managed-capabilities-*`. Its config,
HOME, four XDG directories, TMPDIR, managed configuration and fresh absolute
`OPENCODE_DB` are under that directory, outside the workspace and source tree.
The child receives only the test's explicit environment, not the caller's
credentials or configuration. Before the first HTTP request, the test checks the
database startup diagnostic, `/proc/<pid>/environ`, and open database descriptors.
`events.jsonl` retains those checks, model requests, gateway requests and replies,
HTTP outcomes, retirement results and durable accounting evidence. Serve stdout
and stderr are retained separately. Owned processes and local peers are stopped
in the finalizer even after an assertion fails.

## Required Workflow

The model authors actual tool calls admitted through HTTP `prompt_async`:

- Read synthetic `STAGING-1` and update progress using `expectedGeneration: 7`.
- Execute real sandboxed root Bash with observable output and workspace writes.
- Run configured foreground reviewer and verifier children, each using real Bash.
- Queue native `compress({})`, execute the existing summary provider path, and
  continue with another real root Bash call.
- Verify both child parent IDs and placement through HTTP, and durable child
  membership plus root-linked execution permits through the isolated SQLite DB.
- Retire the root, require all permits confirmed before `drained`, and reject late
  root and child prompt attempts without another provider request.
- Retire another root while a child owns a detached shell descendant; wait for
  joined cleanup and prove the descendant's delayed workspace write never occurs.
- Hold a real gateway mutation response open, require repeated `draining`, reject
  late admission, release a valid response, and only then accept `drained`.

The pre-existing Bash E2E retains its original success, failure, duration, bounded
output, abort/resume, descendant cleanup, retirement races and restart assertions.
Its catalog check now expects exactly `bash`, `task` and `compress`, independent
of catalog ordering. Do not set `OPENCODE_MANAGED_BAILA_FIXTURE` for the toy
capabilities validation; the expensive optional compiler fixture is unnecessary.

## Integrated Result

Both complete E2E files passed together on 2026-10-31: two tests, 1,186 assertions,
109.77 seconds. Evidence is retained at:

- `/tmp/opencode/managed-ai-bTEU1j`: the existing shell, abort/resume, output,
  cancellation, replacement and durable restart workflow.
- `/tmp/opencode/managed-capabilities-U6cbee`: WorkQueue JSON/SSE operations, both
  reviewer and verifier children, compression, post-summary execution, retirement
  during child execution, late admission denial and pending-MCP join.

The first assembled run, `/tmp/opencode/managed-capabilities-RyJWUk`, exposed an
ancestry trigger incorrectly invalidating coverage on unchanged parent writes.
The trigger now distinguishes unchanged projection updates from actual
reparenting. Both real child executions and all later retirement assertions pass;
summary text is not accepted as proof of child execution. This is isolated source
validation, not a production recovery or external-provider validation result.

## Orchestrator Consumer Requirements

Configure the trusted launch environment as described in
`../mcp/managed-workqueue.md`, binding the gateway to the exact canonical checkout
and explicitly listing the required `wq_*` tools. Do not install the generic MCP
entry or a DCP plugin in managed configuration. Keep the plugin allowlist empty.
Grant tool permissions separately from the operator allowlist. In particular,
reviewer/verifier agents need explicit WorkQueue write restrictions; an `edit`
deny does not deny a `wq_*` mutation.

Use configured `mode: "subagent"` agents with foreground `task` calls, and native
`compress({})` for context reduction. Background promotion, asynchronous child
notifications and independent HTTP prompt/queue execution on a child are not
supported. Task prompts are literal model-authored text, not trusted file or
agent mention expansion. The root remains the retirement/accounting authority.

For pruned identities, follow `historical-admission-fence.md`. A normal retirement
404 is not a permanent fence or termination receipt. An owner-authorized signed
maintenance attestation can establish the fence, but its partial membership and
`historicalCleanup: "unknown"` must remain distinct from cleanup evidence. Persist
the immutable proof and audited artifact binding in the consumer's recovery
receipt; do not convert it into `commandStatus: "drained"`. No historical BAILA-160
identity was enrolled as part of these tests.

For new managed roots, poll retirement until both execution and command cleanup
are conclusively settled. Do not authorize replacement merely because admission
is fenced. An MCP response held open keeps retirement `draining`; an ambiguous
post-dispatch failure leaves durable `unknown` and requires reconciliation rather
than automatic retry. These changes do not authorize resuming the production
orchestrator or changing its persisted run.
