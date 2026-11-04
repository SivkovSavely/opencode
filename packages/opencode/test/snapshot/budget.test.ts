import { expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"
import { MAX_FULL_DIFF_FILE_BYTES, Snapshot } from "../../src/snapshot"
import { provideInstance, TestInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([AppProcess.node, FSUtil.node, CrossSpawnSpawner.node])),
    testInstanceStoreLayer,
  ),
)

type Call = {
  args: ReadonlyArray<string>
  options?: AppProcess.RunOptions
  result?: AppProcess.RunResult
}
type Run = ReturnType<AppProcess.Interface["run"]>

// Observe the real process service, including its actual captured output and truncation flags.
const observed = <A, E, R>(
  use: (calls: Call[]) => Effect.Effect<A, E, R>,
  around?: (call: Call, run: Run, command: ChildProcess.Command) => Run,
) =>
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const calls: Call[] = []
    const layer = Layer.succeed(AppProcess.Service, {
      ...process,
      run: (command, options) =>
        Effect.gen(function* () {
          const call: Call = { args: command._tag === "StandardCommand" ? command.args : [], options }
          calls.push(call)
          const run = process.run(command, options)
          const result = yield* around ? around(call, run, command) : run
          call.result = result
          return result
        }),
    })
    return yield* use(calls).pipe(Effect.provide(LayerNode.compile(Snapshot.node, [[AppProcess.node, layer]])))
  })

const write = (file: string, value: string) => FSUtil.Service.use((fs) => fs.writeWithDirs(file, value))
const remove = (file: string) => FSUtil.Service.use((fs) => fs.remove(file, { force: true }))
const git = Effect.fnUntraced(function* (directory: string, args: string[], stdin?: string) {
  const process = yield* AppProcess.Service
  const result = yield* process.run(ChildProcess.make("git", args, { cwd: directory }), { stdin })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return result.stdout.toString().trim()
})
const tracked = Effect.gen(function* () {
  const snapshot = yield* Snapshot.Service
  const hash = yield* snapshot.track()
  if (!hash) return yield* Effect.die(new Error("snapshot.track returned no tree"))
  return hash
})
const loads = (calls: Call[]) => calls.filter((call) => call.args.includes("--batch"))
const statistics = (calls: Call[]) => calls.filter((call) => call.args.includes("--numstat"))

