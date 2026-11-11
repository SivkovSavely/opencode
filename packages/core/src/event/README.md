# Durable event payload storage

Only `event.data` uses this codec. The column retains its existing `TEXT`
declaration; SQLite also permits BLOB values in that column. There is no schema
migration or automatic historical conversion. Opening a database does not
rewrite its events, and other JSON columns remain uncompressed. An explicit,
standalone offline utility for historical conversion is documented in
[`../../script/event-compress.md`](../../script/event-compress.md).

The Drizzle column mapper returns the same logical JSON object for both legacy
TEXT and compressed BLOB rows. Event IDs, versioned types, aggregate IDs, sequence
numbers, projectors, duplicate comparison, replay, and JSON synchronization retain
their existing contracts. Synchronization sends decoded JSON, never the storage
envelope. Raw SQL bypasses this mapper and must use `EventData.decode` itself.

## Write policy and format

JSON smaller than 4 KiB (4096 UTF-8 bytes) remains TEXT. Payloads at or above
4096 bytes are tried with native Zstandard level 3 and retained as BLOB only if
the complete encoded representation, including its 41-byte header, is strictly
smaller than the original JSON UTF-8 byte length. Even a one-byte net saving is
retained; equal-size or larger representations remain TEXT. Attempting
compression still costs CPU.

Version 1 is a 41-byte header followed by a standard Zstandard frame:

| Offset | Size      | Value                                              |
| ------ | --------- | -------------------------------------------------- |
| 0      | 4         | ASCII `OCEZ`                                       |
| 4      | 1         | Codec version `1`                                  |
| 5      | 4         | Original UTF-8 byte length, unsigned little-endian |
| 9      | 32        | SHA-256 of all compressed bytes                    |
| 41     | remaining | Zstandard frame                                    |

Unknown formats or versions, truncated or modified frames, length mismatches,
invalid UTF-8, and invalid JSON fail explicitly. The checksum detects accidental
corruption, not malicious tampering. Normal event schema validation still applies
after storage decoding.

Bun uses `zstdCompressSync` / `zstdDecompressSync`. Node uses the equivalent
`node:zlib` APIs (available starting in Node 22.15 / 23.8). Both function pairs are
feature-detected. A runtime without either native pair writes TEXT but explicitly
rejects compressed rows; it cannot fully use a mixed database. Interoperability
tests exercise real Bun and Node SQLite adapters, effect Drizzle and native
Drizzle, across database close/reopen. Tested locally with Bun 1.4.4 and Node
26.13.0. Older application binaries are **not downgrade-compatible** with this
representation: they may accept the unchanged schema and then fail reading BLOBs.
Do not downgrade a mixed database without a separately verified conversion.

## SQL diagnostics

SQLite's `json_extract(event.data, ...)` and other JSON functions no longer work
on compressed rows. Do not cast a compressed BLOB to TEXT. Inspect storage without
decoding using `typeof(data)` and `length(data)`; JSON-only queries must explicitly
handle TEXT rows, for example:

```sql
SELECT id, typeof(data) AS storage, length(data) AS stored_length,
       CASE WHEN typeof(data) = 'text' THEN json_extract(data, '$.sessionID') END AS session_id
FROM event;
```

For a single event, run from `packages/core`:

```sh
bun script/event-inspect.ts /path/to/isolated-or-approved.db evt_example
```

The script requires an explicit database filename and event ID, opens SQLite
read-only, and prints metadata plus decoded JSON. It bypasses the application
database layer: no migrations, WAL configuration, conversion, or checkpoint
commands. Decoded events can contain sensitive file contents and tool output.

Conversion back to TEXT for an older binary remains a separate maintenance
operation requiring its own backup, bounded restartable procedure, verification,
and compatibility testing. Do not downgrade a database containing OCEZ BLOBs
without that separately verified process.

## Persistence cost

Run `bun script/event-benchmark.ts` from `packages/core`. It creates and removes
temporary WAL databases and measures real `EventV2.publish` calls, including a
call inside an outer immediate transaction. Each case has 5 warmups and 25
measured iterations. Synthetic ASCII/UTF-8 diff and high-entropy cases cover
1, 4, 8, 16, 32, 256, and 1024 KiB targets. JSON escaping makes actual sizes differ
from the target.

Historical local medians under the former 16 KiB threshold and 25% minimum
savings policy, on Bun 1.4.4, WAL, `synchronous=NORMAL`, in microseconds:

| Payload                      | JSON / stored bytes    | Stringify | Codec encode | Publish total / writer lock | Outer transaction total / lock |
| ---------------------------- | ---------------------- | --------- | ------------ | --------------------------- | ------------------------------ |
| Diff ASCII, 16 KiB target    | 17,666 / 1,874         | 22        | 45           | 278 / 163                   | 313 / 292                      |
| Diff UTF-8, 16 KiB target    | 17,559 / 1,823         | 14        | 39           | 251 / 143                   | 250 / 229                      |
| Entropy ASCII, 16 KiB target | 16,422 / 16,422 (TEXT) | 13        | 64           | 236 / 157                   | 255 / 232                      |
| Diff ASCII, 1 MiB target     | 1,122,741 / 111,012    | 897       | 2,300        | 3,475 / 492                 | 3,213 / 3,139                  |
| Diff UTF-8, 1 MiB target     | 1,116,459 / 107,745    | 929       | 2,831        | 3,221 / 478                 | 3,066 / 3,026                  |

Under that former policy, near-threshold diffs saved about 89% with tens of
microseconds of encoding work, while the 25% savings gate kept these synthetic
entropy cases as TEXT. These measurements have not been rerun for the current
4 KiB / strictly-smaller policy. Results vary between runs and are not production
distribution or concurrent-writer benchmarks. Separate stringify timings are a
serialization reference, not a full legacy persistence baseline.

Event persistence prepares the storage representation before acquiring its own
`BEGIN IMMEDIATE` writer lock. If the caller already holds an outer transaction,
encoding necessarily occurs while that lock is held. The benchmark measures
lock duration from immediately after successful `BEGIN IMMEDIATE` through
successful `COMMIT` / `ROLLBACK`, including commit execution but excluding lock
acquisition wait. Native synchronous compression also occupies the runtime thread.
