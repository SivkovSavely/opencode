# Managed Baila Workflow Consumer Handoff

This is a design and integration handoff, not authorization to deploy or resume
anything. The protected BAILA-160 run remains stopped, on hold, and untouched.
Do not change production topology, migrate source, enroll historical identities,
or create a new production archive on the strength of this document. The owner
must explicitly authorize commits as well as any separate production action.

Use one dedicated Serve process per slot assignment, not a shared server for
arbitrary slots. A trusted consumer still has to implement and validate this
orchestration. In the current orchestrator model, model workers perform commit,
fetch, rebase and push while Python verifies; that is incompatible with this
design. Implement a trusted control-plane Git executor, per-slot endpoint routing,
and a durable result/intent protocol before adoption. There is no new host-Git
endpoint or sandbox-to-host bridge in OpenCode.

## Assignment And Isolation

Allocate an exclusive canonical workspace and persistent, distinct private DB,
HOME, XDG homes, config, authentication, endpoint and Git snapshot for each slot
assignment. Keep them outside the candidate workspace and inaccessible to sandbox
processes and other clients. Reuse the slot's DB and identity across its restarts;
do not reuse them for a different assignment. Protect the server password and
endpoint at the OS/process/network boundary: Basic authentication and directory
matching do not isolate arbitrary clients authorized to access both endpoints.
Do not expose the server or WorkQueue listener to the sandbox.

The trusted launcher supplies environment before importing runtime modules. This
is a template, not a ready-to-run production command; provision existing canonical
directories, a private config with provider and agents, and secrets through the
trusted supervisor. Substitute every placeholder with a validated value; never
source workspace files. The port must be unique and private.

```sh
export HOME=/private/slot-a/home
export XDG_CONFIG_HOME=/private/slot-a/xdg-config
export XDG_DATA_HOME=/private/slot-a/xdg-data
export XDG_CACHE_HOME=/private/slot-a/xdg-cache
export XDG_STATE_HOME=/private/slot-a/xdg-state
export OPENCODE_DB=/private/slot-a/state/opencode.db
export OPENCODE_CONFIG=/private/slot-a/config/opencode.json
export OPENCODE_SERVER_USERNAME=opencode
export OPENCODE_SERVER_PASSWORD='<unique-secret-from-trusted-supervisor>'
export OPENCODE_MANAGED_PROFILE=1
export OPENCODE_MANAGED_PLUGIN_ALLOWLIST='[]'
export OPENCODE_MANAGED_WORKSPACE=/canonical/staging/slot-a
export OPENCODE_MANAGED_RUST_TOOLCHAIN=/trusted/installed/rust-toolchain
export OPENCODE_MANAGED_GIT='{"directory":"/canonical/staging/slot-a","snapshot":"/private/slot-a/snapshot/.git"}'
export OPENCODE_MANAGED_SKILLS='{"commit-work":"/trusted/skills/commit-work/SKILL.md"}'
export OPENCODE_MANAGED_READ_ONLY_AGENTS='["reviewer","verifier","verifier-openai-luna","reviewer-openai-luna"]'
export OPENCODE_MANAGED_WORK_QUEUE='{"url":"http://127.0.0.1:8765/mcp?project=STAGING","project":"STAGING","directory":"/canonical/staging/slot-a","issueId":"STAGING-1","tools":["wq_get_work","wq_update_progress"]}'
opencode serve --hostname 127.0.0.1 --port 14001
```

The consumer must select an endpoint by **assignment**, not just repository. Its
current single `base_url` is insufficient: construct each slot's HTTP client with
that slot's private Serve URL, Basic credentials and exact canonical
`x-opencode-directory`. Attach workers with, for example,
`opencode run --attach http://127.0.0.1:14001 --dir /canonical/staging/slot-a --agent build --model provider/model`;
supply the matching authentication through the CLI's trusted environment, not
prompt text. Persist endpoint/DB identity beside `worker.json` and `integration.json`,
and route every lookup, child enumeration, retirement, recovery and replacement to
the same assignment. Preserve existing session histories, child budgets and root
ownership. An HTTP directory hint cannot select a different slot or enlarge policy.

