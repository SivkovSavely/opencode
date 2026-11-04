# Snapshot summaries and restart recovery safety

These limits protect V1 snapshot **summaries**. Snapshot capture, patch manifests,
restore, and revert retain their existing behavior. An omitted summary is not a
partial snapshot and must not be used as a revert manifest.

## Resource limits

| Work                                    | Limit per full diff                                  |
| --------------------------------------- | ---------------------------------------------------- |
| Raw Git metadata and object-size output | 4 MiB stdout per command                             |
| Git stderr                              | 8 KiB per command                                    |
| Git command time                        | 15 seconds                                           |
| Blob size                               | 2 MiB per side of a file                             |
| Statistics                              | 20,000 files and 8 MiB total before/after blob bytes |
| Partial statistics batches              | 100 literal paths and 16 KiB path arguments          |
| Detailed records                        | 200 named files, plus at most one aggregate omission |
| Loaded detail input                     | 8 MiB total before/after blob bytes                  |
| Generated patches                       | 8 MiB total JSON-encoded patch-string bytes          |
| Patch complexity                        | 20,000 changed lines and 1 second per file           |
| Retained pathname                       | 4,096 UTF-16 code units                              |
| Concurrent full diffs                   | 2 across instances sharing the server Snapshot layer |

Raw metadata and object-size inspection precede content reads, including Git
`numstat`. Only budgeted blobs reach statistics or detailed patch construction.
Ignored changes are excluded before this work. Partial path batches avoid both
pathspec interpretation and file/directory-transition descendant selection.
Metadata and statistics use worktree-root-relative paths even with
`diff.relative=true`, while retaining the session directory's scope.
Full-context patches are conservatively sized before calling the patch builder.
Cancellation releases subprocess scopes, the repository lock, and the shared
full-diff permit.
Repository-lock waiters do not consume shared full-diff permits, so a capture in
one worktree cannot exhaust detail concurrency in unrelated worktrees.

The optional `FileDiff.omitted` field is backward compatible with existing
messages and events:

- A named row with `omitted` has no detailed patch; its change counts remain useful.
- A row without `file` summarizes excluded rows. `omitted.files` is their count.
- A missing `omitted.files` means that the total file count is unknown.
- `omitted.statisticsIncomplete: true` means line counts are known lower bounds,
  not complete totals. In particular, unavailable statistics are not exact zeroes.

The browser and TUI show omission warnings. Aggregate rows are not synthetic
filenames. Binary files within the statistics budget retain their normal known
zero line counts and empty patches. File counts and line counts are exact when
all statistics fit, even when only the first 200 files have detailed records.
Known file counts remain visible even when line statistics are incomplete. Undo
summary counts include aggregate omissions; undo still uses full patch manifests.

## Historical data and transport

New summary writes are bounded before durable events are recorded. Selected
historical message/session JSON is projected in SQLite when necessary, before
the JavaScript JSON decoder materializes oversized patches. Read projections do
not rewrite historical records, prompts, snapshot references, or tool results.
Summary calculation reads only the requested turn; summary retrieval reads only
the requested message metadata. Browser/TUI consumers also apply the shared
summary bound before normalizing patches.
New NUL-delimited Git paths are re-quoted at the summary boundary so legacy
retrieval decoding preserves literal surrounding quotes and other special names.

Canonical event data and exact duplicate-replay comparison remain unchanged.
Legacy event views are summary-bounded. Historical transport readers reject an
individual decoded event exceeding **16 MiB** before parsing or decompression;
compressed frames also have a native decompression-output ceiling. This limit
includes prompts and other metadata, not just patches. Oversized canonical
events fail explicitly rather than being silently rewritten into different
events. SQLite still reads the stored TEXT/BLOB, and this is not an aggregate
event-history or HTTP request-body limit. Canonical storage/audit readers remain
available for exact data access.

## Recovery and incident evidence

The November 4, 2026 journal confirms `systemd-oomd` selected the server cgroup at
15:53:42 amid sustained memory pressure. It does not identify the allocations
responsible. A baseline replacement involving thousands of files could exercise
the previous unbounded full-diff path, but that is a suspected contributor, not
a proven OOM cause.

Malformed preserved raw tool arguments reproduce an invalid model-history input
shape with the pinned V1 dependencies. They do **not** reproduce the incident's
`SyntaxError`. The available application logs contain no corresponding stack.
Model history now uses the reconciled structured tool input while retaining raw
fragments in diagnostic metadata. Interrupted shell calls are not replayed, and
completed outcomes remain intact.

Recovery failures retain durable fencing and `recovery_needed` semantics.
Pre-stream failures finalize their assistant record with a safe error so an
explicit continuation can proceed. Cleanup does not replace the original cause.
Critical diagnostics contain session/owner/fence context, phase, preparation and
transition status, and at most four cause reasons. Each reason has an 80-character
type, a sanitized 512-character message, and at most eight 384-character stack
frames. Attached payloads and recursive exception causes are not serialized.
Only data properties are inspected; message/name/stack accessors are omitted
without invocation, since they may render unbounded query parameters or payloads.

## Upstream v2.2.5 carry-forward

Comparison is pinned to upstream release commit
`9bbb8ce18c80f099e0e448775f59d965ead40a21`, not the migration worktree or the local
`personal-v2.2.5` branch (which has an additional commit).

- `packages/core/src/snapshot.ts` delegates diffing to `Git.tree.diff` and exposes
  a separate metadata-only `files` operation.
- `packages/core/src/git.ts` and `vcs/patch.ts` already cap total captured patch
  output at **10,000,000 bytes**. V2 is therefore not wholly unbounded in the same
  way as old V1. Its equivalent path still enumerates all name/stat rows and does
  not show V1's preflight blob/input/file budgets or explicit aggregate-omission
  representation. Carry those protections into that Git boundary, rather than
  replacing its architecture with V1 services.
- `session/runner/to-llm-message.ts` attempts to decode streaming tool input but
  falls back to the original string on malformed JSON. Only completed/error
  states produce tool results there. Carry forward structured interrupted input
  plus a corresponding safe interrupted result; preserve completed outcomes.
- `session/execution/restart.ts` uses durable execution claims and bounded resume
  attempts, with explicitly at-least-once recovery. Integrate diagnostics and safe
  tool-history lowering with those claims instead of porting V1 ownership logic.
- Conversation compaction's token/summary-output guards are a separate concern
  and do not replace snapshot resource budgets.

## Shared-server deployment

Deploy server, schema, browser, and TUI changes together so omission markers are
visible. No database migration, historical deletion, dependency upgrade, or
service-memory-limit change is required. Drain or explicitly interrupt active
work before a controlled restart; do not reset a running session's Git baseline.
Do not alter the separate active migration checkout as part of deployment.

Check recovery phase diagnostics after restart. A failed recovery should remain
`recovery_needed` until explicit continuation or use of a clean new session;
uncertain commands must not be retried automatically. Clients reading historical
events larger than 16 MiB will receive an explicit transport failure and may need
a current-cursor connection or separate exact archival inspection. Do not repair
that by deleting or editing production rows. The limits reduce a known risk path;
continue monitoring total process/cgroup memory to investigate the original OOM.
