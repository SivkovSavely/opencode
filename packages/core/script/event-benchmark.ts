// Run from packages/core: bun script/event-benchmark.ts
// Only newly created temporary databases are opened. Timings are microseconds.
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Layer, Schema } from "effect"
import { layer } from "#sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { Sqlite } from "../src/database/sqlite"
import { EventV2 } from "../src/event"
import { EventData } from "../src/event/data"

const rounds = Number(process.env.EVENT_BENCH_ROUNDS ?? 25)
const warmup = Number(process.env.EVENT_BENCH_WARMUP ?? 5)
if (!Number.isSafeInteger(rounds) || rounds < 1 || !Number.isSafeInteger(warmup) || warmup < 1)
  throw new Error("EVENT_BENCH_ROUNDS and EVENT_BENCH_WARMUP must be positive integers")

const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) }
}
const micros = (start: number) => (performance.now() - start) * 1000
const event = EventV2.define({
  type: "benchmark.payload",
  durable: { version: 1, aggregate: "sessionID" },
  schema: { sessionID: Schema.String, payload: Schema.String },
})

// Seeded synthetic data, not application payloads. Base64 has six bits per ASCII byte;
// random two-byte Unicode characters have ten bits per character, so neither is
// statistically incompressible. Diff-like lines combine repeated structure and
// varying identifiers, rather than repeating one identical line.
function payload(kind: string, bytes: number) {
  let seed = 0x9e3779b9
  const next = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  if (kind === "entropy-ascii") {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    return Array.from({ length: bytes }, () => alphabet[next() & 63]).join("")
  }
  if (kind === "entropy-utf8")
    return Array.from({ length: bytes / 2 }, () => String.fromCharCode(0x400 + (next() & 1023))).join("")
  const lines: string[] = []
  let length = 0
  while (length < bytes) {
    const line = `+ const value_${lines.length} = "${kind === "diff-utf8" ? "\u96ea-" : ""}updated field ${next() % 1000}";\n`
    lines.push(line)
    length += Buffer.byteLength(line)
  }
  return lines.join("")
}

const directory = await mkdtemp(join(tmpdir(), "opencode-event-bench-"))
try {
  console.log(
    JSON.stringify({ bun: Bun.version, rounds, warmup, units: "microseconds", wal: true, synchronous: "NORMAL" }),
  )
  for (const kind of ["diff-ascii", "entropy-ascii", "diff-utf8", "entropy-utf8"]) {
    for (const kib of [1, 4, 8, 16, 32, 256, 1024]) {
      const data = { sessionID: "benchmark", payload: payload(kind, kib * 1024) }
      const json = JSON.stringify(data)
      const encoded = EventData.encode(data)
      const stringify: number[] = []
      const encode: number[] = []
      for (let i = 0; i < rounds + warmup; i++) {
        let start = performance.now()
        JSON.stringify(data)
        const jsonTime = micros(start)
        start = performance.now()
        EventData.encode(data)
        const codecTime = micros(start)
        if (i >= warmup) {
          stringify.push(jsonTime)
          encode.push(codecTime)
        }
      }

      const filename = join(directory, `${kind}-${kib}.db`)
      const sqlite = layer({ filename })
      const dbLayer = Layer.effect(
        Database.Service,
        Effect.gen(function* () {
          const db = yield* EffectDrizzleSqlite.makeWithDefaults()
          yield* db.run("PRAGMA journal_mode = WAL")
          yield* db.run("PRAGMA synchronous = NORMAL")
          yield* db.run("PRAGMA busy_timeout = 5000")
          yield* db.run("PRAGMA cache_size = -64000")
          yield* db.run("PRAGMA foreign_keys = ON")
          yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
          yield* DatabaseMigration.apply(db)
          return { db }
        }).pipe(Effect.orDie),
      ).pipe(Layer.provideMerge(sqlite))
      const layers = EventV2.layerWith().pipe(Layer.provideMerge(dbLayer))
      const result: {
        normal: { total: number[]; lock: number[] }
        nested: { total: number[]; lock: number[] }
      } = { normal: { total: [], lock: [] }, nested: { total: [], lock: [] } }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const native = (yield* Sqlite.Drizzle).$client
            const db = (yield* Database.Service).db
            const events = yield* EventV2.Service
            const query = native.query.bind(native)
            let begin: number | undefined
            let duration: number | undefined
            let savepoints = 0
            // Instance-only instrumentation, installed after migrations. The adapter
            // invokes all/values on prepared transaction control statements.
            native.query = ((sql: string) => {
              const statement = query(sql)
              if (/^\s*savepoint\b/i.test(sql)) savepoints++
              const isBegin = /^\s*begin\s+immediate\b/i.test(sql)
              const isEnd = /^\s*(?:commit|end|rollback)(?!\s+to\b)\b/i.test(sql)
              if (!isBegin && !isEnd) return statement
              return new Proxy(statement, {
                get(target, property) {
                  const value = Reflect.get(target, property, target)
                  if (typeof value !== "function") return value
                  if (property !== "all" && property !== "values" && property !== "run") return value.bind(target)
                  return (...args: unknown[]) => {
                    const output = Reflect.apply(value, target, args)
                    if (isBegin) begin = performance.now()
                    if (isEnd && begin !== undefined) {
                      duration = micros(begin)
                      begin = undefined
                    }
                    return output
                  }
                },
              })
            }) as typeof native.query

            for (let i = 0; i < rounds + warmup; i++) {
              for (const mode of ["normal", "nested"] as const) {
                duration = undefined
                const before = savepoints
                const start = performance.now()
                const publish = events.publish(event, data)
                if (mode === "normal") yield* publish
                else yield* db.transaction(() => publish, { behavior: "immediate" }).pipe(Effect.orDie)
                const total = micros(start)
                if (duration === undefined || begin !== undefined)
                  throw new Error(`Missing transaction timing: ${mode}`)
                if (savepoints > before !== (mode === "nested"))
                  throw new Error(`Unexpected savepoint behavior: ${mode}`)
                if (i >= warmup) {
                  result[mode].total.push(total)
                  result[mode].lock.push(duration)
                }
              }
            }
          }).pipe(Effect.provide(layers)),
        ),
      )
      console.log(
        JSON.stringify({
          kind,
          kib,
          jsonBytes: Buffer.byteLength(json),
          encodedBytes: typeof encoded === "string" ? Buffer.byteLength(encoded) : encoded.byteLength,
          mode: typeof encoded === "string" ? "text" : "zstd",
          stringify: stats(stringify),
          encode: stats(encode),
          normal: { total: stats(result.normal.total), lock: stats(result.normal.lock) },
          nested: { total: stats(result.nested.total), lock: stats(result.nested.lock) },
        }),
      )
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
