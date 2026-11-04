import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Git } from "@opencode/core/git"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { VcsPatch } from "@opencode/core/vcs/patch"
import { branch, commit, initGit, initRepo, read, withRemote } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { withEnv } from "./fixture/env"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

describe("Git", () => {
  it.live("discovers repository metadata without a work tree", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await $`git config core.bare true`.cwd(root.path).quiet()
      })
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(directory)

      expect(repository?.worktree).toBe(directory)
      expect(repository?.gitDirectory).toBe(AbsolutePath.make(path.join(directory, ".git")))
      expect(repository?.commonDirectory).toBe(repository?.gitDirectory)
    }),
  )

  it.live("clones a remote and reads checkout metadata", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        expect(yield* git.remote.get(repository)).toBe(fixture.remote)
        expect(yield* git.history.head(repository)).toBeString()
        expect(yield* git.history.branch(repository)).toBe("main")
        expect(yield* git.history.defaultRemoteBranch(repository)).toBe("main")
        expect(repository.worktree).toBe(target)
        expect(repository.gitDirectory).toBe(AbsolutePath.make(path.join(target, ".git")))
        expect(repository.commonDirectory).toBe(repository.gitDirectory)
        expect(yield* read(path.join(target, "README.md"))).toBe("one\n")
      }),
    ),
  )

  it.live("fetches, checks out, and resets remote changes", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        yield* Effect.promise(() => commit(fixture.source, "two\n", "second"))
        yield* git.sync.fetchRemotes(repository)
        yield* git.sync.resetHard(repository, "origin/main")
        expect(yield* read(path.join(target, "README.md"))).toBe("two\n")

        yield* Effect.promise(() => branch(fixture.source, "feature/docs", "feature\n"))
        yield* git.sync.fetchBranch(repository, { branch: "feature/docs" })
        yield* git.sync.checkoutRemoteBranch(repository, { branch: "feature/docs" })
        yield* git.sync.resetHard(repository, "origin/feature/docs")
        expect(yield* git.history.branch(repository)).toBe("feature/docs")
        expect(yield* read(path.join(target, "README.md"))).toBe("feature\n")
      }),
    ),
  )
})

describe("Git worktrees", () => {
  it.live("creates, lists, and removes linked worktrees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const worktree = AbsolutePath.make(`${root.path}-git-worktree`)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })))
      const git = yield* Git.Service
      const repo = yield* git.repo.discover(directory)
      if (!repo) throw new Error("Repository not found")

      yield* git.worktree.create({ repository: repo, directory: worktree })

      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(true)
      const linked = yield* git.repo.discover(worktree)
      expect(linked?.worktree).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(worktree))))
      expect(linked?.commonDirectory).toBe(repo.commonDirectory)
      expect(linked?.gitDirectory).not.toBe(repo.gitDirectory)
      if (!linked) throw new Error("Linked worktree not found")
      yield* git.worktree.remove({ repository: linked, directory: worktree, force: false })
      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(false)
    }),
  )

  it.live("reads no remote and no root commits from an unborn repository", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initGit(root.path))
      const git = yield* Git.Service
      const repo = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repo) throw new Error("Repository not found")
      expect(yield* git.remote.get(repo)).toBeUndefined()
      expect(yield* git.history.rootCommits(repo)).toEqual([])
    }),
  )

  it.live("fingerprint changes with repository metadata, including from a linked worktree", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const main = path.join(root.path, "main")
      const linked = path.join(root.path, "linked")
      yield* Effect.promise(() => initGit(main))
      const git = yield* Git.Service
      const fingerprint = (dir: string) => git.repo.fingerprint(AbsolutePath.make(path.join(dir, ".git")))

      expect(yield* fingerprint(root.path)).toBeUndefined()
      const unborn = yield* fingerprint(main)
      expect(unborn).toBeDefined()
      expect(yield* fingerprint(main)).toBe(unborn)

      yield* Effect.promise(() => $`git commit --allow-empty -qm root`.cwd(main).quiet())
      const committed = yield* fingerprint(main)
      expect(committed).not.toBe(unborn)

      yield* Effect.promise(() => $`git worktree add -q ${linked}`.cwd(main).quiet())
      const before = yield* fingerprint(linked)
      expect(before).toBeDefined()
      yield* Effect.promise(() => $`git remote add origin git@github.com:owner/repo.git`.cwd(main).quiet())
      expect(yield* fingerprint(main)).not.toBe(committed)
      expect(yield* fingerprint(linked)).not.toBe(before)
    }),
  )
})

