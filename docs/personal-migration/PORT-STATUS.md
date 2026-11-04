# Personal V1 to V2 port status

## Scope and evidence rules

- Active checkout: `/home/savochek/ExternalProjects/opencode-v2.2.5`, branch `personal-v2.2.5`.
- Released V2 base: `9bbb8ce18c80f099e0e448775f59d965ead40a21` (`v2.2.5`). No tracking of upstream `dev` during this port.
- Audited V1 HEAD: `2931c950db2ac2c499ab10bf509239d1c6c69963`. V1 sources are read-only Git objects. Individual historical feature commits remain mapped in the archive's `commit-coverage.csv` and `source-delta-coverage.csv`.
- Reference archive: `OpenCode-V2-Migration-Kickoff-2026-11-04.tar.gz`, SHA256 `a62745a12f378e77c0f8b33f1a714baebd8b2ccf5eaeb03c1109104b083b79ba`. Extracted reference files are read-only, outside this checkout.
- `source-only` means selected production/test source was inspected, not that acceptance passed. `partial` is not parity. No feature is yet `verified` or `native-verified`.
- Normalized acceptance IDs use `F026/A02`, including source spellings such as `A-02` and `AC-02`. Only the assertions listed below have execution evidence. All other acceptance candidates remain **NOT RUN**, not implicitly passed.
- All runtime checks use disposable HOME/XDG/database fixtures. No installed binary replacement, user database migration, live service restart, model account, real WorkQueue, managed namespace, production Serve, push, rebase, merge or deployment has been performed.

## All-feature inventory

Every row refers to the audited V1 HEAD above. `-` means no port commit, not native equivalence. Batch IDs resolve in the batch log below.

| Spec | Status         | V2 port | Remaining contract / next dependency                                                                                                  |
| ---- | -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| F001 | source-only    | -       | Durable bookmarks absent from inspected paths; session projection, API and Home collection needed.                                    |
| F002 | source-only    | -       | Local transcript/title search is not a global persisted transcript index; indexing and exact-target integration needed.               |
| F003 | source-only    | -       | Native search/hash navigation does not establish the chronological prompt-history picker.                                             |
| F004 | source-only    | -       | Native tool disclosures do not establish complete retained raw request/response or reversible formatting.                             |
| F005 | needs-decision | -       | Native relative time differs from second-precision creation/start clocks; presentation decision and tests needed.                     |
| F006 | needs-decision | -       | Native first-admission-wins retries conflict with V1 changed-payload conflicts. Preserve native repository contract pending decision. |
| F007 | source-only    | -       | Web queue acknowledgment/draft ownership, stable identity/reorder and revision races depend on F006.                                  |
| F008 | source-only    | -       | Full-screen queue manager, key consumption and owning-session destination need TUI validation.                                        |
| F009 | source-only    | -       | Native recovery claims are not fenced external-effect ownership or uncertain-tool/child recovery parity.                              |
| F010 | source-only    | -       | Server-wide drain/admission/listener lifecycle and initializer interruption need isolated process tests.                              |
| F011 | source-only    | -       | Native bounded retry differs from repeated typed-429 policy; parser/deadline/recovery tests needed.                                   |
| F012 | source-only    | -       | Attempt/deadline-bound one-shot manual wake and UI races depend on F009-F011.                                                         |
| F013 | source-only    | -       | Location-scoped MCP connection is not a durable session grant across every model-facing lookup.                                       |
| F014 | source-only    | -       | Native OAuth happy path does not establish replacement-attempt ownership and stale credential completion safety.                      |
| F015 | source-only    | -       | Worktree backend exists; external discovery, request capture and actual execution isolation need assertions.                          |
| F016 | source-only    | -       | Deep child navigation, unavailable child model handling and explicit Default depend on F009/F036.                                     |
| F017 | needs-decision | -       | Choose globally shared explicit project ordering versus native client-local visibility. Never copy V1 malformed-storage data loss.    |
| F018 | source-only    | -       | Persisted Enter/newline preference not established; integrate native shared editor/settings policy.                                   |
| F019 | source-only    | -       | Native workspace selector is a candidate replacement, not yet proven against production/destination assertions.                       |
| F020 | needs-decision | -       | V1 protocol support decision separate from isolated reconnect/draft/generation validation.                                            |
| F021 | needs-decision | -       | Native raw/operation-ID API CLI is not an offline nested catalog; choose command shape before generation changes.                     |
| F022 | source-only    | -       | Snapshot capture cap is not an expensive-diff guard; opt-in bounded diagnostics not established.                                      |
| F023 | partial        | setup   | Frozen dependency install and baseline checks pass; safe artifact replacement/fullstack harness contracts not implemented.            |
| F024 | needs-decision | -       | Permanent retirement is not Stop/Archive/Delete; managed threat model and ancestry barriers unresolved.                               |
| F025 | needs-decision | -       | Opt-in Linux containment, durable start permits and independently confirmed descendant cleanup require security design.               |
| F026 | partial        | B01     | Read-only V2 admission gate and focused regressions implemented; historical-stage/FK/graph/upgrade matrix incomplete.                 |
| F027 | needs-decision | -       | Managed model leases/provenance and capability gating are not native execution recovery claims.                                       |
| F028 | needs-decision | -       | Requires trusted operator-pinned WorkQueue identity, directory binding and durable post-dispatch uncertainty.                         |
| F029 | needs-decision | -       | Signed historical enrollment/pruning requires owner-provided signing authority; no invented cleanup evidence.                         |
| F030 | needs-decision | -       | Managed child reservation/authority and same-runner compression depend on F024/F027.                                                  |
| F031 | needs-decision | -       | Dedicated workspace route/tool/event boundary and independent read-only Git snapshot need security design.                            |
| F032 | source-only    | -       | Actual V2 client permit/transaction cancellation and contention assertions still needed.                                              |
| F033 | source-only    | -       | Native shell/job/process ownership needs progressive-output and bounded cleanup assertions.                                           |
| F034 | source-only    | -       | V1 OCEZ event BLOBs need explicit logical import/replay validation, not a wholesale codec transplant.                                 |
| F035 | source-only    | -       | Reuse native Schedule; calendar/DST/catch-up/delivery/selection matrix depends on F006/F009/F036.                                     |
| F036 | source-only    | -       | Native selection is not inline control/editor materialization, queued capture or explicit Default parity.                             |