The read-only agent list is correct only if exhaustive for the actual configuration.
The defaults are exactly those four names; setting the variable replaces them, so
include every configured reviewer and verifier, including custom names. Operator
policy is not a permission grant. Configure agent and inherited permissions
explicitly, including WorkQueue mutation denies for reviewers. Dedicated WorkQueue
requires an exact `issueId` and canonical workspace match; issue-bearing arguments
are checked against that assignment. Read-only calls may query project data without
an issue argument; this is not a general tenant authorization boundary.

Managed discovery ignores workspace project configuration, plugins, custom tools,
and workspace skills; generic MCP configuration is rejected. The managed native
tool surface is Bash, Task, Compress, Skill and explicitly allowed native WorkQueue
tools, subject to permissions. Do not enable unsafe native host file tools or
network access. `commit-work` must be the actual installed, owner-approved skill,
not a model-authored substitute. The loader requires a canonical absolute safe
`SKILL.md` outside the workspace, safe ownership and path components, a single-link
regular file, and matching frontmatter; invalid entries are not exposed. Record a
successful Skill tool load receipt in the relevant execution before any
commit-affecting operation. A receipt is not the owner's commit authorization.

## HTTP Boundary

Dedicated mode enforces a method/path allowlist in
`routes/instance/httpapi/middleware/managed-workspace.ts`. It covers legacy
orchestrator session creation, status, messages, prompts, abort, retirement,
summarization, children and events, plus selected discovery, permission/question,
health and signed maintenance operations. It is not a general proxy: V2, worktree,
config mutation, file, host-Git, shell, command execution, fork and queue HTTP
routes are not exposed. Provider discovery (`/provider`, `/config/providers`) is
also denied because its ordinary responses can contain configured credentials;
clients must select the operator-configured model explicitly. The allowed
`GET /command` is discovery, not execution. `/global/event` is filtered to the
bound workspace. Managed prompt `file:` attachments and structured `subtask`
parts are denied, including resolved queued input. Use the native Task tool for
joined children. Caller-supplied data attachments remain possible and must be
treated as untrusted input. The allowlist does not replace endpoint and credential
isolation or authorize an external client across slots. It excludes `OPTIONS`;
this is not a browser/CORS or general interactive-UI deployment.

## Sandbox And Git Inspection

An agent named read-only or subject to an effective ancestor `edit` deny gets a
read-only workspace ceiling even if a broader permission says allow. Nested and
resumed Task policies are durable and intersected; inherited denial cannot be
overridden by a descendant. The candidate and Git snapshot are read-only for
reviewers/verifiers. `/tmp`, HOME and Cargo home are private scratch per command
and discarded on exit; for read-only compiler tests use, for example,
`CARGO_TARGET_DIR=/tmp/baila-target cargo test --locked --offline`. Workspace
build products cannot be shared through that scratch across commands.

Git inspection uses an independently provisioned standalone `.git` snapshot
outside the workspace, never the linked worktree's common Git directory. Clone
without local hardlinks or alternates; remove hooks and remote configuration,
provide an index matching the selected HEAD, and use exactly:

```ini
[core]
	repositoryformatversion = 0
	bare = false
```

The runtime validates the snapshot before launch and mounts it read-only at
`/git`, with `GIT_DIR=/git`, `GIT_WORK_TREE=/work` and optional index locks disabled.
It protects a linked worktree's `.git` pointer with a read-only bind, or masks a
standalone workspace's `.git` directory. The snapshot must not contain shared
metadata, hooks, alternates, hardlinks or symlinks.
The snapshot is an inspection view, not an authority to write Git metadata. Refresh
it only after retiring and conclusively draining all roots using it, stopping the
slot Serve, and before restarting with the newly validated snapshot. Neither a
snapshot nor a readonly bind makes an untrusted concurrently mutated host tree safe.
See `../tool/shell/managed-linux.md` for launcher prerequisites and limitations.

