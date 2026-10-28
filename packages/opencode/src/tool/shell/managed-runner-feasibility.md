# Local Managed Command Feasibility

Investigation on 2026-10-28 used the active checkout
`/home/savochek/ExternalProjects/opencode`. No shell execution path is enabled by
this document. Keep `OPENCODE_MANAGED_PROFILE=1` fail-closed.

## Observed Host Capabilities

- Linux 7.2.9-arch1-1, cgroup v2 mounted read-write, UID 1000.
- The OpenCode service is under
  `/user.slice/user-1000.slice/user@1000.service/app.slice/opencode-serve.service`.
- Its service properties are `Delegate=no`, `ProtectControlGroups=no`, and
  `KillMode=control-group`. Writable cgroup files do not authorize managing
  systemd's subtree without delegation.
- A disposable `systemd-run --user --property=Delegate=yes` service succeeded.
  Delegation is available through the user manager, not currently configured on
  the OpenCode service itself.
- systemd 262 and Bubblewrap 0.13.0 are installed. Bubblewrap successfully ran
  `/bin/true` with new user and PID namespaces and a private proc mount.

This host is not categorically incapable of containment. The blocker for a
safe, drop-in cgroup runner is the absence of an established isolation boundary
between the command and the same-user supervisor/control plane. A restricted
namespace sandbox or separately privileged broker would need its own design and
adversarial tests; the capability checks above do not validate either design.

## Actual Escape Probe

A disposable transient service was started with `Delegate=yes` and
`KillMode=control-group`. Its command invoked `systemd-run --user` to start a
second transient service running `/usr/bin/sleep 60`. Both manager environment
variables, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`, were explicitly
supplied to the first service.

The first service exited with status 0. Querying the second service afterward
returned `ActiveState=active`, a nonzero `MainPID`, and a sibling `ControlGroup`.
The escaped process was explicitly stopped, and no probe units remained.

This is a real descendant escape, not a mock or an argument based only on
process groups. Killing the first cgroup cannot establish that the command's
external work has stopped. `setsid`, PID tracking, or process-group termination
would not fix this. Cgroup emptiness is necessary for cgroup cleanup, but is not
proof that no descendants escaped before the kill.

A separate exploratory Bubblewrap invocation with a read-only bind of the host
root and user/PID/network namespaces failed to connect to the user manager.
That failed connection is not proof of a complete sandbox: it does not cover
other host IPC endpoints, writable cgroup access, namespace manipulation, or
inherited descriptors. No complete sandbox or conclusive descendant-cleanup
test suite was implemented or validated.

## Required Runner Contract

Only enable managed commands once the launcher prevents escape into other
cgroups and prevents access to host process-launching services. Depending on the
design, this requires a separate command identity and supervisor, or a restricted
filesystem/PID/user/network namespace sandbox with host IPC and control-plane
access denied. Merely clearing the environment is insufficient: well-known
socket paths can be reconstructed. A read-only host filesystem bind does not
prevent connecting to Unix sockets.

The runner should expose a command handle registered under its session and
execution ownership fence before allowing user code to run. It must require a
finite positive timeout, continuously drain both output streams while retaining
at most a configured byte budget, and report truncation. Preserve the actual
exit code or terminating signal separately from timeout/cancellation reasons.

Timeout, cancellation, normal main-process exit, and retirement must all join
descendant cleanup. Use the protected cgroup's `cgroup.kill` and observe
`cgroup.events` reaching `populated 0`, or a validated equivalent namespace
termination protocol. A missing permissions check, cleanup timeout, or observer
failure must produce an explicit containment failure, never successful cleanup.
Do not unregister ownership or acknowledge retirement completion on that path.

The supervisor must also own shutdown/crash cleanup; process-local registration
alone is insufficient if the OpenCode process dies. An uninterruptible process
can prevent bounded-time cleanup, so timeout must not be represented as proof of
termination. Avoid promising a hard completion deadline and conclusive cleanup
simultaneously when the kernel cannot provide both.

## Integration Points

No existing API implements the command registry described below. These are
proposed changes, not calls that can currently be wired in directly.

1. Add a process-global command owner registry keyed by session ID, command ID,
   and execution ownership fence. Register the containment handle before
   execution. Coordinate registration with retirement: a retirement check
   followed by an unrelated map insertion has an admission race. A durable
   retirement barrier must remain authoritative across runtime replacement.
2. In `src/tool/shell.ts`, replace only the managed branch at
   `requireUnmanagedShell()` and its corresponding process-launch path with the
   validated runner. Preserve existing permission admission, command parsing,
   output handling, and unmanaged behavior. Do not simply remove the guard.
3. In `src/session/prompt.ts`, cover all guarded paths: direct session shell
   execution, command admission, and command-template shell substitutions. The
   substitutions must not retain an uncontained alternate spawn path.
4. After `RuntimeLifecycle.retireRoot(rootID)` establishes the durable barrier,
   reject new command registrations for every returned session, cancel and join
   their registered containment handles, and then complete existing prompt
   cancellation. Call `finishCancel` only after cleanup has been conclusively
   observed. A failed join leaves retirement permanent and cleanup retryable;
   it must not release ownership as though external work had stopped.
5. Validate the actual launcher with double-forking/`setsid` children, ignored
   termination signals, a main process that exits while descendants remain,
   attempted cgroup migration, attempts to launch sibling user services, output
   floods, explicit timeout, retirement racing admission, and supervisor death.
   Observe descendant death independently of the runner's own returned status.

Until that boundary and those tests exist, the safe alternative is the existing
managed-profile shell rejection, or execution by an independently supervised
container/VM broker with a tested teardown contract. Neither delegation support
nor the presence of Bubblewrap alone justifies enabling managed shell commands.