it.instance(
  "diffFull bounds named files before content loading and retains omitted totals",
  observed((calls) =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const removed = Array.from({ length: 37 }, (_, i) => `z-old-${i}.txt`)
      yield* Effect.forEach(removed, (file) => write(path.join(tmp.directory, file), "old\n"), { concurrency: 8 })
      const before = yield* tracked
      yield* Effect.forEach(removed, (file) => remove(path.join(tmp.directory, file)), { concurrency: 8 })
      yield* Effect.forEach(
        Array.from({ length: 237 }, (_, i) => i),
        (i) => write(path.join(tmp.directory, `new-${String(i).padStart(3, "0")}.txt`), "one\ntwo\n"),
        { concurrency: 8 },
      )
      const after = yield* tracked
      calls.length = 0
      const diffs = yield* snapshot.diffFull(before, after)
      expect(diffs).toHaveLength(201)
      expect(diffs.filter((row) => row.file)).toHaveLength(SnapshotDiff.MAX_FILES)
      expect(diffs.at(-1)).toEqual({ additions: 74, deletions: 37, omitted: { reason: "aggregate-budget", files: 74 } })
      expect(SnapshotDiff.totals(diffs)).toEqual({
        files: 274,
        additions: 474,
        deletions: 37,
        filesComplete: true,
        complete: true,
      })
      expect(loads(calls)).toHaveLength(200)
      expect(calls.filter((call) => call.args.includes("--batch-check"))).toHaveLength(1)
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull preflights a large batch without reading any oversized blob",
  observed((calls) =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const before = yield* tracked
      // Reuse a single real Git object rather than allocating 101 large working-tree files.
      const blob = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "x".repeat(MAX_FULL_DIFF_FILE_BYTES + 1))
      const tree = yield* git(
        tmp.directory,
        ["mktree"],
        Array.from({ length: 101 }, (_, i) => `100644 blob ${blob}\tlarge-${String(i).padStart(3, "0")}.txt\n`).join(
          "",
        ),
      )
      calls.length = 0
      const diffs = yield* snapshot.diffFull(before, tree)
      expect(diffs).toHaveLength(101)
      expect(
        diffs.every(
          (row) =>
            row.patch === "" &&
            row.omitted?.reason === "size" &&
            row.omitted.files === 1 &&
            row.omitted.statisticsIncomplete === true,
        ),
      ).toBe(true)
      expect(SnapshotDiff.totals(diffs)).toEqual({
        files: 101,
        additions: 0,
        deletions: 0,
        filesComplete: true,
        complete: false,
      })
      expect(statistics(calls)).toHaveLength(0)
      expect(loads(calls)).toHaveLength(0)
      expect(calls.some((call) => call.args.includes("show"))).toBe(false)
      const preflight = calls.find((call) => call.args.includes("--batch-check"))
      expect(preflight?.options?.stdin).toBe(`${blob}\n`)
      expect(preflight?.result?.stdout.toString()).toContain(`blob ${MAX_FULL_DIFF_FILE_BYTES + 1}`)
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull checks sizes before numstat even when attributes force oversized blobs to text",
  observed((calls) =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      yield* write(path.join(tmp.directory, ".gitattributes"), "*.txt diff\n")
      const before = yield* tracked
      const attributes = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "*.txt diff\n")
      const large = yield* git(
        tmp.directory,
        ["hash-object", "-w", "--stdin"],
        "x".repeat(MAX_FULL_DIFF_FILE_BYTES + 1),
      )
      const small = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "small\n")
      const files = ["[literal].txt", "z-small.txt"]
      const tree = yield* git(
        tmp.directory,
        ["mktree"],
        [
          `100644 blob ${attributes}\t.gitattributes\n`,
          `100644 blob ${large}\ta-large.txt\n`,
          ...files.map((file) => `100644 blob ${small}\t${file}\n`),
        ].join(""),
      )
      expect(yield* git(tmp.directory, ["check-attr", "diff", "--", "a-large.txt"])).toBe("a-large.txt: diff: set")
      calls.length = 0
      const diffs = yield* snapshot.diffFull(before, tree)
      expect(diffs).toHaveLength(3)
      expect(diffs.find((row) => row.file === "a-large.txt")).toEqual({
        file: "a-large.txt",
        patch: "",
        additions: 0,
        deletions: 0,
        status: "added",
        omitted: { reason: "size", files: 1, statisticsIncomplete: true },
      })
      expect(diffs.filter((row) => files.includes(row.file ?? "")).every((row) => row.patch?.includes("+small"))).toBe(
        true,
      )
      expect(calls[0].args).toContain("--raw")
      expect(calls[0].args).not.toContain("--numstat")
      const checked = calls.findIndex((call) => call.args.includes("--batch-check"))
      expect(calls[checked].result?.stdout.toString()).toContain(`${large} blob ${MAX_FULL_DIFF_FILE_BYTES + 1}`)
      expect(statistics(calls)).toHaveLength(1)
      expect(statistics(calls)[0].args).toContain("--literal-pathspecs")
      expect(statistics(calls)[0].args.slice(statistics(calls)[0].args.indexOf("--") + 1)).toEqual(files)
      expect(loads(calls)).toHaveLength(2)
      for (const call of [...statistics(calls), ...loads(calls)]) {
        expect(calls.indexOf(call)).toBeGreaterThan(checked)
        expect(call.options?.stdin ?? "").not.toContain(large)
      }
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull keeps exact aggregate file counts but marks excluded binary statistics incomplete",
  observed((calls) =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const before = yield* tracked
      const text = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "text\n")
      const binary = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "\0binary")
      const large = yield* git(
        tmp.directory,
        ["hash-object", "-w", "--stdin"],
        "x".repeat(MAX_FULL_DIFF_FILE_BYTES + 1),
      )
      const tree = yield* git(
        tmp.directory,
        ["mktree"],
        [
          `100644 blob ${binary}\ta-binary.bin\n`,
          ...Array.from(
            { length: SnapshotDiff.MAX_FILES - 1 },
            (_, i) => `100644 blob ${text}\tnormal-${String(i).padStart(3, "0")}-${"x".repeat(190)}.txt\n`,
          ),
          `100644 blob ${large}\tz-large.txt\n`,
          `100644 blob ${binary}\tz-small.bin\n`,
        ].join(""),
      )
      calls.length = 0
      const diffs = yield* snapshot.diffFull(before, tree)
      expect(diffs).toHaveLength(201)
      expect(diffs[0]).toEqual({ file: "a-binary.bin", patch: "", status: "added", additions: 0, deletions: 0 })
      expect(diffs.at(-1)).toEqual({
        additions: 0,
        deletions: 0,
        omitted: { reason: "aggregate-budget", files: 2, statisticsIncomplete: true },
      })
      expect(SnapshotDiff.totals(diffs)).toEqual({
        files: 202,
        additions: 199,
        deletions: 0,
        filesComplete: true,
        complete: false,
      })
      expect(calls.find((call) => call.args.includes("--batch-check"))?.options?.stdin).toContain(large)
      expect(loads(calls)).toHaveLength(199)
      expect(statistics(calls)).toHaveLength(3)
      for (const call of statistics(calls)) {
        expect(call.args).toContain("--literal-pathspecs")
        const files = call.args.slice(call.args.indexOf("--") + 1)
        expect(files.length).toBeLessThanOrEqual(100)
        expect(files.reduce((sum, file) => sum + Buffer.byteLength(file) + 1, 0)).toBeLessThanOrEqual(16 * 1024)
        expect(files).not.toContain("z-large.txt")
      }
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull does not let directory pathspecs include oversized descendants",
  observed((calls) =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      yield* write(path.join(tmp.directory, ".gitattributes"), "*.txt diff\n")
      yield* write(path.join(tmp.directory, "entry.txt"), "old\n")
      const before = yield* tracked
      const attributes = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "*.txt diff\n")
      const large = yield* git(
        tmp.directory,
        ["hash-object", "-w", "--stdin"],
        "x".repeat(MAX_FULL_DIFF_FILE_BYTES + 1),
      )
      const directory = yield* git(tmp.directory, ["mktree"], `100644 blob ${large}\tlarge.txt\n`)
      const tree = yield* git(
        tmp.directory,
        ["mktree"],
        `100644 blob ${attributes}\t.gitattributes\n040000 tree ${directory}\tentry.txt\n`,
      )
      calls.length = 0
      const diffs = yield* snapshot.diffFull(before, tree)
      expect(statistics(calls)).toHaveLength(0)
      expect(loads(calls)).toHaveLength(0)
      expect(SnapshotDiff.totals(diffs)).toEqual({
        files: 2,
        additions: 0,
        deletions: 0,
        filesComplete: true,
        complete: false,
      })
      expect(diffs.find((row) => row.file === "entry.txt")?.omitted).toEqual({
        reason: "git-statistics-unavailable",
        files: 1,
        statisticsIncomplete: true,
      })
      expect(diffs.find((row) => row.file === "entry.txt/large.txt")?.omitted).toEqual({
        reason: "size",
        files: 1,
        statisticsIncomplete: true,
      })
    }),
  ),
  { git: true },
  15000,
)

