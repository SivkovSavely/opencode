# Isolated full-stack worktree regression

Run from `packages/app`:

```sh
bun run test:e2e:worktree
```

The runner starts a separate OpenCode server, a separate Vite frontend, a local scripted OpenAI-compatible fake provider, and Chromium. It currently requires Linux x64 or arm64 with `/proc`, pidfd syscalls, and `mkfifo`. It always disables Playwright server reuse. It uses a system Chromium executable when available, otherwise downloads the Playwright-matched browser into the run root. Each run owns one unique `/tmp/opencode-worktree-e2e-*` root containing its SQLite database, XDG/HOME data, Git projects and worktrees, Vite cache, browser downloads and temp directory, and Playwright artifacts. Before signaling, the runner opens a pidfd and revalidates the process identity and run token; it checks both detached process sessions and run-token processes before removing the root. After a failing or interrupted Playwright run, it preserves the test report and artifacts and prints their exact path; use stale recovery to remove the preserved root when finished diagnosing. The runner handles SIGINT, SIGTERM, and SIGHUP and waits for owned-process cleanup before exiting.

If the runner is terminated with `SIGKILL` and leaves test-owned processes behind, recover only verifiably stale runs with:

```sh
bun run test:e2e:worktree:recover
```

Recovery requires Linux x64 or arm64 with pidfd support. It checks the ownership marker and run token, preserves active runs, and scans process environments for the exact run ID and root so it can find children spawned before the manifest update. It opens a pidfd before revalidating each process ID, start time, process group, session, and run token, then signals only through that pidfd. It checks process-session membership and repeats the run-token scan before removing the marked `/tmp` directory. If any owned or unverified process remains, it reports and preserves the exact leftover path.
