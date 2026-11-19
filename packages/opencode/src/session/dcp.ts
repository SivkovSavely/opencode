export * as SessionDcp from "./dcp"

import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { SessionDcpV1 } from "@opencode-ai/schema/v1/session-dcp"
import { SessionID } from "./schema"
import { isRecord } from "@/util/record"

const maxBytes = 8 * 1024 * 1024
// The plugin uses this XDG path, independently of OpenCode's database/profile path.
const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
const idPattern = /^ses_[A-Za-z0-9_-]{1,124}$/

export function project(sessionID: SessionID, input: unknown): SessionDcpV1.Snapshot {
  if (!isRecord(input) || !isRecord(input.prune)) return { sessionID, state: "invalid" }
  const prune = input.prune
  if (prune.messages !== undefined && !isRecord(prune.messages)) return { sessionID, state: "invalid" }
  const messages = isRecord(prune.messages) ? prune.messages : undefined
  const raw = messages && isRecord(messages.blocksById) ? messages.blocksById : undefined
  const active = messages ? ids(messages.activeBlockIds) : undefined
  const blocks: SessionDcpV1.Block[] = Object.entries(raw ?? {})
    .flatMap(([key, value]) => {
      const blockId = /^[1-9]\d*$/.test(key) ? positive(Number(key)) : undefined
      if (blockId === undefined || !isRecord(value)) return []
      const on = bool(value.active) ?? (active ? active.includes(blockId) : undefined)
      const pruned = bool(value.summaryPruned)
      const parent = positive(value.deactivatedByBlockId)
      const parents = ids(value.parentBlockIds)
      const containers = (parent === undefined ? (parents ?? []) : [parent])
        .map((id) => raw?.[String(id)])
        .filter(isRecord)
      const status: SessionDcpV1.Block["status"] = on
        ? pruned
          ? "pruned"
          : "active"
        : value.deactivatedByUser === true
          ? "user-decompressed"
          : containers.some((block) => ids(block.includedBlockIds)?.includes(blockId))
            ? "nested"
            : containers.some((block) => ids(block.consumedBlockIds)?.includes(blockId))
              ? "superseded"
              : pruned
                ? "pruned"
                : on === false
                  ? "inactive"
                  : "unknown"
      return [
        compact({
          blockId,
          status,
          active: on,
          summaryPruned: pruned,
          topic: text(value.topic),
          batchTopic: text(value.batchTopic),
          summary: text(value.summary),
          mode: text(value.mode),
          runId: positive(value.runId),
          startId: text(value.startId),
          endId: text(value.endId),
          createdAt: count(value.createdAt),
          deactivatedAt: count(value.deactivatedAt),
          deactivatedByBlockId: parent,
          includedBlockIds: ids(value.includedBlockIds),
          consumedBlockIds: ids(value.consumedBlockIds),
          parentBlockIds: parents,
          directMessageCount: stringCount(value.directMessageIds),
          directToolCount: stringCount(value.directToolIds),
          effectiveMessageCount: stringCount(value.effectiveMessageIds),
          effectiveToolCount: stringCount(value.effectiveToolIds),
          compressedTokens: count(value.compressedTokens),
          summaryTokens: count(value.summaryTokens),
          durationMs: count(value.durationMs),
        }),
      ]
    })
    .sort((a, b) => a.blockId - b.blockId)
  const history =
    isRecord(input.operations) && Array.isArray(input.operations.history)
      ? input.operations.history.slice(-100).flatMap((value): SessionDcpV1.Operation[] => {
          if (!isRecord(value)) return []
          const id = positive(value.id)
          const type = text(value.type)
          if (id === undefined || type === undefined) return []
          return [
            compact({
              id,
              type,
              timestamp: count(value.timestamp),
              topic: text(value.topic),
              blockIds: ids(value.blockIds),
              consumedBlockIds: ids(value.consumedBlockIds),
              newlyCoveredMessages: count(value.newlyCoveredMessages),
              existingBlocks: count(value.existingBlocks),
              savings: isRecord(value.savings)
                ? compact({
                    before: count(value.savings.before),
                    after: count(value.savings.after),
                    saved: integer(value.savings.saved),
                    reductionPercent: finite(value.savings.reductionPercent),
                  })
                : undefined,
            }),
          ]
        })
      : undefined
  // A missing/corrupt ledger or one unknown active block makes the total unknown.
  const summariesKnown =
    raw !== undefined &&
    blocks.length === Object.keys(raw).length &&
    (messages?.activeBlockIds === undefined || active !== undefined) &&
    (active?.every((id) => blocks.some((block) => block.blockId === id && block.active)) ?? true) &&
    blocks.every(
      (block) =>
        block.active !== undefined &&
        (!block.active || active === undefined || active.includes(block.blockId)) &&
        (!block.active || block.summaryPruned || block.summaryTokens !== undefined),
    )
  const total = summariesKnown
    ? blocks.reduce((sum, block) => sum + (block.active && !block.summaryPruned ? (block.summaryTokens ?? 0) : 0), 0)
    : undefined
  return compact({
    sessionID,
    state: "available" as const,
    lastUpdated:
      typeof input.lastUpdated === "string" && Number.isFinite(Date.parse(input.lastUpdated))
        ? input.lastUpdated
        : undefined,
    blocks,
    stats: compact({
      activeSummaryTokens: count(total),
      historicalRemovedTokens: isRecord(input.stats) ? count(input.stats.totalPruneTokens) : undefined,
      prunedToolCount: isRecord(prune.tools) ? Object.keys(prune.tools).length : undefined,
      prunedMessageCount:
        messages && isRecord(messages.byMessageId) ? Object.keys(messages.byMessageId).length : undefined,
    }),
    operations: history,
  })
}

