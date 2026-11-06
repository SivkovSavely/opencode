import type { SessionMessageInfo } from "@opencode/client/promise"
import type { Data } from "@opencode/client/solid"
import { Timeline } from "@opencode/session-ui/timeline/projection"
import { Option, Schema } from "effect"

const Target = Schema.Struct({
  messageID: Schema.String.check(Schema.isMinLength(1)),
  partID: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
})

export type TranscriptTarget = typeof Target.Type

export function transcriptTarget(hash: string): TranscriptTarget | undefined {
  if (!hash.startsWith("#search:")) return

  try {
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.fromJsonString(Target))(decodeURIComponent(hash.slice(8))),
    )
  } catch {
    return
  }
}

export function hasTranscriptPart(message: SessionMessageInfo, target: TranscriptTarget) {
  if (!target.partID) return true

  if (message.type === "assistant") return Boolean(Timeline.resolveContent(message, target.partID))

  if (message.type === "user")
    return (
      (message.experimental?.textParts
        ? message.experimental.textParts.some((part) => part.id === target.partID)
        : target.partID === `${message.id}:text:0`) ||
      Boolean(message.experimental?.filePartIDs?.includes(target.partID)) ||
      Boolean(message.experimental?.fileParts?.some((part) => part.id === target.partID)) ||
      (!message.experimental?.filePartIDs &&
        (message.files ?? []).some((_, index) => target.partID === `${message.id}:file:${index}`))
    )

  return message.type === "shell" && (target.partID === `${message.id}:tool` || target.partID === message.id)
}

function nativePartID(message: SessionMessageInfo, partID: string | undefined) {
  if (message.type === "shell" && partID === `${message.id}:tool`) return message.id

  if (!partID || message.type !== "assistant") return partID

  return (
    Timeline.contentEntries(message).find(
      (entry) =>
        (entry.content.type === "text" || entry.content.type === "tool") &&
        entry.content.experimental?.sourcePartID === partID,
    )?.id ?? partID
  )
}

/** Loads the owning prompt as well as the target. One missing-part refresh per
 * selection is deliberate: a sibling is never a successful fallback. */
export async function resolveTranscriptTarget(
  history: Data["session"]["message"],
  sessionID: string,
  target: TranscriptTarget,
  current: () => boolean,
) {
  await history.settled(sessionID)

  while (current()) {
    const messages = history.list(sessionID)
    const index = messages.findIndex((message) => message.id === target.messageID)

    const owner =
      index < 0
        ? undefined
        : messages.slice(0, index + 1).findLast((message) => message.type === "user" || message.type === "shell")

    if (index >= 0 && (owner || !history.more(sessionID))) {
      const partID = nativePartID(messages[index]!, target.partID)

      if (!hasTranscriptPart(messages[index]!, { ...target, partID })) {
        await history.refresh(sessionID, target.messageID)

        if (!current()) return
        const refreshed = history.get(sessionID, target.messageID)

        if (!refreshed || !hasTranscriptPart(refreshed, { ...target, partID: nativePartID(refreshed, target.partID) }))
          return { status: "unavailable" as const }
      }

      return {
        status: "found" as const,
        messageID: target.messageID,
        ownerID: owner?.id ?? target.messageID,
        partID: nativePartID(history.get(sessionID, target.messageID)!, target.partID),
      }
    }

    if (!history.more(sessionID)) return { status: "unavailable" as const }
    const page = await history.loadPage(sessionID)

    if (page.before.cursor === page.after.cursor && page.before.records === page.after.records)
      return { status: "unavailable" as const }
  }
}
