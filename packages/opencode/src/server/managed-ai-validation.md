# Managed AI Source Validation

The reusable `test/server/managed-ai-e2e.test.ts` exercises the **source** Serve
CLI through HTTP `prompt_async`, local model streaming, real managed bash,
durable accounting, and joined native sandbox cleanup. It does not restart or
deploy production Serve, launch/resume an orchestrator, or edit a protected Baila
checkout.

Run from `packages/opencode` in `/home/savochek/ExternalProjects/opencode`, branch
`personal-v1.18.29`, common Git directory
`/home/savochek/ExternalProjects/opencode/.git`:

```sh
bun test test/server/managed-ai-e2e.test.ts
OPENCODE_MANAGED_BAILA_FIXTURE=/absolute/verified/disposable-source bun test test/server/managed-ai-e2e.test.ts
bun typecheck
```

## Isolation and Evidence

Every run retains evidence under a new `/tmp/opencode/managed-ai-*` directory:
`events.jsonl`, `database.sqlite`, explicit config, copied workspace, and source
Serve stdout/stderr (`serve-0.log`, `serve-0.log.stderr`, and corresponding
`serve-1` files for the disposable restart).

The child environment is constructed fresh, not inherited. It has separate
HOME/test HOME, all four XDG homes, TMPDIR, absolute DB/config paths, managed
profile enabled, and an empty plugin allowlist. State is outside the workspace
and source checkout. Before **any HTTP request**, the harness checks the exact
DB path in startup diagnostics, `/proc/PID/environ`, and actual open DB file
descriptors. The historical credential-free loopback SSE model asserted bash as
the only advertised tool; no plugins or MCP servers were configured. The current
managed catalog also includes Task, Compress and Skill subject to configuration
and permissions.

The optional offline fixture is read-only input under `/tmp/opencode`. Every
top-level entry, including `.cargo`, is recursively copied without hardlinks
into a new workspace. Cargo uses the installed read-only nightly Rust toolchain,
`--locked --offline`, and sandbox-private `/tmp/baila-target`; no host Cargo home
or credentials are forwarded.

## Coverage

- Real output/file creation and exit 0; a deliberately failing Rust test exits 101.
- A 65-second command completes; 2 MiB output is bounded with explicit discarded-output metadata.
- Ordinary abort joins tool cleanup and reaches idle without retirement; a new model-issued bash command on the same root succeeds before permanent retirement and late-prompt rejection.
- Abort plus retirement, and retirement alone, drain detached descendants; delayed writes remain absent after confirmed cleanup.
- Retired roots reject late prompts with 409 without another model request.
- A provider response held until retirement cannot execute its stale tool request.
- A replacement runs in the same disposable workspace only after older roots drain.
- A disposable Serve restart preserves drained retirement and rejects prompts; an untracked historical root reports unknown.

The ordinary abort-and-resume case has independent ready/delayed-write markers,
waits past the detached child's write deadline after confirmed terminal tool
state and idle status, then checks fresh output, exit 0, and file creation on
the same root. The model mock and completion checks select the latest user turn,
so historical tools, errors, or assistant completions cannot satisfy the resumed
turn. The held-provider-response case tests an end-to-end cancellation boundary,
not every instruction-level native authorization race; focused native and
runtime-retirement tests cover those races.

## Compiler Diagnostics

The fixture-enabled run actually model-issues these commands from its copied
workspace; these are not direct launcher or direct Cargo substitutes:

```sh
cd baila-compiler && CARGO_TARGET_DIR=/tmp/baila-target cargo build --locked --offline
cd baila-compiler && CARGO_TARGET_DIR=/tmp/baila-target cargo test --locked --offline --lib identifier::tests
cd baila-compiler && CARGO_TARGET_DIR=/tmp/baila-target cargo test --locked --offline --lib
cd baila-compiler && RUST_MIN_STACK=67108864 CARGO_TARGET_DIR=/tmp/baila-target cargo test --locked --offline --lib -- --quiet
```

Build and identifier tests must exit 0. Both full-suite commands are explicitly
diagnostic: exit 101 may be recorded, but output must prove that tests started
and either report a test result or an explicit stack-overflow abort. Compilation
setup failures cannot pass as candidate test failures. Exit-0 test cases must
report a successful test summary with a nonzero passed count. All commands are
attempted and durable restart is verified before the final compiler assertion.
`case-result` events retain the command, elapsed time, exit, full bounded output,
and tool state; `baila-results` records each diagnostic's recognized outcome.
The increased-stack case uses quiet libtest output so the final summary remains
inside the tool's bounded output instead of being discarded behind test names.

## Recorded Results

### Ordinary Abort/Resume

The strengthened default run passed: **1 test, 0 failures, 842 assertions,
97.71 seconds**. Executed from `packages/opencode`:

```sh
env -u OPENCODE_MANAGED_BAILA_FIXTURE bun test test/server/managed-ai-e2e.test.ts
bun typecheck
```