for (const relative of [false, true]) {
  it.instance(
    `diffFull keeps scoped subdirectory paths root-relative with ${relative ? "diff.relative=true" : "default settings"}`,
    Effect.gen(function* () {
      const process = yield* AppProcess.Service
      yield* observed(
        (calls) =>
          Effect.gen(function* () {
            const tmp = yield* TestInstance
            const directory = path.join(tmp.directory, "nested")
            const rootBefore = "root old\n".repeat(2)
            const rootAfter = "root new\n".repeat(31)
            const subBefore = "sub old\n".repeat(6)
            const subAfter = "sub new\n".repeat(2)
            yield* write(path.join(tmp.directory, "same.txt"), rootBefore)
            yield* write(path.join(directory, "same.txt"), subBefore)
            yield* write(path.join(directory, "large.txt"), "small baseline\n")
            const before = yield* tracked
            yield* write(path.join(tmp.directory, "same.txt"), rootAfter)
            yield* write(path.join(directory, "same.txt"), subAfter)
            const whole = yield* tracked
            // Already tracked, so capture retains this blob while diffFull must exclude its contents.
            yield* write(path.join(directory, "large.txt"), "x".repeat(MAX_FULL_DIFF_FILE_BYTES + 1))
            const partial = yield* tracked
            const rootRefs = yield* Effect.forEach([rootBefore, rootAfter], (text) =>
              git(tmp.directory, ["hash-object", "--stdin"], text),
            )
            const subRefs = yield* Effect.forEach([subBefore, subAfter], (text) =>
              git(tmp.directory, ["hash-object", "--stdin"], text),
            )

            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              for (const after of [partial, whole]) {
                calls.length = 0
                const diffs = yield* snapshot.diffFull(before, after)
                const small = diffs.find((row) => row.file?.endsWith("same.txt"))
                expect(small).toMatchObject({
                  file: "nested/same.txt",
                  additions: 2,
                  deletions: 6,
                  status: "modified",
                })
                expect(small?.patch).toContain("+sub new")
                expect(small?.patch).not.toContain("root new")
                expect(small?.omitted).toBeUndefined()
                expect(diffs.every((row) => row.file?.startsWith("nested/"))).toBe(true)
                expect(diffs).toHaveLength(after === partial ? 2 : 1)
                if (after === partial)
                  expect(diffs.find((row) => row.file === "nested/large.txt")?.omitted).toEqual({
                    reason: "size",
                    files: 1,
                    statisticsIncomplete: true,
                  })

                expect(calls[0].args).toContain("--raw")
                expect(calls[0].args).toContain("--no-relative")
                expect(calls[0].args.slice(calls[0].args.indexOf("--") + 1)).toEqual(["."])
                const checked = calls.findIndex((call) => call.args.includes("--batch-check"))
                expect(checked).toBeGreaterThan(0)
                for (const ref of subRefs) expect(calls[checked].options?.stdin).toContain(`${ref}\n`)
                for (const ref of rootRefs) expect(calls[checked].options?.stdin).not.toContain(ref)
                expect(statistics(calls)).toHaveLength(1)
                const stats = statistics(calls)[0]
                expect(stats.args).toContain("--no-relative")
                expect(calls.indexOf(stats)).toBeGreaterThan(checked)
                expect(stats.args.slice(stats.args.indexOf("--") + 1)).toEqual(
                  after === partial ? ["nested/same.txt"] : ["."],
                )
                expect(stats.result?.stdout.toString()).toBe("2\t6\tnested/same.txt\0")
                expect(loads(calls)).toHaveLength(1)
                expect(loads(calls)[0].options?.stdin).toBe(subRefs.join("\n") + "\n")
                expect(calls.indexOf(loads(calls)[0])).toBeGreaterThan(checked)
              }
            }).pipe(provideInstance(directory))
          }),
        (call, run, command) =>
          !relative || command._tag !== "StandardCommand" || command.command !== "git" || !call.args.includes("diff")
            ? run
            : process.run(
                ChildProcess.make(command.command, ["-c", "diff.relative=true", ...command.args], command.options),
                call.options,
              ),
      )
    }),
    { git: true },
    15000,
  )
}

