export * as SnapshotDiff from "./snapshot-diff"

import type { FileDiff } from "@opencode-ai/schema/file-diff"

export const MAX_FILES = 200
export const MAX_INPUT_BYTES = 8 * 1024 * 1024
export const MAX_PATCH_BYTES = 8 * 1024 * 1024
export const MAX_PATH_CHARS = 4096

// Count JSON string bytes without allocating an encoded copy of historical patches.
export function bytes(value: string) {
  let size = 2
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
      size += 2
      continue
    }
    if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) {
      if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
        size += 4
        i++
        continue
      }
      size += 6
      continue
    }
    size += code < 128 ? 1 : code < 2048 ? 2 : 3
  }
  return size
}

export function limit(diffs: readonly FileDiff.Info[]): FileDiff.Info[] {
  const result: FileDiff.Info[] = []
  const omitted = { additions: 0, deletions: 0, files: 0, complete: true, statisticsIncomplete: false }
  for (const diff of diffs) {
    if (!diff.file || result.length >= MAX_FILES || diff.file.length > MAX_PATH_CHARS) {
      omitted.additions += diff.additions
      omitted.deletions += diff.deletions
      omitted.files += diff.file ? 1 : (diff.omitted?.files ?? 0)
      if (!diff.file && diff.omitted?.files === undefined) omitted.complete = false
      if (diff.omitted?.statisticsIncomplete) omitted.statisticsIncomplete = true
      continue
    }
    result.push(diff)
  }
  let patchBytes = result.length * bytes("")
  for (let i = 0; i < result.length; i++) {
    const diff = result[i]
    const size = (diff.patch?.length ?? 0) > MAX_PATCH_BYTES ? MAX_PATCH_BYTES + 1 : bytes(diff.patch ?? "")
    if (size - 2 > MAX_PATCH_BYTES - patchBytes) {
      result[i] = { ...diff, patch: "", omitted: { ...diff.omitted, reason: "patch-budget", files: 1 } }
      continue
    }
    patchBytes += size - 2
  }
  if (omitted.files || !omitted.complete || omitted.statisticsIncomplete)
    result.push({
      additions: omitted.additions,
      deletions: omitted.deletions,
      omitted: {
        reason: "aggregate-budget",
        ...(omitted.complete ? { files: omitted.files } : {}),
        ...(omitted.statisticsIncomplete ? { statisticsIncomplete: true } : {}),
      },
    })
  return result
}

export function totals(diffs: readonly FileDiff.Info[]) {
  const initial = { additions: 0, deletions: 0, files: 0, filesComplete: true, complete: true }
  return diffs.reduce<typeof initial>(
    (sum, diff) => ({
      additions: sum.additions + diff.additions,
      deletions: sum.deletions + diff.deletions,
      files: sum.files + (diff.file ? 1 : (diff.omitted?.files ?? 0)),
      filesComplete: sum.filesComplete && (Boolean(diff.file) || diff.omitted?.files !== undefined),
      complete:
        sum.complete &&
        !diff.omitted?.statisticsIncomplete &&
        (Boolean(diff.file) || diff.omitted?.files !== undefined),
    }),
    initial,
  )
}
