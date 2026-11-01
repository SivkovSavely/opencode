import type { Session } from "@opencode-ai/sdk/v2"

export function taskSession(input: {
  task: Record<string, unknown>
  metadata: Record<string, unknown>
  parentID: string | undefined
  currentID: string | undefined
  sessions: Session[] | undefined
  agent?: string
  titleFallback?: boolean
}) {
  if (!input.parentID || input.currentID !== input.parentID) return undefined

  const metadataID = input.metadata.sessionId
  if ("sessionId" in input.metadata) {
    return typeof metadataID === "string" && /^[\w-]+$/.test(metadataID) ? metadataID : undefined
  }

  const taskID = input.task.task_id
  if ("task_id" in input.task) {
    if (typeof taskID !== "string" || !/^[\w-]+$/.test(taskID)) return undefined
    const session = input.sessions?.find((session) => session.id === taskID)
    if (session && session.parentID !== input.parentID) return undefined
    return taskID
  }
  if (!input.titleFallback) return undefined

  const description = typeof input.task.description === "string" ? input.task.description : ""
  return (input.sessions ?? [])
    .filter((session) => session.parentID === input.parentID && !session.time?.archived)
    .filter((session) => (description ? session.title.startsWith(description) : true))
    .filter((session) => (input.agent ? session.title.includes(`@${input.agent}`) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}
