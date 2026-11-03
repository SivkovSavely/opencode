import type { PromptInputV2Prompt } from "./types"

export function isPromptInputV2Control(part: PromptInputV2Prompt[number]) {
  return part.type === "model" || part.type === "variant"
}

// Only semantic controls disappear. Literal text resembling a control stays text.
export function promptInputV2Logical(prompt: PromptInputV2Prompt, cursor = Infinity) {
  let source = 0
  let caret = 0
  let value = ""
  const spans: { start: number; end: number }[] = []
  prompt.forEach((part) => {
    if (part.type === "image") return
    const start = source
    source += part.content.length
    if (isPromptInputV2Control(part)) return
    const text = part.type === "text" ? part.content : "\uFFFC".repeat(part.content.length)
    for (let index = 0; index < text.length; index++) {
      spans.push({ start: start + index, end: start + index + 1 })
      value += text[index]
      if (start + index < cursor) caret++
    }
  })
  return { value, caret, spans }
}

export function promptInputV2Trigger(prompt: PromptInputV2Prompt, cursor?: number) {
  const logical = promptInputV2Logical(prompt, cursor)
  const before = logical.value.slice(0, logical.caret)
  const match = before.match(/(?:^|\s)([@$])([^\s@$\uFFFC]*)$/)
  const command = before.match(/^\s*\/([^\s\uFFFC]*)$/)
  const trigger = match?.[1] ?? (command ? "/" : undefined)
  if (!trigger) return
  const query = match?.[2] ?? command?.[1] ?? ""
  // Currency and uppercase template variables are not skill invocations.
  if (trigger === "$" && (/^\d/.test(query) || /^[A-Z][A-Z0-9_]*$/.test(query))) return
  const index = logical.caret - query.length - 1
  return {
    trigger,
    query,
    start: logical.spans[index]?.start ?? cursor ?? 0,
    end: logical.spans[logical.caret - 1]?.end ?? cursor ?? 0,
  }
}
