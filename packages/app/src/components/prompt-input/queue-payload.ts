import { Schema } from "effect"
import { unwrap } from "solid-js/store"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { QueueCommand } from "@opencode-ai/schema/queue-command"
import type { SessionQueueV1Payload } from "@opencode-ai/sdk/v2"
import type { FollowupDraft } from "./submit"
import { buildRequestParts } from "./build-request-parts"
import { blobDataUrl } from "@/utils/draft-store"
import { materializePrompt, commandBody } from "./controls"

export class QueuePayloadError extends Error {
  readonly key = "queue.attachmentsUnsupported"
}

export async function queuePayload(
  draft: FollowupDraft,
  options?: {
    mode?: "normal" | "shell"
    command?: Extract<QueueCommand.Result, { type: "enqueue" }>
    custom?: boolean
    commands?: { name: string; source?: string; model?: { providerID: string; id: string; variant?: string } }[]
  },
): Promise<SessionQueueV1Payload> {
  draft = structuredClone(unwrap(draft))
  options = options ? structuredClone(unwrap(options)) : undefined
  const clean =
    options?.mode === "shell"
      ? {
          prompt: draft.prompt,
          text: draft.prompt.map((part) => ("content" in part ? part.content : "")).join(""),
          selection: {},
        }
      : materializePrompt(
          draft.prompt,
          options?.commands?.filter((item) => item.source === "skill").map((item) => item.name),
        )
  const selection = { ...clean.selection, ...draft.selection }
  const text = clean.text
  const body = options?.command?.body ?? text
  const command = commandBody(body)
  const defaults = options?.commands?.find((item) => item.name === command?.name && item.source !== "skill")?.model
  const variant = selection.variant ?? defaults?.variant ?? draft.variant
  const common = {
    agent: draft.agent,
    model: selection.model ?? (defaults ? { providerID: defaults.providerID, modelID: defaults.id } : draft.model),
    ...(variant !== undefined ? { variant } : {}),
    selection: {
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
    },
  }
  const requestedKind =
    options?.command?.kind ??
    (options?.mode === "shell"
      ? "shell"
      : body.trim() === "/compact"
        ? "compact"
        : options?.custom && command
          ? "command"
          : "prompt")
  const kind =
    requestedKind === "command" &&
    options?.commands?.some((item) => item.name === command?.name && item.source === "skill")
      ? "prompt"
      : requestedKind
  if (
    (kind === "compact" || kind === "shell") &&
    (draft.context.length || clean.prompt.some((part) => part.type !== "text"))
  ) {
    throw new QueuePayloadError()
  }
  if (kind === "compact") return { kind, ...common }
  if (kind === "shell") {
    return { kind, ...common, command: options?.command?.kind === "shell" ? options.command.command : body }
  }

  // Rebase mention offsets after stripping queue syntax, without losing captured files or agents.
  const offset = text.indexOf(body)
  const prompt = clean.prompt.map((part) =>
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
    const payload = {
      kind,
      ...common,
      command: options?.command?.kind === "command" ? options.command.command : command!.name,
      arguments: [
        options?.command?.kind === "command" ? options.command.arguments : command!.arguments,
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
