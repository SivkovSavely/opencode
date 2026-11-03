import type { Prompt } from "@/context/prompt"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { QueueCommand } from "@opencode-ai/schema/queue-command"

export type PromptSelection = {
  inheritActive?: boolean
  model?: { providerID: string; modelID: string }
  variant?: string
}

// Only structured controls are elided. Literal unresolved tokens and surrounding bytes survive unchanged.
export function materializePrompt(input: Prompt, skills: string[] = []) {
  const selection: PromptSelection = {}
  const controls = input.some((part) => part.type === "model" || part.type === "variant")
  let position = 0
  const surviving = input
    .flatMap<Prompt[number]>((part) => {
      if (part.type === "model") {
        selection.model = { providerID: part.providerID, modelID: part.modelID }
        return []
      }
      if (part.type === "variant") {
        selection.variant = part.variant
        return []
      }
      if (part.type === "image") return [{ ...part }]
      const start = position
      position += part.content.length
      const next = { ...part, ...(controls ? { start, end: position } : {}) }
      return [next]
    })
    .reduce<Prompt>((parts, part) => {
      const previous = parts.at(-1)
      if (previous?.type === "text" && part.type === "text") {
        previous.content += part.content
        previous.end = previous.start + previous.content.length
        return parts
      }
      parts.push(part)
      return parts
    }, [])
  const names = skills
    .filter((name) => name && !/^\d/.test(name) && !/^[A-Z][A-Z0-9_]*$/.test(name))
    .sort((a, b) => b.length - a.length)
  const prompt = surviving.flatMap<Prompt[number]>((next) => {
    if (next.type !== "text" || !names.length) return [next]
    let offset = 0
    const parts: Prompt = []
    for (const match of next.content.matchAll(/(?:^|[\s([{])\$/gu)) {
      const rest = next.content.slice(match.index + match[0].length)
      const name = names.find((candidate) => {
        if (!rest.startsWith(candidate)) return false
        const suffix = rest.slice(candidate.length)
        return !suffix || /^[\s)\]},!?;:]/u.test(suffix) || /^\.(?![\p{L}\p{N}_.-])/u.test(suffix)
      })
      if (!name) continue
      const start = match.index + match[0].length - 1
      if (start > offset)
        parts.push({
          type: "text",
          content: next.content.slice(offset, start),
          start: next.start + offset,
          end: next.start + start,
        })
      const content = `$${name}`
      parts.push({
        type: "skill",
        name,
        content,
        start: next.start + start,
        end: next.start + start + content.length,
      })
      offset = start + content.length
    }
    if (offset < next.content.length)
      parts.push({ ...next, content: next.content.slice(offset), start: next.start + offset })
    return parts
  })
  return { prompt, selection, text: prompt.map((part) => ("content" in part ? part.content : "")).join("") }
}

// A running gate alone is insufficient: only a real parent turn, including tool continuations, supplies selection.
export function activePromptSelection(
  messages: Message[],
  running = false,
  sessionID?: string,
  admitted: readonly { id: string; type: string }[] = [],
) {
  if (!running) return
  const assistant = messages.findLast(
    (message) => message.role === "assistant" && !message.summary && (!sessionID || message.sessionID === sessionID),
  )
  if (!assistant || assistant.role !== "assistant") return
  const continuation = assistant.finish === "tool-calls" || assistant.finish === "unknown"
  const parent = messages.find(
    (message) =>
      message.id === assistant.parentID && message.role === "user" && message.sessionID === assistant.sessionID,
  )
  if (!parent || parent.role !== "user") return
  const parentIndex = messages.indexOf(parent)
  const steer = messages.findLast(
    (message, index) =>
      index > parentIndex &&
      message.role === "user" &&
      !message.summary &&
      message.sessionID === assistant.sessionID &&
      admitted.some((item) => item.id === message.id && item.type === "user"),
  )
  if (steer?.role === "user") return { ...steer.model }
  if (assistant.error || ((assistant.finish || assistant.time.completed) && !continuation)) return
  return {
    providerID: assistant.providerID,
    modelID: assistant.modelID,
    variant: assistant.variant ?? parent.model.variant,
  }
}

type ExecutionSelection = { providerID: string; modelID: string; variant?: string }

export function contemplatedPromptSelection(input: {
  text: string
  base: ExecutionSelection
  selection: PromptSelection
  active?: ExecutionSelection
  queue?: boolean
  commands: readonly {
    name: string
    source?: string
    agent?: string
    subtask?: boolean
    model?: { providerID: string; id: string; variant?: string }
  }[]
  agents?: readonly { name: string; mode?: string; model?: { providerID: string; modelID: string }; variant?: string }[]
}) {
  const queue = parseQueueCommand(input.text)
  const command = commandBody(queue?.type === "enqueue" ? queue.body : input.text)
  const configured = input.commands.find((item) => item.name === command?.name && item.source !== "skill")
  const agent = input.agents?.find((item) => item.name === configured?.agent)
  const subtask = configured?.subtask === true || (agent?.mode === "subagent" && configured?.subtask !== false)
  const defaults = subtask
    ? undefined
    : configured?.model
      ? { providerID: configured.model.providerID, modelID: configured.model.id }
      : agent?.model
  const fallback = !input.queue && queue?.type !== "enqueue" && input.active ? input.active : input.base
  return {
    ...(input.selection.model ?? defaults ?? fallback),
    variant: input.selection.variant ?? (!subtask ? configured?.model?.variant : undefined) ?? fallback.variant,
  }
}