describe("Git trees", () => {
  ;[0, 1, 128].forEach((exitCode) => {
    it.live(`refresh handles check-ignore exit ${exitCode}`, () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
        )
        const project = path.join(root.path, "project")
        const paths = ["scope/allowed.txt", "scope/ignored name.txt"].map((file) => RelativePath.make(file))
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(project, "scope"), { recursive: true })
          await initRepo(project)
          await Promise.all(paths.map((file) => Bun.write(path.join(project, file), "one\n")))
          await $`git add .`.cwd(project).quiet()
          await $`git commit -m initial`.cwd(project).quiet()
        })
        const git = yield* Git.Service
        const source = yield* git.repo.discover(AbsolutePath.make(project))
        if (!source) throw new Error("Repository not found")
        const repository = yield* git.repo.create({
          worktree: source.worktree,
          gitDirectory: AbsolutePath.make(path.join(root.path, "storage")),
          seed: source,
        })
        const before = yield* git.tree.write(repository)
        yield* Effect.promise(async () => {
          await Promise.all(paths.map((file) => Bun.write(path.join(project, file), "two\n")))
          await Bun.write(path.join(source.gitDirectory, "info", "exclude"), exitCode === 0 ? `${paths[1]}\n` : "")
          if (exitCode === 128) await Bun.write(path.join(source.gitDirectory, "config"), "[broken\n")
          // A broken config makes git exit before reading stdin, so piping a Buffer races an EPIPE on the writer.
          const stdin = exitCode === 128 ? Bun.file("/dev/null") : Buffer.from(paths.join("\0") + "\0")
          const result =
            await $`git --git-dir ${source.gitDirectory} --work-tree ${source.worktree} check-ignore --no-index --stdin -z < ${stdin}`
              .cwd(project)
              .quiet()
              .nothrow()
          expect(result.exitCode).toBe(exitCode)
        })
        const refresh = git.index.refresh({ repository, scope: RelativePath.make("scope"), ignores: source })
        if (exitCode === 128) {
          const error = yield* refresh.pipe(Effect.flip)
          expect(error).toBeInstanceOf(Git.OperationError)
          expect(error.message).toContain("bad config line")
          expect(yield* git.tree.write(repository)).toBe(before)
          expect(
            yield* git.index.refresh({ repository, scope: RelativePath.make("missing"), ignores: source }),
          ).toEqual({ skipped: [] })
          return
        }
        expect(yield* git.index.ignored({ repository: source, paths })).toEqual(
          new Set(exitCode === 0 ? [paths[1]] : []),
        )
        expect(yield* refresh).toEqual({ skipped: [] })
        const after = yield* git.tree.write(repository)
        expect((yield* git.tree.diff({ repository, from: before, to: after })).map((file) => file.status)).toEqual([
          "modified",
          exitCode === 0 ? "deleted" : "modified",
        ])
      }),
    )
  })

  it.live("lists both sides of a rename as separate file changes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await $`git config diff.renames true`.cwd(root.path).quiet()
        await Bun.write(path.join(root.path, "old name.txt"), "Preserve this content.\n")
      })
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repository) throw new Error("Repository not found")
      const before = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
      yield* Effect.promise(() => fs.rename(path.join(root.path, "old name.txt"), path.join(root.path, "new name.txt")))
      const after = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })

      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual([
        RelativePath.make("new name.txt"),
        RelativePath.make("old name.txt"),
      ])
      expect(
        (yield* git.tree.diff({ repository, from: before, to: after })).map((file) => [file.file, file.status]),
      ).toEqual([
        ["new name.txt", "added"],
        ["old name.txt", "deleted"],
      ])
    }),
  )

  it.live("guards tree full-diff input bytes before generating patches and keeps file metadata", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const limit = 2 * 1024 * 1024
      const oversized = `${"x".repeat(limit)}\n`
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await Bun.write(path.join(root.path, "grown.txt"), "small\n")
        await Bun.write(path.join(root.path, "shrunk.txt"), oversized)
        await Bun.write(path.join(root.path, "deleted.txt"), oversized)
        await Bun.write(path.join(root.path, "z-normal.txt"), "before\n")
      })
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repository) throw new Error("Repository not found")
      const before = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
      yield* Effect.promise(async () => {
        await Bun.write(path.join(root.path, "grown.txt"), oversized)
        await Bun.write(path.join(root.path, "shrunk.txt"), "small\n")
        await fs.rm(path.join(root.path, "deleted.txt"))
        await Bun.write(path.join(root.path, "added.txt"), oversized)
        await Bun.write(path.join(root.path, "exact.txt"), `${"\u00e9".repeat(limit / 2 - 1)}x\n`)
        await Bun.write(path.join(root.path, "utf-above.txt"), `${"\u00e9".repeat(limit / 2)}\n`)
        await Bun.write(path.join(root.path, "z-normal.txt"), "after\n")
      })
      const after = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
      const trace = path.join(repository.gitDirectory, "patch-trace")
      const diffs = yield* withEnv({ GIT_TRACE: trace, OPENCODE_HANG_DIAGNOSTICS: undefined }, () =>
        git.tree.diff({ repository, from: before, to: after, context: VcsPatch.PATCH_CONTEXT_LINES }),
      )
      expect(diffs.map((entry) => [entry.file, entry.status, entry.additions, entry.deletions])).toEqual([
        ["added.txt", "added", 1, 0],
        ["deleted.txt", "deleted", 0, 1],
        ["exact.txt", "added", 1, 0],
        ["grown.txt", "modified", 1, 1],
        ["shrunk.txt", "modified", 1, 1],
        ["utf-above.txt", "added", 1, 0],
        ["z-normal.txt", "modified", 1, 1],
      ])
      const skipped = ["added.txt", "deleted.txt", "grown.txt", "shrunk.txt", "utf-above.txt"]
      skipped.forEach((file) => expect(diffs.find((entry) => entry.file === file)?.patch.length).toBe(0))
      expect(diffs.find((entry) => entry.file === "exact.txt")?.patch.length).toBeGreaterThan(limit / 2)
      expect(diffs.find((entry) => entry.file === "z-normal.txt")?.patch).toContain("-before\n+after\n")
      const commands = (yield* Effect.promise(() => fs.readFile(trace, "utf8")))
        .split("\n")
        .filter((line) => line.includes("--unified="))
      expect(commands.length).toBeGreaterThan(0)
      skipped.forEach((file) => expect(commands.some((command) => command.includes(file))).toBe(false))
      const reverse = yield* git.tree.diff({
        repository,
        from: after,
        to: before,
        paths: ["exact.txt", "grown.txt", "shrunk.txt"].map((file) => RelativePath.make(file)),
      })
      expect(reverse.map((entry) => [entry.file, entry.status, entry.additions, entry.deletions])).toEqual([
        ["exact.txt", "deleted", 0, 1],
        ["grown.txt", "modified", 1, 1],
        ["shrunk.txt", "modified", 1, 1],
      ])
      expect(reverse[0]?.patch.length).toBeGreaterThan(limit / 2)
      expect(reverse[1]?.patch.length).toBe(0)
      expect(reverse[2]?.patch.length).toBe(0)
    }),
  )

  it.live("guards tree full-diff churn above but not at the limit", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await Bun.write(path.join(root.path, "churn-exact.txt"), "before\n".repeat(10_000))
        await Bun.write(path.join(root.path, "churn-above.txt"), "before\n".repeat(10_000))
        await Bun.write(path.join(root.path, "z-normal.txt"), "before\n")
      })
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repository) throw new Error("Repository not found")
      const before = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
      yield* Effect.promise(async () => {
        await Bun.write(path.join(root.path, "churn-exact.txt"), "after\n".repeat(10_000))
        await Bun.write(path.join(root.path, "churn-above.txt"), "after\n".repeat(10_001))
        await Bun.write(path.join(root.path, "churn-added.txt"), "after\n".repeat(20_001))
        await Bun.write(path.join(root.path, "z-normal.txt"), "after\n")
      })
      const after = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
      const trace = path.join(repository.gitDirectory, "patch-trace")
      const diffs = yield* withEnv({ GIT_TRACE: trace, OPENCODE_HANG_DIAGNOSTICS: undefined }, () =>
        git.tree.diff({ repository, from: before, to: after, context: VcsPatch.PATCH_CONTEXT_LINES }),
      )
      expect(diffs.map((entry) => [entry.file, entry.status, entry.additions, entry.deletions])).toEqual([
        ["churn-above.txt", "modified", 10_001, 10_000],
        ["churn-added.txt", "added", 20_001, 0],
        ["churn-exact.txt", "modified", 10_000, 10_000],
        ["z-normal.txt", "modified", 1, 1],
      ])
      expect(diffs[0]?.patch.length).toBe(0)
      expect(diffs[1]?.patch.length).toBe(0)
      expect(diffs[2]?.patch).toContain("-before\n")
      expect(diffs[2]?.patch).toContain("+after\n")
      expect(diffs[3]?.patch).toContain("-before\n+after\n")
      const commands = (yield* Effect.promise(() => fs.readFile(trace, "utf8")))
        .split("\n")
        .filter((line) => line.includes("--unified="))
      expect(commands.length).toBeGreaterThan(0)
      expect(commands.some((command) => command.includes("churn-above.txt"))).toBe(false)
      expect(commands.some((command) => command.includes("churn-added.txt"))).toBe(false)
    }),
  )

  it.live("guards tree full-diff descendants across file-directory replacements", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await fs.mkdir(path.join(root.path, "collapsed"))
        await Bun.write(path.join(root.path, "expanded"), "before\n")
        await Bun.write(path.join(root.path, "collapsed", "large.txt"), `${"x".repeat(2 * 1024 * 1024)}\n`)
        await Bun.write(path.join(root.path, "collapsed", "small.txt"), "small before\n")
      })
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repository) throw new Error("Repository not found")
      const before = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
      yield* Effect.promise(async () => {
        await fs.rm(path.join(root.path, "expanded"))
        await fs.rm(path.join(root.path, "collapsed"), { recursive: true })
        await fs.mkdir(path.join(root.path, "expanded"))
        await Bun.write(path.join(root.path, "collapsed"), "after\n")
        await Bun.write(path.join(root.path, "expanded", "large.txt"), `${"y".repeat(2 * 1024 * 1024)}\n`)
        await Bun.write(path.join(root.path, "expanded", "[small] caf\u00e9.txt"), "small after\n")
      })
      const after = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
      const trace = path.join(repository.gitDirectory, "patch-trace")
      const diffs = yield* withEnv({ GIT_TRACE: trace }, () => git.tree.diff({ repository, from: before, to: after }))
      expect(diffs.map((entry) => [entry.file, entry.status, entry.additions, entry.deletions])).toEqual([
        ["collapsed", "added", 1, 0],
        ["collapsed/large.txt", "deleted", 0, 1],
        ["collapsed/small.txt", "deleted", 0, 1],
        ["expanded", "deleted", 0, 1],
        ["expanded/[small] caf\u00e9.txt", "added", 1, 0],
        ["expanded/large.txt", "added", 1, 0],
      ])
      expect(diffs[0]?.patch).toContain("+after\n")
      expect(diffs[1]?.patch.length).toBe(0)
      expect(diffs[2]?.patch).toContain("-small before\n")
      expect(diffs[3]?.patch).toContain("-before\n")
      expect(diffs[4]?.patch).toContain("+small after\n")
      expect(diffs[5]?.patch.length).toBe(0)
      const commands = (yield* Effect.promise(() => fs.readFile(trace, "utf8")))
        .split("\n")
        .filter((line) => line.includes("--unified="))
      expect(commands.some((command) => command.includes(":(exclude,glob)collapsed/**"))).toBe(true)
      expect(commands.some((command) => command.includes(":(exclude,glob)expanded/**"))).toBe(true)
      expect(commands.some((command) => command.includes("large.txt"))).toBe(false)
    }),
  )

  it.live("guards tree full-diff patch matching against inherited case folding", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repository) throw new Error("Repository not found")
      const before = yield* git.tree.write(repository)
      yield* Effect.promise(async () => {
        // Index-only entries also exercise this combination on case-insensitive filesystems.
        const large = (
          await $`git hash-object -w --stdin < ${Buffer.from("x".repeat(VcsPatch.MAX_TOTAL_PATCH_BYTES) + "\n")}`
            .cwd(root.path)
            .text()
        ).trim()
        const small = (await $`git hash-object -w --stdin < ${Buffer.from("small\n")}`.cwd(root.path).text()).trim()
        await $`git update-index --add --cacheinfo 100644 ${large} README.txt`.cwd(root.path).quiet()
        await $`git update-index --add --cacheinfo 100644 ${small} readme.txt`.cwd(root.path).quiet()
      })
      const after = yield* git.tree.write(repository)
      const diffs = yield* withEnv({ GIT_ICASE_PATHSPECS: "1" }, () =>
        git.tree.diff({ repository, from: before, to: after }),
      )
      expect(diffs.map((entry) => [entry.file, entry.status, entry.additions, entry.deletions])).toEqual([
        ["README.txt", "added", 1, 0],
        ["readme.txt", "added", 1, 0],
      ])
      expect(diffs[0]?.patch.length).toBe(0)
      expect(diffs[1]?.patch).toContain("+small\n")
    }),
  )

  it.live("tree full-diff keeps gitlink parents while excluding guarded descendants", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repository) throw new Error("Repository not found")
      const objects = yield* Effect.promise(async () => {
        const large = (
          await $`git hash-object -w --stdin < ${Buffer.from("x".repeat(2 * 1024 * 1024) + "\n")}`.cwd(root.path).text()
        ).trim()
        const small = (await $`git hash-object -w --stdin < ${Buffer.from("small\n")}`.cwd(root.path).text()).trim()
        await $`git update-index --add --cacheinfo 160000 ${"c".repeat(40)} 'expanded[link]'`.cwd(root.path).quiet()
        await $`git update-index --add --cacheinfo 100644 ${large} 'collapsed[link]/large.txt'`.cwd(root.path).quiet()
        await $`git update-index --add --cacheinfo 100644 ${small} 'collapsed[link]/small.txt'`.cwd(root.path).quiet()
        return { large, small }
      })
      const before = yield* git.tree.write(repository)
      yield* Effect.promise(async () => {
        await $`git update-index --force-remove -- 'expanded[link]' 'collapsed[link]/large.txt' 'collapsed[link]/small.txt'`
          .cwd(root.path)
          .quiet()
        await $`git update-index --add --cacheinfo 160000 ${"c".repeat(40)} 'collapsed[link]'`.cwd(root.path).quiet()
        await $`git update-index --add --cacheinfo 100644 ${objects.large} 'expanded[link]/large.txt'`
          .cwd(root.path)
          .quiet()
        await $`git update-index --add --cacheinfo 100644 ${objects.small} 'expanded[link]/small.txt'`
          .cwd(root.path)
          .quiet()
      })
      const after = yield* git.tree.write(repository)
      const trace = path.join(repository.gitDirectory, "patch-trace")
      const diffs = yield* withEnv({ GIT_TRACE: trace }, () => git.tree.diff({ repository, from: before, to: after }))
      expect(diffs.map((entry) => [entry.file, entry.status, entry.additions, entry.deletions])).toEqual([
        ["collapsed[link]", "added", 1, 0],
        ["collapsed[link]/large.txt", "deleted", 0, 1],
        ["collapsed[link]/small.txt", "deleted", 0, 1],
        ["expanded[link]", "deleted", 0, 1],
        ["expanded[link]/large.txt", "added", 1, 0],
        ["expanded[link]/small.txt", "added", 1, 0],
      ])
      expect(diffs[0]?.patch).toContain(`+Subproject commit ${"c".repeat(40)}`)
      expect(diffs[1]?.patch.length).toBe(0)
      expect(diffs[2]?.patch).toContain("-small\n")
      expect(diffs[3]?.patch).toContain(`-Subproject commit ${"c".repeat(40)}`)
      expect(diffs[4]?.patch.length).toBe(0)
      expect(diffs[5]?.patch).toContain("+small\n")
      expect(
        (yield* Effect.promise(() => fs.readFile(trace, "utf8")))
          .split("\n")
          .some((line) => line.includes("--unified=") && line.includes("large.txt")),
      ).toBe(false)
    }),
  )

  it.live("tree full-diff size checks support symlink blobs and do not read submodule commits", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repository) throw new Error("Repository not found")
      const before = yield* git.tree.write(repository)
      yield* Effect.promise(async () => {
        const object = (await $`git hash-object -w --stdin < ${Buffer.from("target.txt")}`.cwd(root.path).text()).trim()
        await $`git update-index --add --cacheinfo 120000 ${object} symbolic-link`.cwd(root.path).quiet()
        await $`git update-index --add --cacheinfo 160000 ${"c".repeat(40)} submodule`.cwd(root.path).quiet()
      })
      const after = yield* git.tree.write(repository)
      const diffs = yield* git.tree.diff({ repository, from: before, to: after })
      expect(diffs.map((entry) => [entry.file, entry.status, entry.additions, entry.deletions])).toEqual([
        ["submodule", "added", 1, 0],
        ["symbolic-link", "added", 1, 0],
      ])
      expect(diffs[0]?.patch).toContain(`+Subproject commit ${"c".repeat(40)}`)
      expect(diffs[1]?.patch).toContain("+target.txt")
    }),
  )

  it.live("caps batched tree patches, keeps per-file stats past the cap, and matches non-ASCII names", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repository) throw new Error("Repository not found")
      const before = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
      const largeFiles = Array.from({ length: 6 }, (_, index) => `b-large-${index}.txt`)
      yield* Effect.promise(async () => {
        await Bun.write(path.join(root.path, "a-small.txt"), "small\n")
        await Promise.all(
          largeFiles.map((file) => Bun.write(path.join(root.path, file), `${"x".repeat(2 * 1024 * 1024 - 1)}\n`)),
        )
        await Bun.write(path.join(root.path, "c-binary.bin"), new Uint8Array([0, 1, 2, 3]))
        await Bun.write(path.join(root.path, "a-caf\u00e9.txt"), "caf\u00e9\n")
      })
      const after = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })

      const diffs = yield* git.tree.diff({ repository, from: before, to: after, context: 0 })
      expect(diffs.map((item) => [item.file, item.status, item.additions, item.deletions])).toEqual([
        ["a-caf\u00e9.txt", "added", 1, 0],
        ["a-small.txt", "added", 1, 0],
        ...largeFiles.map((file) => [file, "added", 1, 0]),
        ["c-binary.bin", "added", 0, 0],
      ])
      // Patch headers are not NUL-delimited; a quoted (octal-escaped) header would orphan this chunk.
      expect(diffs[0]?.patch).toContain("+caf\u00e9\n")
      expect(diffs[1]?.patch).toContain("+small\n")
      expect(diffs.slice(2, 6).every((entry) => entry.patch.startsWith("diff --git "))).toBe(true)
      expect(diffs[6]?.patch).toBe(VcsPatch.emptyPatch(largeFiles[4]!))
      expect(diffs[7]?.patch).toBe(VcsPatch.emptyPatch(largeFiles[5]!))
      expect(diffs[8]?.patch).toBe("")
      expect(yield* git.tree.diff({ repository, from: before, to: after, paths: [] })).toEqual([])
    }),
  )

  it.live(
    "diffs a path selection longer than any platform command line",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(async () => {
          await initRepo(root.path)
          await fs.mkdir(path.join(root.path, "dir", "nested"), { recursive: true })
          await Bun.write(path.join(root.path, "changed.txt"), "before\n")
          await Bun.write(path.join(root.path, "removed.txt"), "removed\n")
          await Bun.write(path.join(root.path, "dir", "nested", "file.txt"), "before\n")
        })
        const git = yield* Git.Service
        const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
        if (!repository) throw new Error("Repository not found")
        const before = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
        yield* Effect.promise(async () => {
          await Bun.write(path.join(root.path, "changed.txt"), "after\n")
          await fs.rm(path.join(root.path, "removed.txt"))
          await Bun.write(path.join(root.path, "dir", "nested", "file.txt"), "after\n")
          await Bun.write(path.join(root.path, "first.txt"), "first\n")
          await Bun.write(path.join(root.path, "last.txt"), "last\n")
          await Bun.write(path.join(root.path, "unselected.txt"), "unselected\n")
        })
        const after = yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")] })
        const missing = Array.from({ length: 30_000 }, (_, index) =>
          RelativePath.make(`missing/${String(index).padStart(6, "0")}/${"x".repeat(80)}.txt`),
        )
        const paths = ["first.txt", "changed.txt", "removed.txt", "dir", ...missing, "last.txt"].map((file) =>
          RelativePath.make(file),
        )

        const diffs = yield* git.tree.diff({ repository, from: before, to: after, paths })
        expect(diffs.map((item) => [item.file, item.status, item.additions, item.deletions])).toEqual([
          ["changed.txt", "modified", 1, 1],
          ["dir/nested/file.txt", "modified", 1, 1],
          ["first.txt", "added", 1, 0],
          ["last.txt", "added", 1, 0],
          ["removed.txt", "deleted", 0, 1],
        ])
        expect(diffs[0]?.patch).toContain("-before\n+after\n")
        expect(diffs[2]?.patch).toContain("+first\n")
        expect(diffs[4]?.patch).toContain("-removed\n")
        expect(yield* git.tree.diff({ repository, from: before, to: after, paths: missing })).toEqual([])
        expect(yield* git.tree.write(repository)).toBe(after)
      }),
    { timeout: 60_000 },
  )

  it.live("captures, compares, previews, and restores scoped trees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await fs.mkdir(path.join(root.path, "scope"))
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "one\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "outside\n")
        await $`git add .`.cwd(root.path).quiet()
        await $`git commit -m initial`.cwd(root.path).quiet()
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!source) throw new Error("Repository not found")
      const storage = AbsolutePath.make(path.join(root.path, ".snapshot storage"))
      const repository = yield* git.repo.create({ worktree: source.worktree, gitDirectory: storage, seed: source })
      yield* Effect.promise(() => $`git --git-dir ${storage} config --add include.path first.gitconfig`.quiet())
      yield* Effect.promise(() => $`git --git-dir ${storage} config --add include.path second.gitconfig`.quiet())
      yield* Effect.promise(() => $`git --git-dir ${storage} config core.autocrlf true`.quiet())
      yield* git.repo.create({ worktree: source.worktree, gitDirectory: storage, seed: source })
      expect(
        yield* Effect.promise(() => $`git --git-dir ${storage} config --local --includes core.autocrlf`.text()),
      ).toBe("false\n")
      expect(
        (yield* Effect.promise(() => fs.readFile(path.join(storage, "config"), "utf8"))).match(/opencode\.gitconfig/g),
      ).toHaveLength(1)
      expect(
        yield* Effect.promise(() => $`git --git-dir ${storage} config --local --get-all include.path`.text()),
      ).toBe("opencode.gitconfig\nfirst.gitconfig\nsecond.gitconfig\n")
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const before = yield* git.tree.write(repository)

      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "two\n")
        await fs.writeFile(path.join(root.path, "scope", "added.txt"), "added\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "changed outside\n")
      })
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const after = yield* git.tree.write(repository)

      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual([
        RelativePath.make("scope/added.txt"),
        RelativePath.make("scope/tracked.txt"),
      ])
      const diffs = yield* git.tree.diff({ repository, from: before, to: after, context: 1 })
      expect(diffs.map((item) => [item.file, item.status])).toEqual([
        [RelativePath.make("scope/added.txt"), "added"],
        [RelativePath.make("scope/tracked.txt"), "modified"],
      ])

      const files = new Map([[RelativePath.make("scope/tracked.txt"), before]])
      yield* git.tree.restore({ repository, files })
      expect(yield* read(path.join(root.path, "scope", "tracked.txt"))).toBe("one\n")
      expect(yield* read(path.join(root.path, "scope", "added.txt"))).toBe("added\n")
      expect(yield* read(path.join(root.path, "outside.txt"))).toBe("changed outside\n")
    }),
  )
})

