import type { Message, Model } from "@opencode-ai/sdk/v2"
import { QueueCommand } from "@opencode-ai/schema/queue-command"

export function activePromptModel(messages: readonly Message[], running: boolean, agents: readonly string[]) {
  if (!running) return
  const assistant = messages.findLast(
    (message) => message.role === "assistant" && !message.summary && agents.includes(message.agent),
  )
  if (!assistant || assistant.role !== "assistant") return
  const parent = messages.find((message) => message.id === assistant.parentID)
  if (parent?.role !== "user" || parent.agent !== assistant.agent) return
  // The sync transcript contains admitted server messages, not local optimistic drafts.
  // A steer may be projected before its first assistant event arrives.
  const admitted = messages
    .slice(messages.indexOf(parent) + 1)
    .findLast(
      (message) =>
        message.role === "user" && message.sessionID === assistant.sessionID && agents.includes(message.agent),
    )
  if (admitted?.role === "user") return admitted.model
  if (assistant.error || (assistant.finish && assistant.finish !== "tool-calls" && assistant.finish !== "unknown"))
    return
  return parent.model
}

export function contemplatedPromptModel(input: {
  text: string
  explicit?: { providerID: string; modelID: string }
  persistent?: { providerID: string; modelID: string }
  active?: { providerID: string; modelID: string }
  commands: readonly { name: string; model?: string; agent?: string; source?: string; subtask?: boolean }[]
  agents: readonly { name: string; model?: { providerID: string; modelID: string }; mode?: string }[]
}) {
  const queued = QueueCommand.parse(input.text, true)
  const enqueue = queued?.type === "enqueue"
  const name = enqueue
    ? queued.kind === "command"
      ? queued.command
      : undefined
    : input.text.trimStart().match(/^\/(\S+)/)?.[1]
  const command = input.commands.find((command) => command.name === name && command.source !== "skill")
  const agent = input.agents.find((agent) => agent.name === command?.agent)
  const subtask = command?.subtask === true || (agent?.mode === "subagent" && command?.subtask !== false)
  const [providerID, ...modelID] = command?.model?.split("/") ?? []
  const defaults = command?.model ? { providerID, modelID: modelID.join("/") } : agent?.model
  return (
    input.explicit ??
    (enqueue || !subtask ? defaults : undefined) ??
    (enqueue ? undefined : input.active) ??
    input.persistent
  )
}

export function promptVariant(
  model: Pick<Model, "variants"> | undefined,
  explicit: string | undefined,
  inherited: string | undefined,
) {
  const variant = explicit ?? inherited ?? "default"
  const valid = variant === "default" || Object.hasOwn(model?.variants ?? {}, variant)
  return {
    variant: valid ? variant : "default",
    error: !valid && explicit !== undefined ? `Variant '${variant}' is not available for this model` : undefined,
  }
}
