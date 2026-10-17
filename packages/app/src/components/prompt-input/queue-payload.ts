import { Schema } from "effect"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { QueueCommand } from "@opencode-ai/schema/queue-command"
import type { SessionQueueV1Payload } from "@opencode-ai/sdk/v2"
import type { FollowupDraft } from "./submit"
import { buildRequestParts } from "./build-request-parts"
import { blobDataUrl } from "@/utils/draft-store"

export class QueuePayloadError extends Error {
  readonly key = "queue.attachmentsUnsupported"
}

export async function queuePayload(
  draft: FollowupDraft,
  options?: {
    mode?: "normal" | "shell"
    command?: Extract<QueueCommand.Result, { type: "enqueue" }>
    custom?: boolean
  },
): Promise<SessionQueueV1Payload> {
  const text = draft.prompt.map((part) => ("content" in part ? part.content : "")).join("")
  const body = options?.command?.body ?? text
  const common = {
    agent: draft.agent,
    model: draft.model,
    ...(draft.variant !== undefined ? { variant: draft.variant } : {}),
  }
  const kind =
    options?.command?.kind ??
    (options?.mode === "shell"
      ? "shell"
      : body.trim() === "/compact"
        ? "compact"
        : options?.custom && body.startsWith("/")
          ? "command"
          : "prompt")
  if (
    (kind === "compact" || kind === "shell") &&
    (draft.context.length || draft.prompt.some((part) => part.type !== "text"))
  ) {
    throw new QueuePayloadError()
  }
  if (kind === "compact") return { kind, ...common }
  if (kind === "shell") {
    return { kind, ...common, command: options?.command?.kind === "shell" ? options.command.command : body }
  }

  // Rebase mention offsets after stripping queue syntax, without losing captured files or agents.
  const offset = text.indexOf(body)
  const prompt = draft.prompt.map((part) =>
    part.type === "file" || part.type === "agent"
      ? { ...part, start: Math.max(0, part.start - offset), end: Math.max(0, part.end - offset) }
      : part,
  )
  const images = await Promise.all(
    prompt
      .filter((part) => part.type === "image")
      .map(async (part) => ({
        ...part,
        dataUrl: await blobDataUrl(part.blob, part.mime),
      })),
  )
  const parts = buildRequestParts({
    prompt,
    context: draft.context,
    images,
    text: body,
    sessionID: draft.sessionID,
    messageID: "",
    sessionDirectory: draft.sessionDirectory,
  }).requestParts.map(({ id, ...part }) => part)
  if (kind === "command") {
    const [head, ...tail] = body.split(" ")
    const payload = {
      kind,
      ...common,
      command: options?.command?.kind === "command" ? options.command.command : head.slice(1),
      arguments: [
        options?.command?.kind === "command" ? options.command.arguments : tail.join(" "),
        ...parts.flatMap((part) => (part.type === "text" && part.synthetic ? [part.text] : [])),
      ]
        .filter(Boolean)
        .join("\n\n"),
      parts: parts.filter((part) => part.type === "file"),
    }
    Schema.decodeUnknownSync(SessionQueueV1.Payload)(payload)
    return payload
  }
  const payload = { kind, ...common, parts }
  Schema.decodeUnknownSync(SessionQueueV1.Payload)(payload)
  return payload
}