describe("Git objects", () => {
  it.live(
    "packs loose objects and combines packs without losing or delegating any object",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
        )
        const project = path.join(root.path, "project")
        yield* Effect.promise(async () => {
          await fs.mkdir(project)
          await initRepo(project)
          await Bun.write(path.join(project, "seed.txt"), "seed\n")
          await $`git add . && git commit -q -m initial`.cwd(project).quiet()
        })
        const git = yield* Git.Service
        const source = yield* git.repo.discover(AbsolutePath.make(project))
        if (!source) throw new Error("Repository not found")
        const repository = yield* git.repo.create({
          worktree: source.worktree,
          gitDirectory: AbsolutePath.make(path.join(root.path, "storage")),
          seed: source,
        })
        const capture = () => git.tree.capture({ repository, scopes: [RelativePath.make(".")], ignores: source })
        const trees = [yield* capture()]
        // Enough distinct content to cross the loose-object threshold.
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 2100 }, (_, index) =>
              Bun.write(path.join(project, `gen/d${index % 20}/f${index}.txt`), `${index}\n`),
            ),
          ),
        )
        trees.push(yield* capture())
        const objects = path.join(repository.gitDirectory, "objects")
        const alternates = path.join(objects, "info", "alternates")
        // Objects stored in the snapshot repository itself, excluding anything borrowed through alternates.
        const everything = () =>
          Effect.promise(async () => {
            const borrowed = await fs.readFile(alternates, "utf8")
            await fs.rm(alternates)
            const listed =
              await $`git --git-dir ${repository.gitDirectory} cat-file --batch-all-objects ${"--batch-check=%(objectname)"}`.text()
            await fs.writeFile(alternates, borrowed)
            return listed.split("\n").filter(Boolean).toSorted()
          })
        const loose = () => Effect.promise(() => looseObjectIDs(objects))
        const before = yield* everything()
        expect((yield* loose()).length).toBeGreaterThan(2048)

        yield* git.objects.pack(repository)
        expect(yield* loose()).toEqual([])
        expect(yield* everything()).toEqual(before)

        for (let batch = 0; batch < 16; batch++) {
          yield* Effect.promise(() => Bun.write(path.join(project, `batch-${batch}.txt`), `${batch}\n`))
          trees.push(yield* capture())
          yield* Effect.promise(async () => {
            const list = await looseObjectIDs(objects)
            await $`git --git-dir ${repository.gitDirectory} pack-objects -q ${path.join(objects, "pack", "pack")} < ${Buffer.from(list.join("\n") + "\n")}`.quiet()
            await $`git --git-dir ${repository.gitDirectory} prune-packed`.quiet()
          })
        }
        const packs = () =>
          Effect.promise(async () =>
            (await fs.readdir(path.join(objects, "pack"))).filter((file) => file.endsWith(".pack")),
          )
        expect((yield* packs()).length).toBeGreaterThanOrEqual(16)
        const merged = yield* everything()

        yield* git.objects.pack(repository)
        expect((yield* packs()).length).toBe(1)
        expect(yield* everything()).toEqual(merged)

        expect((yield* git.tree.files({ repository, from: trees[0]!, to: trees.at(-1)! })).length).toBe(2100 + 16)
      }),
    { timeout: 60_000 },
  )
})