## Trusted Phase Protocol

The consumer must persist an assignment/phase lease and an immutable audit trail.
Each intent and result binds slot, issue, expected WorkQueue generation, canonical
workspace, root and execution ownership, phase, candidate tree and HEAD, expected
branch/ref, canonical gitdir and common directory, exact worktree `.git` file bytes
or directory identity, configured fetch and push remote URLs, and the intended
operation and expected result. Capture and compare these under exclusive host
ownership immediately before and after each operation; reject stale generation,
unexpected branch/HEAD, dirty or changed metadata, remote, topology, owner, lease
or path, and ambiguous results. Resolve paths without following attacker-controlled
replacements; hold a lease excluding all other writers, including other slots sharing
the Git common directory. Never recycle on an unknown outcome.

1. **Assign and prepare.** Verify assignment and generation, establish exclusive
   workspace and common-Git ownership, start the dedicated Serve with preparation
   gateway grants only, and run the worker. Preparation cannot call Ready or Done.
   Require the approved `commit-work` load receipt and separate owner commit
   authorization. Persist worker intent and evidence, not a model claim of Git success.
2. **Host Git boundary.** Retire every root and descendant, poll until all execution
   and command permits are conclusively drained, stop Serve, and verify no sandbox
   owner remains before host Git. `draining`, failed cleanup, unknown historical
   lineage or ambiguous dispatched WorkQueue mutation means hold and reconcile,
   not replacement or a retry. Execute Git exclusively in the trusted orchestrator,
   with a clean fixed environment, trusted binary and empty hooks directory; disable
   system/global and attacker-controlled repository configuration, includes, hooks,
   external commands, textconv, filters, credential helpers and prompts. Validate
   attributes and paths rather than executing candidate content. Do not rely merely
   on a few `-c` flags while still loading untrusted local configuration. Credentials
   for an approved remote are scoped to the trusted executor, never sandbox-visible.
   Verify the resulting index, tree, commit, branch and metadata against the intent.
3. **Review and integration.** Refresh the snapshot only at a drained restart.
   Obtain two independent reviews and a verifier on the exact candidate identity;
   record their results and provenance, not just summary text. Change WorkQueue
   grants only by draining and restarting the dedicated Serve with a new phase policy.
   A readiness root may receive only the necessary read and Ready grants after
   the checks and generation gate succeed, never Done or release. Fetch and rebase
   are trusted host operations under the same lease.
   If rebase conflicts, return the same checkout to preparation, resolve there,
   drain again, and obtain two fresh independent reviews plus a verifier for the
   resulting candidate. Do not reuse pre-rebase approvals.
4. **Push and finish.** Validate expected upstream and candidate, push the explicit
   approved SHA to the explicit destination ref normally, never force, and fetch
   the destination to prove its ref equals that SHA. Check ancestry and all lease,
   generation, metadata and remote gates again. Only then can a narrow integration
   root, launched with completion-only grants after verified push, issue WorkQueue
   Done and release with current generation and recorded push proof. The present
   fixture tests `wq_mark_done`, not checkout release; the
   release integration remains to be implemented and validated by the consumer.

Keep Git writes, remote access, review receipt validation and gateway phase
transitions in trusted control-plane code. Uncertain remote push or gateway outcome
requires explicit reconciliation against actual state, not automatic replay.
The signed maintenance procedure in `historical-admission-fence.md` preserves an
admission fence with partial membership and unknown historical cleanup; it is not
a drain receipt. No production identity was enrolled by this validation.

### Required Consumer Changes

`wq_orchestrator/opencode.py` needs assignment-specific clients;
`parallel.py` needs phase-specific launch, drain/stop/restart and permission
policies, and must stop instructing model workers to commit or access remotes.
The trusted executor can reuse the identity/provenance checks in `parallel_git.py`,
but must perform operations itself rather than merely authenticate model reports.
`workflow.py` must retain the `commit-work` requirement and consume the successful
skill tool result before accepting a commit intent.

