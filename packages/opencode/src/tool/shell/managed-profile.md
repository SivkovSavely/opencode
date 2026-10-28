# Managed profile shell commands

When `OPENCODE_MANAGED_PROFILE=1`, the shell tool requires a tracked runtime and
executes inside the managed Linux sandbox. Only the instance directory is mounted
writable, and the working directory must resolve inside it. Set
`OPENCODE_MANAGED_RUST_TOOLCHAIN` in the trusted server environment to the path of
an installed Rust toolchain to expose it read-only in the sandbox. Host and plugin
environment variables are not forwarded. Output is bounded and discarded output
is not saved. Session shell commands and shell expansions in command templates
remain rejected. This does not establish containment for other process-launching
features. See `managed-linux.md` for sandbox requirements and limitations.

The sandbox exposes the canonical host workspace path as a symlink to `/work`,
so absolute project paths refer to the same files. Paths outside the workspace
are not mapped. Paths resolving through host-side symlinks outside the workspace
are not available; the alias exists only inside the sandbox.