for (const stage of ["--raw", "--batch-check"]) {
  it.instance(
    `diffFull retains known file counts when Git objects disappear after ${stage}`,
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const fs = yield* FSUtil.Service
      const blob = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "unavailable statistics\n")
      const files = ["one.txt", "two.txt", "three.txt"]
      const tree = yield* git(tmp.directory, ["mktree"], files.map((file) => `100644 blob ${blob}\t${file}\n`).join(""))
      yield* observed(
        (calls) =>
          Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* tracked
            calls.length = 0
            const diffs = yield* snapshot.diffFull(before, tree)
            expect(SnapshotDiff.totals(diffs)).toEqual({
              files: 3,
              additions: 0,
              deletions: 0,
              filesComplete: true,
              complete: false,
            })
            expect(loads(calls)).toHaveLength(0)
            if (stage === "--raw") {
              expect(diffs).toEqual([
                {
                  additions: 0,
                  deletions: 0,
                  omitted: { reason: "git-metadata-unavailable", files: 3, statisticsIncomplete: true },
                },
              ])
              expect(statistics(calls)).toHaveLength(0)
              return
            }
            expect(diffs.map((row) => row.file)).toEqual([...files].sort())
            expect(
              diffs.every(
                (row) =>
                  row.patch === "" &&
                  row.omitted?.reason === "git-statistics-unavailable" &&
                  row.omitted.files === 1 &&
                  row.omitted.statisticsIncomplete === true,
              ),
            ).toBe(true)
            expect(statistics(calls)).toHaveLength(1)
            expect(statistics(calls)[0].result?.exitCode).not.toBe(0)
          }),
        (call, run) =>
          !call.args.includes(stage)
            ? run
            : run.pipe(
                Effect.tap(() =>
                  fs
                    .remove(path.join(tmp.directory, ".git", "objects", blob.slice(0, 2), blob.slice(2)))
                    .pipe(Effect.orDie),
                ),
              ),
      )
    }),
    { git: true },
    15000,
  )
}

