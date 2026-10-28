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
commandStatus: "unknown" }`. It establishes the durable barrier, requests local
legacy and V2 interruption, and waits for local legacy leases to be released.
The operation may wait indefinitely for local work to finish. A failed or
interrupted request can leave the root retired; retry rather than resuming it.

The result is not proof that external commands have stopped. Historical command
ownership is not tracked and there is no authoritative drained result. V2 checks
retirement at execution boundaries and interrupts active local drains, but a
boundary check is not atomic with a subsequent external provider or tool call.
Other processes observe fence revocation at their own ownership boundaries. Work
already in progress cannot be undone. The returned membership snapshots cannot
reconstruct ancestry edges deleted before that root was first retired. Do not use
this operation alone as permission to start replacement work in the same checkout.