describe("Git capture", () => {
  it.live("applies both the store's own and the source's ignore rules and never splits the index", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const project = path.join(root.path, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(project)
        await initRepo(project)
        await Bun.write(path.join(project, "tracked.bin"), "small\n")
        await $`git add . && git commit -q -m initial`.cwd(project).quiet()
        await Bun.write(path.join(project, ".git", "info", "exclude"), "source-ignored/\n")
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(project))
      if (!source) throw new Error("Repository not found")
      const storage = AbsolutePath.make(path.join(root.path, "storage"))
      const repository = yield* git.repo.create({ worktree: source.worktree, gitDirectory: storage, seed: source })
      yield* Effect.promise(async () => {
        // Rules an init template left in the store keep applying, and a split index would lose entries.
        await Bun.write(path.join(storage, "info", "exclude"), "store-ignored/\n")
        await $`git --git-dir ${storage} config core.splitIndex true`.quiet()
      })
      const capture = () => git.tree.capture({ repository, scopes: [RelativePath.make(".")], ignores: source })
      const before = yield* capture()
      yield* Effect.promise(async () => {
        await Bun.write(path.join(project, "tracked.bin"), "changed\n")
        await Bun.write(path.join(project, "store-ignored", "a.txt"), "a\n")
        await Bun.write(path.join(project, "source-ignored", "b.txt"), "b\n")
        await Bun.write(path.join(project, "kept.txt"), "kept\n")
      })
      const after = yield* capture()
      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual([
        RelativePath.make("kept.txt"),
        RelativePath.make("tracked.bin"),
      ])
      expect(yield* capture()).toBe(after)
      expect(yield* Effect.promise(() => fs.readFile(path.join(storage, "info", "exclude"), "utf8"))).toStartWith(
        "store-ignored/\n",
      )
    }),
  )

  it.live("queued captures share one capture that still sees changes made before the call", () =>
    Effect.gen(function* () {
      const { root, project, repository, service, capture } = yield* captureSetup
      const before = yield* capture()
      yield* Effect.promise(() => Bun.write(path.join(project, "a.txt"), "changed\n"))
      const trace = path.join(root.path, "trace")
      const trees = yield* withEnv({ GIT_TRACE: trace }, () =>
        Effect.all(Array.from({ length: 4 }, capture), { concurrency: "unbounded" }),
      )
      expect(new Set(trees).size).toBe(1)
      expect(yield* service.tree.files({ repository, from: before, to: trees[0]! })).toEqual([
        RelativePath.make("a.txt"),
      ])
      expect((yield* traced(trace)).filter((command) => command === "ls-files").length).toBeLessThanOrEqual(2)
    }),
  )

  it.live("skips repeat ignore checks for oversized and info/exclude-only untracked files", () =>
    Effect.gen(function* () {
      const { root, project, capture } = yield* captureSetup
      yield* Effect.promise(async () => {
        await Bun.write(path.join(project, ".git", "info", "exclude"), "excluded.txt\n")
        await Bun.write(path.join(project, "excluded.txt"), "x\n")
        await Bun.write(path.join(project, "large.txt"), "too large\n")
      })
      const first = yield* capture({ maximumUntrackedFileBytes: 4 })
      const trace = path.join(root.path, "trace")
      expect(yield* withEnv({ GIT_TRACE: trace }, () => capture({ maximumUntrackedFileBytes: 4 }))).toBe(first)
      expect((yield* traced(trace)).toSorted()).toEqual(["diff-files", "ls-files"])
      const entries = yield* Effect.promise(() =>
        $`git --git-dir ${root.path}/storage ls-tree --name-only ${first}`.text(),
      )
      expect(entries.split("\n").filter(Boolean)).toEqual(["a.txt", "b.txt"])
    }),
  )

  it.live("seeds and rebuilds the store from a source with a split index", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const project = path.join(root.path, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(project)
        await initRepo(project)
        await Bun.write(path.join(project, "a.txt"), "one\n")
        await $`git add . && git commit -q -m initial && git update-index --split-index`.cwd(project).quiet()
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(project))
      if (!source) throw new Error("Repository not found")
      const storage = AbsolutePath.make(path.join(root.path, "storage"))
      const repository = yield* git.repo.create({ worktree: source.worktree, gitDirectory: storage, seed: source })
      const capture = () => git.tree.capture({ repository, scopes: [RelativePath.make(".")], ignores: source })
      const before = yield* capture()
      yield* Effect.promise(() => Bun.write(path.join(project, "a.txt"), "two\n"))
      const after = yield* capture()
      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual([RelativePath.make("a.txt")])
      yield* git.tree.restore({ repository, files: new Map([[RelativePath.make("a.txt"), before]]) })
      expect(yield* read(path.join(project, "a.txt"))).toBe("one\n")

      yield* Effect.promise(() => Bun.write(path.join(storage, "index"), "not an index"))
      expect(yield* capture()).toBe(before)
      expect(
        (yield* Effect.promise(() => fs.readdir(storage))).filter((entry) => entry.startsWith("sharedindex.")),
      ).toEqual([])
    }),
  )
})

