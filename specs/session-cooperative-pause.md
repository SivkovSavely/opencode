# Cooperative action pause v1 contract

Status: wire proposal frozen for Native/V2 review; no pause endpoint or capability is implemented.

## Wire

Keep `legacyQueuePromptHandoffRecovery` at `/4`. Add an independent capability to `GET /experimental/capabilities`:

```json
{"cooperativeExecutionPause":{"version":"cooperative-execution-pause/1"}}
```

Add these Native routes:

- `POST /session/:sessionID/execution/pause`
- `POST /session/:sessionID/execution/resume`
- Poll either request through the existing `GET /session/:sessionID/handoff/:requestID` receipt route.

`SessionHandoffV1.PauseRequest` contains `requestID`, `expectedDirectory`, `expected: Identity`, and `expectedRecoveryRevision`. `Identity` is the existing tuple of queue ID, user-message ID, owner lineage/instance, fence, action revision, and context digest.

`SessionHandoffV1.ResumeRequest` contains a new `requestID`, `pauseRequestID`, `expectedDirectory`, the original `expected: Identity`, and `expectedPauseRevision`.

Wire DTOs (IDs use the existing nonempty V1 ID schema; revisions/times use `NonNegativeInt`):

```ts
PauseRequest = {
  requestID: ID
  expectedDirectory: ID
  expected: SessionHandoffV1.Identity
  expectedRecoveryRevision: NonNegativeInt
}

ResumeRequest = {
  requestID: ID
  pauseRequestID: ID
  expectedDirectory: ID
  expected: SessionHandoffV1.Identity
  expectedPauseRevision: NonNegativeInt
}

CooperativePauseReceipt = {
  kind: "cooperative_pause"
  version: "cooperative-execution-pause/1"
  requestID: ID
  sessionID: ID
  directory: ID
  expected: SessionHandoffV1.Identity
  expectedRecoveryRevision: NonNegativeInt
  pauseRevision: NonNegativeInt
  state: "accepted" | "draining" | "paused" | "terminal" | "refused"
  boundaryAssistantMessageID: ID | null
  reason: "stale_action" | "pending_control" | "conflicting_input" | "not_quiet" | "unresolved_resource" | null
  createdAt: NonNegativeInt
  updatedAt: NonNegativeInt
}

CooperativeResumeReceipt = {
  kind: "cooperative_resume"
  version: "cooperative-execution-pause/1"
  requestID: ID
  pauseRequestID: ID
  sessionID: ID
  directory: ID
  expected: SessionHandoffV1.Identity
  expectedPauseRevision: NonNegativeInt
  state: "accepted" | "resumed" | "terminal" | "refused" | "recovery_required"
  resumeFence: NonNegativeInt | null
  reason: "stale_action" | "pending_control" | "conflicting_input" | "terminal_action" | "owner_lost" | null
  createdAt: NonNegativeInt
  updatedAt: NonNegativeInt
}
```

Add these as separate variants in the durable receipt union. Receipts carry no transcript or tool output.

Same request ID and payload returns the canonical receipt. Reusing an ID with different arguments conflicts. `terminal` wins if completion commits before the pause boundary. Normal same-process pause/resume does not change owner fence, selection, history epoch, queue ID, or user-message ID.

## Native state and atomicity

Keep pause intent in a durable action-scoped record keyed by session, queue ID, and user-message ID. Do not use `SessionQueueState.paused/blocked`, add a queue entry, steer, enqueue a prompt, wake the queue, or clear existing block flags.

Pause admission runs under runtime durable admission and one SQLite `IMMEDIATE` transaction. It verifies the exact current enrolled action, directory, owner/fence and recovery revision; rejects pending control requests, conflicting input, and stale identity; and records `accepted`. A blocked queue alone is not a reason to reject a still-owned current action.

The running prompt observes that request only at the boundary immediately before the next provider dispatch, after the current provider response and all already-admitted tools/children have settled. The boundary transaction rechecks owner/fence and action identity, handles terminal completion first, verifies no pending work/resources, then commits the paused receipt and a distinct durable `cooperative_paused` runtime state together. The runner exits cleanly: no cancellation, `queue.abandon`, interruption marker, or tool-result rewrite.