it.instance(
  "diffFull retains known file and line totals when blob contents disappear after statistics",
  Effect.gen(function* () {
    const tmp = yield* TestInstance
    const fs = yield* FSUtil.Service
    const missing = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "unavailable\n")
    const available = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "available\n")
    const tree = yield* git(
      tmp.directory,
      ["mktree"],
      [
        `100644 blob ${missing}\ta-unavailable.txt\n`,
        ...Array.from(
          { length: SnapshotDiff.MAX_FILES },
          (_, i) => `100644 blob ${available}\tb-${String(i).padStart(3, "0")}.txt\n`,
        ),
      ].join(""),
    )
    yield* observed(
      (calls) =>
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          const before = yield* tracked
          calls.length = 0
          const diffs = yield* snapshot.diffFull(before, tree)
          expect(diffs).toHaveLength(201)
          expect(diffs[0]).toEqual({
            file: "a-unavailable.txt",
            patch: "",
            status: "added",
            additions: 1,
            deletions: 0,
            omitted: { reason: "git-content-unavailable", files: 1 },
          })
          expect(diffs[1].patch).toContain("+available")
          expect(diffs.at(-1)).toEqual({
            additions: 1,
            deletions: 0,
            omitted: { reason: "aggregate-budget", files: 1 },
          })
          expect(SnapshotDiff.totals(diffs)).toEqual({
            files: 201,
            additions: 201,
            deletions: 0,
            filesComplete: true,
            complete: true,
          })
          expect(loads(calls)[0]?.result?.stdout.toString()).toBe(`${missing} missing\n`)
        }),
      (call, run) =>
        !call.args.includes("--numstat")
          ? run
          : run.pipe(
              Effect.tap(() =>
                fs
                  .remove(path.join(tmp.directory, ".git", "objects", missing.slice(0, 2), missing.slice(2)))
                  .pipe(Effect.orDie),
              ),
            ),
    )
  }),
  { git: true },
  15000,
)

it.instance(
  "diffFull bounds statistics inputs across many individually small blobs without losing file counts",
  observed((calls) =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const before = yield* tracked
      const size = 64 * 1024
      const blob = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "x".repeat(size - 1) + "\n")
      const files = Array.from({ length: 210 }, (_, i) => `small-${String(i).padStart(3, "0")}.txt`)
      const tree = yield* git(tmp.directory, ["mktree"], files.map((file) => `100644 blob ${blob}\t${file}\n`).join(""))
      calls.length = 0
      const diffs = yield* snapshot.diffFull(before, tree)
      expect(diffs).toHaveLength(201)
      expect(diffs.filter((row) => row.file && row.omitted?.statisticsIncomplete)).toHaveLength(72)
      expect(diffs.at(-1)).toEqual({
        additions: 0,
        deletions: 0,
        omitted: { reason: "aggregate-budget", files: 10, statisticsIncomplete: true },
      })
      expect(SnapshotDiff.totals(diffs)).toEqual({
        files: 210,
        additions: 128,
        deletions: 0,
        filesComplete: true,
        complete: false,
      })
      expect(
        diffs
          .filter((row) => row.file && row.omitted?.statisticsIncomplete)
          .every((row) => row.omitted?.reason === "input-budget"),
      ).toBe(true)
      const counted = statistics(calls).flatMap((call) => call.args.slice(call.args.indexOf("--") + 1))
      expect(counted).toEqual(files.slice(0, 128))
      expect(counted.length * size).toBe(SnapshotDiff.MAX_INPUT_BYTES)
      expect(loads(calls).length * size).toBeLessThanOrEqual(SnapshotDiff.MAX_INPUT_BYTES)
      expect(diffs.reduce((sum, row) => sum + SnapshotDiff.bytes(row.patch ?? ""), 0)).toBeLessThanOrEqual(
        SnapshotDiff.MAX_PATCH_BYTES,
      )
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull limits statistics work to twenty thousand files even for empty blobs",
  observed((calls) =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const before = yield* tracked
      const blob = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "")
      const tree = yield* git(
        tmp.directory,
        ["mktree"],
        Array.from({ length: 20001 }, (_, i) => `100644 blob ${blob}\tempty-${String(i).padStart(5, "0")}.txt\n`).join(
          "",
        ),
      )
      calls.length = 0
      const diffs = yield* snapshot.diffFull(before, tree)
      expect(diffs).toHaveLength(201)
      expect(diffs.at(-1)).toEqual({
        additions: 0,
        deletions: 0,
        omitted: { reason: "aggregate-budget", files: 19801, statisticsIncomplete: true },
      })
      expect(SnapshotDiff.totals(diffs)).toEqual({
        files: 20001,
        additions: 0,
        deletions: 0,
        filesComplete: true,
        complete: false,
      })
      expect(statistics(calls)).toHaveLength(200)
      expect(statistics(calls).reduce((sum, call) => sum + call.args.length - call.args.indexOf("--") - 1, 0)).toBe(
        20000,
      )
      expect(loads(calls)).toHaveLength(200)
    }),
  ),
  { git: true },
  30000,
)

