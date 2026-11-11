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
| `--max-payload-bytes N` |      16777216 | One-payload read cap; maximum 67108864                      |
| `--page-rows N`         |           128 | Metadata page size; maximum 1024                            |
| `--min-free-bytes N`    |    1073741824 | Free-space reserve, plus three times the maximum row budget |
| `--checkpoint-rows N`   |            32 | Checkpoint after this many updates; maximum 1024            |
| `--max-wal-bytes N`     |      33554432 | WAL checkpoint threshold; maximum 67108864                  |
| `--busy-timeout-ms N`   |          5000 | SQLite lock wait; maximum 60000                             |

`--max-converted` counts verified profitable rows, including in dry-run; it
does not count merely eligible rows. Metadata scans use `octet_length()` and
keyset pagination over signed 64-bit implicit rowids. At most one capped TEXT
payload is loaded at a time. SQLite `json_valid`, fatal UTF-8 decoding, exact
raw UTF-8 round-trip comparison, shared `EventData.encodeJson`, and exact
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

## Operator Procedure

The following is an operator-run production maintenance procedure, not work
performed by a development session. Do not run these commands against a live
database or from an OpenCode development process.

1. Before accessing any database, confirm the intended maintenance host and
   working-copy filesystem have sufficient free space and enforce the process
   memory limit. Under systemd, the recommended operator unit limits are
   `MemoryMax=2G` and `MemorySwapMax=0`; verify the effective cgroup limits
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
systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 \
  sh -eu -c '
    cg=$(awk -F: '\''$1 == "0" { print $3 }'\'' /proc/self/cgroup)
    test -n "$cg"
    test "$(cat "/sys/fs/cgroup$cg/memory.max")" = 2147483648
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
