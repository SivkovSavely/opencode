import type { QueueCommand } from "@opencode-ai/schema/queue-command"
import type { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"

export function queuePayload(
  command: Extract<QueueCommand.Result, { type: "enqueue" }>,
  captured: { agent: string; model: { providerID: string; modelID: string }; variant?: string },
  parts: Extract<SessionQueueV1.Payload, { kind: "prompt" }>["parts"],
  sourceText = command.body,
): SessionQueueV1.Payload {
  const selection = { ...captured, model: { ...captured.model } }
  if (command.kind === "compact") return { ...selection, kind: "compact" }
  if (command.kind === "shell") return { ...selection, kind: "shell", command: command.command }
  if (command.kind === "command")
    return {
      ...selection,
      kind: "command",
      command: command.command,
      arguments: command.arguments,
      parts: parts.filter((part) => part.type === "file"),
    }
  const offset = Math.max(0, sourceText.indexOf(command.body))
  return {
    ...selection,
    kind: "prompt",
    parts: [
      ...parts.filter((part) => part.type === "text"),
      { type: "text", text: command.body },
      ...parts
        .filter((part) => part.type !== "text")
        .map((part) => {
          if (part.type === "agent" && part.source)
            return {
              ...part,
              source: {
                ...part.source,
                start: Math.max(0, part.source.start - offset),
                end: Math.max(0, part.source.end - offset),
              },
            }
          if (part.type === "file" && part.source)
            return {
              ...part,
              source: {
                ...part.source,
                text: {
                  ...part.source.text,
                  start: Math.max(0, part.source.text.start - offset),
                  end: Math.max(0, part.source.text.end - offset),
                },
              },
            }
          return part
        }),
    ],
  }
}
