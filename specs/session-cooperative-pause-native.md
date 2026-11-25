# Native Cooperative Pause Qualification

The frozen 104-line wire contract is `session-cooperative-pause.md`. This
implementation adds its separate `cooperative-execution-pause/1` receipt and
routes without changing legacy handoff `/4` or its receipts.

## Owner-Loss Activation Decision

V1 supports an enrolled, currently owned, running action. Its next quiet
provider boundary atomically acknowledges the pause and records
`cooperative_paused`. A same-process explicit resume re-leases the original
fence and continues persisted history. After Serve restart or owner loss,
resume returns `recovery_required` / `owner_lost` and retains the barrier.
Ordinary recovery cannot claim that paused action.

An accepted/draining intent whose owner dies before acknowledgement is not a
paused checkpoint. After positively verifying owner death, startup atomically
installs an ordinary root recovery hold and settles that exact pause receipt as
`refused` / `not_quiet`. If live descendants prevent a tree-wide startup hold,
this conversion inserts only the root hold record; already-admitted child
runners are not interrupted. Ordinary recovery admission can still derive the
held action tree from that record. Its boundary assistant stays null;
runtime ownership, fence, tools, and physical-effect evidence are untouched.
The ordinary recovery hold remains and prevents any automatic wake. Exact pause
retries return the durable refusal. Explicit resume of that original owner-lost
intent returns `recovery_required` / `owner_lost`, never `resumed`. Existing
separately authorized crash recovery may handle this unacknowledged action;
there is no new cross-owner paused-checkpoint bridge. Live/unknown owners leave
the intent pending, and acknowledged paused records
are never retired by this startup resolution.

Held/parked adoption is deliberately refused without creating a pause barrier
or waking/claiming the action. This is the permitted safe-v1 limitation, not a
claim that a held view is itself proof of quiescence. An existing held/dead
owner cannot supply a same-process continuation; adopting it as paused would
strand the action behind a barrier whose cross-owner recovery binding does
not exist in this wire version. Refusal uses the existing `stale_action` or
`not_quiet` reason, depending on whether the process-local owner proof exists.
No v5/v6 cross-owner activation or new recovery binding is implemented or
advertised. The already-running live166 process cannot acquire this primitive
through source changes. Its admitted tool must finish before any future
separately qualified activation; this candidate must not be hotpatched into it.

## Drain Semantics

Already-admitted provider/tool work is not interrupted. Root dispatch stops,
but children can finish additional turns. A background child's authenticated
in-action notification is persisted without a queue entry or provider wake;
the pause waits for its delivery acknowledgement. Unknown physical resources
remain uncertain and prevent acknowledgement unless an existing applied
authenticated legacy reconciliation covers the exact resource. No tool
success or process-death evidence is manufactured.

The receipt poll reads only durable request/receipt records. It does not
reconstruct the transcript. Accepted intent is not a paused acknowledgement.
Terminal outcomes settle the pause as terminal rather than leaving a barrier.
Cancellation's execution fence revocation and pause terminal receipt share one
SQLite IMMEDIATE transaction under the runtime synchronized state lock. Receipt
failure rolls back the execution transition instead of exposing a committed
cancelled action with an unsettled accepted intent.

## Cancellation After Acknowledgement

Cancellation of `cooperative_paused` is an atomic execution transition to
`cancelled`, `desired_active=0`, and fence+1, together with retirement of the
internal resumable pause record to `terminal`. The already acknowledged
`cooperative_pause` receipt remains byte-for-byte `paused`, including its
boundary assistant, revision, and timestamps: it is an immutable historical
acknowledgement, not current continuation authority. Exact pause retries and
receipt GET return that same historical body. Explicit resume of the cancelled
checkpoint returns the existing `cooperative_resume` outcome
`recovery_required` / `owner_lost`, with `resumeFence=null`, and dispatches
nothing. This denotes revoked ownership, not physical owner death. A matching
resume request retry is canonical; a new request ID cannot resurrect the action.
No V2 paused-receipt mutation handling is required for this transition.

## Held Background Result Limitation

Two bounded real-background-child regressions cover success and failure.
An accepted intent can lose its root owner while an already-admitted child
continues and finishes.
The result remains durable and the notification remains pending. The inherited
ordinary recovery hold correctly prevents unqualified parent-message injection.
However, the old v1 path admitted root recovery and only then discovered that
queue restoration needed the held notification delivered before removing its
hold. That dependency is circular; it is not loss of the child result.

V1 truthfully refuses that qualified recovery for either terminal result state,
`completed` or `error`, before any fence claim, history epoch, queue mutation,
or provider dispatch. It returns the existing
`pending_conflict` error with an explicit pending-background-notification held
reason. Root/child results, ownership, selection, queues, and holds are retained.
Already-delivered notifications and the existing terminal-root reconciliation
path are not subject to this refusal. Guarded delivery of this pending result
is unsupported in v1: no exactly-once delivery or automatic restoration is
claimed. It requires a future separately qualified authority-bound operation,
not a generic ignore-holds exception. The held result must not be erased or
represented as a failed/lost tool result.
