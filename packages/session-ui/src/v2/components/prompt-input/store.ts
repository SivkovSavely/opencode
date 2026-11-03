import { batch, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import type {
  PromptInputV2Attachment,
  PromptInputV2Comment,
  PromptInputV2Mention,
  PromptInputV2Model,
  PromptInputV2PersistedState,
  PromptInputV2Prompt,
} from "./types"
import { isPromptInputV2Control, promptInputV2Trigger } from "./logical"

export type PromptInputV2StoreTuple = [
  Store<PromptInputV2PersistedState> | Accessor<Store<PromptInputV2PersistedState>>,
  SetStoreFunction<PromptInputV2PersistedState>,
]

export type PromptInputV2StoreInput = PromptInputV2StoreTuple | Accessor<PromptInputV2StoreTuple>

export function createPromptInputV2Store(input: PromptInputV2StoreInput) {
  const tuple = () => (typeof input === "function" ? input() : input)
  const store = () => {
    const value = tuple()[0]
    return typeof value === "function" ? value() : value
  }
  const setStore = () => tuple()[1]
  const undo: { prompt: PromptInputV2Prompt; cursor?: number }[] = []
  const redo: typeof undo = []
  const snapshot = () => ({
    prompt: JSON.parse(JSON.stringify(store().prompt)) as PromptInputV2Prompt,
    cursor: store().cursor,
  })
  const checkpoint = () => {
    undo.push(snapshot())
    if (undo.length > 100) undo.shift()
    redo.length = 0
  }

  return {
    get state() {
      return store()
    },
    clearUndo() {
      undo.length = 0
      redo.length = 0
    },
    undo(restore = false) {
      const source = restore ? redo : undo
      const entry = source.pop()
      if (!entry) return false
      ;(restore ? undo : redo).push(snapshot())
      batch(() => {
        setStore()("prompt", entry.prompt)
        setStore()("cursor", entry.cursor)
      })
      return true
    },
    setPrompt(prompt: PromptInputV2Prompt, cursor?: number) {
      if (JSON.stringify(prompt) !== JSON.stringify(store().prompt)) checkpoint()
      batch(() => {
        setStore()("prompt", prompt)
        if (cursor !== undefined) setStore()("cursor", cursor)
      })
    },
    setCursor(cursor: number) {
      setStore()("cursor", cursor)
    },
    setText(content: string) {
      checkpoint()
      batch(() => {
        setStore()("prompt", (prompt) => [
          { type: "text", content, start: 0, end: content.length },
          ...prompt.filter((part) => part.type !== "text"),
        ])
        setStore()("cursor", content.length)
      })
    },
    addText(content: string) {
      checkpoint()
      const cursor = store().cursor ?? promptLength(store().prompt)
      batch(() => {
        setStore()("prompt", (prompt) => insertText(prompt, cursor, content))
        setStore()("cursor", cursor + content.length)
      })
    },
    reset() {
      checkpoint()
      batch(() => {
        setStore()("prompt", [{ type: "text", content: "", start: 0, end: 0 }])
        setStore()("cursor", 0)
      })
    },
    setModel(model: PromptInputV2Model | undefined) {
      setStore()("model", model)
    },
    setVariant(variant: string | null) {
      if (store().model) setStore()("model", "variant", variant)
    },
    addContext(item: PromptInputV2Comment) {
      if (store().context.items.some((entry) => entry.key === item.key)) return
      setStore()("context", "items", (items) => [...items, item])
    },
    removeContext(key: string) {
      setStore()("context", "items", (items) => items.filter((item) => item.key !== key))
    },
    replaceRange(start: number, end: number, content: string) {
      checkpoint()
      setStore()("prompt", replaceRange(store().prompt, start, end, [{ type: "text", content, start: 0, end: 0 }]))
      setStore()("cursor", start + content.length)
    },
    addMention(mention: PromptInputV2Mention) {
      checkpoint()
      const text = store()
        .prompt.map((part) => ("content" in part ? part.content : ""))
        .join("")
      const end = store().cursor ?? text.length
      const trigger = promptInputV2Trigger(store().prompt, end)
      const start = trigger?.start ?? end
      const control = isPromptInputV2Control(mention)
      const space = !control && mention.type !== "skill"
      const parts = replaceRange(store().prompt, start, end, [
        mention,
        ...(space ? [{ type: "text" as const, content: " ", start: 0, end: 0 }] : []),
      ])
      // Reselecting a control replaces the prior token, never its neighboring text.
      let offset = 0
      let removedBefore = 0
      const next = parts.filter((part) => {
        if (part.type === "image") return true
        const position = offset
        offset += part.content.length
        if (!control || part.type !== mention.type || position === start) return true
        if (position < start) removedBefore += part.content.length
        return false
      })
      setStore()("prompt", withOffsets(next))
      setStore()("cursor", start - removedBefore + mention.content.length + (space ? 1 : 0))
    },
    addAttachment(attachment: PromptInputV2Attachment) {
      setStore()("prompt", (prompt) => [...prompt, attachment])
    },
    removeAttachment(id: string) {
      setStore()("prompt", (parts) => parts.filter((part) => part.type !== "image" || part.id !== id))
    },
  }
}

export type PromptInputV2Store = ReturnType<typeof createPromptInputV2Store>

function insertText(prompt: PromptInputV2Prompt, cursor: number, content: string): PromptInputV2Prompt {
  let position = 0
  let inserted = false
  const parts = prompt.flatMap<PromptInputV2Prompt[number]>((part) => {
    if (part.type === "image") return [part]
    const start = position
    position += part.content.length
    if (inserted) return [part]
    if (part.type === "text" && cursor >= start && cursor <= position) {
      inserted = true
      const offset = cursor - start
      return [{ ...part, content: part.content.slice(0, offset) + content + part.content.slice(offset) }]
    }
    if (cursor > start) return [part]
    inserted = true
    return [{ type: "text", content, start: 0, end: 0 }, part]
  })
  if (!inserted) parts.push({ type: "text", content, start: 0, end: 0 })
  return withOffsets(parts)
}

function replaceRange(
  prompt: PromptInputV2Prompt,
  start: number,
  end: number,
  replacement: PromptInputV2Prompt,
): PromptInputV2Prompt {
  let position = 0
  let inserted = false
  const parts = prompt.flatMap<PromptInputV2Prompt[number]>((part) => {
    if (part.type === "image") return [part]
    const partStart = position
    position += part.content.length
    if (part.type !== "text") {
      if (!inserted && start === partStart) {
        inserted = true
        return [...replacement, part]
      }
      return [part]
    }
    if (position < start || partStart > end) return [part]
    const before = part.content.slice(0, Math.max(0, start - partStart))
    const after = part.content.slice(Math.max(0, end - partStart))
    const insert = !inserted
    inserted = true
    return [
      ...(before ? [{ type: "text" as const, content: before, start: 0, end: 0 }] : []),
      ...(insert ? replacement : []),
      ...(after ? [{ type: "text" as const, content: after, start: 0, end: 0 }] : []),
    ]
  })
  if (!inserted) parts.push(...replacement)
  return withOffsets(parts)
}

function withOffsets(prompt: PromptInputV2Prompt): PromptInputV2Prompt {
  let offset = 0
  return prompt.map((part) => {
    if (part.type === "image") return part
    const next = { ...part, start: offset, end: offset + part.content.length }
    offset = next.end
    return next
  })
}

function promptLength(prompt: PromptInputV2Prompt) {
  return prompt.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
}
