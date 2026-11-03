import { displaySlice, mentionTriggerIndex, promptOffsetWidth } from "./display"
import type { PromptInfo } from "./history"
import { materializePrompt } from "./materialize"

export const mentionNamespaces = ["file", "agent", "model", "variant", "reference", "resource"] as const

export function promptTrigger(prompt: PromptInfo, caret: number) {
  if (
    prompt.parts.some((part) => {
      const source = part.type === "file" || part.type === "text" ? part.source?.text : part.source
      return source && source.start < caret && (part.type === "control" ? source.end > caret : source.end >= caret)
    })
  )
    return
  const logical = materializePrompt(prompt, caret)
  const before = displaySlice(logical.input, 0, logical.caret)
  const command = before.match(/^\s*\/([\p{L}_-][\p{L}\p{N}_-]*|)$/u)
  if (command)
    return { mode: "/" as const, index: logical.sourceOffset(promptOffsetWidth(before.slice(0, before.indexOf("/")))) }
  const skill = before.match(/(?:^|\s)\$([\p{L}_][\p{L}\p{N}_.-]*|)$/u)
  if (skill && !/^[A-Z_]+$/.test(skill[1]))
    return {
      mode: "$" as const,
      index: logical.sourceOffset(promptOffsetWidth(before.slice(0, before.lastIndexOf("$")))),
    }
  if (prompt.parts.some((part) => part.type === "control" && part.source.end === caret)) return
  const mention = mentionTriggerIndex(logical.input, logical.caret)
  if (mention !== undefined) return { mode: "@" as const, index: logical.sourceOffset(mention) }
}
