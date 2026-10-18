import type { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"

export function queuePreview(payload: SessionQueueV1.Payload, compact: string) {
  if (payload.kind === "compact") return compact
  if (payload.kind === "shell") return `!${payload.command}`
  if (payload.kind === "command") return `/${payload.command} ${payload.arguments}`
  return payload.parts
    .flatMap((part) =>
      part.type === "text"
        ? [part.text]
        : part.type === "agent"
          ? [`@${part.name}`]
          : part.type === "subtask"
            ? [part.prompt]
            : [],
    )
    .join("\n")
}

export const queueCount = (snapshot?: SessionQueueV1.Snapshot) =>
  snapshot?.items.filter((item) => item.delivery === "queue" && item.state === "pending").length ?? 0

export const pendingSteers = (snapshot?: SessionQueueV1.Snapshot) =>
  new Set<string>(
    snapshot?.items.flatMap((item) =>
      item.delivery === "steer" && item.state === "pending" && item.messageID ? [item.messageID] : [],
    ),
  )

export function queueOrder(items: readonly SessionQueueV1.Entry[], id: string, direction: number) {
  const item = items.find((entry) => entry.id === id)
  if (item?.state !== "pending") return
  const ids = items
    .filter((entry) => entry.delivery === item.delivery && entry.state === "pending")
    .sort((left, right) => left.position - right.position)
    .map((entry) => entry.id)
  const index = ids.indexOf(id)
  const next = index + direction
  if (next < 0 || next >= ids.length) return
  ;[ids[index], ids[next]] = [ids[next]!, ids[index]!]
  return { action: "reorder", delivery: item.delivery, ids } satisfies SessionQueueV1.Mutation
}
