# Linux Managed Launcher

`managed-linux.ts` is an opt-in command primitive. It does not itself enable a
managed shell profile or register command ownership. Its caller supplies the
durable authorization fence and retains ownership until cleanup is confirmed.

## Ownership Contract

```ts
const handle = await ManagedLinux.prepare({
  workspace: disposableDelegatedDirectory,
  rustToolchain: installedToolchainDirectory,
  argv: ["cargo", "test", "--offline"],
  timeoutMs: 30_000,
  outputBytes: 1024 * 1024,
})
// prepare() validates inputs but creates no process and executes no command.
// Durably register ownership before publishing any permit.
if (!(await handle.startPaused())) {
  // Setup failed or cancellation won. Inspect completion and cleanup.
}
// Under the registry's synchronous retirement transaction/fence:
// recheck durable ownership and retirement, then call handle.authorize().
// true acknowledges a synchronous kernel write; false denies this attempt.
const published = handle.authorize()
// Outside the transaction, optionally await handle.authorizationAcknowledged.
const result = await handle.completion!
// Cancellation/retirement: await handle.cancel(), which also joins cleanup.
// Do not release registry ownership if result.cleanup !== "confirmed".
```

The precise handle interface is:

```ts
prepare(options: Options): Promise<{
  startPaused(): Promise<boolean>
  authorize(): boolean
  readonly authorizationAcknowledged: Promise<boolean>
  readonly completion: Promise<Result> | undefined
  readonly phase: "prepared" | "launching" | "ready" | "authorized" | "stopping" | "completed"
  start(): Promise<Result>
  cancel(): Promise<Result>
  [Symbol.asyncDispose](): Promise<void>
}>
```

`startPaused()` is idempotent and resolves true only when the namespace-init
identity is recorded and the trusted native helper has acknowledged its closed startup
gate. False means cancellation or failed setup; inspect `completion` for the
result. The promise records that readiness was observed, not that it still holds:
it remains true after later cancellation/completion. `completion` exists as soon
as launch/cancellation is requested. `prepare()` has no spawn or gate allocation.

`authorize()` is synchronous and never awaits a scheduler or buffered JS stream.
It writes one six-byte token to a nonblocking, empty FIFO; true positively
acknowledges the entire token was accepted by the kernel. False publishes no
token **in that call**, including repeated authorization, not-ready, stopped,
expired, completed, or broken-pipe states. It checks the monotonic timeout even
when a DB transaction blocks timer callbacks. This is a publication receipt,
not proof of peer consumption or exec success. A separate
`authorizationAcknowledged` promise resolves true when the helper confirms it read
the token, or false on completion without that acknowledgement. Never wait for
peer acknowledgement or cleanup while holding a synchronous DB transaction.

The registry must serialize its retirement check and `authorize()` under the
same durable retirement fence. Launch/setup and cleanup run outside that
transaction. Durable ownership must already exist before publishing a permit.
This primitive does **not** make a filesystem side effect transactional with a
database commit: rollback after successful authorization cannot undo user code.
The registry must retain recoverable ownership if its authorization transaction
rolls back, and must not equate a publication receipt with durable commit.
There is no built-in session identity, database, registry, or unregistration.

`Options.authorize?: (open: () => void) => Promise<boolean>` connects an external
ownership registry. `start(): Promise<Result>` is idempotent, launches and waits
for readiness, then calls this callback exactly once. The callback calls `open()`
synchronously under its durable retirement fence, and returns true only on
successful authorization. `open()` throws if the permit is no longer valid.
Returning false, returning true without opening, or throwing cancels and joins;
an exception is rethrown after cleanup. Cancellation/timeout does not wait for a
stalled callback, and a retained late `open` is revoked. Rejecting after opening
cannot undo user code; it only initiates teardown. Never rely on rollback to
retract a published permit.

Without the callback, `start()` is a standalone auto-authorizing shortcut,
including for a previously paused handle. Do not use that shortcut on a
registry-managed handle without supplying its fence. `startPaused()/authorize()`
remain available to callers that implement the fence directly; they intentionally
do not call `Options.authorize` on the caller's behalf.
`cancel(): Promise<Result>` is idempotent, synchronously revokes future
authorization and closes the gate, then kills and joins cleanup. Cancellation
before any successful authorization guarantees no user code, including while
launch is in flight. After publication it cannot promise code has not run.
`Symbol.asyncDispose` cancels and joins, throwing on failed cleanup. Callers must
inspect cleanup results even on ordinary command failure.

The command's stdin is `/dev/null`. Before fork/exec, the trusted helper requires a
positive token from the supervisor after it records the namespace-init identity.
EOF denies execution. This covers early supervisor death even before Bubblewrap
installs its parent-death signal. The command receives neither the gate nor the
Bubblewrap or native wait-report descriptors. Arguments are passed verbatim, not interpolated.
The FIFO is provisioned at launch by trusted `/usr/bin/mkfifo` in a private 0700
temporary directory and unlinked before spawning Bubblewrap. Only its blocking
read descriptor is inherited as stdin; the host alone owns the nonblocking write
descriptor. Fixed ready/authorized frames are stripped before output accounting.
An abrupt crash during provisioning can leave private temporary directories,
FIFOs and the helper binary, not an authorized command or reachable control socket.

