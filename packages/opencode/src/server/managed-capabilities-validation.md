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
Its historical catalog check expected `bash`, `task` and `compress`, independent
of catalog ordering. Do not set `OPENCODE_MANAGED_BAILA_FIXTURE` for the toy
capabilities validation; the expensive optional compiler fixture is unnecessary.

## Integrated Result

Both complete E2E files passed together on 2026-11-01 at `e5be972147`: two tests,
1,186 assertions, 110.36 seconds. Evidence is retained at:

- `/tmp/opencode/managed-ai-tHAS7V`: the existing shell, abort/resume, output,
  cancellation, replacement and durable restart workflow.
- `/tmp/opencode/managed-capabilities-5SAWw6`: WorkQueue JSON/SSE operations, both
  reviewer and verifier children, compression, post-summary execution, retirement
  during child execution, late admission denial and pending-MCP join.

The first assembled run, `/tmp/opencode/managed-capabilities-RyJWUk`, exposed an
ancestry trigger incorrectly invalidating coverage on unchanged parent writes.
The trigger now distinguishes unchanged projection updates from actual
reparenting. Both real child executions and all later retirement assertions pass;
summary text is not accepted as proof of child execution. This is isolated source
validation, not a production recovery or external-provider validation result.

## Validation Summary

Historical validation after the recovery fixes, from package directories:

| Scope                                                                           | Result                                  |
| ------------------------------------------------------------------------------- | --------------------------------------- |
| Full Core suite, 154 files                                                      | 1,338 passed, 0 failed                  |
| Recovery, lifecycle, retirement and historical-fence HTTP/server tests, 5 files | 100 passed, 0 failed                    |
| Full Session directory plus background-job and sharing tests, 23 files          | 568 passed, 7 skipped, 1 todo, 0 failed |
| Both isolated source-Serve E2E files                                            | 2 passed, 0 failed                      |
| Core and OpenCode `bun typecheck`                                               | Passed                                  |
| Core migration generation `--check`                                             | Passed                                  |

Session tests ran with `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` unset: an inherited
value of `65536` overrides the fixtures' expected default of `32000`. No token-limit
assertions or runtime behavior were changed to accommodate that environment.

Earlier completed validation remains applicable: the focused capability set passed
277 tests with 2 skipped; the native/MCP/provider safety set passed 174 tests;
Client passed all 16 tests and SDK passed its test, with both package typechecks
passing. Public clients and the CLI catalog were regenerated; the catalog covers
205 operations, including both maintenance routes.

The old 89-event assertion drift is fixed: the actual 90th event is
`session.queue.changed`, added in `d1902bf076` after the older 89-event expectation
from `3fe8474afe`. The test checks the manifest's unique definition inventory and
explicit queue-event presence, not an arbitrary new count. The schema manifest
now imports that V1 event through a compatibility entrypoint, preserving canonical
identity and the V1-isolation check.

Final validation on 2026-11-01 at HEAD `e89cc42867c3` plus uncommitted changes:

| Scope                                  | Result                                                |
| -------------------------------------- | ----------------------------------------------------- |
| Full Core suite, 154 files             | 1,338 passed                                          |
| Full Schema suite, 8 files             | 117 passed                                            |
| Full Protocol suite                    | 2 passed                                              |
| Full Client suite                      | 16 passed                                             |
| Full sdk-next suite                    | 5 passed                                              |
| Seven package `bun typecheck` commands | Passed                                                |
| Client generated check                 | Passed, no drift                                      |
| Core migration `--check`               | Passed, no migration needed                           |
| CLI API catalog `--check`              | Passed, 205 operations                                |
| Focused managed regression groups      | Passed; see `/tmp/opencode/final-managed-*.log`       |
| Full OpenCode suite, 285 files         | 3,930 passed, 109 failed, 23 skipped, 1 todo, 1 error |

The full OpenCode run is **not green**. Its completed serial run took 30m 58s and
exited 1; `/tmp/opencode/final-opencode-full.log` retains the failure evidence.
Failures include prompt/queue timeouts, workspace session-warp scope errors, HTTP
Session and processor tests, and managed plugin/shell checks. Several affected
files pass in fresh focused processes; that does not prove the aggregate failures
pre-exist these changes or excuse them. Do not report release readiness. An earlier
aggregate run had 250 failures; counts from different runs are not cumulative.
The sdk-next database failure was traced to its first test deleting the
module-captured database directory. A suite-lifetime test database fixes that
fixture without changing production database behavior.

After the final boundary changes and formatting, a fresh seven-file boundary set
passed 34 tests, and sdk-next again passed all 5 tests. Evidence is
`/tmp/opencode/final-boundary-validation.{log,exit}` and
`/tmp/opencode/final-sdk-next-suite.{log,exit}`. The final managed source E2E pair
passed 2 tests with 1,192 assertions in 108.97 seconds, with evidence at
`/tmp/opencode/managed-ai-Krioxp` and `/tmp/opencode/managed-capabilities-hhlRp4`.
The final full prompt file passed 123 tests with 1 skipped in a fresh process
(`/tmp/opencode-prompt-followup.log`); its import-time managed guard wrapper passed
both attachment and structured-subtask rejection cases. The managed plugin
fixture now supplies allowlisted hooks through trusted configuration; its isolated
trigger and profile files pass. These focused results do not erase aggregate
failures or imply that the full suite was rerun after each fixture-only change.

Reproduce from package directories, never the repository root:

```sh
# Each of packages/core, packages/schema, packages/protocol, packages/client, packages/sdk-next
bun test
bun typecheck
# packages/server has no package-local tests
# packages/opencode, packages/server, and each package above
bun typecheck
# packages/client
bun run check:generated
# packages/core
bun run script/migration.ts --check
# packages/opencode, without inherited managed configuration or output-token overrides
env -u OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX -u OPENCODE_MANAGED_BAILA_FIXTURE bun test --max-concurrency 1
bun run api:check
```

The retained `/tmp/opencode/final-<package>-{test,typecheck}.*` files and separate
generated, catalog and migration logs record package checks. Bun was
`1.4.3 (c6da4a4d3)`. The runtime/sandbox changes are Linux-only; compiler input,
offline dependencies and the approved skill are local prerequisites, not downloads
performed by this suite.

The opt-in real-worktree staging evidence and source provenance are in
`managed-baila-workflow.md`; it does not validate production adoption or model
review quality.

## Orchestrator Consumer Requirements

Configure the trusted launch environment as described in
`../mcp/managed-workqueue.md`, binding the gateway to the exact canonical checkout
and explicitly listing the required `wq_*` tools. Do not install the generic MCP
entry or a DCP plugin in managed configuration. Keep the plugin allowlist empty.
Grant tool permissions separately from the operator allowlist. In particular,
reviewer/verifier agents should have explicit WorkQueue write restrictions in
addition to the managed named-identity/effective-edit-deny mutation ceiling.

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