Evidence: `/tmp/opencode/managed-ai-plFUOK/events.jsonl`, disposable DB, and both
Serve log pairs. Events `abort-cleanup-idle`,
`abort-cleanup-delayed-write-absent`, `case-result` with key `resume-success`,
and `abort-resume-verified` share root `ses_e6d4ef047ffeP25qBEWuw9qONV`.
The resumed tool returned `resumed-success`, exited 0, and created `resumed.txt`
with the expected content; only afterward was retirement verified and a late
prompt rejected with 409 without another model call. The existing default
runtime, race, restart, and historical-unknown checks also passed. Both owned
Serve processes exited **0** (PIDs 3579658 and 3611983). Typecheck and full-file
Prettier checks passed. This run intentionally omitted the expensive compiler
fixture; the previously recorded compiler evidence below remains unchanged.

### Copied Compiler

The prior fixture-enabled command above passed: **1 test, 0 failures, 3,593
assertions, 371.32 seconds**. Evidence: `/tmp/opencode/managed-ai-QWVKYZ`, including
`results.md`, `events.jsonl`, the disposable DB, and both Serve log pairs.
Assertion counts vary with HTTP polling iterations. Package `bun typecheck` and
Prettier checks passed.

| Model-Issued Case                      | Exit | Observed Result                                 | Admission-To-Completion |
| -------------------------------------- | ---- | ----------------------------------------------- | ----------------------- |
| Offline build                          | 0    | Dev build completed                             | 33.939 s                |
| Identifier tests                       | 0    | 8 passed, 0 failed, 1,141 filtered              | 37.978 s                |
| Ordinary full library suite            | 101  | 1,149 tests started; stack overflow and SIGABRT | 38.344 s                |
| Full suite, 64 MiB stack, quiet output | 0    | **1,149 passed, 0 failed**, untruncated summary | 172.962 s               |

The ordinary command fails in
`compile_time::engine::tests::a_coalescing_assignment_does_not_evaluate_its_right_hand_side`.
The increased-stack command completes the entire suite (test execution itself:
134.65 seconds). This establishes stack-size sensitivity in this staging
environment, not an unconditional ordinary-stack compiler pass. No direct Cargo
comparison outside the sandbox was performed, so the ordinary-stack failure is
not labeled a proven pre-existing candidate defect.

The 65-second tool completed in 65.231 seconds. Both cancellation/retirement
cases first reported draining, then drained; neither detached descendant wrote
its delayed file after cleanup. The stale provider response did not execute.
Replacement, late-prompt 409s, durable restart, and historical unknown checks
passed. Both owned Serve processes exited **0** (PIDs 3284042 and 3405706).

Earlier runtime-only evidence `/tmp/opencode/managed-ai-IrSZcq` passed in 88.19
seconds; the first header-fixed fixture run `/tmp/opencode/managed-ai-dNLXKR`
passed in 214.68 seconds while retaining the ordinary-suite stack-overflow
diagnostic. Earlier missing-header failures (`/tmp/opencode/managed-ai-irEvb7`)
occurred before Baila test bodies ran; the native owner fixed this by mounting
`/usr/include` read-only. A first increased-stack attempt
(`/tmp/opencode/managed-ai-R9TKbb`) exited 0 but failed the stronger harness
assertion because verbose output discarded the summary. Quiet libtest output
corrected the evidence gap in the final run; the output limit was not bypassed.

### Live External Provider Attempt

A separate credential-free attempt used the real Zen `opencode/big-pickle`
endpoint, `https://opencode.ai/zen/v1/chat/completions`. Evidence is retained at
`/tmp/opencode/managed-live-TE5fmU`: `events.jsonl`, `remote.jsonl`,
`transcript-success.json`, disposable database/config, and source Serve logs.
The same database/environment/open-FD isolation checks completed before the first
HTTP request. Only synthetic disposable workspace content was sent.

The provider received one request advertising only bash and returned HTTP 429:
`Free usage limit reached`. It returned no model text or tool call, and the
requested output file was not created. The 180-second completion budget expired
while Serve waited on its quota retry. The owned source Serve exited 0 on SIGTERM.
No credential fallback was attempted. This is a blocked live-model smoke test,
not a passing execution or retirement result. The successful integration results
above use a deterministic loopback model endpoint with real provider streaming,
HTTP admission, tool execution, process cleanup, and durable retirement.

## Package Validation

All commands ran from the affected package directory, never the repository root:

- Core: full managed-command, runtime-retirement, session-execution-retirement,
  database recovery/migration/compatibility, and session-create files:
  **204 passed, 0 failed**. V2 managed-execution rejection: **1 passed**.
- OpenCode: full native launcher, managed-execution, runtime lifecycle/retirement,
  prompt, tools, and task files: **266 passed, 1 skipped, 0 failed**.
  Full HTTP queue file: **18 passed, 0 failed**.
- OpenCode: full provider file and config/MCP directories:
  **416 passed, 3 skipped, 0 failed**.
- After formatting the changed code, the full lifecycle/retirement/accounting,
  prompt, and MCP subset was rerun: **274 passed, 1 skipped, 0 failed**.
- `bun typecheck` passed in both `packages/core` and `packages/opencode`.
  `git diff --check` passed. Unrelated pre-existing formatting was preserved.

The suite totals above overlap the later subset rerun and are not cumulative.
Historical recovery semantics and consumer requirements are documented separately
in `runtime-retirement.md`; no production recovery evidence was fabricated.
