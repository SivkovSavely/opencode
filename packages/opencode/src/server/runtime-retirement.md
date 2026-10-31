# Root Retirement

`RuntimeLifecycle.Interface.retireRoot(sessionID)` is the runtime entry point for
permanent root retirement. It returns an Effect yielding
`{ rootSessionID: string, sessionIDs: string[] }`. IDs are sorted, include the root,
and include descendants from both `session.parent_id` and
`runtime_execution.parent_session_id`, even when a descendant has never executed.

The durable primitive is also available as
`RuntimeRetirement.retireRoot(database, sessionID)` from
`@opencode-ai/core/runtime-retirement`. Prefer the runtime entry point when a live
runtime is available: it additionally invalidates retry wakes and recovery
preparations, and aborts retired parent-notification waits. It retains local leases
until their owners release them.

## Contract

- Retirement is permanent, idempotent, independent of owner lineage, and survives
  Session deletion, database reopen, and runtime replacement. There is no unretire
  operation. Cancellation alone remains resumable.
- The SQLite `IMMEDIATE` transaction is the admission barrier. It persists
  tombstones and cancels/fences existing execution rows together. A descendant
  created before this transaction is included; creation under a retired parent
  afterward is rejected by a database trigger. Execution claims and reconstruction
  are similarly guarded within their own write statement, not just by a prior read.
- Repeating retirement on a retired root succeeds even after deleting its Session.
  It returns the persisted tree and does not keep incrementing terminal fences.
- Per-root membership is persisted independently of the first retirement tombstone.
  A descendant shared by projected and execution ancestry is included in each
  retired root's result, including retries after projection deletion. Admission's
  `rootSessionID` identifies the first tombstone, not every overlapping root.
- `RootRetirementError` has `sessionID` and `reason`: `not_found` means no Session
  or root tombstone exists; `not_root` means the ID has projected or execution
  ancestry, or is already a descendant tombstone; `unavailable` is returned by
  `RuntimeLifecycle.unavailable()`. Errors come from
  `@opencode-ai/core/runtime-retirement`. SQL/storage failures remain defects, as
  with the existing database interface.
- Admission (including manual recovery and notification admission) to a retired
  ID or beneath a retired parent fails with the existing `RuntimeDrainingError`
  tag, `reason: "retired"`, `rootSessionID`, and message `Session root is retired`.
  Callers should inspect `reason`, not parse the message. Other draining errors
  have no retirement reason.
- Low-level Session insert/reparent attempts across the barrier fail with SQLite
  `Session root is retired`. Low-level guarded runtime writes return no row
  (`RAISE(IGNORE)`), preserving existing CAS/recovery-claim behavior.
- `beforeTurn` and `checkpoint` reject revoked execution ownership;
  `ownershipFence` no longer returns a stale local fence. Recovery rechecks
  ownership after waiting for a permit before invoking its continuation callback.

## HTTP operation and limitations

`POST /session/:sessionID/retire` returns `{ rootSessionID, sessionIDs,
commandStatus: "draining" | "drained" | "unknown" }`. It establishes the durable
barrier and schedules local legacy and V2 interruption in the runtime scope.
It does not wait for leases or uncooperative tools. Repeating the operation polls
the current status without reopening admission. A failed or
interrupted request can leave the root retired; retry rather than resuming it.

Historical roots, unacknowledged permits after a crash, failed cleanup, and
unaccounted execution remain `unknown`. V2 history/input also invalidates managed
coverage because V2 execution is not supported by this profile. Legitimate legacy
model messages and tool results do not invalidate an already enrolled root.
`draining` means this process still owns a pending/running managed command or a
live local execution lease. `drained` requires explicit enrollment, confirmed
settlement of every durable permit, and no live local lease. A runner's release
does not confirm an independent shell permit or an arbitrary plugin's cleanup.
Never infer completion from owner death or fence revocation.

V2 checks
retirement at execution boundaries and interrupts active local drains, but a
boundary check is not atomic with a subsequent external provider or tool call.
Other processes observe fence revocation at their own ownership boundaries. Work
already in progress cannot be undone. The returned membership snapshots cannot
reconstruct ancestry edges deleted before that root was first retired. Do not use
this operation alone as permission to start replacement work in the same checkout.

## Managed Shell Integration

Use `runtime.runManagedCommand(sessionID, authorize => ManagedLinux.prepare({
...options, authorize }), executionFence)`. Capture `executionFence` from the owning
provider turn, not from a later lookup when a stale tool finally starts. Omitting
it permits only independent commands with no runtime execution row. A mismatched,
foreign, or inactive execution is rejected before preparation. The launcher must call `authorize(open)` at its final
paused user-code gate, after readiness. `open` must synchronously release that gate
and must not wait for the command. The ownership module checks retirement and
releases the gate inside a short SQLite `IMMEDIATE` transaction. No transaction is
held while preparing, running, cancelling, or joining a command. The gate also
revalidates the complete projected/execution ancestry and each ancestor execution
generation, including owner, fence, state and desired activity.

The callback returns `Promise<boolean>`. False must deny execution and tear down
the paused launcher. Checking only before calling `start()` is insufficient.
The handle has idempotent `start()` and `cancel()` returning a result with
`cleanup: "confirmed" | "failed"`. The runtime owns the permit before preparation,
retains it across caller interruption, cancels late handles, observes retirement
from other processes, and settles only after the handle's cleanup result.

