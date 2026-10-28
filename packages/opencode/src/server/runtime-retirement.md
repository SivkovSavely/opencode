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

Historical roots, unacknowledged permits after a crash, failed cleanup, and roots
with runtime execution or legacy/V2 history/input records remain `unknown`. Runner lease release is not proof
of every tool or plugin's cleanup. `draining` means this process still owns a
pending/running managed command or a live local execution lease. `drained` is only
available for explicitly enrolled, execution-free roots whose commands all have
confirmed cleanup. Never infer completion from owner death or fence revocation.

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
History, inbox, and runtime execution inserts also permanently invalidate coverage
in SQLite, including when their projections are subsequently deleted. Child
creation and ancestry changes also invalidate coverage, so reparenting cannot
import untracked work into a covered tree. Ordinary model sessions deliberately
remain unknown even after all tracked commands and local leases finish. This
implementation does not claim containment of arbitrary in-process plugin code,
external tools, or activity that bypasses every application admission boundary.