it.instance(
  "diffFull bounds total loaded inputs independently of generated patches",
  observed((calls) =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const files = Array.from({ length: 6 }, (_, i) => path.join(tmp.directory, `${i}.txt`))
      const body = "x".repeat(1024 * 1024 - 2) + "\n"
      yield* Effect.forEach(files, (file) => write(file, "a" + body), { concurrency: 6 })
      const before = yield* tracked
      yield* Effect.forEach(files, (file) => write(file, "b" + body), { concurrency: 6 })
      const after = yield* tracked
      calls.length = 0
      const diffs = yield* snapshot.diffFull(before, after)
      expect(diffs).toHaveLength(6)
      expect(diffs.filter((row) => row.omitted?.reason === "input-budget")).toHaveLength(2)
      expect(diffs.slice(0, 4).every((row) => row.additions === 1 && row.deletions === 1)).toBe(true)
      expect(diffs.slice(4)).toEqual(
        [4, 5].map((i) => ({
          file: `${i}.txt`,
          patch: "",
          status: "modified",
          additions: 0,
          deletions: 0,
          omitted: { reason: "input-budget", files: 1, statisticsIncomplete: true },
        })),
      )
      expect(SnapshotDiff.totals(diffs)).toEqual({
        files: 6,
        additions: 4,
        deletions: 4,
        filesComplete: true,
        complete: false,
      })
      expect(loads(calls)).toHaveLength(4)
      // The only bytes above 8 MiB are the bounded cat-file object headers and separators.
      const captured = loads(calls).reduce((sum, call) => sum + (call.result?.stdout.length ?? 0), 0)
      expect(captured).toBeGreaterThan(SnapshotDiff.MAX_INPUT_BYTES)
      expect(captured).toBeLessThanOrEqual(SnapshotDiff.MAX_INPUT_BYTES + loads(calls).length * 256)
      expect(diffs.reduce((sum, row) => sum + SnapshotDiff.bytes(row.patch ?? ""), 0)).toBeLessThanOrEqual(
        SnapshotDiff.MAX_PATCH_BYTES,
      )
      expect(calls.findIndex((call) => call.args.includes("--batch-check"))).toBeLessThan(
        calls.findIndex((call) => call.args.includes("--batch")),
      )
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull caps JSON-encoded patches across many small files",
  observed(() =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const before = yield* tracked
      yield* Effect.forEach(
        Array.from({ length: 200 }, (_, i) => i),
        (i) => write(path.join(tmp.directory, `${String(i).padStart(3, "0")}.txt`), "\x01".repeat(8192)),
        { concurrency: 8 },
      )
      const diffs = yield* snapshot.diffFull(before, yield* tracked)
      const omitted = diffs.filter((row) => row.omitted)
      expect(diffs).toHaveLength(200)
      expect(omitted.length).toBeGreaterThan(0)
      expect(omitted.length).toBeLessThan(100)
      expect(
        omitted.every((row) => row.patch === "" && row.omitted?.reason === "patch-budget" && row.omitted.files === 1),
      ).toBe(true)
      expect(diffs.reduce((sum, row) => sum + SnapshotDiff.bytes(row.patch ?? ""), 0)).toBeLessThanOrEqual(
        SnapshotDiff.MAX_PATCH_BYTES,
      )
      expect(SnapshotDiff.totals(diffs)).toEqual({
        files: 200,
        additions: 200,
        deletions: 0,
        filesComplete: true,
        complete: true,
      })
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull omits an over-budget patch before expensive diff construction",
  observed(() =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      yield* write(path.join(tmp.directory, "a-escaped.txt"), "\x01".repeat(1536 * 1024) + "\n")
      yield* write(path.join(tmp.directory, "z-normal.txt"), "before\n")
      const before = yield* tracked
      yield* write(path.join(tmp.directory, "a-escaped.txt"), "\x02".repeat(1536 * 1024) + "\n")
      yield* write(path.join(tmp.directory, "z-normal.txt"), "after\n")
      const diffs = yield* snapshot.diffFull(before, yield* tracked)
      expect(diffs[0]).toEqual({
        file: "a-escaped.txt",
        patch: "",
        additions: 1,
        deletions: 1,
        status: "modified",
        omitted: { reason: "patch-budget", files: 1 },
      })
      expect(diffs[1].patch).toContain("+after")
      expect(diffs[1].omitted).toBeUndefined()
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull reports unknown totals on real metadata overflow",
  observed((calls) =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const before = yield* tracked
      const blob = yield* git(tmp.directory, ["hash-object", "-w", "--stdin"], "x\n")
      const tree = yield* git(
        tmp.directory,
        ["mktree"],
        Array.from(
          { length: 15000 },
          (_, i) => `100644 blob ${blob}\t${String(i).padStart(5, "0")}-${"x".repeat(194)}\n`,
        ).join(""),
      )
      calls.length = 0
      const diffs = yield* snapshot.diffFull(before, tree)
      expect(diffs).toEqual([{ additions: 0, deletions: 0, omitted: { reason: "git-metadata-unavailable" } }])
      expect(SnapshotDiff.totals(diffs).complete).toBe(false)
      expect(calls).toHaveLength(1)
      expect(calls[0].result?.stdoutTruncated).toBe(true)
      expect(calls[0].result?.stdout.length).toBe(4 * 1024 * 1024)
      expect(calls[0].options).toMatchObject({
        maxOutputBytes: 4 * 1024 * 1024,
        maxErrorBytes: 8 * 1024,
        timeout: 15000,
      })
      for (const flag of ["--no-textconv", "--no-ext-diff", "--no-renames", "-z", "core.bigFileThreshold=2097152"]) {
        expect(calls[0].args).toContain(flag)
      }
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull never reports a failed Git comparison as a complete empty diff",
  observed(() =>
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const diffs = yield* snapshot.diffFull("not-a-snapshot", yield* tracked)
      expect(diffs).toEqual([{ additions: 0, deletions: 0, omitted: { reason: "git-metadata-unavailable" } }])
      expect(SnapshotDiff.totals(diffs).complete).toBe(false)
    }),
  ),
  { git: true },
)
;(process.platform === "win32" ? it.instance.skip : it.instance)(
  "diffFull preserves NUL-safe special paths",
  observed(() =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      const before = yield* tracked
      const files = [
        "line\nname.txt",
        "tab\tname.txt",
        "space name.txt",
        'quote"name.txt',
        ":(glob)literal.txt",
        "back\\slash.txt",
        "caf\u00e9.txt",
      ]
      yield* Effect.forEach(files, (file) => write(path.join(tmp.directory, file), "special\n"))
      const diffs = yield* snapshot.diffFull(before, yield* tracked)
      expect(diffs.map((row) => row.file).sort()).toEqual([...files].sort())
      expect(diffs.every((row) => row.patch?.includes("+special") && !row.omitted && row.additions === 1)).toBe(true)
    }),
  ),
  { git: true },
)