## Setup and baseline

Commands ran from the active checkout or the stated package directory. The reference integrity checks are documentation checks, not application parity.

| Result | Command / boundary                                                                                                                                             | Evidence                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| PASS   | Reference directory: `sha256sum -c SHA256SUMS`; `python3 validate_collection.py`                                                                               | 36 specs/manifests, 1,384 acceptance candidates, 310 diagnostics; no integrity errors.                                                  |
| PASS   | Root: `bun install --frozen-lockfile --ignore-scripts` under `env -i` and a disposable profile                                                                 | 1,797 packages installed; lockfile unchanged; lifecycle scripts intentionally skipped. Stale optional dependency patches were warnings. |
| PASS   | Root: `bun run check` under `env -i` and a disposable profile                                                                                                  | Baseline lint/SDK docs and all 35 typecheck tasks passed; preexisting unused-suppression/postinstall warnings only.                     |
| PASS   | `packages/core`: `bun run script/test.ts test/database-migration.test.ts test/database-drizzle.test.ts test/sqlite-workerd.test.ts test/sqlite-bundle.test.ts` | Baseline 38 tests, 77 assertions. Native runner isolates HOME/XDG/TMPDIR and uses in-memory default DB.                                 |
| SKIP   | Windows runtime and production/mixed historical database migration                                                                                             | Not executed on this Linux host; no production data inspected.                                                                          |

## B01: read-only V2 database admission

Commit: B01, with its exact SHA to be recorded in the next ledger update. Source is derived from V2 migration `20260804233008_loose_psylocke` and V2's actual journal handling, not V1's table lifecycle map. V1 comparison: `packages/core/test/database-compatibility.test.ts` at the audited V1 HEAD, especially coherent snapshot, rollback failure, byte-preserving refusal and supported-journal assertions. V1 tests were inspected, **not executed**.

The gate runs on an independent read-only, no-create connection before file permissions, writable open, WAL/checkpoint tuning or journal seeding. It inspects schema and effective journal in one read transaction, rejects unrelated databases, unknown migration IDs/timestamps, missing completed split-V2 table and the migration's known V1-only-history refusal. It recognizes the 19 retired native V2 journal IDs removed by `0fbe489e35`, which supported databases retain. Read-only Bun clients no longer request creation/readwrite/WAL by default. Generic SQL adapters and injected workerd storage do not acquire V1-specific application-schema checks.