No Git intent endpoint is implemented in OpenCode. Use the existing durable
message/tool transcript and retirement API as the OpenCode side of the contract.
The consumer must implement a versioned intent/result record containing the
binding fields above and an operation enum such as `prepare_commit`,
`fetch_rebase`, or `publish`, never a model-supplied shell command or argv array.
Accept an intent only from the owning root's final message, verify its referenced
skill/review/validation tool receipts, capture the candidate independently, and
retire and stop before execution. Persist the actual result and its evidence
before admitting a new root with the refreshed inspection view. Model text alone
is not a review attestation, commit authorization, drain receipt or push proof.
The fixture demonstrates this lifecycle with trusted test code, not an installed
production consumer or a complete gateway checkout-release implementation.

### Protected BAILA-160 Continuation

There is no in-place topology migration in this change. Leave its existing linked
worktree, common Git metadata, worker/integration state, session IDs, histories and
budgets exactly where they are, stopped in recovery hold. Do not import its IDs
into a fresh dedicated database, replay its prompt, clone away its unfinished
candidate, or infer cleanup from a new server's missing-session response. First
adopt dedicated assignment servers only for separately authorized new work.
Continuing BAILA-160 requires a separate owner-authorized recovery decision using
the original persisted authority, admission fencing and independent historical
cleanup evidence. Signed historical fencing alone still leaves historical cleanup
unknown. No such recovery, attestation or production restart was performed here.

## Evidence And Reproduction

On 2026-11-01, HEAD `e89cc42867c3` plus uncommitted implementation changes was
validated in `/home/savochek/ExternalProjects/opencode`. The final real-worktree
run passed one test with 14,905 assertions in 1,502.18 seconds. Its report is
`/tmp/opencode/managed-workflow-QlPBMe/report.json`; the log and exit code are
`/tmp/opencode/final-real-worktree.log` and `.exit`. Read-only `git archive` input
was `/home/savochek/Projects/baila` at
`fdc242df81f4cff3ea3527fde1bb5eeee6ae2ece`, unchanged after the run. The test created
its own staging repository, Git common directory, two linked worktrees and local
bare remote, never linked to production metadata.

Before and after rebase, both the committed 16 MiB configuration and increased
64 MiB stack passed all 1,149 library tests. Those runs are required gates. Both
identifier subsets passed 8 tests; the deliberately smaller 2 MiB full run
overflowed with exit 101 and remains a failed diagnostic. The fixture uses a
deterministic provider and synthetic WorkQueue; it does not demonstrate model
review quality, production compatibility, or remote credentials. The test performs
trusted fixture Git actions itself, not the missing consumer executor. Separate
managed E2Es exercise command abort, active-command retirement, delayed descendant
writes and a held-open gateway response. They are not evidence that a real gateway
can roll back an interrupted mutation; uncertain dispatch requires reconciliation.

From `packages/opencode`, with a separately verified and authorized disposable
source Git checkout containing `baila-compiler/Cargo.lock`, and the actual approved
`commit-work` skill installed at the fixture's operator path:

```sh
OPENCODE_MANAGED_BAILA_FIXTURE=/absolute/verified/disposable-source bun test test/server/managed-workflow-e2e.test.ts
bun test test/server/managed-ai-e2e.test.ts test/server/managed-capabilities-e2e.test.ts
bun typecheck
```

The workflow test is opt-in and uses `git archive` of the source HEAD, creates an
independent disposable repository and worktrees, and requires local offline Rust
dependencies and toolchain. Verify the source and authorization before running;
do not point it at a protected production checkout. See
`managed-capabilities-validation.md` and `managed-ai-validation.md` for scoped
results and unresolved suite failures. In particular, the full OpenCode suite is
not green; passing this staging workflow is not release authorization.
