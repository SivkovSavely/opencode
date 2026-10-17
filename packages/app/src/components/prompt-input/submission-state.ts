import type { ContextItem, Prompt, usePrompt } from "@/context/prompt"
import { unwrap } from "solid-js/store"

type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>

export function createPromptSubmissionState(input: {
  target: PromptTarget
  prompt: Prompt
  context: (ContextItem & { key: string })[]
}) {
  const initial = input.target
  const prompt = structuredClone(unwrap(input.prompt))
  const context = structuredClone(unwrap(input.context))
  let target = input.target
  let cleared: Prompt | undefined
  const unchanged = () =>
    JSON.stringify(initial.current()) === JSON.stringify(prompt) &&
    JSON.stringify(initial.context.items()) === JSON.stringify(context)
  let transferredChanges = false
  let transferredState: string | undefined

  const transferChanges = () => {
    target.set(initial.current(), initial.cursor())
    target.context.items().forEach((item) => target.context.remove(item.key))
    initial.context.items().forEach(({ key, ...item }) => target.context.add(item))
    transferredChanges = true
    transferredState = JSON.stringify([initial.current(), initial.context.items()])
  }

  return {
    prompt,
    context,
    unchanged,
    target: () => target,
    clear(preserveChanges = false) {
      const currentState = JSON.stringify([initial.current(), initial.context.items()])
      if (initial !== target && !unchanged() && transferredState !== currentState) transferChanges()
      if (preserveChanges && !unchanged() && !transferredChanges) return false
      if (initial !== target) initial.reset()
      if (!transferredChanges) target.reset()
      cleared = target.current()
      return true
    },
    retarget(next: PromptTarget) {
      if (next === initial) return
      target = next
      if (unchanged()) {
        context.forEach(next.context.add)
        return
      }
      transferChanges()
    },
    current: (value: PromptTarget) => target === value,
    restore() {
      if (cleared !== undefined && target.current() !== cleared) return
      return { target, prompt, context }
    },
  }
}
