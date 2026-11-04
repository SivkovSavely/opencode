import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { uniqueSummaryDiffs } from "./summary-diffs"
import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"

const diff = (file: string, additions: number) =>
  ({
    file,
    additions,
    deletions: 0,
  }) satisfies SnapshotFileDiff

describe("uniqueSummaryDiffs", () => {
  test("preserves unique input and retains unknown statistics without inventing a file", () => {
    const alpha = diff("alpha.ts", 1)
    const beta = diff("beta.ts", 1)
    const invalid = { additions: 1, deletions: 0 } satisfies SnapshotFileDiff

    expect(uniqueSummaryDiffs(undefined)).toEqual([])
    expect(uniqueSummaryDiffs([])).toEqual([])
    expect(SnapshotDiff.totals(uniqueSummaryDiffs([invalid]))).toEqual({
      files: 0,
      additions: 1,
      deletions: 0,
      filesComplete: false,
      complete: false,
    })

    const result = uniqueSummaryDiffs([alpha, invalid, beta])
    expect(result.slice(0, 2)).toEqual([alpha, beta])
    expect(result[0]).toBe(alpha)
    expect(result[1]).toBe(beta)
    expect(result[2]).not.toHaveProperty("file")
    expect(result[2]?.omitted).toEqual({ reason: "aggregate-budget" })
  })

  test("bounds historical file lists and preserves aggregate totals", () => {
    const input = Array.from({ length: SnapshotDiff.MAX_FILES + 17 }, (_, index) => diff(`src/${index}.ts`, 2))
    const result = uniqueSummaryDiffs(input)

    expect(result).toHaveLength(SnapshotDiff.MAX_FILES + 1)
    expect(result.at(-1)).toEqual({
      additions: 34,
      deletions: 0,
      omitted: { reason: "aggregate-budget", files: 17 },
    })
    expect(SnapshotDiff.totals(result)).toEqual({
      files: 217,
      additions: 434,
      deletions: 0,
      filesComplete: true,
      complete: true,
    })
  })

  test("omits oversized historical patches before normalization", () => {
    const result = uniqueSummaryDiffs([
      { ...diff("large.ts", 8), patch: "x".repeat(SnapshotDiff.MAX_PATCH_BYTES + 1) },
      { ...diff("small.ts", 1), patch: "@@ -1 +1 @@\n-old\n+new\n" },
    ])

    expect(result[0]).toMatchObject({
      file: "large.ts",
      patch: "",
      additions: 8,
      omitted: { reason: "patch-budget", files: 1 },
    })
    expect(result[1]?.patch).toContain("+new")
    expect(result.reduce((sum, diff) => sum + SnapshotDiff.bytes(diff.patch ?? ""), 0)).toBeLessThanOrEqual(
      SnapshotDiff.MAX_PATCH_BYTES,
    )
    expect(SnapshotDiff.totals(result).files).toBe(2)
  })

  test("keeps supplied aggregate counts, including aggregate-only summaries", () => {
    const result = uniqueSummaryDiffs([
      { additions: 30, deletions: 20, omitted: { reason: "input-budget", files: 600 } },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).not.toHaveProperty("file")
    expect(result[0]).not.toHaveProperty("patch")
    expect(SnapshotDiff.totals(result)).toEqual({
      files: 600,
      additions: 30,
      deletions: 20,
      filesComplete: true,
      complete: true,
    })
  })

  test("keeps the last diff per file in the legacy display order", () => {
    const oldAlpha = diff("alpha.ts", 1)
    const oldBeta = diff("beta.ts", 1)
    const newAlpha = diff("alpha.ts", 2)
    const charlie = diff("charlie.ts", 1)
    const newBeta = diff("beta.ts", 2)

    const result = uniqueSummaryDiffs([oldAlpha, oldBeta, newAlpha, charlie, newBeta])

    expect(result).toEqual([newAlpha, charlie, newBeta])
    expect(result[0]).toBe(newAlpha)
    expect(result[1]).toBe(charlie)
    expect(result[2]).toBe(newBeta)
  })

  test("retains known file counts when line statistics are unavailable", () => {
    const result = uniqueSummaryDiffs([
      {
        file: "unknown.png",
        patch: "",
        additions: 0,
        deletions: 0,
        omitted: { reason: "input-budget", files: 1, statisticsIncomplete: true },
      },
    ])
    expect(SnapshotDiff.totals(result)).toEqual({
      files: 1,
      additions: 0,
      deletions: 0,
      filesComplete: true,
      complete: false,
    })
  })
})
