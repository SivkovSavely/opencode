# Offline historical event compression

`script/event-compress.ts` is an explicit maintenance utility for converting
profitable historical `event.data` TEXT payloads to the V1 OCEZ BLOB format.
It is standalone: it is not run by application startup or migrations, does not
touch other JSON columns, and does not rename, delete, replace, or vacuum a
database. Normal event writes use the codec policy documented in
[`../src/event/README.md`](../src/event/README.md); this utility does not change
that policy or imply that historical rows are converted automatically.

Run commands from `packages/core`. Use only a separately named, isolated
working copy, never a production, reference, NAS, or pristine backup database.
The designated disposable development copy is suitable for bounded testing.
The utility rejects protected database basenames before
filesystem access, missing paths, URI paths, symlinks in the path, non-regular
files, hard-linked databases, and unsafe sidecars. It never creates a database.

## Modes and limits

```sh
bun script/event-compress.ts --db /absolute/path/to/event-working-copy.db --dry-run --max-scanned 1000
bun script/event-compress.ts --db /absolute/path/to/event-working-copy.db --write --offline --max-converted 100
```

The bounded dry run is immutable and read-only. It uses SQLite immutable mode
and refuses any `-wal`, `-shm`, or `-journal` sidecar; it will not ignore WAL
state. Prepare a checkpointed, closed, sidecar-free copy before dry-run. Write
mode requires the explicit `--offline` acknowledgement and permits only safe
regular sidecars for SQLite crash recovery. Do not remove sidecars to get past a
refusal. Close all other connections to the working copy.

Options (byte values are bytes):

| Option                  |       Default | Limit / meaning                                             |
| ----------------------- | ------------: | ----------------------------------------------------------- |
| `--db PATH`             |      required | Existing database file; use a separately named copy         |
| `--dry-run`             | required mode | Immutable read-only analysis; refuses all sidecars          |
| `--write --offline`     | required mode | Mutates only the acknowledged isolated copy                 |
| `--max-scanned N`       |     unlimited | Stop after N rows examined, including skipped rows          |
| `--max-converted N`     |     unlimited | Stop after N verified profitable rows, in either mode       |
| `--max-payload-bytes N` |      16777216 | One-payload read cap; maximum 1073741824 (1 GiB)            |
| `--timings`             |           off | Bounded phase statistics by original payload size           |
| `--page-rows N`         |           128 | Metadata page size; maximum 1024                            |
| `--min-free-bytes N`    |    1073741824 | Free-space reserve, plus three times the maximum row budget |
| `--checkpoint-rows N`   |            32 | Checkpoint after this many updates; maximum 1024            |
| `--max-wal-bytes N`     |      33554432 | WAL checkpoint threshold; maximum 67108864                  |
| `--busy-timeout-ms N`   |          5000 | SQLite lock wait; maximum 60000                             |

`--max-converted` counts verified profitable rows, including in dry-run; it
does not count merely eligible rows. Metadata scans use `octet_length()` and
keyset pagination over signed 64-bit implicit rowids. At most one capped TEXT
payload is loaded at a time. Native `isUtf8`, SQLite `json_valid`, shared
`EventData.encodeBytes`, and exact
decompression round-trip are checked before any update. Each write is one row
per transaction, guarded by the original TEXT bytes, must change exactly one
row, and is read back before commit. The write run retains an exclusive
connection lock, uses WAL with `synchronous=FULL`, disables autocheckpoint, and
truncates/checks the WAL at start, end, periodically, and at the size
threshold. A blocked or incomplete checkpoint fails the run. WAL can exceed
the threshold by one bounded transaction.

Existing BLOBs are skipped without validation. Small TEXT rows and rows above
the payload cap are also skipped without validation. Restarting safely rescans
from the beginning; there is no cursor file, and already-converted BLOBs are
left untouched. Earlier committed rows remain committed on failure or
interruption. Exit status is 0 for success or a bounded stop, 1 for safety or
SQLite failure, 2 for usage errors, 130 for SIGINT, and 143 for SIGTERM.

Progress and final JSON summaries contain counts and byte totals, not payload
contents. `savedBytes` is the reduction in event payload bytes (potential
savings in dry-run), not a prediction of database-file shrinkage. `peakRssBytes`
is sampled process RSS. The utility does not vacuum or compact the database.

### Runtime limits and memory

