import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { SnapshotDiff } from "../src/snapshot-diff"

describe("snapshot summary budgets", () => {
  test("measures JSON-encoded UTF-8 without changing the string", () => {
    for (const value of [
      "",
      "plain",
      '"\\\n\t\b\f\r\u0000\u001f',
      "\u00e9\u96ea",
      "\ud83d\ude80",
      "\ud800",
      "\udfff",
      ...Array.from({ length: 32 }, (_, code) => `${String.fromCharCode(code)}\udc00`),
    ])
      expect(SnapshotDiff.bytes(value)).toBe(Buffer.byteLength(JSON.stringify(value)))
  })

  test("keeps normal diffs and the optional omission representation compatible", () => {
    const diffs = [
      { file: "small.txt", patch: "-before\n+after\n", additions: 1, deletions: 1, status: "modified" as const },
      { file: "binary.bin", patch: "", additions: 0, deletions: 0 },
    ]
    expect(SnapshotDiff.limit(diffs)).toEqual(diffs)
    expect(SnapshotDiff.totals(diffs)).toEqual({
      additions: 1,
      deletions: 1,
      files: 2,
      filesComplete: true,
      complete: true,
    })
    for (const diff of [...diffs, { additions: 2, deletions: 3, omitted: { reason: "aggregate-budget", files: 4 } }])
      expect(Schema.decodeUnknownSync(FileDiff.Info)(diff)).toEqual(diff)
  })

  test("bounds materialized rows while preserving exact statistics for omitted files", () => {
    const diffs = Array.from({ length: SnapshotDiff.MAX_FILES + 7 }, (_, index) => ({
      file: `${index}.txt`,
      patch: "+x\n",
      additions: 2,
      deletions: 1,
    }))
    const result = SnapshotDiff.limit(diffs)
    expect(result).toHaveLength(SnapshotDiff.MAX_FILES + 1)
    expect(result.at(-1)).toEqual({
      additions: 14,
      deletions: 7,
      omitted: { reason: "aggregate-budget", files: 7 },
    })
    expect(SnapshotDiff.totals(result)).toEqual({
      additions: 414,
      deletions: 207,
      files: 207,
      filesComplete: true,
      complete: true,
    })
    expect(SnapshotDiff.limit(result)).toEqual(result)
    expect(diffs).toHaveLength(207)
  })

  test("reserves empty-patch bytes before accepting a patch at the aggregate boundary", () => {
    const patch = "x".repeat(SnapshotDiff.MAX_PATCH_BYTES - SnapshotDiff.MAX_FILES * 2)
    const diffs = Array.from({ length: SnapshotDiff.MAX_FILES }, (_, index) => ({
      file: `${index}.txt`,
      patch: index === 0 ? patch : index === 1 ? "+x" : "",
      additions: 1,
      deletions: 0,
    }))
    const result = SnapshotDiff.limit(diffs)
    expect(result[0]?.patch).toBe(patch)
    expect(result[1]).toEqual({
      ...diffs[1],
      patch: "",
      omitted: { reason: "patch-budget", files: 1 },
    })
    expect(result.reduce((sum, diff) => sum + SnapshotDiff.bytes(diff.patch ?? ""), 0)).toBe(
      SnapshotDiff.MAX_PATCH_BYTES,
    )
    expect(diffs[1]?.patch).toBe("+x")
    expect(SnapshotDiff.limit(result)).toEqual(result)
  })

  test("does not scan an individually oversized historical patch", () => {
    const patch = "\n".repeat(SnapshotDiff.MAX_PATCH_BYTES + 1)
    const result = SnapshotDiff.limit([{ file: "large.txt", patch, additions: 7, deletions: 3 }])
    expect(result).toEqual([
      { file: "large.txt", patch: "", additions: 7, deletions: 3, omitted: { reason: "patch-budget", files: 1 } },
    ])
    expect(SnapshotDiff.totals(result)).toEqual({
      additions: 7,
      deletions: 3,
      files: 1,
      filesComplete: true,
      complete: true,
    })
  })

  test("counts mixed controls and unpaired surrogates toward the patch budget", () => {
    const patch = "\u0001\udc00".repeat(Math.floor(SnapshotDiff.MAX_PATCH_BYTES / 12) + 1)
    const diff = { file: "control.txt", patch, additions: 7, deletions: 3 }
    expect(Schema.decodeUnknownSync(FileDiff.Info)(diff)).toEqual(diff)
    expect(SnapshotDiff.bytes(patch)).toBe(Buffer.byteLength(JSON.stringify(patch)))
    expect(SnapshotDiff.bytes(patch)).toBeGreaterThan(SnapshotDiff.MAX_PATCH_BYTES)
    expect(SnapshotDiff.limit([diff])).toEqual([{ ...diff, patch: "", omitted: { reason: "patch-budget", files: 1 } }])
    expect(diff.patch).toBe(patch)
  })

  test("keeps known file counts when only line statistics are incomplete", () => {
    const result = SnapshotDiff.limit([
      { file: "large.bin", additions: 0, deletions: 0, omitted: { reason: "size", statisticsIncomplete: true } },
      { additions: 2, deletions: 3, omitted: { reason: "input-budget", files: 6, statisticsIncomplete: true } },
    ])
    expect(SnapshotDiff.totals(result)).toEqual({
      additions: 2,
      deletions: 3,
      files: 7,
      filesComplete: true,
      complete: false,
    })
  })

  test("retains unknown statistics and file counts instead of turning them into exact zeroes", () => {
    const result = SnapshotDiff.limit([
      { file: "x".repeat(SnapshotDiff.MAX_PATH_CHARS + 1), additions: 2, deletions: 3 },
      { additions: 4, deletions: 5, omitted: { reason: "previous-budget", files: 6 } },
      { additions: 0, deletions: 0, omitted: { reason: "metadata-unavailable", statisticsIncomplete: true } },
    ])
    expect(result).toEqual([
      { additions: 6, deletions: 8, omitted: { reason: "aggregate-budget", statisticsIncomplete: true } },
    ])
    expect(SnapshotDiff.totals(result)).toEqual({
      additions: 6,
      deletions: 8,
      files: 0,
      filesComplete: false,
      complete: false,
    })
    expect(SnapshotDiff.limit(result)).toEqual(result)
  })
})
