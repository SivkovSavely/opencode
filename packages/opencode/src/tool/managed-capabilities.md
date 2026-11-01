# Managed Native Capabilities

`OPENCODE_MANAGED_PROFILE=1` exposes the built-in `bash`, `task`, and `compress`
tools through both the tool registry and the Session tool resolver. The trusted
WorkQueue adapter is integrated separately. This is not permission to load local
plugins, arbitrary MCP servers, or custom workspace tools. V2 Session execution
remains unsupported in the managed profile.

## Foreground Child Tasks

Use `task` with any configured agent whose `mode` is `subagent`, including
reviewer and verifier roles. The normal agent-selection and permission checks
still apply, with a durable maximum of eight nested child levels. Independent
reviews may be repeated or concurrent in different child Sessions. Concurrent
`task_id` reuse of the same child is rejected. Managed children
receive the same restricted tools as their parent.

Managed membership stores ordered ancestor permission policies independently of
the child's own permissions. Every managed tool permission check intersects the
effective decisions of the child, parent agent/Session and earlier ancestors:
any deny rejects; otherwise any ask still requires approval. A parent wildcard
deny followed by an `echo *` allow retains that exception without overriding a
child's deny or ask. This also applies to trusted WorkQueue calls. The parent's
`task` policy gates its delegation call, not each descendant's delegation policy.
Resuming a `task_id` refreshes the inherited policies in a transaction that
revalidates the parent's fence, ownership, membership and retirement status.
Existing child restrictions are retained.

Model-authored Task prompts are always a single literal text part. File paths,
including workspace paths, and `@agent` mentions do not become attachments or
agent parts and cannot confer read or delegation authority. Managed Task
reconstruction applies the same rule. Trusted user input and unmanaged Tasks
retain their existing mention semantics.

`background: true` is rejected before child creation or scheduling. Managed tasks
never register a BackgroundJob, cannot promote to background, and do not send
late parent notifications. Aborting a foreground task first interrupts and joins
its prompt waiter, preventing late admission, then cancels and joins any instance
runner it already created before the tool returns. Its Task claim covers both
joins. Parent
and child execution permits stay outstanding until their owners actually release
them; retirement alone never proves that execution has stopped.

Before publishing a child's Created event, `Session.createNext` calls
`ManagedCommand.reserveChild(database, childID, parentID, parentFence)`. The
reservation requires a live parent's exact execution fence and owner, its running
managed execution permit, matching directory and workspace, and covered durable
root ancestry. Database triggers validate the reservation again at projection
insertion, before Session subscribers can schedule execution.

`beginExecution` creates an independent durable child execution permit linked to
the original root, not a new root. A resumed `task_id` must already have a managed
membership for this exact parent/root and placement. An existing root or an
untracked historical child cannot be adopted. The membership migration does not
backfill history. Retirement of the original root recursively fences children,
and reservations and admission both reject retirement. Unknown historical
lineage continues to prevent a `drained` claim.

Durable membership is necessary but is not an execution credential. The Task
path obtains two identity-only, single-use runtime capabilities: one for the
prompt caller and one for the same joined runner. Admission validates the live
parent owner, fence and leases even when the child is already active. Public
prompt, loop and queue paths cannot supply these capabilities and cannot append
unjoined work to a foreground child. IDs and serialized objects do not grant
admission.

Authorization also acquires an exclusive runtime-local Task claim before child
permission updates, metadata callbacks or prompting. The Task scope retains that
claim until child completion or cancellation cleanup has joined, then revokes
unused capabilities and releases it. A competing same-child Task cannot acquire
authorization and therefore cannot cancel another Task's child. Independent
children do not share this claim.

## Context Compression

`compress({})` queues a native `SessionCompaction` marker in the current Session.
It requires a tracked execution context and the runner's `requestCompaction`
callback; direct untracked invocation fails closed. It accepts neither arbitrary
filesystem paths nor model-authored replacement history.

The tool does not launch a summary provider. After the current tool turn has
completed, the same Session runner consumes the durable marker, checks its
runtime fence, and runs the existing native summary processor while retaining
the Session's execution permit. Summary processing consumes a provider turn.
The marker and synthetic continuation do not reset the managed provider-turn
budget. Original structured transcript records remain durable; native history
selection uses the summary and retained recent turns on subsequent requests.
The marker, replay and synthetic continuation preserve the requested structured
output format; a post-summary plain-text completion still fails when the user
requires `StructuredOutput`.
Overflow replay carries the same internal continuation marker, including for
file-only replay, so it cannot reset the provider-turn budget. A genuinely new
external user prompt still resets the budget normally.

The external DCP plugin is neither required nor permitted by this capability.
Compression interruption and retirement follow the existing tracked runner's
join/release path, rather than a detached plugin operation.

## Verification

- `test/server/managed-execution.test.ts` exercises independent child permits,
  stale fences, cross-root reuse, background rejection, recursive retirement,
  retirement before admission, late completion, and conservative historical
  coverage.
- `test/tool/task.test.ts` executes concurrent configured reviewers/verifiers and
  proves abort waits for child cleanup before the tool completes. Existing
  nonmanaged background behavior remains covered by the same test file.
- `test/session/compaction.test.ts` exercises the native compress tool, durable
  marker, real summary processor with a controlled provider, retained transcript,
  and the root permit across summary execution.
- `test/session/prompt.test.ts` rejects independent work on an active managed
  child and exercises structured-output enforcement through the complete native
  compression provider path.
- `test/server/managed-capabilities-e2e.test.ts` launches the isolated source CLI
  and exercises trusted WorkQueue, both reviewer and verifier children, native
  compression, post-summary shell work, and joined retirement.

The ancestry trigger ignores unchanged `parent_id` projection writes but still
invalidates coverage for actual reparenting, including managed members.