The unchanged default is 16 MiB. The accepted 1 GiB configuration ceiling is
**not a promise that the engine can process a 1 GiB payload**. Bun 1.4.4 embeds
SQLite 3.53.4 with `MAX_LENGTH=1000000000` (about 953.67 MiB). SQLite applies
that limit to the **entire encoded row**, including its other columns and
record header, so the usable payload ceiling is smaller and schema-dependent.
A 1024 MiB row is impossible with this build. The tool checks engine metadata
and fails safely on engine errors; it never truncates a payload or changes
SQLite's build/runtime limits. See [SQLite limits](https://www.sqlite.org/limits.html).

This Bun reports Buffer `MAX_LENGTH=4294967296` and string
`MAX_STRING_LENGTH=2147483647`; these are implementation ceilings, not safe
allocation budgets. The offline path now validates and compresses the original
UTF-8 bytes without constructing a full JS string or re-encoding it. Native
Zstd level 3 still allocates compressed output, and the codec allocates the
OCEZ envelope and checksum. SQLite loading/binding, JSON validation, compression,
framing, and bounded decompression can hold several row-sized allocations at
once. Native compression has no exposed output-memory cap; the cgroup is the
hard stop. The 41-byte OCEZ v1 header and four-byte original-length field are
unchanged. Runtime allocation failures stop the run; a cgroup OOM kill can
prevent graceful reporting, but SQLite retains transaction atomicity.

Large-payload runs require a verified cgroup-v2 scope with `MemoryMax=8G`
(`memory.max=8589934592`) and `MemorySwapMax=0`. Never remove the limit to get
past a failed run. Sampled RSS may miss transient peaks; the synthetic benchmark
also reports Linux `/proc/self/status` `VmHWM`, cgroup `memory.peak` if available,
and `memory.events` OOM/kill deltas. Cgroup peaks are scope-wide, not per-row RSS.

### Optional phase timings

```sh
bun script/event-compress.ts --db /absolute/path/to/event-working-copy.db \
  --dry-run --timings --max-payload-bytes 134217728 --max-scanned 1000
```

Use the verified 8 GiB wrapper below for large payloads. `--timings` preserves
the single final JSON record on stdout, adds its `timings` field, and prints a
human-readable summary on stderr. Without the flag, the existing output shape
and progress behavior are unchanged. Progress is still throttled, not per-row.
No payloads are logged.

Monotonic `performance.now()` measures payload loading; UTF-8/JSON validation;
Zstd compression **plus envelope construction and checksum**; bounded
decompression and exact-byte comparison; UPDATE/readback/commit; row-triggered
checkpointing; and complete candidate processing. Compression time is not total
processing time. Total row time includes safety checks and row-triggered WAL
work, but excludes metadata pagination, startup/final checkpoints, and connection
close. All checkpoints are also reported separately; `elapsedMs` includes
startup, metadata scanning and the final checkpoint, but not connection close.
Only successfully processed candidates, including nonprofitable attempts,
contribute observations. Failure stops the run rather than fabricating a sample.

Buckets have inclusive lower and exclusive upper bounds, except the final
inclusive 1024 MiB ceiling: 4-16 KiB, 16-64 KiB, 64-256 KiB, 256 KiB-1 MiB,
1-4 MiB, 4-16 MiB, 16-64 MiB, 64-128 MiB, 128-256 MiB, 256-512 MiB,
512-1024 MiB. Empty buckets are omitted. Each populated bucket reports row and
byte counts, retained-output savings, aggregate compression MiB/s, and per-phase
count, sum, mean, population standard deviation, minimum, maximum, median and
p95. Retained output includes the envelope when profitable, otherwise the
original TEXT size. Unexecuted phases have count zero and null percentiles.

Percentiles are approximate upper histogram boundaries: 512 fixed bins per
phase, 16 bins per doubling in microseconds (about 4.5% relative resolution plus
1 microsecond). Very long phases overflow the final bin and use the observed
maximum as the bound. Storage is fixed at 78 histograms of 512 counters, about
312 KiB plus metadata, regardless of row count. Means/totals/minima/maxima are
not sampled. Small sample counts cannot establish reliable tail latency; do
not interpret a three-row p95 as a population estimate. Instrumentation has
overhead, especially for small rows, and payload entropy affects throughput.

### Explicit synthetic benchmark

This separate facility accepts no database path and creates only its own
temporary synthetic databases. It refuses to allocate payloads unless it
verifies the exact 8 GiB/zero-swap scope from inside the process. Start small:

```sh
systemd-run --user --scope --expand-environment=no \
  -p MemoryMax=8G -p MemorySwapMax=0 \
  bun script/event-compress-benchmark.ts --run \
  --sizes-mib 1,4,16 --classes repetitive,structured,entropy --repetitions 3
```

Then request increasing sizes `64,108,128,256,512,1024` only with adequate
headroom. The harness checks conservative disk/memory budgets, runs fresh
sequential worker processes, and stops escalating after a failed trial. It skips
engine-incompatible sizes before allocating them. Add `--write` for synthetic
write/commit/checkpoint measurements. Normal core tests never run this benchmark.
SIGINT/SIGTERM stops and joins the active worker, removes its owned temporary
fixtures, and exits 130/143 without starting more trials. Uncatchable SIGKILL or
cgroup OOM can prevent cleanup; inspect only the abandoned synthetic temporary
directory before removing it, never unrelated databases or backups.
JSONL trial records include sample size/class, individual phase timings, ratio,
RSS and cgroup telemetry. Grouped summaries report sample count, mean, population
standard deviation and range, not statistically reliable tail estimates.

Classes are repeated text, varying synthetic diff/output-like text, and random
base64-like ASCII (six bits per character). The last class is poorly compressible
relative to the others, not incompressible binary. They are not real workload
samples. Any size-to-time prediction must be explicitly labeled, report its
class and fit range, account for fixed overhead, and distinguish compression
from total processing. Extrapolation does not override engine limits or predict
write/fsync latency. Do not assume one universal linear throughput.

### Local synthetic observations

Measured on an AMD Ryzen 7 7700X with Bun 1.4.4 and SQLite 3.53.4, under verified
8 GiB/zero-swap scopes. There were 72 read-only trials and nine 108 MiB write
trials. Every measured size/class has **three** fresh-process repetitions. The
values below are mean ± population standard deviation in milliseconds;
throughput is aggregate input MiB divided by aggregate compression seconds.
"Compression" includes the unchanged OCEZ envelope and checksum, not just the
native Zstd call. "Total" is complete candidate processing as defined above,
not fixture generation, process startup, or whole-command wall time.

| MiB | Class     | Compression ms | Read-only total ms | Output/input |   Saved | MiB/s |
| --: | --------- | -------------: | -----------------: | -----------: | ------: | ----: |
|   1 | Repeated  |    0.36 ± 0.02 |        4.49 ± 0.39 |      0.00017 | 99.983% |  2761 |
|   1 | Diff-like |    0.75 ± 0.07 |        4.62 ± 0.21 |      0.02533 | 97.467% |  1333 |
|   1 | Entropy   |    1.73 ± 0.30 |        7.24 ± 0.69 |      0.75072 | 24.928% |   580 |
|   4 | Repeated  |    0.99 ± 0.14 |       17.11 ± 2.05 |      0.00011 | 99.989% |  4058 |
|   4 | Diff-like |    2.55 ± 0.18 |       18.06 ± 2.20 |      0.01994 | 98.006% |  1568 |
|   4 | Entropy   |    5.11 ± 0.16 |       22.41 ± 0.82 |      0.75029 | 24.971% |   782 |
|  16 | Repeated  |    2.61 ± 0.26 |       58.80 ± 1.37 |      0.00010 | 99.990% |  6121 |
|  16 | Diff-like |   10.01 ± 1.00 |       69.44 ± 4.78 |      0.03091 | 96.909% |  1598 |
|  16 | Entropy   |   22.01 ± 0.62 |       84.62 ± 2.50 |      0.75018 | 24.982% |   727 |
|  64 | Repeated  |    9.92 ± 1.61 |      307.41 ± 7.62 |      0.00009 | 99.991% |  6450 |
|  64 | Diff-like |   37.83 ± 0.81 |     313.16 ± 10.15 |      0.03607 | 96.393% |  1692 |
|  64 | Entropy   |   75.13 ± 0.59 |      364.53 ± 5.90 |      0.75015 | 24.985% |   852 |
| 108 | Repeated  |   14.20 ± 1.24 |     435.34 ± 14.43 |      0.00009 | 99.991% |  7605 |
| 108 | Diff-like |   60.99 ± 2.68 |     519.09 ± 19.93 |      0.03018 | 96.982% |  1771 |
| 108 | Entropy   |  137.37 ± 5.34 |      645.92 ± 4.85 |      0.75015 | 24.985% |   786 |
| 128 | Repeated  |   17.49 ± 3.10 |     578.11 ± 22.12 |      0.00009 | 99.991% |  7319 |
| 128 | Diff-like |   65.37 ± 1.99 |     583.22 ± 16.65 |      0.02831 | 97.169% |  1958 |
| 128 | Entropy   |  152.83 ± 2.09 |      715.80 ± 6.65 |      0.75015 | 24.985% |   838 |
| 256 | Repeated  |   30.60 ± 0.80 |    1132.17 ± 19.01 |      0.00009 | 99.991% |  8366 |
| 256 | Diff-like | 131.33 ± 10.53 |    1237.27 ± 58.51 |      0.02323 | 97.677% |  1949 |
| 256 | Entropy   |  401.59 ± 2.22 |    1555.85 ± 22.40 |      0.75015 | 24.985% |   637 |
| 512 | Repeated  |   65.12 ± 3.54 |   2380.41 ± 127.02 |      0.00009 | 99.991% |  7862 |
| 512 | Diff-like |  239.02 ± 8.73 |   2511.63 ± 106.67 |      0.02136 | 97.864% |  2142 |
| 512 | Entropy   | 826.54 ± 31.31 |   3318.20 ± 138.10 |      0.75015 | 24.985% |   619 |