export const read = Effect.fn("SessionDcp.read")(function* (sessionID: SessionID, home = dataHome) {
  if (!idPattern.test(sessionID)) return { sessionID, state: "invalid" } as const
  // Node has no openat API. Linux's descriptor paths let each O_NOFOLLOW open
  // resolve relative to a pinned directory, including during rename/symlink races.
  // Fail closed on hosts without this facility rather than use a racy lstat check.
  if (process.platform !== "linux" || !path.isAbsolute(home)) return { sessionID, state: "unavailable" } as const
  return yield* Effect.scoped(
    Effect.gen(function* () {
      let directory = yield* openScoped("/", constants.O_RDONLY | constants.O_DIRECTORY)
      for (const name of path.join(home, "opencode/storage/plugin/dcp").split("/").filter(Boolean)) {
        directory = yield* openScoped(
          `/proc/self/fd/${directory.fd}/${name}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
      }
      const file = yield* openScoped(
        `/proc/self/fd/${directory.fd}/${sessionID}.json`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      const before = yield* io(() => file.stat())
      if (!before.isFile()) return { sessionID, state: "invalid" } as const
      if (before.size > maxBytes) return { sessionID, state: "too-large" } as const
      const buffer = Buffer.alloc(before.size)
      let length = 0
      while (length < buffer.length) {
        const result = yield* io(() => file.read(buffer, length, buffer.length - length, length))
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      const after = yield* io(() => file.stat())
      if (after.size > maxBytes) return { sessionID, state: "too-large" } as const
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || length !== before.size)
        return { sessionID, state: "invalid" } as const
      const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(buffer.toString("utf8"))
      return Option.isNone(parsed) ? ({ sessionID, state: "invalid" } as const) : project(sessionID, parsed.value)
    }),
  ).pipe(Effect.catch((state) => Effect.succeed({ sessionID, state })))
})

function io<A>(work: () => Promise<A>) {
  return Effect.tryPromise({
    try: work,
    catch: (error): "absent" | "invalid" | "unavailable" => {
      if (!isRecord(error)) return "unavailable"
      if (error.code === "ENOENT") return "absent"
      if (error.code === "ELOOP" || error.code === "ENOTDIR") return "invalid"
      return "unavailable"
    },
  })
}

function openScoped(file: string, flags: number) {
  return Effect.acquireRelease(
    io(() => open(file, flags)),
    (handle) => Effect.promise(() => handle.close()),
  )
}

function compact<T extends object>(value: T): T {
  Object.keys(value).forEach((key) => {
    if (Reflect.get(value, key) === undefined) Reflect.deleteProperty(value, key)
  })
  return value
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}
function bool(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}
function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined
}
function count(value: unknown) {
  const n = integer(value)
  return n !== undefined && n >= 0 ? n : undefined
}
function positive(value: unknown) {
  const n = count(value)
  return n !== undefined && n > 0 ? n : undefined
}
function ids(value: unknown) {
  return Array.isArray(value) && value.every((x): x is number => positive(x) !== undefined)
    ? [...new Set(value)]
    : undefined
}
function stringCount(value: unknown) {
  return Array.isArray(value) && value.every((x) => typeof x === "string") ? new Set(value).size : undefined
}
