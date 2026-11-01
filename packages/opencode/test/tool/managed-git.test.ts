import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ManagedGit } from "../../src/tool/shell/managed-git"
import { ManagedLinux } from "../../src/tool/shell/managed-linux"

const config = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (status !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
  return stdout.trim()
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "managed-git-test-"))
  const common = path.join(root, "common")
  const work = path.join(root, "candidate")
  const other = path.join(root, "other")
  const clone = path.join(root, "clone")
  const snapshot = path.join(clone, ".git")
  await mkdir(common)
  await git(common, "init")
  await git(common, "config", "user.name", "Test")
  await git(common, "config", "user.email", "test@example.invalid")
  await Bun.write(path.join(common, "source.txt"), "first\n")
  await git(common, "add", "source.txt")
  await git(common, "commit", "-m", "first")
  await Bun.write(path.join(common, "source.txt"), "second\n")
  await git(common, "commit", "-am", "second")
  await git(common, "worktree", "add", "-b", "candidate", work)
  await git(common, "worktree", "add", "-b", "other", other)
  await git(root, "clone", "--no-local", "--no-hardlinks", "--no-checkout", work, clone)
  await git(clone, "read-tree", "HEAD")
  await rm(path.join(snapshot, "hooks"), { recursive: true })
  await Bun.write(path.join(snapshot, "config"), config)
  await Bun.write(path.join(other, "secret"), "outside slot\n")
  return {
    root,
    common,
    work,
    other,
    snapshot,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function prepare(workspace: string, gitDirectory: string, script = "true", readOnly = true) {
  return ManagedLinux.prepare({ workspace, gitDirectory, readOnly, argv: ["/bin/sh", "-c", script], timeoutMs: 20_000 })
}

async function digest(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
}

test("operator policy is exact, absolute and bound to the selected workspace", async () => {
  await using f = await fixture()
  expect(await ManagedGit.directory(f.work, JSON.stringify({ directory: f.work, snapshot: f.snapshot }))).toBe(
    f.snapshot,
  )
  for (const policy of [
    "null",
    "[]",
    "{}",
    JSON.stringify({ directory: f.work, snapshot: "relative" }),
    JSON.stringify({ directory: f.work, snapshot: f.snapshot, extra: true }),
  ]) {
    await expect(ManagedGit.directory(f.work, policy)).rejects.toThrow()
  }
  await expect(
    ManagedGit.directory(f.other, JSON.stringify({ directory: f.work, snapshot: f.snapshot })),
  ).rejects.toThrow()
})

test("rejects unsafe or shared Git snapshots before launch", async () => {
  await using f = await fixture()
  await expect(prepare(f.work, f.work)).rejects.toThrow()
  await expect(prepare(f.work, f.common)).rejects.toThrow()
  for (const value of [
    config + "[include]\n path = /tmp/config\n",
    config + "[core]\n hooksPath = /tmp/hooks\n",
    "[core]\n bare = true\n",
  ]) {
    await Bun.write(path.join(f.snapshot, "config"), value)
    await expect(prepare(f.work, f.snapshot)).rejects.toThrow()
  }
  await Bun.write(path.join(f.snapshot, "config"), config)
  for (const file of [
    "commondir",
    "gitdir",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "hooks",
    "worktrees",
  ]) {
    const target = path.join(f.snapshot, file)
    await Bun.write(target, "unsafe\n")
    await expect(prepare(f.work, f.snapshot)).rejects.toThrow()
    await rm(target)
  }
  await symlink(path.join(f.common, ".git"), path.join(f.snapshot, "linked"))
  await expect(prepare(f.work, f.snapshot)).rejects.toThrow()
  await rm(path.join(f.snapshot, "linked"))
  await link(path.join(f.snapshot, "index"), path.join(f.root, "hardlink"))
  await expect(prepare(f.work, f.snapshot)).rejects.toThrow()
})

test("read-only candidate can inspect Git but cannot modify workspace or history", async () => {
  await using f = await fixture()
  const head = await git(f.work, "rev-parse", "HEAD")
  const parent = await git(f.work, "rev-parse", "HEAD^")
  const index = path.join(f.common, ".git/worktrees/candidate/index")
  const before = await Promise.all([
    digest(path.join(f.work, "source.txt")),
    digest(index),
    digest(path.join(f.snapshot, "index")),
  ])
  const script = `set -eu
test "$GIT_DIR" = /git && test "$GIT_WORK_TREE" = /work && test "$GIT_OPTIONAL_LOCKS" = 0
git status --porcelain
git diff --exit-code
git log --format=%s | grep -q second
test "$(git rev-parse HEAD)" = ${head}
git merge-base --is-ancestor ${parent} HEAD
! (echo changed > source.txt) 2>/dev/null
! (echo changed > .git) 2>/dev/null
! (echo changed > /git/index) 2>/dev/null
! (echo changed > /git/HEAD) 2>/dev/null
! git add source.txt 2>/dev/null
test ! -e '${f.other}/secret'
printf 'int main(void){return 0;}\n' > /tmp/test.c
cc /tmp/test.c -o /tmp/test && /tmp/test
echo inspected`
  const result = await (await prepare(f.work, f.snapshot, script)).start()
  expect({
    reason: result.reason,
    status: result.exitCode,
    cleanup: result.cleanup,
    stderr: result.stderr.toString(),
  }).toEqual({ reason: "exit", status: 0, cleanup: "confirmed", stderr: "" })
  expect(result.stdout.toString()).toContain("inspected")
  expect(
    await Promise.all([digest(path.join(f.work, "source.txt")), digest(index), digest(path.join(f.snapshot, "index"))]),
  ).toEqual(before)
  expect(await git(f.work, "rev-parse", "HEAD")).toBe(head)
})

test("writable worktree permits edits but not Git mutations or access to another slot", async () => {
  await using f = await fixture()
  const head = await git(f.work, "rev-parse", "HEAD")
  const result = await (
    await prepare(
      f.work,
      f.snapshot,
      `set -eu
echo edited > source.txt
! (echo changed > .git) 2>/dev/null
! git add source.txt 2>/dev/null
! git -c user.name=Test -c user.email=test@example.invalid commit -am bad 2>/dev/null
! git fetch 2>/dev/null
! git push 2>/dev/null
test ! -e '${f.other}/secret'
(sleep 0.2; echo escaped > late-write) >/dev/null 2>&1 &
echo allowed`,
      false,
    )
  ).start()
  expect({
    reason: result.reason,
    status: result.exitCode,
    cleanup: result.cleanup,
    stderr: result.stderr.toString(),
  }).toEqual({ reason: "exit", status: 0, cleanup: "confirmed", stderr: "" })
  expect(result.stdout.toString()).toContain("allowed")
  expect(await Bun.file(path.join(f.work, "source.txt")).text()).toBe("edited\n")
  expect(await git(f.work, "rev-parse", "HEAD")).toBe(head)
  await Bun.sleep(500)
  expect(await Bun.file(path.join(f.work, "late-write")).exists()).toBe(false)
})

test("standalone repository metadata is masked even for a writable workspace", async () => {
  await using f = await fixture()
  const head = await git(f.common, "rev-parse", "HEAD")
  const result = await (
    await prepare(
      f.common,
      f.snapshot,
      `set -eu
test ! -e .git/config
! (echo changed > .git/config) 2>/dev/null
test "$(git rev-parse HEAD)" = ${head}
echo standalone`,
      false,
    )
  ).start()
  expect({
    reason: result.reason,
    status: result.exitCode,
    cleanup: result.cleanup,
    stderr: result.stderr.toString(),
  }).toEqual({ reason: "exit", status: 0, cleanup: "confirmed", stderr: "" })
  expect(result.stdout.toString()).toContain("standalone")
  expect(await git(f.common, "rev-parse", "HEAD")).toBe(head)
})
