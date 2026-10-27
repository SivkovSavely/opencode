import { TimelineRow } from "./timeline-row"

export function partRowIndices(rows: readonly TimelineRow.TimelineRow[]) {
  const result = new Map<string, Map<string, number>>()
  rows.forEach((row, index) => {
    if (row._tag !== "AssistantPart") return
    const refs = row.group.type === "part" ? [row.group.ref] : row.group.refs
    refs.forEach((ref) => {
      const parts = result.get(ref.messageID)
      if (parts) parts.set(ref.partID, index)
      else result.set(ref.messageID, new Map([[ref.partID, index]]))
    })
  })
  return result
}