Three observations do not support reliable median/p95 claims or confidence
intervals. For example, 512 MiB entropy compression ranged from 789.95 to
866.43 ms. These synthetic classes do not predict the production distribution.
Peak kernel process RSS across all trials was **3033.3 MiB**, sampled compressor
RSS **2615.8 MiB**, and scope-wide cgroup peak **3524.5 MiB**. They are different
high-water measurements, not additive. No allocation failure, OOM event, or
OOM kill occurred. Even the reduced-copy path needs several times the payload
size in memory; these observations do not establish a universal amplification
bound for arbitrary JSON or write workloads.

At 108 MiB, synthetic write-mode observations were:

| Class     | Compression ms | UPDATE/readback/commit ms | All checkpoints ms |    Row total ms |
| --------- | -------------: | ------------------------: | -----------------: | --------------: |
| Repeated  |   13.85 ± 0.28 |            150.15 ± 32.12 |      0.210 ± 0.047 |  621.29 ± 70.03 |
| Diff-like |   57.62 ± 0.98 |             189.78 ± 3.84 |      2.390 ± 0.116 |   691.63 ± 7.30 |
| Entropy   |  127.23 ± 1.60 |            455.28 ± 21.26 |     59.607 ± 0.641 | 1139.01 ± 26.20 |

Write-mode kernel RSS peaked at 977.3 MiB, cgroup usage at 1194.7 MiB, and WAL
at 81.69 MiB. Startup/final checkpoints are in the checkpoint column but outside
row total. These timings do not predict storage/fsync latency on another disk.

**1024 MiB was not tested and is not supported by this SQLite build.** All nine
requested 1024 MiB trials were skipped before allocation. The maximum successfully
tested size was **512 MiB**, not a claim that every smaller row is processable.
For planning only, a local affine extrapolation from the 256/512 MiB means,
`t(1024) = 3*t(512) - 2*t(256)`, gives these **hypothetical, unverified** values:

| Class     | Extrapolated compression ms | Hypothetical read-only pipeline ms |
| --------- | --------------------------: | ---------------------------------: |
| Repeated  |                         134 |                               4877 |
| Diff-like |                         454 |                               5060 |
| Entropy   |                        1676 |                               6843 |

These are not executable 1 GiB SQLite measurements. The model does not force a
zero intercept: fixed overhead and size-dependent cost both matter. Fits to
the 1/4/16 MiB compression means have intercepts of 0.30/0.11/0.04 ms for the
three classes and slopes of 0.1460/0.6187/1.3681 ms per MiB. The local 256-512 MiB
slopes instead are 0.1349/0.4207/1.6599 ms per MiB. Fitted intercepts are
descriptive, not proven physical overhead; negative local intercepts are fit
artifacts. Different regimes and classes do not justify universal linear scaling.
The extrapolation has no measured confidence interval and must not be used to
infer 1 GiB support or full-backfill/fsync duration.

## Operator Procedure

The following is an operator-run production maintenance procedure, not work
performed by a development session. Do not run these commands against a live
database or from an OpenCode development process.

1. Before accessing any database, confirm the intended maintenance host and
   working-copy filesystem have sufficient free space and enforce the process
   memory limit. Under systemd, the recommended operator unit limits are
   `MemoryMax=8G` and `MemorySwapMax=0`; verify the effective cgroup limits
   before opening the database. The process RSS statistic is observational,
   not an enforcement mechanism.
