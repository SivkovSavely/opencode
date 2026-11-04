import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Semaphore } from "effect"
import { isDeepStrictEqual } from "node:util"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"
import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"
import { Database } from "@opencode-ai/core/database/database"
import { MessageV2 } from "./message-v2"
import { NotFoundError } from "@/storage/storage"

function quoteGitPath(input: string) {
  if (!/["\\\x00-\x1f\x7f]/.test(input)) return input
  return `"${Array.from(Buffer.from(input), (byte) =>
    byte === 34 || byte === 92
      ? `\\${String.fromCharCode(byte)}`
      : byte < 32 || byte >= 127
        ? `\\${byte.toString(8).padStart(3, "0")}`
        : String.fromCharCode(byte),
  ).join("")}"`
}

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: {
    messages: SessionV1.WithParts[]
    sessionID?: SessionID
    messageID?: MessageID
  }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const database = yield* Database.Service
    const locks = new Map<MessageID, { semaphore: Semaphore.Semaphore; users: number }>()
    const getInfo = (input: { sessionID: SessionID; messageID: MessageID }) =>
      MessageV2.getInfo(input).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catchIf(NotFoundError.isInstance, () => Effect.void),
      )

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: {
      messages: SessionV1.WithParts[]
      sessionID?: SessionID
      messageID?: MessageID
    }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) {
        const diffs = yield* snapshot.diffFull(from, to, { sessionID: input.sessionID, messageID: input.messageID })
        // Summary storage historically contains Git-quoted paths, while NUL-delimited snapshot metadata is raw.
        return SnapshotDiff.limit(
          diffs.map((diff) => (diff.file === undefined ? diff : { ...diff, file: quoteGitPath(diff.file) })),
        )
      }
      return []
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
        },
      })
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
      if ((yield* config.get()).snapshot === false) return
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const lock = locks.get(input.messageID) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
          lock.users++
          locks.set(input.messageID, lock)
          return lock
        }),
        (lock) =>
          Effect.gen(function* () {
            const messages = yield* MessageV2.turn(input).pipe(Effect.provideService(Database.Service, database))
            const target = messages.find((m) => m.info.id === input.messageID)
            if (!target || target.info.role !== "user") return
            const msgDiffs = yield* computeDiff({ messages, sessionID: input.sessionID, messageID: input.messageID })
            const current = yield* getInfo(input)
            if (!current || current.role !== "user") return
            const summary = { ...current.summary, diffs: msgDiffs }
            if (isDeepStrictEqual(current.summary, summary)) return
            // Persisted formats are plain JSON, but message events require schema class instances.
            yield* sessions.updateMessage({
              ...current,
              ...(current.format && {
                format:
                  current.format.type === "text"
                    ? new SessionV1.OutputFormatText(current.format)
                    : new SessionV1.OutputFormatJsonSchema(current.format),
              }),
              summary,
            })
          }).pipe(lock.semaphore.withPermits(1)),
        (lock) =>
          Effect.sync(() => {
            if (--lock.users === 0) locks.delete(input.messageID)
          }),
      )
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (!input.messageID) return []
      const message = yield* getInfo({ sessionID: input.sessionID, messageID: input.messageID })
      if (!message || message.role !== "user") return []
      const diffs = SnapshotDiff.limit(message.summary?.diffs ?? [])
      return diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, EventV2Bridge.node, Config.node, Database.node],
})

export * as SessionSummary from "./summary"
