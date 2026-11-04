import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"
import type { FileDiff } from "@opencode-ai/schema/file-diff"
import type { SummaryDiff } from "./timeline-row"

export function uniqueSummaryDiffs(diffs: FileDiff.Info[] | undefined) {
  const files = new Set<string>()
  return SnapshotDiff.limit(diffs ?? [])
    .reduceRight<SummaryDiff[]>((result, diff) => {
      const file = diff.file
      if (file && files.has(file)) return result
      if (file) files.add(file)
      result.push(diff)
      return result
    }, [])
    .reverse()
}