2. Stop OpenCode and confirm no clients or other processes have production
   database connections. Use SQLite's backup API or another SQLite-safe backup
   procedure while the service is stopped. Preserve the pristine backup and
   NAS copy untouched. Do not make the working copy by copying a live database
   file with active WAL state.
3. After a clean checkpoint and closing every connection, make a fresh,
   separately named backup of the latest production database. Create a
   separate local working copy from that backup. A same-filesystem
   `cp --reflink=always --preserve=all` may be used only after checkpoint and
   close; verify the copy is independent and do not operate on the backup.
4. Run a bounded dry-run against the working copy, then review the counts and
   disk headroom. Only after that, run the full compressor against the copy
   under the verified memory limit. Do not target production. The bounded
   `--max-converted 100` example above is a write smoke sample, not a substitute
   for a full dry-run or full conversion.
5. After conversion, checkpoint and close the working-copy connection. Produce
   a separate compact output with SQLite `VACUUM INTO`; budget space for the
   original, fresh backup, working copy, compact output, copy-on-write
   allocation, and WAL. `VACUUM INTO` can change implicit rowids, so do not use
   a pre-compaction rowid cursor afterward.
6. Verify the compact output before cutover: run full `PRAGMA integrity_check`
   and `PRAGMA foreign_key_check`; confirm stable event count and logical event
   identity; compare exact original UTF-8 TEXT bytes with compressed bytes, or
   decode pre-existing OCEZ BLOBs to their original raw bytes. Do not treat
   JSON parse/stringify equality or rowid equality as proof. Also compare other
   tables and schema content and preserve sequence state. No new verification
   utility is provided here; if reliable streaming byte and logical-content
   comparisons are not available, require a separately reviewed verifier
   before cutover.
7. Confirm every client is stopped and all database connections are closed.
   Ensure the old database has been checkpointed and all SQLite sidecars are
   absent through normal SQLite close/checkpoint handling. Never blindly delete
   `-wal`, `-shm`, or journal files: stale sidecars must not be replayed onto a
   different database. Verify the deployed binary supports OCEZ BLOBs before
   starting it; older binaries are not downgrade-compatible. Keep a separate
   rollback copy of the original and stage the compact output as a `.next` file
   in the production directory, preserving ownership, mode, and required
   metadata. Flush the staged file and directory, then use one same-filesystem
   atomic rename/replace of `.next` over the database path. Do not implement
   cutover as two renames that leave the production pathname absent. Retain the
   original for rollback, then restart and validate service health without
   logging event payloads.

No production access, backup, conversion, verification, compaction, or cutover
is performed by this documentation or by the development session that authored
it.

### Command template for later maintenance

These commands are **not executed as part of development**. Substitute paths and
the actual service name. Use paths without SQL quote characters in the SQLite
commands below. Run as the database owner. Do not use the protected reference or
NAS backup as `BACKUP`, `WORK`, or `COMPACT`.

```sh
# Operator only. Stop the real service and every other database client first.
systemctl --user stop YOUR_OPENCODE_SERVICE || exit 1
PROD=/path/to/production/opencode.db
BACKUP=/local/maintenance/latest-before-compression.db
WORK=/local/maintenance/event-working-copy.db
COMPACT=/local/maintenance/event-compacted.db

# Review the result: busy must be 0 and every WAL frame checkpointed.
sqlite3 "$PROD" 'PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(TRUNCATE);' || exit 1
# The connection has closed. Abort if any sidecar remains; do not delete it.
for suffix in -wal -shm -journal; do test ! -e "$PROD$suffix" || exit 1; done
test ! -e "$BACKUP" && test ! -e "$WORK" && test ! -e "$COMPACT" || exit 1
cp --reflink=always --preserve=all -- "$PROD" "$BACKUP" || exit 1
cp --reflink=always --preserve=all -- "$BACKUP" "$WORK" || exit 1
```

Enforce and verify cgroup limits **inside the same scope** before invoking Bun.
For example, this Linux cgroup-v2 wrapper refuses to start without the requested
limits. Use it first with the bounded dry-run arguments, then with bounded write
arguments, then without run bounds only when ready for the full backfill:

```sh
systemd-run --user --scope --expand-environment=no -p MemoryMax=8G -p MemorySwapMax=0 \
  sh -eu -c '
    cg=$(awk -F: '\''$1 == "0" { print $3 }'\'' /proc/self/cgroup)
    test -n "$cg"
    test "$(cat "/sys/fs/cgroup$cg/memory.max")" = 8589934592
    test "$(cat "/sys/fs/cgroup$cg/memory.swap.max")" = 0
    exec bun script/event-compress.ts "$@"
  ' sh --db "$WORK" --dry-run --max-scanned 1000 --max-converted 100
# Repeat the same verified wrapper with:
#   --db "$WORK" --write --offline --max-scanned 1000 --max-converted 100
# Later full backfill, only on WORK, with no --max-scanned/--max-converted:
#   --db "$WORK" --write --offline
```

Review `oversizedRows` and `nonprofitableRows`; completion does not mean every
TEXT row became a BLOB. Increase the per-row cap only within the hard maximum
and after reviewing memory headroom. Never loop with `--max-scanned 1000` and
expect the scan to advance: every invocation intentionally starts at the beginning.

```sh
# Operator only, after the compressor succeeds and closes its connection.
sqlite3 "$WORK" 'PRAGMA wal_checkpoint(TRUNCATE);' || exit 1
for suffix in -wal -shm -journal; do test ! -e "$WORK$suffix" || exit 1; done
# VACUUM INTO output must not exist. It is separate from all source files.
test ! -e "$COMPACT" || exit 1
sqlite3 "$WORK" "VACUUM INTO '$COMPACT';" || exit 1
integrity=$(sqlite3 "$COMPACT" 'PRAGMA integrity_check;') || exit 1
test "$integrity" = ok || exit 1
foreign_keys=$(sqlite3 "$COMPACT" 'PRAGMA foreign_key_check;') || exit 1
test -z "$foreign_keys" || exit 1
before_count=$(sqlite3 "$BACKUP" 'SELECT count(*) FROM event;') || exit 1
after_count=$(sqlite3 "$COMPACT" 'SELECT count(*) FROM event;') || exit 1
test "$before_count" = "$after_count" || exit 1
```

Before cutover, require a reviewed **bounded streaming content verification** of
`BACKUP` versus `COMPACT`, ordered by stable event `id`, not rowid. Compare
`id`, `aggregate_id`, `seq`, and `type`, and compare exact serialized UTF-8 bytes
after bounded OCEZ decompression with header/checksum validation. Length-prefix
fields if hashing, to avoid ambiguous concatenations. Check stored byte length
before loading each payload, bound decompressed output, and fail rather than
silently skip an oversized or corrupt row. Also compare schema, all other tables,
and sequence/owner state. Counts, integrity checks, and the compressor's per-row
checks do not replace this end-to-end comparison. No general whole-database
verifier is shipped here: **do not cut over until this verification is available
and passes**.

```sh
# Operator only AFTER all verification passes, while every client remains stopped.
# Stage on the production filesystem. Retain an independent rollback original.
NEXT="$PROD.next"
ROLLBACK="$PROD.before-compression"
test ! -e "$NEXT" && test ! -e "$ROLLBACK" || exit 1
for db in "$PROD" "$COMPACT"; do
  for suffix in -wal -shm -journal; do test ! -e "$db$suffix" || exit 1; done
done
cp --reflink=always --preserve=all -- "$PROD" "$ROLLBACK" || exit 1
cp --reflink=always --preserve=all -- "$COMPACT" "$NEXT" || exit 1
cmp -s -- "$PROD" "$ROLLBACK" || exit 1
cmp -s -- "$COMPACT" "$NEXT" || exit 1
chown --reference="$PROD" -- "$NEXT" || exit 1
chmod --reference="$PROD" -- "$NEXT" || exit 1
# Preserve/check ACLs, xattrs and security labels separately if applicable.
production_device=$(stat -c %d -- "$PROD") || exit 1
staged_device=$(stat -c %d -- "$NEXT") || exit 1
test "$production_device" = "$staged_device" || exit 1
sync -f "$ROLLBACK" || exit 1
sync -f "$NEXT" || exit 1
sync -f "$(dirname "$PROD")" || exit 1
mv -T -- "$NEXT" "$PROD" || exit 1  # One same-filesystem atomic pathname replacement.
sync -f "$(dirname "$PROD")" || exit 1
systemctl --user start YOUR_OPENCODE_SERVICE || exit 1
```

After restart, check logs, session loading, event replay, and a small normal
write/read without dumping contents. Keep `ROLLBACK` and `BACKUP` until confident.
Rollback also requires stopping all clients, checkpointing/closing the current
database, confirming no sidecars, and staging/replacing from a **copy** of the
rollback original. Do not overwrite or consume the only rollback file.