## Actual Termination

At launch, trusted `/usr/bin/cc` compiles a small, fixed C source embedded in
`managed-linux-wait.ts`, using a private temporary directory and a cleared
environment. No project source, configuration, compiler flags or executable is
used during this host-side setup. `prepare()` still spawns nothing. The generated
helper is bound read-only at `/managed-wait`. Bubblewrap's PID-1 reaper remains in
place; the helper forks the actual argv process and uses `waitpid` on that child.
It exits after reporting, so ordinary completion still triggers namespace-wide
descendant destruction.

The helper opens a private FIFO in a narrowly bound disposable control directory
at `/run/managed`, unlinks it **before** acknowledging the closed gate, and sets
`PR_SET_DUMPABLE=0` before admitting any child. The FIFO is not opened in any
Bubblewrap ancestor. The child explicitly closes the report fd, sanitizes all
fds above stderr with `close_range`, and inherits no report or exec-error pipe
after exec. Non-dumpability and dropped capabilities prevent same-UID children
from reopening the parent's report fd via proc, ptrace or `pidfd_getfd`. Replacing
the now-unlinked FIFO pathname or printing JSON cannot affect the original
reporting channel. The control bind initially contains only that FIFO and is
empty before user code starts; user-created entries are disposable and cleanup
does not follow their symlinks. The binary and control directory are removed
after completion/cancellation. An abrupt host-process death can leave them behind.

```ts
interface TerminationResult {
  exitCode: number | null // Actual direct child's exit code, including explicit 143.
  signal: number | null // Actual Linux signal number, e.g. 15 for SIGTERM.
  termination:
    | { kind: "exit"; exitCode: number }
    | { kind: "signal"; signal: number; coreDumped: boolean }
    | { kind: "exec-error"; exitCode: 127; errno: number }
    | { kind: "unreported" }
}
```

Explicit exit 143 has `exitCode: 143, signal: null`; SIGTERM has
`exitCode: null, signal: 15`. The signal variant also carries the kernel's
`WCOREDUMP` flag, not proof that a core file was saved. An exec/sanitization error
is distinguished from a program explicitly exiting 127 by the exec-error pipe;
the pre-exec child actually exits 127 and the report includes Linux errno.
These fields describe the direct argv process, not an arbitrary nested command
whose status a shell might translate.

Missing reports, reporter death and namespace-wide SIGKILL leave
`termination: { kind: "unreported" }` and both fields null. No signal is ever
inferred from a shell convention or from cancellation. If a normal completion has
no raw report, `reason` is `setup-failed` (including reporter failure after user
code started), even when namespace cleanup is independently confirmed. Malicious
code can kill its same-UID reporter and lose status, but cannot thereby forge a
raw wait result. Timeout/cancellation can race a report that was already produced;
such a valid report is retained without changing the cancellation/timeout reason.

## Boundary

- Requires Linux and `/usr/bin/bwrap` with all requested flags and namespaces.
  There is no reduced-isolation fallback. Validated on Bubblewrap 0.13.0 with
  merged `/usr` (`/bin`, `/lib`, `/lib64` mapped to `/usr/bin`, `/usr/lib`). Other
  distributions/toolchains can fail; this is not a portable Linux runtime image.
- Requires Bun FFI, glibc `libc.so.6` exporting `pidfd_open`/`pidfd_send_signal`,
  `/usr/bin/cc`, `/usr/bin/mkfifo`, and Linux `close_range`. Missing support fails
  closed; there is no numeric-PID kill or lossy-status fallback. Validated with
  glibc 2.44 and GCC 16.2.1. Each launch compiles its helper; compilation/setup is
  trusted, joined work, not a sandboxed project build. Cancellation/expiry during
  setup prevents namespace launch but waits for this trusted work to finish.
  An abrupt host-process crash can leave these trusted setup helpers running
  until they finish; they have no project inputs or authorization to run user code.
- Mandatory user, PID, network, IPC, UTS, and cgroup namespaces; private proc and
  minimal devices; all capabilities dropped; further user namespaces disabled.
  Bubblewrap's PID-1 reaper is retained. `--die-with-parent` kills the namespace
  chain on supervisor death. New network namespaces include working loopback but
  no host interfaces or routes; host abstract Unix sockets are also isolated.
