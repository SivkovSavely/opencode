import { Context, Effect } from "effect"
import { applyEffectWrapper } from "drizzle-orm/effect-core/query-effect"

export const sqliteExecutionEnabled =
  process.platform !== "win32" && process.env.OPENCODE_SQLITE_EXECUTION_DIAGNOSTICS === "1"

export const SqlOrigin = Context.Reference<readonly string[]>("@opencode-ai/effect-drizzle-sqlite/SqlOrigin", {
  defaultValue: () => [],
})

export function sqlSourceLocations(stack?: string) {
  return (stack ?? "")
    .split("\n")
    .flatMap((line) => {
      const match = line.match(
        /(?:[\\/](packages[\\/](?:core|opencode)[\\/][\w./\\-]{1,160}\.[cm]?[jt]sx?|dist\/node\/node\.js|out\/main\/(?:sidecar\.js|chunks\/[\w-]{1,100}\.js))|(?:\/\$bunfs\/root\/|~BUN\/root\/)([\w./-]{1,160})):(\d{1,9}:\d{1,9})\)?$/,
      )
      return match ? [`${match[1] ?? match[2]}:${match[3]}`.replaceAll("\\", "/")] : []
    })
    .slice(0, 4)
}

export function captureSqlOrigin() {
  if (sqliteExecutionEnabled) {
    try {
      const error = new Error()
      Error.captureStackTrace(error, captureSqlOrigin)
      return sqlSourceLocations(error.stack)
    } catch {
      // A custom stack formatter must not affect SQL.
    }
  }
  return undefined
}

export function withSqlOrigin<A, E, R>(effect: Effect.Effect<A, E, R>, locations: string[] | undefined) {
  if (!locations?.length) return effect
  // Keep the outer submission site when lazy preparation supplies a second one.
  return Effect.withFiber<A, E, R>((fiber) =>
    fiber.getRef(SqlOrigin).length ? effect : Effect.provideService(effect, SqlOrigin, locations),
  )
}

export function applySqlEffectWrapper(query: { prototype: object }) {
  applyEffectWrapper(query)
  if (!sqliteExecutionEnabled) return
  const iterate: Effect.Effect<unknown, unknown, unknown>[typeof Symbol.iterator] = Reflect.get(
    query.prototype,
    Symbol.iterator,
  )
  Object.assign(query.prototype, {
    [Symbol.iterator](this: Effect.Effect<unknown, unknown, unknown>) {
      // Capture yield* before the interpreter resumes the query on a different stack.
      return iterate.call(withSqlOrigin(this, captureSqlOrigin()))
    },
  })
}