const captureSetup = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  )
  const project = path.join(root.path, "project")
  yield* Effect.promise(async () => {
    await fs.mkdir(project)
    await initRepo(project)
    await Bun.write(path.join(project, "a.txt"), "a\n")
    await Bun.write(path.join(project, "b.txt"), "b\n")
    await $`git add . && git commit -q -m initial`.cwd(project).quiet()
  })
  const service = yield* Git.Service
  const source = yield* service.repo.discover(AbsolutePath.make(project))
  if (!source) throw new Error("Repository not found")
  const repository = yield* service.repo.create({
    worktree: source.worktree,
    gitDirectory: AbsolutePath.make(path.join(root.path, "storage")),
    seed: source,
  })
  const capture = (options?: { maximumUntrackedFileBytes?: number }) =>
    service.tree.capture({ repository, scopes: [RelativePath.make(".")], ignores: source, ...options })
  return { root, project, repository, service, capture }
})

const traced = (file: string) =>
  Effect.promise(async () =>
    (await Bun.file(file).text()).split("\n").flatMap((line) => line.match(/trace: built-in: git (\S+)/)?.[1] ?? []),
  )

describe("Git capture recovery", () => {
  const setup = Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const project = path.join(root.path, "project")
    yield* Effect.promise(async () => {
      await fs.mkdir(project)
      await initRepo(project)
      await Bun.write(path.join(project, "a.txt"), "a\n")
      await Bun.write(path.join(project, "b.txt"), "b\n")
      await $`git add . && git commit -q -m initial`.cwd(project).quiet()
    })
    const git = yield* Git.Service
    const source = yield* git.repo.discover(AbsolutePath.make(project))
    if (!source) throw new Error("Repository not found")
    const repository = yield* git.repo.create({
      worktree: source.worktree,
      gitDirectory: AbsolutePath.make(path.join(root.path, "storage")),
      seed: source,
    })
    const capture = () => git.tree.capture({ repository, scopes: [RelativePath.make(".")], ignores: source })
    return { root, project, repository, capture }
  })

  it.live("sweeps abandoned temporary indexes by their creation time, not their mtime", () =>
    Effect.gen(function* () {
      const { repository, capture } = yield* setup
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
      const live = path.join(repository.gitDirectory, `index.opencode-${Date.now()}-1-live`)
      const abandoned = path.join(repository.gitDirectory, `index.opencode-${twoHoursAgo}-1-abandoned`)
      yield* Effect.promise(async () => {
        await Bun.write(live, "")
        await Bun.write(abandoned, "")
        // A hard link to an index nobody wrote for hours carries that old mtime while in use.
        await fs.utimes(live, new Date(twoHoursAgo), new Date(twoHoursAgo))
      })
      yield* capture()
      expect(yield* Effect.promise(() => Bun.file(live).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(abandoned).exists())).toBe(false)
    }),
  )

  it.live("records a tracked file replaced by an embedded repository as a gitlink", () =>
    Effect.gen(function* () {
      const { project, repository, capture } = yield* setup
      yield* capture()
      yield* Effect.promise(async () => {
        await fs.rm(path.join(project, "a.txt"))
        await Bun.write(path.join(project, "a.txt", "inner.txt"), "inner\n")
        await initRepo(path.join(project, "a.txt"))
        await $`git add . && git commit -q -m inner`.cwd(path.join(project, "a.txt")).quiet()
      })
      const tree = yield* capture()
      const entry = yield* Effect.promise(() =>
        $`git --git-dir ${repository.gitDirectory} ls-tree ${tree} a.txt`.text(),
      )
      expect(entry).toStartWith("160000 commit ")
    }),
  )

  it.live("keeps the index when Git cannot even start", () =>
    Effect.gen(function* () {
      const { root, project, repository, capture } = yield* setup
      const before = yield* capture()
      const moved = path.join(root.path, "moved")
      yield* Effect.promise(() => fs.rename(project, moved))
      expect(Exit.isFailure(yield* capture().pipe(Effect.exit))).toBe(true)
      yield* Effect.promise(() => fs.rename(moved, project))
      expect(yield* Effect.promise(() => Bun.file(path.join(repository.gitDirectory, "index")).exists())).toBe(true)
      expect(yield* capture()).toBe(before)
    }),
  )
})

async function looseObjectIDs(objects: string) {
  const prefixes = (await fs.readdir(objects)).filter((entry) => /^[0-9a-f]{2}$/.test(entry))
  const listed = await Promise.all(
    prefixes.map(async (prefix) => (await fs.readdir(path.join(objects, prefix))).map((entry) => prefix + entry)),
  )
  return listed.flat()
}