Startup recovery and scheduling must exclude `cooperative_paused`. Do not use `RuntimeLifecycle.park` alone: startup currently recovers parked executions owned by another instance. Ordinary prompts, steering, queue flush, and model control cannot release a pause. While the exact pause is active, conflicting input is refused rather than silently queued for later execution.

Resume is explicit and bound to the pause request. In the same process it verifies the unchanged owner/fence and resumes the same action from persisted history without a new user message or replaying completed tools. After an acknowledged pause loses its owner, v1 returns `recovery_required` and retains the pause barrier; it does not invoke crash recovery. Cross-owner continuation of that checkpoint requires a separately authorized recovery request tied to the pause receipt and a V2-validated recovery boundary. An unacknowledged `accepted`/`draining` intent is not a checkpoint: after positively verified owner death and installation of its durable ordinary recovery hold, startup settles its exact pause receipt as `refused`/`not_quiet`, without a boundary assistant or runtime/tool mutation. Exact retries return that refusal; an explicit resume of the original owner-lost intent returns `recovery_required`/`owner_lost`. Only the unacknowledged cooperative intent is retired; the ordinary recovery hold remains, blocks automatic execution, and requires the existing separately authorized crash-recovery path. Live/unknown owners are not resolved this way. Physical-unknown resources are never treated as quiet; pause may proceed only when an existing authenticated legacy reconciliation covers the exact resource, while retaining its uncertain effect evidence.

## Implementation gate

Do not advertise this capability until Native can atomically coordinate the safe-boundary receipt with runtime lease release, block startup recovery from auto-resuming the pause, reject ordinary admission while paused, and resume same-process execution without changing NativeHistory. Owner-loss resume remains `recovery_required` in v1 until V2 can validate the recovery boundary while retaining the pause barrier.

## Required tests before capability advertisement

- Public route: a long admitted Bash/tool remains uninterrupted; the receipt stays `accepted`/`draining`, then becomes `paused` after its persisted result and before another root provider/tool dispatch.
- The current blocked/empty queue remains byte-for-byte unchanged; the root action anchor and selection are unchanged.
- A completed action racing the pause returns `terminal`, not `paused`. Cancellation fence revocation and accepted-pause terminal settlement commit atomically; a failed settlement rolls back cancellation, and concurrent cancel/pause admission cannot leave an accepted barrier on a cancelled action. Cancellation after acknowledgement atomically retires the resumable checkpoint and records `cancelled`, desired-active zero, and fence+1, but preserves the old `paused` receipt body and timestamps as immutable history. Exact pause retries return that historical ACK. Explicit resume of the cancelled checkpoint returns `recovery_required`/`owner_lost` with null resume fence and no dispatch; this is revoked authority, not physical owner-death evidence.
- Exact request retry is idempotent; conflicting payload, stale directory/action/fence, pending control, and conflicting input are refused without queue or runtime mutation.
- Active foreground/background child work delays acknowledgement; unknown resources without an exact prior approval cannot be acknowledged as paused. If an accepted intent loses its root owner while a live background child completes, retain the actual durable result and pending notification. A qualified v1 root recovery whose held notification cannot be delivered is refused before any claim or dispatch with `pending_conflict` and an explicit pending-background-notification held reason; do not falsely report recoverability, clear the hold, erase the result, or inject into the held parent without separately qualified authority.
- A held/parked clean action can be acknowledged without waking or claiming it; a held view alone does not reject a live owner whose action/fence proof is current.
- Restart while paused does not auto-resume. A normal prompt, queue flush, startup scan, or unrelated action does not release the pause. Restart after acceptance but before acknowledgement refuses the exact unacknowledged intent only after positive owner-death evidence and a durable ordinary recovery hold; no work wakes and no quiescence is asserted.
- Same-process explicit resume preserves the original user input, selection, fence, messages, tool results, and Task counts. Owner-loss resume returns `recovery_required` and retains the barrier until the explicit V2 recovery path is used.
- Route/schema capability tests keep legacy handoff `/4` unchanged and verify the additive `cooperative-execution-pause/1` capability.