it.instance(
  "diffFull compares captured trees across fixture checkout baseline changes",
  observed(() =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      yield* write(path.join(tmp.directory, "modified.txt"), "first\n")
      yield* write(path.join(tmp.directory, "deleted.txt"), "old\n")
      yield* git(tmp.directory, ["add", "."])
      yield* git(tmp.directory, ["commit", "-m", "first baseline"])
      const commit = yield* git(tmp.directory, ["rev-parse", "HEAD"])
      const before = yield* tracked
      yield* write(path.join(tmp.directory, "modified.txt"), "second\n")
      yield* remove(path.join(tmp.directory, "deleted.txt"))
      yield* write(path.join(tmp.directory, "added.txt"), "new\n")
      yield* git(tmp.directory, ["add", "."])
      yield* git(tmp.directory, ["commit", "-m", "second baseline"])
      const after = yield* tracked
      // This checkout is a scoped test fixture, never the active source checkout.
      yield* git(tmp.directory, ["checkout", "--detach", commit])
      const diffs = yield* snapshot.diffFull(before, after)
      expect(diffs.map((row) => [row.file, row.status])).toEqual([
        ["added.txt", "added"],
        ["deleted.txt", "deleted"],
        ["modified.txt", "modified"],
      ])
      expect(diffs.find((row) => row.file === "modified.txt")?.patch).toContain("+second")
      expect(SnapshotDiff.totals(diffs)).toEqual({
        files: 3,
        additions: 2,
        deletions: 2,
        filesComplete: true,
        complete: true,
      })
      expect(yield* tracked).toBe(before)
    }),
  ),
  { git: true },
  15000,
)