export function promptTrigger(prompt: Prompt, caret: number) {
  let position = 0
  let logical = 0
  const spans: { start: number; end: number; logical: number }[] = []
  const prefix = prompt
    .flatMap((part) => {
      if (!("content" in part)) return []
      const start = position
      position += part.content.length
      if (part.type === "model" || part.type === "variant") return []
      if (caret <= start) return []
      if (part.type !== "text") {
        logical += 1
        return ["\0"]
      }
      const content = part.content.slice(0, Math.max(0, caret - start))
      spans.push({ start, end: start + content.length, logical })
      logical += content.length
      return [content]
    })
    .join("")
  const at = prefix.match(/(?:^|[\s([{])@([^\s@\0]*)$/)
  const skill = prefix.match(/(?:^|[\s([{])\$([\p{L}_][\p{L}\p{N}_.-]*|)$/u)
  if (skill && /^[A-Z][A-Z0-9_]*$/.test(skill[1])) return
  const slash = prefix.match(/^\s*\/([^\s\0]*)$/)
  const match = at ?? skill ?? slash
  if (!match) return
  const start = prefix.length - match[1].length - 1
  return {
    type: at ? ("at" as const) : skill ? ("skill" as const) : ("slash" as const),
    query: match[1],
    ranges: spans.flatMap((span) => {
      const from = Math.max(start, span.logical)
      const to = Math.min(prefix.length, span.logical + span.end - span.start)
      return from < to ? [{ start: span.start + from - span.logical, end: span.start + to - span.logical }] : []
    }),
  }
}

export function replacePromptTrigger(
  input: Prompt,
  caret: number,
  replacement: Exclude<Prompt[number], { type: "image" }>,
  trailingSpace = false,
) {
  const trigger = promptTrigger(input, caret)
  if (!trigger?.ranges.length) return
  let raw = 0
  let cursor = caret + replacement.content.length + (trailingSpace ? 1 : 0)
  const next = input.flatMap<Prompt[number]>((part) => {
    if (!("content" in part)) return [{ ...part }]
    const start = raw
    raw += part.content.length
    if ((replacement.type === "model" || replacement.type === "variant") && part.type === replacement.type) {
      cursor -= Math.max(0, Math.min(caret - start, part.content.length))
      return []
    }
    if (part.type !== "text") return [{ ...part }]
    const range = trigger.ranges.find((range) => range.start < raw && range.end > start)
    if (!range) return [{ ...part }]
    const from = range.start - start
    const to = range.end - start
    cursor -= to - from
    return [
      ...(from ? [{ ...part, content: part.content.slice(0, from) }] : []),
      ...(range.start === trigger.ranges[0].start
        ? [{ ...replacement }, ...(trailingSpace ? [{ type: "text" as const, content: " ", start: 0, end: 1 }] : [])]
        : []),
      ...(to < part.content.length ? [{ ...part, content: part.content.slice(to) }] : []),
    ]
  })
  let position = 0
  return {
    cursor,
    prompt: next.map((part) => {
      if (!("content" in part)) return part
      const start = position
      position += part.content.length
      return { ...part, start, end: position }
    }),
  }
}

export function commandBody(text: string) {
  const match = text.match(/^\s*\/([^\s]+)(?:[ \t]|\r?\n)?/)
  if (!match) return
  return { name: match[1], arguments: text.slice(match[0].length) }
}

export function parseQueueCommand(text: string, attachments = false) {
  const command = commandBody(text)
  return QueueCommand.parse(
    command?.name === "queue" || command?.name === "queues" ? text.trimStart() : text,
    attachments,
  )
}

export function resolvePromptSelection(
  base: { providerID: string; modelID: string; variant?: string },
  selection: PromptSelection,
  models: { providerID: string; modelID: string; variants?: string[] }[],
) {
  const pair = selection.model ?? base
  const model = models.find((item) => item.providerID === pair.providerID && item.modelID === pair.modelID)
  if (!model) return { error: "prompt.controls.modelUnavailable" as const }
  const explicit = selection.variant
  if (explicit !== undefined && explicit !== "default" && !model.variants?.includes(explicit))
    return { error: "prompt.controls.variantUnavailable" as const }
  const variant = explicit ?? (base.variant && model.variants?.includes(base.variant) ? base.variant : undefined)
  return { model: { providerID: pair.providerID, modelID: pair.modelID }, variant }
}