Review pass 1 found that the initial allowlist incorrectly refused those retired IDs. Both new positive regressions failed before the correction; the complete retained pre-split journal and a current database retaining that journal now pass. These synthetic admission/reopen fixtures are not a historical-file upgrade certification.

Review pass 2: **PASS**, no actionable findings. The reviewer independently ran the isolated 47-test, 117-assertion focused suite. Windows, full historical upgrades/schema/FK coverage and rollback/close-failure matrices remain unverified. Review stopped after this clean pass.

| Normalized candidates            | Actual V2 assertion                                                                    | Result / limit                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| F026/A02                         | `uses one snapshot for schema and journal inspection`                                  | PASS: writer commits an unknown journal entry after schema inspection; this snapshot passes, next snapshot refuses.      |
| F026/A03, A16, A18, A19          | `refuses previous V2-only lineage with V1 history without touching committed WAL`      | PASS: repeated refusal, path/reason, exact main/WAL bytes and retained history. V2-specific refusal, not every V1 shape. |
| F026/A04, A16, A19               | `Node admission refuses incompatible history before writable open`                     | PASS: actual Node process, bundled production Database layer, path/reason and exact main/WAL bytes.                      |
| F026/A05, A22                    | `admits new, empty and current databases and preserves data on reopen`                 | PASS: fresh, zero-byte, memory and current file reopen; preserved embedder data. Not a copied historical upgrade.        |
| F026/A09, A17                    | Unknown legacy timestamp and unrelated-database tests                                  | PASS: source bytes unchanged, no new migration journal, existing DELETE journal mode unchanged.                          |
| F026/A07, A09, A24               | Unknown migration ID / missing completed V2 table test                                 | PASS for these selected V2 shapes only.                                                                                  |
| F026/A08                         | Complete retained native V2 journal admission and current-file reopen tests            | PASS for native V2 IDs retained before/after the split; no full legacy named/timestamp upgrade fixture.                  |
| F026/A01, A06, A10-A15, A20, A23 | Full historical-stage/FK/project graph, upgrade, failed rollback/close and leak matrix | NOT RUN / not covered by the focused gate. F026 remains partial.                                                         |

| Result        | Exact command from `packages/core`                                                                                                                                                | Evidence                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXPECTED FAIL | `bun run script/test.ts test/database-compatibility.test.ts` before implementation                                                                                                | Initial 3 regressions failed against release V2; writable startup altered source bytes or lacked preflight path diagnostic.                       |
| EXPECTED FAIL | `bun run script/test.ts test/database-compatibility.test.ts` before review correction                                                                                             | 7 pass, 2 fail: complete native pre-split and retained post-split journals were rejected.                                                         |
| PASS          | `bun run script/test.ts test/database-compatibility.test.ts test/database-migration.test.ts test/database-drizzle.test.ts test/sqlite-workerd.test.ts test/sqlite-bundle.test.ts` | Final gate after correction: 47 tests, 117 assertions; includes real Node runtime.                                                                |
| PASS          | `bun typecheck`                                                                                                                                                                   | Core source and tests, 1,859 files across two projects.                                                                                           |
| PASS          | `bun run script/test.ts test/database-compatibility.test.ts --rerun-each 10 --randomize --seed=2604`                                                                              | After correction: 90 tests, 400 assertions; repeated real Node runs and order randomization.                                                      |
| PASS          | Root: `bun run check` under a disposable profile                                                                                                                                  | All 35 typecheck tasks, lint and SDK docs pass. Both baseline and final lint report 1,347 warnings and zero errors; no new-file lint diagnostics. |

## Next work and nonproduction migration plan

1. Record B01's verified SHA/trailers, then test native permit handoff/rollback under F032 before changing its implementation.
2. Audit F023 artifact staging and F034 logical import/replay before any real migration. Keep source fixture bytes/checksums and schema/journal provenance. Read-only admission is not migration authorization.
3. Build disposable synthetic/copied-and-redacted V1 fixtures for selected historical stages. Verify bookmarks, event payload decoding, retained history/relationships/order and V2 projections independently. Refuse unsupported shapes; never modify the source copy.
4. Exercise the feasible P0/P1 dependency graph with synthetic providers, loopback servers and fake clocks. No account-backed quota testing or real WorkQueue dispatch.
5. Resolve native-contract/product decisions and the managed security threat model before exposing new authority. Native overlap and source-only audits cannot close these gates.
6. Only after those results, propose a separate owner-approved deployment/migration rehearsal. This run has no production authorization.