it.instance(
  "diffFull waiting for capture cannot starve a free worktree",
  Effect.gen(function* () {
    const captureHeld = yield* Deferred.make<void>()
    const releaseCapture = yield* Deferred.make<void>()
    let holdCapture = false
    yield* observed(
      (calls) =>
        Effect.gen(function* () {
          const tmp = yield* TestInstance
          const directory = path.join(yield* tmpdirScoped(), "free-worktree")
          yield* git(tmp.directory, ["worktree", "add", "--detach", directory, "HEAD"])
          yield* Effect.addFinalizer(() =>
            git(tmp.directory, ["worktree", "remove", "--force", directory]).pipe(Effect.asVoid, Effect.orDie),
          )
          const snapshot = yield* Snapshot.Service
          const before = yield* tracked
          yield* write(path.join(tmp.directory, "file.txt"), "after capture\n")
          const after = yield* tracked
          const free = yield* Effect.gen(function* () {
            const before = yield* tracked
            yield* write(path.join(directory, "file.txt"), "free worktree\n")
            return { before, after: yield* tracked }
          }).pipe(provideInstance(directory))

          calls.length = 0
          holdCapture = true
          const capture = yield* tracked.pipe(Effect.forkScoped)
          yield* awaitWithTimeout(Deferred.await(captureHeld), "capture did not acquire the repository lock")
          // Warm state plus immediate forks queues both diffs at the held lock before B starts.
          const first = yield* snapshot.diffFull(before, after).pipe(Effect.forkScoped({ startImmediately: true }))
          const second = yield* snapshot.diffFull(before, after).pipe(Effect.forkScoped({ startImmediately: true }))
          expect(calls.some((call) => call.args.includes("--raw"))).toBe(false)
          const diffs = yield* awaitWithTimeout(
            snapshot.diffFull(free.before, free.after).pipe(provideInstance(directory)),
            "capture waiters consumed all global detail permits and starved a free worktree",
          )
          expect(diffs).toHaveLength(1)
          expect(diffs[0].patch).toContain("+free worktree")
          expect(yield* Deferred.isDone(releaseCapture)).toBe(false)
          expect(calls.filter((call) => call.args.includes("--raw"))).toHaveLength(1)

          yield* Deferred.succeed(releaseCapture, undefined)
          expect(yield* awaitWithTimeout(Fiber.join(capture), "capture did not release its repository lock")).toBe(
            after,
          )
          const waiting = yield* awaitWithTimeout(
            Effect.all([Fiber.join(first), Fiber.join(second)]),
            "queued diffs did not resume after capture released the repository lock",
          )
          expect(waiting.every((rows) => rows.length === 1 && rows[0].patch?.includes("+after capture"))).toBe(true)
        }),
      (call, run) =>
        !holdCapture || !call.args.includes("write-tree")
          ? run
          : run.pipe(
              Effect.tap(() => Deferred.succeed(captureHeld, undefined)),
              Effect.tap(() => Deferred.await(releaseCapture)),
            ),
    )
  }),
  { git: true },
  15000,
)

it.instance(
  "diffFull globally caps linked-worktree detail work and releases locks on interruption",
  Effect.gen(function* () {
    const twoActive = yield* Deferred.make<void>()
    const allInvoked = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let active = 0
    let peak = 0
    let gated = true
    yield* observed(
      () =>
        Effect.gen(function* () {
          const tmp = yield* TestInstance
          const parent = yield* tmpdirScoped()
          const directories = [tmp.directory, path.join(parent, "one"), path.join(parent, "two")]
          for (const directory of directories.slice(1)) {
            yield* git(tmp.directory, ["worktree", "add", "--detach", directory, "HEAD"])
            yield* Effect.addFinalizer(() =>
              git(tmp.directory, ["worktree", "remove", "--force", directory]).pipe(Effect.asVoid, Effect.orDie),
            )
          }
          const snapshot = yield* Snapshot.Service
          const comparisons = yield* Effect.forEach(directories, (directory) =>
            Effect.gen(function* () {
              const before = yield* tracked
              yield* write(path.join(directory, "file.txt"), "after\n")
              return { directory, before, after: yield* tracked }
            }).pipe(provideInstance(directory)),
          )
          let invoked = 0
          const work = yield* Effect.forEach(
            comparisons,
            (comparison) =>
              Effect.gen(function* () {
                if (++invoked === comparisons.length) yield* Deferred.succeed(allInvoked, undefined)
                return yield* snapshot.diffFull(comparison.before, comparison.after)
              }).pipe(provideInstance(comparison.directory)),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkScoped)
          yield* awaitWithTimeout(Deferred.await(allInvoked), "all diff requests were not invoked")
          yield* awaitWithTimeout(Deferred.await(twoActive), "two diff requests did not reach content loading")
          expect(active).toBe(2)
          expect(peak).toBe(2)
          yield* Fiber.interrupt(work)
          expect(active).toBe(0)
          gated = false
          const results = yield* awaitWithTimeout(
            Effect.forEach(
              comparisons,
              (comparison) =>
                snapshot.diffFull(comparison.before, comparison.after).pipe(provideInstance(comparison.directory)),
              { concurrency: "unbounded" },
            ),
            "interrupted diffs leaked a global or per-gitdir permit",
            "5 seconds",
          )
          expect(results.every((rows) => rows.length === 1 && rows[0].patch?.includes("+after"))).toBe(true)
        }),
      (call, run) =>
        !gated || !call.args.includes("--batch")
          ? run
          : Effect.gen(function* () {
              active++
              peak = Math.max(peak, active)
              if (active === 2) yield* Deferred.succeed(twoActive, undefined)
              return yield* Deferred.await(release).pipe(Effect.andThen(run))
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active--
                }),
              ),
            ),
    )
  }),
  { git: true },
  15000,
)
