export type SearchMessageTarget = { messageID: string; partID?: string }

export const messageIdFromHash = (hash: string) => {
  const value = hash.startsWith("#") ? hash.slice(1) : hash
  const match = value.match(/^message-(.+)$/)
  if (!match) return
  return match[1]
}

export const searchMessageTargetFromHash = (hash: string): SearchMessageTarget | undefined => {
  const value = hash.startsWith("#") ? hash.slice(1) : hash
  const match = value.match(/^search:(.+)$/)
  if (!match) return
  try {
    const target: unknown = JSON.parse(decodeURIComponent(match[1]!))
    if (typeof target !== "object" || target === null || !("messageID" in target)) return
    const messageID = target.messageID
    const partID = "partID" in target ? target.partID : undefined
    if (typeof messageID !== "string" || !messageID) return
    if (partID !== undefined && partID !== null && typeof partID !== "string") return
    return { messageID, partID: typeof partID === "string" ? partID : undefined }
  } catch {
    return
  }
}
