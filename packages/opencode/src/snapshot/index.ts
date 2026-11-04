import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { Info } from "@opencode-ai/schema/file-diff"
import { EventDiagnostics } from "@opencode-ai/core/event-diagnostics"
import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Info
export type FileDiff = typeof FileDiff.Type

export type DiffContext = {
  sessionID?: string
  messageID?: string
}

const prune = "7.days"
const MAX_SNAPSHOT_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024
export const MAX_FULL_DIFF_FILE_BYTES = 2 * 1024 * 1024
export const MAX_FULL_DIFF_CHURN = 20_000
const MAX_FULL_DIFF_METADATA_BYTES = 4 * 1024 * 1024
const MAX_FULL_DIFF_STDERR_BYTES = 8 * 1024
const MAX_FULL_DIFF_STATS_FILES = 20_000
const MAX_FULL_DIFF_STATS_PATH_BYTES = 16 * 1024
const FULL_DIFF_GIT_TIMEOUT = 15_000
const FULL_DIFF_PATCH_TIMEOUT = 1_000
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

type State = Omit<Interface, "init">

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string, context?: DiffContext) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | AppProcess.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const locks = new Map<string, Semaphore.Semaphore>()
    const details = Semaphore.makeUnsafe(2)

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          projectID: ctx.project.id,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const encodeNulTerminatedPaths = (files: string[]) => files.join("\0") + "\0"
        const encodeTopLevelLiteralPathspecs = (files: string[]) =>
          encodeNulTerminatedPaths(files.map((file) => `:(top,literal)${file}`))

        const git = Effect.fnUntraced(
          function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
              { stdin: opts?.stdin },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          // check-ignore treats a leading colon as pathspec magic but accepts and echoes a protective ./ prefix.
          const checkIgnorePaths = files.map((item) => (item.startsWith(":") ? `./${item}` : item))
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.worktree,
              stdin: encodeNulTerminatedPaths(checkIgnorePaths),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(
            check.text
              .split("\0")
              .filter(Boolean)
              .map((item) => (item.startsWith("./:") ? item.slice(2) : item)),
          )
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
          if (result.code === 0) return
          yield* Effect.logWarning("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
        })

        // Reuse the hashes for the git storage between the original repo and snapshot
        // on huge repos like chromium checkout the git add --all rebuilding the
        // hashes can take minutes. By doing this we eliminating this at all
        const seed = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return

          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })

          if (commonDir.code !== 0) return
          const source = commonDir.text.trim()
          if (!source || !(yield* exists(source))) return

          // Share the source object database (and the source's own alternates,
          // skipping any that no longer exist) so seeded blobs resolve.
          const sourceObjects = path.join(source, "objects")
          const chained = (yield* read(path.join(sourceObjects, "info", "alternates")))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          const alternates: string[] = []
          for (const candidate of [sourceObjects, ...chained]) {
            if (yield* exists(candidate)) alternates.push(candidate)
          }
          if (!alternates.length) return

          yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
          yield* fs
            .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")
            .pipe(Effect.orDie)

          // Seed the index from the source repo so already-hashed entries are reused.
          // Best-effort: a missing/incompatible index just falls back to a full add.
          const sourceIndex = path.join(source, "index")
          if (yield* exists(sourceIndex)) {
            yield* fs.copyFile(sourceIndex, path.join(state.gitdir, "index")).pipe(Effect.catch(() => Effect.void))
          }
        })

        const add = Effect.fnUntraced(function* () {
          yield* sync()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              git([...quote, ...args(["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            yield* Effect.logWarning("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return

          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.worktree, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > MAX_SNAPSHOT_UNTRACKED_FILE_BYTES ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          yield* stage(allow.filter((item) => !block.has(item)))
        })

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                yield* Effect.logWarning("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              yield* Effect.logInfo("cleanup", { prune })
            }),
          )
        })

        const track = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              const existed = yield* exists(state.gitdir)
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              if (!existed) {
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
                yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
                // Tuning for very large worktrees so the first add stays bounded.
                yield* git(["--git-dir", state.gitdir, "config", "feature.manyFiles", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "index.version", "4"])
                yield* git(["--git-dir", state.gitdir, "config", "index.threads", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.untrackedCache", "true"])
                yield* seed()
                yield* Effect.logInfo("initialized")
              }
              yield* add()
              const result = yield* git(args(["write-tree"]), { cwd: state.directory })
              const hash = result.text.trim()
              yield* Effect.logInfo("tracking", { hash, cwd: state.directory, git: state.gitdir })
              return hash
            }),
          )
        })

        const patch = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git(
                [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", hash, "--", "."])],
                {
                  cwd: state.directory,
                },
              )
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text
                .trim()
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* Effect.logInfo("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                yield* Effect.logError("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              yield* Effect.logError("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                yield* Effect.logInfo("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  yield* Effect.logInfo("file existed in snapshot but checkout failed, keeping", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return
                }
                yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  yield* Effect.logInfo("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  yield* Effect.logInfo("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logInfo("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string, context?: DiffContext) {
          const diagnosticsEnabled = EventDiagnostics.enabled
          const operationStarted = diagnosticsEnabled ? performance.now() : 0
          const operationID = diagnosticsEnabled
            ? EventDiagnostics.diffFullStart({
                from,
                to,
                directory: state.directory,
                projectID: state.projectID,
                ...context,
              })
            : undefined
          let completed = false
          return yield* locked(
            Effect.gen(function* () {
              type Row = {
                file: string
                status: "added" | "deleted" | "modified"
                before?: string
                after?: string
                binary: boolean
                additions: number
                deletions: number
                reason?: string
              }

              const run = Effect.fnUntraced(
                function* (
                  cmd: string[],
                  opts?: { stdin?: string; cwd?: string; maxOutputBytes?: number; okExitCodes?: number[] },
                ) {
                  const result = yield* appProcess.run(
                    ChildProcess.make(
                      "git",
                      [...cfg, "-c", `core.bigFileThreshold=${MAX_FULL_DIFF_FILE_BYTES}`, ...cmd],
                      {
                        cwd: opts?.cwd ?? state.directory,
                        extendEnv: true,
                      },
                    ),
                    {
                      stdin: opts?.stdin,
                      maxOutputBytes: opts?.maxOutputBytes ?? MAX_FULL_DIFF_METADATA_BYTES,
                      maxErrorBytes: MAX_FULL_DIFF_STDERR_BYTES,
                      timeout: FULL_DIFF_GIT_TIMEOUT,
                    },
                  )
                  if (
                    !(opts?.okExitCodes ?? [0]).includes(result.exitCode) ||
                    result.stdoutTruncated ||
                    result.stderrTruncated
                  )
                    return
                  return result.stdout
                },
                Effect.catch(() => Effect.void),
              )
              const unavailable = (files?: number): FileDiff[] => [
                {
                  additions: 0,
                  deletions: 0,
                  omitted: {
                    reason: "git-metadata-unavailable",
                    ...(files === undefined ? {} : { files, statisticsIncomplete: true }),
                  },
                },
              ]

              // Keep root-relative paths for ignore checks and numstat pathspecs despite diff.relative.
              // Raw object IDs avoid line-delimited revision:path requests for unusual filenames.
              const metadata = yield* run(
                args([
                  "diff",
                  "--raw",
                  "--no-abbrev",
                  "-z",
                  "--no-textconv",
                  "--no-ext-diff",
                  "--no-renames",
                  "--no-relative",
                  from,
                  to,
                  "--",
                  ".",
                ]),
              )
              if (!metadata) return unavailable()
              if (metadata.length && metadata[metadata.length - 1] !== 0) return unavailable()
              const entries = metadata.toString("utf8").split("\0")
              const objects = new Map<string, Row>()
              for (let i = 0; i < entries.length - 1; i++) {
                const match = entries[i].match(/^:\d{6} \d{6} ([0-9a-f]+) ([0-9a-f]+) ([ADMT])$/)
                const file = entries[++i]
                if (!match || !file || objects.has(file)) return unavailable()
                objects.set(file, {
                  file,
                  before: /^0+$/.test(match[1]) ? undefined : match[1],
                  after: /^0+$/.test(match[2]) ? undefined : match[2],
                  status: match[3] === "A" ? "added" : match[3] === "D" ? "deleted" : "modified",
                  binary: false,
                  additions: 0,
                  deletions: 0,
                  reason: "git-statistics-unavailable",
                })
              }

              // Hide ignored-file removals, but do not silently fail open on incomplete ignore metadata.
              const check = objects.size
                ? yield* run(
                    [
                      "--git-dir",
                      path.join(state.worktree, ".git"),
                      "--work-tree",
                      state.worktree,
                      "check-ignore",
                      "--no-index",
                      "--stdin",
                      "-z",
                    ],
                    {
                      cwd: state.worktree,
                      stdin: encodeNulTerminatedPaths(
                        Array.from(objects.keys(), (file) => (file.startsWith(":") ? `./${file}` : file)),
                      ),
                      okExitCodes: [0, 1],
                    },
                  )
                : Buffer.alloc(0)
              if (!check || (check.length && check[check.length - 1] !== 0)) return unavailable()
              const ignored = new Set(
                check
                  .toString("utf8")
                  .split("\0")
                  .map((file) => (file.startsWith("./:") ? file.slice(2) : file)),
              )
              const rows = Array.from(objects.values()).filter((row) => !ignored.has(row.file))
              if (!rows.length) return []

              // Even numstat reads blob contents, so inspect every object before allowing statistics work.
              const refs = Array.from(
                new Set(rows.flatMap((row) => [row.before, row.after]).filter((ref): ref is string => Boolean(ref))),
              )
              const sizes = new Map<string, { type: string; size: number }>()
              if (refs.length) {
                const preflight = yield* run(args(["cat-file", "--batch-check"]), { stdin: refs.join("\n") + "\n" })
                if (!preflight) return unavailable(rows.length)
                const lines = preflight.toString("utf8").split("\n")
                if (lines.pop() !== "" || lines.length !== refs.length) return unavailable(rows.length)
                for (let i = 0; i < refs.length; i++) {
                  const match = lines[i].match(/^([0-9a-f]+) (\S+) (\d+)$/)
                  if (!match || match[1] !== refs[i] || !Number.isSafeInteger(Number(match[3])))
                    return unavailable(rows.length)
                  sizes.set(refs[i], { type: match[2], size: Number(match[3]) })
                }
              }

              const eligible: Row[] = []
              let statisticsBytes = 0
              for (const row of rows) {
                const before = row.before ? sizes.get(row.before) : { type: "blob", size: 0 }
                const after = row.after ? sizes.get(row.after) : { type: "blob", size: 0 }
                if (!before || !after) return unavailable(rows.length)
                const reason =
                  Math.max(before.size, after.size) > MAX_FULL_DIFF_FILE_BYTES
                    ? "size"
                    : before.type !== "blob" || after.type !== "blob"
                      ? "non-blob"
                      : eligible.length >= MAX_FULL_DIFF_STATS_FILES
                        ? "statistics-file-budget"
                        : before.size + after.size > SnapshotDiff.MAX_INPUT_BYTES - statisticsBytes
                          ? "input-budget"
                          : undefined
                if (reason) {
                  row.reason = reason
                  continue
                }
                statisticsBytes += before.size + after.size
                eligible.push(row)
              }

              // A whole-scope command is safe only if it cannot include ignored or unbudgeted changes.
              const all = eligible.length === objects.size
              const batches: Row[][] = []
              if (all) batches.push(eligible)
              if (!all) {
                const paths = Array.from(objects.keys()).sort()
                let batch: Row[] = []
                let pathBytes = 0
                for (const row of eligible) {
                  const bytes = SnapshotDiff.bytes(row.file) + 1
                  if (bytes > MAX_FULL_DIFF_STATS_PATH_BYTES) {
                    row.reason = "path-budget"
                    continue
                  }
                  // Literal pathspecs still include descendants during file/directory transitions.
                  const prefix = row.file + "/"
                  let start = 0
                  let end = paths.length
                  while (start < end) {
                    const middle = (start + end) >>> 1
                    if (paths[middle] < prefix) {
                      start = middle + 1
                      continue
                    }
                    end = middle
                  }
                  if (paths[start]?.startsWith(prefix)) continue
                  if (batch.length && (batch.length >= 100 || pathBytes + bytes > MAX_FULL_DIFF_STATS_PATH_BYTES)) {
                    batches.push(batch)
                    batch = []
                    pathBytes = 0
                  }
                  batch.push(row)
                  pathBytes += bytes
                }
                if (batch.length) batches.push(batch)
              }
              for (const batch of batches) {
                const statistics = yield* run(
                  [
                    "--literal-pathspecs",
                    ...args([
                      "diff",
                      "--numstat",
                      "-z",
                      "--no-textconv",
                      "--no-ext-diff",
                      "--no-renames",
                      "--no-relative",
                      from,
                      to,
                      "--",
                      ...(all ? ["."] : batch.map((row) => row.file)),
                    ]),
                  ],
                  { cwd: all ? state.directory : state.worktree },
                )
                if (!statistics) continue
                const entries = statistics.toString("utf8").split("\0")
                if (entries.pop() !== "" || entries.length !== batch.length) continue
                const files = new Set(batch.map((row) => row.file))
                const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>()
                for (const entry of entries) {
                  const match = entry.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/)
                  if (
                    !match ||
                    !files.has(match[3]) ||
                    counts.has(match[3]) ||
                    (match[1] === "-") !== (match[2] === "-")
                  )
                    break
                  const binary = match[1] === "-"
                  const additions = binary ? 0 : Number(match[1])
                  const deletions = binary ? 0 : Number(match[2])
                  if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) break
                  counts.set(match[3], { additions, deletions, binary })
                }
                if (counts.size !== batch.length) continue
                for (const row of batch) Object.assign(row, counts.get(row.file), { reason: undefined })
              }

              const selected: Row[] = []
              const omitted = { additions: 0, deletions: 0, files: 0, statisticsIncomplete: false }
              for (const row of rows) {
                if (selected.length < SnapshotDiff.MAX_FILES && row.file.length <= SnapshotDiff.MAX_PATH_CHARS) {
                  selected.push(row)
                  continue
                }
                omitted.additions += row.additions
                omitted.deletions += row.deletions
                omitted.files++
                if (row.reason) omitted.statisticsIncomplete = true
              }

              const result: FileDiff[] = []
              let inputBytes = 0
              // Reserve the JSON quotes of every empty patch, including those omitted later.
              let patchBytes = selected.length * SnapshotDiff.bytes("")

              EventDiagnostics.diffFullFiles(operationID, selected.length + omitted.files)
              let totalBeforeChars = 0
              let totalBeforeBytes = 0
              let totalAfterChars = 0
              let totalAfterBytes = 0
              let totalPatchChars = 0
              let totalPatchBytes = 0
              let slowestFile: { filename: string; elapsedMs: number } | undefined
              let largestInput: { filename: string; bytes: number } | undefined
              let largestPatch: { filename: string; bytes: number } | undefined
              let skippedFiles = 0
              let skippedBytes = 0
              let largestSkippedInput: { filename: string; bytes: number } | undefined
              const skippedReasonCounts = { size: 0, churn: 0 }
              for (const row of selected) {
                const beforeObject = row.before ? sizes.get(row.before) : { type: "blob", size: 0 }
                const afterObject = row.after ? sizes.get(row.after) : { type: "blob", size: 0 }
                if (!beforeObject || !afterObject) return unavailable(rows.length)
                const beforeSize = beforeObject.size
                const afterSize = afterObject.size
                const bytes = beforeSize + afterSize
                const item: { -readonly [K in keyof FileDiff]: FileDiff[K] } = {
                  file: row.file,
                  patch: "",
                  additions: row.additions,
                  deletions: row.deletions,
                  status: row.status,
                }
                result.push(item)
                const reason =
                  row.reason ??
                  (row.additions + row.deletions > MAX_FULL_DIFF_CHURN
                    ? "churn"
                    : row.binary
                      ? undefined
                      : bytes > SnapshotDiff.MAX_INPUT_BYTES - inputBytes
                        ? "input-budget"
                        : 3 * SnapshotDiff.bytes(row.file) + 512 > SnapshotDiff.MAX_PATCH_BYTES - patchBytes + 2
                          ? "patch-budget"
                          : undefined)
                if (reason) {
                  item.omitted = {
                    reason,
                    files: 1,
                    ...(row.reason ? { statisticsIncomplete: true } : {}),
                  }
                  skippedFiles++
                  skippedBytes += bytes
                  if (!largestSkippedInput || bytes > largestSkippedInput.bytes)
                    largestSkippedInput = { filename: row.file, bytes }
                  if (reason === "size" || reason === "churn") {
                    skippedReasonCounts[reason]++
                    EventDiagnostics.diffFileSkipped({
                      operationID,
                      filename: row.file,
                      reason: [reason],
                      beforeBytes: beforeSize,
                      afterBytes: afterSize,
                      additions: row.additions,
                      deletions: row.deletions,
                      sizeLimit: MAX_FULL_DIFF_FILE_BYTES,
                      churnLimit: MAX_FULL_DIFF_CHURN,
                    })
                  }
                  continue
                }
                if (row.binary) continue

                const refs = [row.before, row.after].filter((ref): ref is string => Boolean(ref))
                inputBytes += bytes
                const content = yield* run(args(["cat-file", "--batch"]), {
                  stdin: refs.join("\n") + "\n",
                  maxOutputBytes: bytes + refs.length * 128,
                })
                if (!content) {
                  item.omitted = { reason: "git-content-unavailable", files: 1 }
                  continue
                }
                const text = new Map<string, string>()
                let offset = 0
                for (const ref of refs) {
                  const end = content.indexOf(10, offset)
                  const size = sizes.get(ref)?.size
                  if (
                    size === undefined ||
                    end < offset ||
                    content.toString("ascii", offset, end) !== `${ref} blob ${size}`
                  )
                    break
                  if (content[end + 1 + size] !== 10) break
                  text.set(ref, content.toString("utf8", end + 1, end + 1 + size))
                  offset = end + size + 2
                }
                if (offset !== content.length || refs.some((ref) => !text.has(ref))) {
                  item.omitted = { reason: "git-content-unavailable", files: 1 }
                  continue
                }
                const before = row.before ? (text.get(row.before) ?? "") : ""
                const after = row.after ? (text.get(row.after) ?? "") : ""
                if (diagnosticsEnabled) {
                  totalBeforeChars += before.length
                  totalBeforeBytes += beforeSize
                  totalAfterChars += after.length
                  totalAfterBytes += afterSize
                  if (!largestInput || bytes > largestInput.bytes) largestInput = { filename: row.file, bytes }
                }
                EventDiagnostics.diffFileStart({
                  operationID,
                  filename: row.file,
                  beforeChars: before.length,
                  beforeBytes: beforeSize,
                  afterChars: after.length,
                  afterBytes: afterSize,
                  additions: row.additions,
                  deletions: row.deletions,
                  status: row.status,
                })

                const lines = [before, after].reduce((sum, value) => {
                  let count = value.length && !value.endsWith("\n") ? 1 : 0
                  for (let i = value.indexOf("\n"); i !== -1; i = value.indexOf("\n", i + 1)) count++
                  return sum + count
                }, 0)
                // Full context has one hunk. Bound escaped content, line prefixes, headers and EOF markers.
                // A successful capped diff shares at least this many lines, each costing >= 2 encoded bytes.
                const common = Math.max(0, Math.ceil((lines - MAX_FULL_DIFF_CHURN) / 2))
                const bound =
                  SnapshotDiff.bytes(before) +
                  SnapshotDiff.bytes(after) +
                  lines -
                  2 * common +
                  3 * SnapshotDiff.bytes(row.file) +
                  512
                if (bound > SnapshotDiff.MAX_PATCH_BYTES - patchBytes + 2) {
                  item.omitted = { reason: "patch-budget", files: 1 }
                  continue
                }
                const started = performance.now()
                const patch = structuredPatch(row.file, row.file, before, after, "", "", {
                  context: Number.MAX_SAFE_INTEGER,
                  timeout: FULL_DIFF_PATCH_TIMEOUT,
                  maxEditLength: MAX_FULL_DIFF_CHURN,
                })
                if (!patch) {
                  item.omitted = { reason: "diff-complexity", files: 1 }
                  continue
                }
                const output = formatPatch(patch)
                const encoded = SnapshotDiff.bytes(output)
                if (encoded > SnapshotDiff.MAX_PATCH_BYTES - patchBytes + 2) {
                  item.omitted = { reason: "patch-budget", files: 1 }
                  continue
                }
                item.patch = output
                patchBytes += encoded - 2
                if (diagnosticsEnabled) {
                  const elapsedMs = performance.now() - started
                  const bytes = Buffer.byteLength(output)
                  EventDiagnostics.diffFileEnd({
                    operationID,
                    filename: row.file,
                    elapsedMs,
                    patchChars: output.length,
                    patchBytes: bytes,
                  })
                  if (!slowestFile || elapsedMs > slowestFile.elapsedMs) slowestFile = { filename: row.file, elapsedMs }
                  if (!largestPatch || bytes > largestPatch.bytes) largestPatch = { filename: row.file, bytes }
                  totalPatchChars += output.length
                  totalPatchBytes += bytes
                }
              }
              if (omitted.files)
                result.push({
                  additions: omitted.additions,
                  deletions: omitted.deletions,
                  omitted: {
                    reason: "aggregate-budget",
                    files: omitted.files,
                    ...(omitted.statisticsIncomplete ? { statisticsIncomplete: true } : {}),
                  },
                })

              if (diagnosticsEnabled) {
                EventDiagnostics.diffFullEnd({
                  operationID,
                  elapsedMs: performance.now() - operationStarted,
                  files: result.length,
                  totalBeforeChars,
                  totalBeforeBytes,
                  totalAfterChars,
                  totalAfterBytes,
                  totalPatchChars,
                  totalPatchBytes,
                  skippedFiles,
                  skippedBytes,
                  skippedReasonCounts,
                  largestSkippedInput,
                  slowestFile,
                  largestInput,
                  largestPatch,
                })
                completed = true
              }
              return result
            }).pipe(details.withPermits(1)),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (!diagnosticsEnabled || completed) return
                completed = true
                EventDiagnostics.diffFullEnd({
                  operationID,
                  elapsedMs: performance.now() - operationStarted,
                  files: 0,
                  totalBeforeChars: 0,
                  totalBeforeBytes: 0,
                  totalAfterChars: 0,
                  totalAfterBytes: 0,
                  totalPatchChars: 0,
                  totalPatchBytes: 0,
                  skippedFiles: 0,
                  skippedBytes: 0,
                  skippedReasonCounts: { size: 0, churn: 0 },
                  aborted: true,
                })
              }),
            ),
          )
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => Effect.logError("cleanup loop failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return { cleanup, track, patch, restore, revert, diff, diffFull }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string, context?: DiffContext) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to, context))
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, AppProcess.node, Config.node],
})

export * as Snapshot from "."
