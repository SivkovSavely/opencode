import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { TranscriptSearch } from "../src/session/transcript-search"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>, filename: string) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped))

describe("transcript search benchmark", () => {
  test("large historical corpus with lengthy tool outputs", async () => {
    if (process.env.OPENCODE_TRANSCRIPT_SEARCH_BENCH !== "1") return
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "transcript-search-benchmark.sqlite")

    const result = await run(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const db = database.db
        yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project', '/repo', '[]', 1, 1)`)
        yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('session', 'project', 'benchmark', '/repo', 'Benchmark corpus', '1', 1, 1)`)
        yield* db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
          INSERT INTO message (id, session_id, data, time_created, time_updated)
          SELECT printf('message-%05d', i), 'session', json_object('role', 'assistant', 'agent', 'benchmark-agent'), i, i FROM n`)
        yield* db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
          INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
          SELECT printf('text-%05d', i), printf('message-%05d', i), 'session',
            json_object('type', 'text', 'text', 'ordinary historical transcript entry ' || i), i, i FROM n`)
        yield* db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 128)
          INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
          SELECT printf('tool-%05d', i), printf('message-%05d', i), 'session',
            json_object('type', 'tool', 'tool', 'shell', 'state', json_object('status', 'completed',
              'output', replace(hex(zeroblob(32768)), '00', 'x') || 'benchmark-tail')),
            i, i FROM n`)

        const search = yield* TranscriptSearch.make
        const backfillStart = performance.now()
        let status = yield* search.advance()
        while (!status.ready) status = yield* search.advance()
        const backfillMilliseconds = performance.now() - backfillStart
        const searchStart = performance.now()
        const first = yield* search.search({ query: "benchmark-tail", categories: ["tool-output"], limit: 100 })
        const second = yield* search.search({
          query: "benchmark-tail",
          categories: ["tool-output"],
          limit: 100,
          cursor: first.nextCursor,
        })
        const searchMilliseconds = performance.now() - searchStart
        expect(first.hits).toHaveLength(100)
        expect(second.hits).toHaveLength(28)
        expect(Math.max(...first.hits.map((hit) => hit.excerpt.length))).toBeLessThan(256)
        return { backfillMilliseconds, searchMilliseconds }
      }),
      filename,
    )

    console.info(
      `Transcript search benchmark: 10,128 historical parts, 128 x 32KiB tool outputs; backfill=${result.backfillMilliseconds.toFixed(0)}ms, 128-hit search=${result.searchMilliseconds.toFixed(0)}ms`,
    )
  })
})
