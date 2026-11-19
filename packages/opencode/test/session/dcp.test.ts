import { describe, expect, test } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { mkdir, readFile, rename, rm, stat, symlink } from "node:fs/promises"
import path from "node:path"
import { SessionDcp } from "../../src/session/dcp"
import { SessionDcpV1 } from "@opencode-ai/schema/v1/session-dcp"
import { SessionID } from "../../src/session/schema"
import { tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const id = SessionID.make("ses_dcp_test")
const it = testEffect(NodeServices.layer)
const snapshot = (data: unknown) => SessionDcp.project(id, data)

describe("DCP snapshot projection", () => {
  test("distinguishes saved statuses and projects only public fields", () => {
    const view = snapshot({
      prune: {
        tools: { secret: 1 },
        messages: {
          blocksById: {
            1: { active: true, summaryTokens: 10, summary: "<script>alert(1)</script>", directMessageIds: ["a", "b"] },
            2: { active: true, summaryPruned: true, summaryTokens: 99 },
            3: { active: false, deactivatedByBlockId: 5, parentBlockIds: [5] },
            4: { active: false, deactivatedByBlockId: 5, parentBlockIds: [5] },
            5: { active: true, summaryTokens: 20, includedBlockIds: [3, 7], consumedBlockIds: [3, 4, 7] },
            6: { active: false, deactivatedByUser: true, parentBlockIds: [5] },
            7: { active: false, parentBlockIds: [5], summaryPruned: true },
          },
        },
      },
      stats: { totalPruneTokens: 500 },
      lastUpdated: "2026-11-19T12:00:00.000Z",
      toolParameters: { secret: "must not leak" },
    })
    expect(view.state).toBe("available")
    if (view.state !== "available") throw new Error("Expected available snapshot")
    expect(view.blocks.map((block) => [block.blockId, block.status])).toEqual([
      [1, "active"],
      [2, "pruned"],
      [3, "nested"],
      [4, "superseded"],
      [5, "active"],
      [6, "user-decompressed"],
      [7, "nested"],
    ])
    expect(view.stats).toEqual({ activeSummaryTokens: 30, historicalRemovedTokens: 500, prunedToolCount: 1 })
    expect(view.blocks[0]).toMatchObject({ summary: "<script>alert(1)</script>", directMessageCount: 2 })
    expect(view.blocks[0]).not.toHaveProperty("directMessageIds")
    expect(view).not.toHaveProperty("toolParameters")
    expect(view).not.toHaveProperty("prune")
    expect(view.lastUpdated).toBe("2026-11-19T12:00:00.000Z")
    expect(Schema.decodeUnknownSync(SessionDcpV1.Snapshot)(view)).toEqual(view)
  })

  test("does not invent missing legacy metrics or operation history", () => {
    const legacy = snapshot({ prune: { tools: {} }, stats: {} })
    expect(legacy).toEqual({ sessionID: id, state: "available", blocks: [], stats: { prunedToolCount: 0 } })
    const incomplete = snapshot({ prune: { messages: { blocksById: { 1: { active: true } } } } })
    expect(incomplete.state).toBe("available")
    if (incomplete.state !== "available") throw new Error("Expected available snapshot")
    expect(incomplete.stats.activeSummaryTokens).toBeUndefined()
    expect(incomplete.blocks[0].summaryTokens).toBeUndefined()
  })

  test("preserves recorded signed estimates without inventing recovery savings", () => {
    const view = snapshot({
      prune: { messages: { blocksById: {} } },
      operations: {
        history: [
          {
            id: 1,
            type: "recompress",
            timestamp: 123,
            blockIds: [2],
            newlyCoveredMessages: 0,
            existingBlocks: 1,
            savings: { before: 10, after: 14, saved: -4, reductionPercent: -40 },
          },
          { id: 2, type: "user-decompress", timestamp: 124, blockIds: [2], existingBlocks: 1 },
          { id: 3, type: "future-operation", blockIds: [2], savings: { before: 0, after: 0, saved: 0 } },
        ],
      },
    })
    expect(view.state).toBe("available")
    if (view.state !== "available") throw new Error("Expected available snapshot")
    expect(view.stats.activeSummaryTokens).toBe(0)
    expect(view.operations).toEqual([
      {
        id: 1,
        type: "recompress",
        timestamp: 123,
        blockIds: [2],
        newlyCoveredMessages: 0,
        existingBlocks: 1,
        savings: { before: 10, after: 14, saved: -4, reductionPercent: -40 },
      },
      { id: 2, type: "user-decompress", timestamp: 124, blockIds: [2], existingBlocks: 1 },
      { id: 3, type: "future-operation", blockIds: [2], savings: { before: 0, after: 0, saved: 0 } },
    ])
  })

  test("does not classify replacement ancestry as nesting or an incomplete active ledger as zero", () => {
    const view = snapshot({
      prune: {
        messages: {
          activeBlockIds: [5, 99],
          blocksById: {
            1: { active: false, parentBlockIds: [5] },
            5: { active: true, summaryTokens: 10, includedBlockIds: [], consumedBlockIds: [1] },
          },
        },
      },
    })
    if (view.state !== "available") throw new Error("Expected available snapshot")
    expect(view.blocks[0].status).toBe("superseded")
    expect(view.stats.activeSummaryTokens).toBeUndefined()
  })

  test("drops corrupt fields without coercion and rejects invalid roots", () => {
    for (const value of [null, [], {}, { prune: [] }, { prune: { messages: "bad" } }]) {
      expect(snapshot(value)).toEqual({ sessionID: id, state: "invalid" })
    }
    const view = snapshot({
      prune: {
        messages: {
          blocksById: {
            1: { active: true, summaryTokens: "12", summary: {}, createdAt: -1 },
            "../../secret": { active: true },
            2: null,
          },
        },
      },
      stats: { totalPruneTokens: -5 },
      operations: { history: [null, { id: "1", type: 2 }] },
    })
    expect(view.state).toBe("available")
    if (view.state !== "available") throw new Error("Expected available snapshot")
    expect(view.blocks).toEqual([{ blockId: 1, active: true, status: "active" }])
    expect(view.stats).toEqual({})
    expect(view.operations).toEqual([])
  })
})

describe("DCP snapshot reads", () => {
  it.live("uses the DCP XDG storage suffix without creating or updating files", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const file = path.join(home, "opencode/storage/plugin/dcp", `${id}.json`)
      yield* Effect.promise(() => mkdir(path.dirname(file), { recursive: true }))
      const text = JSON.stringify({ prune: {}, stats: { totalPruneTokens: 7 } })
      yield* Effect.promise(() => Bun.write(file, text))
      const before = yield* Effect.promise(() => stat(file))
      const out = yield* SessionDcp.read(id, home)
      expect(out).toMatchObject({ state: "available", stats: { historicalRemovedTokens: 7 } })
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe(text)
      expect((yield* Effect.promise(() => stat(file))).mtimeMs).toBe(before.mtimeMs)
      expect(yield* SessionDcp.read(SessionID.make("ses_other"), home)).toEqual({
        sessionID: SessionID.make("ses_other"),
        state: "absent",
      })
    }),
  )

  it.live("distinguishes absent, malformed, non-regular, and oversized snapshots", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const file = path.join(home, "opencode/storage/plugin/dcp", `${id}.json`)
      expect(yield* SessionDcp.read(id, home)).toEqual({ sessionID: id, state: "absent" })
      yield* Effect.promise(() => mkdir(path.dirname(file), { recursive: true }))
      for (const text of ["{", "null", "[]", JSON.stringify({ prune: null }), '{"prune":{}}\u0000']) {
        yield* Effect.promise(() => Bun.write(file, text))
        expect(yield* SessionDcp.read(id, home)).toEqual({ sessionID: id, state: "invalid" })
      }
      yield* Effect.promise(() => Bun.write(file, " ".repeat(8 * 1024 * 1024 + 1)))
      expect(yield* SessionDcp.read(id, home)).toEqual({ sessionID: id, state: "too-large" })
      yield* Effect.promise(() => rm(file))
      yield* Effect.promise(() => mkdir(file))
      expect(yield* SessionDcp.read(id, home)).toEqual({ sessionID: id, state: "invalid" })
    }),
  )

  it.live("accepts the exact size limit and projects away unrelated large fields", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const file = path.join(home, "opencode/storage/plugin/dcp", `${id}.json`)
      yield* Effect.promise(() => mkdir(path.dirname(file), { recursive: true }))
      const prefix = '{"prune":{},"padding":"'
      yield* Effect.promise(() => Bun.write(file, prefix + " ".repeat(8 * 1024 * 1024 - prefix.length - 2) + '"}'))
      expect(yield* SessionDcp.read(id, home)).toEqual({ sessionID: id, state: "available", blocks: [], stats: {} })
    }),
  )

  it.live("cannot escape through a parent swapped for a symlink during reads", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      const root = path.join(home, "opencode/storage/plugin/dcp")
      yield* Effect.promise(() => mkdir(root, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(path.join(root, `${id}.json`), '{"prune":{},"stats":{"totalPruneTokens":7}}'),
      )
      yield* Effect.promise(() =>
        Bun.write(path.join(outside, `${id}.json`), '{"prune":{},"stats":{"totalPruneTokens":999}}'),
      )
      yield* Effect.all(
        [
          Effect.promise(async () => {
            for (let index = 0; index < 40; index++) {
              await rename(root, `${root}-pinned`)
              await symlink(outside, root)
              await rm(root)
              await rename(`${root}-pinned`, root)
            }
          }),
          Effect.gen(function* () {
            for (let index = 0; index < 40; index++) {
              const value = yield* SessionDcp.read(id, home)
              if (value.state === "available") expect(value.stats.historicalRemovedTokens).toBe(7)
              else expect(["absent", "invalid"]).toContain(value.state)
            }
          }),
        ],
        { concurrency: "unbounded" },
      )
      expect(yield* SessionDcp.read(id, home)).toMatchObject({
        state: "available",
        stats: { historicalRemovedTokens: 7 },
      })
    }),
  )

  it.live("never follows a snapshot or parent symlink", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const source = yield* tmpdirScoped()
      const root = path.join(home, "opencode/storage/plugin/dcp")
      yield* Effect.promise(() => mkdir(root, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(source, `${id}.json`), '{"prune":{}}'))
      yield* Effect.promise(() => symlink(path.join(source, `${id}.json`), path.join(root, `${id}.json`)))
      expect(yield* SessionDcp.read(id, home)).toEqual({ sessionID: id, state: "invalid" })
      yield* Effect.promise(() => rename(root, `${root}-original`))
      yield* Effect.promise(() => symlink(source, root))
      expect(yield* SessionDcp.read(id, home)).toEqual({ sessionID: id, state: "invalid" })
    }),
  )

  test("rejects traversal IDs before accessing the filesystem", async () => {
    await using home = await tmpdir()
    for (const value of ["ses_../escape", "ses_\\escape", "ses_a\u0000", "ses_" + "x".repeat(129)]) {
      expect(await Effect.runPromise(SessionDcp.read(SessionID.make(value), home.path))).toEqual({
        sessionID: SessionID.make(value),
        state: "invalid",
      })
    }
  })
})
