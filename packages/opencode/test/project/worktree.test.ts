import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { chmod } from "node:fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { LSP } from "@/lsp/lsp"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, SessionID } from "../../src/session/schema"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Worktree.node,
      FSUtil.node,
      Git.node,
      LSP.node,
      Format.node,
      EventV2Bridge.node,
      Truncate.node,
      Agent.node,
      CrossSpawnSpawner.node,
    ]),
    [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
  ),
)
const wintest = process.platform !== "win32" ? it.instance : it.instance.skip
const permissionTest = process.platform !== "win32" && process.getuid?.() !== 0 ? it.instance : it.instance.skip

function normalize(input: string) {
  return input.replace(/\\/g, "/").toLowerCase()
}

const waitReady = Effect.fn("WorktreeTest.waitReady")(function* () {
  const ready = yield* Deferred.make<{ name: string; branch?: string }>()
  const on = (evt: GlobalEvent) => {
    if (evt.payload.type !== Worktree.Event.Ready.type) return
    Deferred.doneUnsafe(ready, Effect.succeed(evt.payload.properties))
  }

  GlobalBus.on("event", on)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

  return yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
    }),
  )
})

const removeCreatedWorktree = (directory: string) =>
  Effect.gen(function* () {
    const svc = yield* Worktree.Service
    const ok = yield* svc.remove({ directory })
    if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${directory}`))
  })

const withCreatedWorktree = <A, E, R>(
  input: Parameters<Worktree.Interface["create"]>[0],
  use: (created: { info: Worktree.Info; ready: { name: string; branch?: string } }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const svc = yield* Worktree.Service
      const ready = yield* waitReady().pipe(Effect.forkScoped)
      const info = yield* svc.create(input)
      const props = yield* Fiber.join(ready)
      return { info, ready: props }
    }),
    use,
    ({ info }) => removeCreatedWorktree(info.directory),
  )

const git = Effect.fn("WorktreeTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})

const gitResult = Effect.fn("WorktreeTest.gitResult")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  return yield* service.run(args, { cwd })
})

const withExternalWorktree = <A, E, R>(
  directory: string,
  name: string,
  use: (target: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const target = path.join(path.dirname(directory), `${path.basename(directory)}-${name}-${Date.now()}`)
      yield* git(directory, ["worktree", "add", "--detach", target, "HEAD"])
      return target
    }),
    use,
    (target) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
      }),
  )

describe("Worktree", () => {
  afterEach(() => disposeAllInstances())

  describe("makeWorktreeInfo", () => {
    it.instance(
      "returns info with name, branch, and directory",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo()

          expect(info.name).toBeDefined()
          expect(typeof info.name).toBe("string")
          expect(info.branch).toBe(`opencode/${info.name}`)
          expect(info.directory).toContain(info.name)
        }),
      { git: true },
    )

    it.instance(
      "uses provided name as base",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "my-feature" })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBe("opencode/my-feature")
        }),
      { git: true },
    )

    it.instance(
      "slugifies the provided name",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "My Feature Branch!" })

          expect(info.name).toBe("my-feature-branch")
        }),
      { git: true },
    )

    it.instance(
      "omits branch for detached info",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          yield* git(test.directory, ["branch", "opencode/my-feature"])

          const info = yield* svc.makeWorktreeInfo({ name: "my-feature", detached: true })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBeUndefined()
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.makeWorktreeInfo())

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )

    wintest(
      "creates detached git worktree when info has no branch",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "detached-test", detached: true })
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          yield* svc.createFromInfo(info)

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          const normalizedList = normalize(list)
          const normalizedDir = normalize(info.directory)
          expect(normalizedList).toContain(normalizedDir)

          const branch = yield* gitResult(info.directory, ["symbolic-ref", "-q", "--short", "HEAD"])
          expect(branch.exitCode).not.toBe(0)

          const props = yield* Fiber.join(ready)
          expect(props.name).toBe(info.name)
          expect(props.branch).toBeUndefined()

          yield* svc.remove({ directory: info.directory })
        }),
      { git: true },
    )
  })

  describe("create + remove lifecycle", () => {
    it.instance(
      "create returns worktree info and remove cleans up",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("opencode/")
            expect(info.directory).toBeDefined()
          }),
        ),
      { git: true },
    )

    it.instance(
      "create returns after setup and fires Event.Ready after bootstrap",
      () =>
        withCreatedWorktree(undefined, ({ info, ready }) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service

            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("opencode/")

            expect(ready.name).toBe(info.name)
            expect(ready.branch).toBe(info.branch)

            const list = yield* svc.list()
            expect(list).toContainEqual(expect.objectContaining({ name: info.name, branch: info.branch }))
          }),
        ),
      { git: true },
    )

    it.instance(
      "waits for bootstrap before returning when requested",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const readyDirectories = new Set<string>()
          const on = (event: GlobalEvent) => {
            if (event.payload.type === Worktree.Event.Ready.type && event.directory) {
              readyDirectories.add(event.directory)
            }
          }
          GlobalBus.on("event", on)
          yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

          const info = yield* svc.create({ waitUntilReady: true })
          yield* Effect.addFinalizer(() => removeCreatedWorktree(info.directory).pipe(Effect.ignore))

          expect(info.ready).toBe(true)
          expect(readyDirectories.has(info.directory)).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(path.join(info.directory, ".git")).exists())).toBe(true)
        }),
      { git: true },
    )

    it.instance(
      "isolates concurrent relative patches across real worktrees",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const info = yield* ApplyPatchTool
          const tool = yield* info.init()
          const writeInfo = yield* WriteTool
          const write = yield* writeInfo.init()
          const editInfo = yield* EditTool
          const edit = yield* editInfo.init()
          const context = {
            sessionID: SessionID.make("ses_worktree_isolation"),
            messageID: MessageID.make("msg_worktree_isolation"),
            callID: "",
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          } satisfies Tool.Context

          yield* withCreatedWorktree({ name: "isolation-a" }, ({ info: a }) =>
            withCreatedWorktree({ name: "isolation-b" }, ({ info: b }) =>
              Effect.gen(function* () {
                const patch = (content: string) =>
                  tool.execute(
                    { patchText: `*** Begin Patch\n*** Add File: isolation.txt\n+${content}\n*** End Patch` },
                    context,
                  )
                yield* Effect.all(
                  [
                    patch("worktree-a").pipe(provideInstance(a.directory)),
                    patch("worktree-b").pipe(provideInstance(b.directory)),
                  ],
                  { concurrency: "unbounded" },
                )
                yield* write
                  .execute({ filePath: "relative-write.txt", content: "before edit" }, context)
                  .pipe(provideInstance(b.directory))
                yield* edit
                  .execute(
                    { filePath: "relative-write.txt", oldString: "before edit", newString: "after edit" },
                    context,
                  )
                  .pipe(provideInstance(b.directory))

                expect(yield* Effect.promise(() => Bun.file(path.join(a.directory, "isolation.txt")).text())).toBe(
                  "worktree-a\n",
                )
                expect(yield* Effect.promise(() => Bun.file(path.join(b.directory, "isolation.txt")).text())).toBe(
                  "worktree-b\n",
                )
                expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "isolation.txt")).exists())).toBe(
                  false,
                )
                expect(yield* Effect.promise(() => Bun.file(path.join(b.directory, "relative-write.txt")).text())).toBe(
                  "after edit",
                )
                expect(
                  yield* Effect.promise(() => Bun.file(path.join(test.directory, "relative-write.txt")).exists()),
                ).toBe(false)
                expect((yield* git(a.directory, ["status", "--porcelain=v1", "--untracked-files=all"])).trim()).toBe(
                  "?? isolation.txt",
                )
                expect((yield* git(b.directory, ["status", "--porcelain=v1", "--untracked-files=all"])).trim()).toBe(
                  "?? isolation.txt\n?? relative-write.txt",
                )
                expect((yield* git(test.directory, ["status", "--porcelain=v1", "--untracked-files=all"])).trim()).toBe(
                  "",
                )
              }),
            ),
          )
        }),
      { git: true },
    )

    it.instance(
      "lists the active linked worktree but not the project checkout",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const test = yield* TestInstance
            const svc = yield* Worktree.Service
            const list = yield* svc.list().pipe(provideInstance(info.directory))

            expect(list.map((item) => item.name)).toContain(info.name)
            expect(list.map((item) => item.name)).not.toContain(path.basename(test.directory).toLowerCase())
          }),
        ),
      { git: true },
    )

    it.instance(
      "create with custom name",
      () =>
        withCreatedWorktree({ name: "test-workspace" }, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBe("test-workspace")
            expect(info.branch).toBe("opencode/test-workspace")
          }),
        ),
      { git: true },
    )
  })

  describe("createFromInfo", () => {
    wintest(
      "creates git worktree and boots asynchronously",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "from-info-test" })
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          yield* svc.createFromInfo(info)

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          const normalizedList = list.replace(/\\/g, "/")
          const normalizedDir = info.directory.replace(/\\/g, "/")
          expect(normalizedList).toContain(normalizedDir)

          yield* Fiber.join(ready)
          yield* removeCreatedWorktree(info.directory)
        }),
      { git: true },
    )
  })

  describe("list", () => {
    it.instance(
      "discovers external worktrees and reflects Git removals",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service

          yield* withExternalWorktree(test.directory, "external", (target) =>
            Effect.gen(function* () {
              const list = yield* svc.list()
              expect(list.map((item) => normalize(item.directory))).toContain(normalize(target))
              expect(list.map((item) => normalize(item.directory))).not.toContain(normalize(test.directory))

              yield* git(test.directory, ["worktree", "remove", "--force", target])
              const afterRemove = yield* svc.list()
              expect(afterRemove.map((item) => normalize(item.directory))).not.toContain(normalize(target))
            }),
          )
        }),
      { git: true },
    )

    it.instance(
      "includes detached and locked worktrees",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service

          yield* withExternalWorktree(test.directory, "locked", (target) =>
            Effect.gen(function* () {
              yield* git(test.directory, ["worktree", "lock", target])
              const list = yield* svc.list()
              expect(list.map((item) => normalize(item.directory))).toContain(normalize(target))
              expect(list.find((item) => normalize(item.directory) === normalize(target))?.branch).toBeUndefined()
              yield* git(test.directory, ["worktree", "unlock", target])
            }),
          )
        }),
      { git: true },
    )

    it.instance(
      "excludes prunable and missing worktrees",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const svc = yield* Worktree.Service

          yield* withExternalWorktree(test.directory, "prunable", (target) =>
            Effect.gen(function* () {
              yield* fs.remove(target, { recursive: true })
              const porcelain = yield* git(test.directory, ["worktree", "list", "--porcelain"])
              expect(porcelain).toContain("prunable")
              expect(yield* svc.list()).toEqual([])
            }),
          )
        }),
      { git: true },
    )

    permissionTest(
      "excludes inaccessible worktrees",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service

          yield* withExternalWorktree(test.directory, "inaccessible", (target) =>
            Effect.acquireUseRelease(
              Effect.promise(() => chmod(target, 0)),
              () =>
                Effect.gen(function* () {
                  expect(yield* svc.list()).toEqual([])
                }),
              () => Effect.promise(() => chmod(target, 0o755)),
            ),
          )
        }),
      { git: true },
    )

    it.instance("returns no worktrees for non-git projects", () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        expect(yield* svc.list()).toEqual([])
      }),
    )

    it.instance(
      "reports Git listing failures",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const svc = yield* Worktree.Service
          yield* fs.remove(path.join(test.directory, ".git"), { recursive: true })

          const exit = yield* Effect.exit(svc.list())
          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) return
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.ListFailedError)
        }),
      { git: true },
    )

    it.instance(
      "uses parent folder name when worktree basename matches the primary worktree",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const svc = yield* Worktree.Service
          const parent = path.join(path.dirname(test.directory), `${path.basename(test.directory)}-parent`)
          const target = path.join(parent, path.basename(test.directory))
          const branch = `same-basename-list-${Date.now()}`

          yield* fs.ensureDir(parent)
          yield* git(test.directory, ["worktree", "add", "-b", branch, target])

          const list = yield* svc.list()
          const directory = yield* fs.realPath(target).pipe(Effect.catch(() => Effect.succeed(target)))

          expect(list.map((item) => ({ ...item, directory: normalize(item.directory) }))).toContainEqual({
            name: path.basename(parent),
            branch,
            directory: normalize(directory),
          })

          yield* svc.remove({ directory: target })
        }),
      { git: true },
    )
  })

  describe("remove edge cases", () => {
    it.instance(
      "remove non-existent directory succeeds silently",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const ok = yield* svc.remove({ directory: path.join(test.directory, "does-not-exist") })
          expect(ok).toBe(true)
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.remove({ directory: path.join(test.directory, "fake") }))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )
  })
})