Coverage is not retroactive. The migration marks only future roots as eligible.
`ManagedCommand.coverRoot(database, rootSessionID)` explicitly enrolls an eligible
root before any history, inputs, descendants, or execution exists. Both Session
creation services call `enrollCreatedRoot` in the creation event transaction before
subscribers run. Only the managed profile with an empty plugin allowlist enrolls;
nonmanaged creation and any configured trusted-plugin authority permanently mark
coverage unknown. Trust is not a plugin cleanup guarantee. Call
`ManagedCommand.invalidateCoverage(database, rootSessionID)` before any untracked
nonmanaged execution. Existing roots cannot be upgraded, and unknown coverage
cannot be restored. Normal nonmanaged execution is not routed through this API.
Managed model execution requires a tracked runtime. Before admitting its first
local owner, the runtime persists a `managed_command` execution lease with generation
`managed-execution`; it confirms that lease only when the last admitted owner has
released. Cancellation acknowledgement, completion state, owner death, and server
restart do not confirm a lease. Unresolved crash-era leases remain unknown even
after a later owner completes new work. Managed bash has its own independent
durable permit and joined namespace cleanup, including after caller interruption.
The instance-owned model runner holds its own admission lease independently of
the prompt caller. Disconnecting that caller cannot settle a still-running model
turn; retirement must cancel and join the runner before its lease is released.

Legacy history alone is not execution and no longer invalidates an enrolled root.
Unaccounted runtime execution, V2 inbox/history activity, child creation, and ancestry
changes still permanently invalidate coverage in SQLite, including when projections
are subsequently deleted. Unmanaged model loops explicitly invalidate coverage.
Retirement fences later model admission, retries, and managed command authorization;
ordinary cancellation remains resumable. A newly enrolled managed root can therefore
execute model turns and managed bash and reach `drained` after joined cancellation.

The initial managed model profile exposes only bash (plus in-process structured
output). Task delegation, background children/notifications, MCP tools/resources,
custom tools, nonempty plugin allowlists, and execution without a tracked runtime
are unsupported. Custom tools and direct task invocation fail closed; unsupported
tools are not advertised to the model. Detached title generation, summaries, and
pruning are disabled. V2 wake/resume remains explicitly unsupported. This contract
does not claim containment of arbitrary in-process plugin code, external tools, or
activity that bypasses every application admission boundary.

Managed configuration rejects every MCP entry, local or remote, including disabled
and lazy entries, before bootstrap or MCP instance initialization. Dynamic MCP add
and transport creation are also rejected. Managed prompts skip MCP system context,
tool/resource discovery and resource attachments, so an MCP server cannot be
launched as a side effect of preparing an otherwise supported model turn.
The managed effective configuration also forces LSP, formatting and snapshots off:
prompt file attachments must not start detached language servers, and snapshot or
formatting helpers must not launch processes outside managed bash accounting.
Configuration loading does not schedule dependency installation in this profile.
Provider SDKs are restricted to bundled `@ai-sdk/openai`,
`@ai-sdk/openai-compatible`, and `@ai-sdk/anthropic`; arbitrary SDK installation,
imports, plugin auth hooks, and provider-specific credential loaders are excluded.
The built-in Zen loader may filter the local model catalog and supply public
credentials. These restrictions are part of the supported execution contract,
not proof that arbitrary in-process extensions have a joined lifecycle.

## Historical Recovery Consumer Requirements

The retirement operation is not a historical cleanup attestation API. Consumers
must retain uncertainty rather than manufacture coverage or Session projections.
In particular, the reported BAILA-160 inventory of 36 historical roots, including
17 absent from both inspected projections, cannot be reconciled by enrolling them
as new managed roots. This implementation does not alter that inventory or its
persisted recovery state.

- Use `POST /session/:sessionID/retire` against the verified owning Serve/database
  with the correct workspace context and normal authentication. Retain the exact
  root ID, returned membership, database identity, runtime version, and responses
  as evidence. HTTP 200 establishes a permanent admission barrier, not cleanup.
- Poll the same operation until `commandStatus` is `drained`. `draining` requires
  waiting; `unknown` requires separate audited recovery, not a timeout-based
  promotion. A lost HTTP response is retried idempotently, never by resuming the
  old root. Retired prompt admission returns HTTP 409.
- HTTP 404 means neither a Session nor a persisted root retirement tombstone was
  found in that database. It is not evidence that execution ended. HTTP 409 on
  retirement means the ID is not a root; HTTP 503 means retirement is unavailable.
  None permits replacement. Do not invent records to turn a missing ID into 200.
- For historical or crash-era `unknown`, separately establish and audit the
  execution process boundary and descendant termination, covering every possible
  owning Serve/runtime and database, and fence all old admission/notification
  paths. A missing PID, process exit, owner death, fence increment, or a clean
  workspace alone cannot supply this evidence. This API deliberately has no
  endpoint to overwrite `unknown` or acknowledge historical cleanup.
- Any future historical-attestation API needs explicit authorization, durable
  immutable provenance binding the exact roots, database/runtime identities and
  terminated process boundaries, idempotency, and admission fencing before
  publishing cleanup. It must not reuse normal creation-time managed enrollment.
  That separate procedure and API are not implemented here.
- Start replacement work only after all relevant roots have both a durable
  admission barrier and authoritative cleanup evidence. New roots do not acquire
  a workspace-wide exclusion lock against unrelated sessions; the consumer must
  enforce this ordering for every historical owner of the workspace.