- Read-only binds: `/usr/bin`, `/usr/lib`, and optionally one Rust toolchain at
  `/toolchain`. User-data writable bind: the explicit workspace at `/work`. No host
  root/home bind, `/run`, host `/tmp`, `/etc`, sysfs/cgroupfs, manager socket,
  session bus, agent socket, resolver, host proc, or inherited extra descriptor.
  `/tmp`, HOME, Cargo home, and `/run` are private. No environment is inherited;
  only fixed HOME, PATH, TMPDIR, CARGO_HOME, and CARGO_NET_OFFLINE are supplied.
- The generated helper adds one read-only file bind and its private writable
  FIFO directory bind described above. No broad temporary-directory mount or
  host control socket is added. Its host temporary directory must not lie under
  the workspace; a conflicting `TMPDIR` is rejected before compilation.
- The workspace must be a **trusted, exclusively delegated staging directory**,
  not an arbitrary live repository or home. Existing special files and writable
  hard links are rejected recursively. Symlinks resolve within the sandbox's
  mount namespace. A host actor can still race validation, add a Unix socket,
  replace a mount source, or introduce a hard link. The caller must prevent that
  mutation for the complete handle lifetime. Runtime directories and toolchains
  must be trusted, static, socket-free installation trees. This is not safe for
  arbitrary concurrent host mutation or for exposing a directory already used
  by host services. Read-only binding a socket does not prevent connecting to it.
- All workspace changes persist and may be malicious. Host automation must not
  blindly execute generated scripts, load project config, follow new symlinks,
  or run build artifacts outside the sandbox. Offline Rust dependency resolution
  requires vendored dependencies already present in the workspace; no host Cargo
  credentials/cache, rustup home, or network download is exposed.

## Completion And Limits

Both output pipes are continuously drained with one combined retention budget
(default 1 MiB, maximum 16 MiB). Excess bytes are discarded and `truncated` is
reported. Byte buffers avoid claiming UTF-8 completeness across truncation.

Finite positive timeout is mandatory. Readiness requires a retained pidfd for
namespace init, captured against a pinned proc-directory start-time identity.
Timeout/cancellation kills init through that pidfd **before** killing the
Bubblewrap monitor; it does not depend solely on the monitor-death signal or use
a reused numeric PID. Cancellation during startup waits for identity capture;
an unobserved init falls back to monitor termination after the cleanup interval
and can never produce confirmed cleanup. `--die-with-parent` remains enabled for
host-process crashes, and gate EOF denies execution before authorization. On
ordinary main-process exit, Bubblewrap's reaper also exits and the kernel kills detached descendants.
Cleanup waits for the recorded host PID/start-time identity of namespace init to
disappear or become a zombie, and joins both pipe EOFs. Linux namespace-init exit
joins the remaining namespace tasks before zombie state. A missing identity,
observer error, I/O error, or cleanup observation deadline produces
`cleanup: "failed"`, never a successful teardown claim. A failed result is not
retryable through a new `start`; retain ownership and escalate externally.

`shellStatus` remains Bubblewrap's JSON `exit-code` for the helper, not the
monitor's process exit code or a raw wait status. The helper exits with the
command's shell-style status when reporting succeeds, so explicit exit 143 and
SIGTERM both produce 143 in this field; use `termination`/`exitCode`/`signal`
instead. Reporter failure or gate denial can produce a helper status without any
reported user-command termination. Without a JSON exit report it is null, even
if the monitor has an exit status. `supervisorSignal` records the actual
signal observed for the Bubblewrap monitor, separately from `reason` (exit,
timeout, cancellation, or setup failure). A missing command produces shell exit 127. Do not interpret nonzero status, timeout, or pipe EOF alone as cleanup.

There is no cgroup resource budget, seccomp syscall filter, disk quota, memory,
CPU, PID, or output-rate limit. Fork/memory/disk exhaustion and kernel exploits
remain risks; this is not a hostile multi-tenant service boundary. Uninterruptible
kernel tasks can prevent exit, so command timeout is not a hard wall-clock return
deadline. A process that already has only fatal signals pending can remain until
the kernel operation completes. No successful cleanup promise is made on a
crash because no live caller remains to observe it; supervisor-death tests verify
the kernel teardown behavior independently instead.

## Validation

From `packages/opencode`:

```sh
bun test test/tool/managed-linux.test.ts --timeout 45000
bun typecheck
```

Tests use only disposable directories. They compile a real Rust adversarial
probe and a separate offline Cargo project; exercise a positive registration
barrier, paused readiness, synchronous authorization, peer acknowledgement,
paused cancellation/death/timeout, blocked-timer deadline enforcement, bounded
stdout/stderr, distinct raw exit/signal reports despite ambiguous Bubblewrap JSON,
reporter death, inherited-fd/proc/ptrace/path/output report-forgery attempts,
private helper artifact removal, cancelled admission, timeout,
double-fork/setsid descendants ignoring signals, main exit with living children,
supervisor SIGKILL, immediate supervisor death before the gate opens, host IPC and
filesystem denial, external network denial, private loopback, and nested-userns
denial. Descendant death is checked independently through host `/proc`, not just
the launcher's returned result. No production project or external workload is
used.
