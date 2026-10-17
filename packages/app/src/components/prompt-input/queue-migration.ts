import { Schema } from "effect"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import type { FollowupDraft } from "./submit"
import { queuePayload } from "./queue-payload"

export async function migrateFollowups(
  items: readonly (FollowupDraft & { id: string })[],
  input: {
    commands: () => Promise<readonly string[]>
    submit: (
      draft: FollowupDraft,
      submission: { id: string; payload: Awaited<ReturnType<typeof queuePayload>> },
    ) => Promise<unknown>
    acknowledge: (sessionID: string, id: string) => void
  },
) {
  const commands = await input.commands()
  for (const item of items) {
    const text = item.prompt.map((part) => ("content" in part ? part.content : "")).join("")
    const [head] = text.split(" ")
    const payload = await queuePayload(item, {
      custom: text.startsWith("/") && commands.includes(head?.slice(1) ?? ""),
    })
    const result = await input.submit(item, { id: `web-followup-${item.id}`, payload })
    Schema.decodeUnknownSync(SessionQueueV1.Snapshot)(result)
    input.acknowledge(item.sessionID, item.id)
  }
}
