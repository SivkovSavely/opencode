export * as QueueCommand from "./queue-command"

export type Result =
  | { readonly type: "manage" }
  | { readonly type: "list" }
  | { readonly type: "start" }
  | { readonly type: "stop" }
  | { readonly type: "flush" }
  | { readonly type: "clear"; readonly indices: readonly number[] }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "enqueue"; readonly front: boolean; readonly kind: "prompt"; readonly body: string }
  | {
      readonly type: "enqueue"
      readonly front: boolean
      readonly kind: "command"
      readonly body: string
      readonly command: string
      readonly arguments: string
    }
  | { readonly type: "enqueue"; readonly front: boolean; readonly kind: "compact"; readonly body: string }
  | {
      readonly type: "enqueue"
      readonly front: boolean
      readonly kind: "shell"
      readonly body: string
      readonly command: string
    }

export function parse(text: string, attachments = false): Result | undefined {
  const manage = text.trim().match(/^\/queues(?:\s+([\s\S]*))?$/)
  if (manage) {
    if (manage[1]?.trim()) return { type: "error", message: "Queues does not accept arguments" }
    if (attachments) return { type: "error", message: "Queues does not support attachments" }
    return { type: "manage" }
  }

  // Prefix syntax wins when both forms are present, matching the queue plugin.
  const prefix = text.match(/^\/queue(?:\s+([\s\S]*))?$/)
  const suffix = prefix ? undefined : text.match(/^([\s\S]*?)\s+\/queue(?:\s+(front))?\s*$/)
  const standalone = text.trim()
  if (!prefix && !suffix && standalone !== "/queue" && standalone !== "/queue front") return undefined

  const input = prefix ? (prefix[1] ?? "") : (suffix?.[1] ?? "")
  const priority = prefix ? input.trim().match(/^front(?:\s+([\s\S]*))?$/) : undefined
  const front = prefix ? Boolean(priority) : suffix ? suffix[2] === "front" : standalone === "/queue front"
  const body = priority ? (priority[1] ?? "") : input
  const content = body.trim()

  if (!front && !attachments) {
    switch (content) {
      case "":
      case "list":
        return { type: "list" }
      case "start":
        return { type: "start" }
      case "stop":
        return { type: "stop" }
      case "flush":
        return { type: "flush" }
    }

    const clear = content.match(/^clear(?:\s+([\s\S]+))?$/)
    if (clear) {
      const values = clear[1]?.trim().split(/\s+/) ?? []
      const indices = values.map(Number)
      if (values.some((value) => !/^[1-9]\d*$/.test(value)) || indices.some((index) => !Number.isSafeInteger(index))) {
        return { type: "error", message: "Queue clear expects positive item numbers" }
      }
      return { type: "clear", indices: [...new Set(indices)] }
    }
  }

  if (!content && !attachments) return { type: "error", message: "Queue front input is empty" }

  if (content.startsWith("!")) {
    const command = content.slice(1).trim()
    if (!command) return { type: "error", message: "Queue shell command is empty" }
    if (attachments) return { type: "error", message: "Queued shell commands do not support attachments" }
    return { type: "enqueue", front, kind: "shell", body: content, command }
  }

  const command = content.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
  if (command) {
    if (command[1] === "compact") {
      if (command[2]?.trim()) return { type: "error", message: "Queue compact does not accept arguments" }
      if (attachments) return { type: "error", message: "Queue compact does not support attachments" }
      return { type: "enqueue", front, kind: "compact", body: content }
    }
    return {
      type: "enqueue",
      front,
      kind: "command",
      body: content,
      command: command[1],
      arguments: command[2] ?? "",
    }
  }

  return { type: "enqueue", front, kind: "prompt", body }
}
