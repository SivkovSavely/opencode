import { Database } from "bun:sqlite"
import { writeSync } from "node:fs"

// Intercept only this isolated child's real SQLite statements, never the test runner.
const wrapped = new WeakSet<object>()
for (const method of ["query", "prepare"] as const) {
  const original = Database.prototype[method]
  Object.defineProperty(Database.prototype, method, {
    value(this: Database, sql: string, ...args: unknown[]) {
      const statement = Reflect.apply(original, this, [sql, ...args])
      if (!/^\s*UPDATE\b/i.test(sql) || !/\bevent\b/i.test(sql) || wrapped.has(statement)) return statement
      wrapped.add(statement)
      const run = statement.run
      const db = this
      Object.defineProperty(statement, "run", {
        value(...bindings: unknown[]) {
          const result = Reflect.apply(run, statement, bindings)
          if (!db.inTransaction) throw new Error("UPDATE unexpectedly ran outside a transaction")
          writeSync(1, "killed-after-uncommitted-update\n")
          process.kill(process.pid, "SIGKILL")
          return result
        },
      })
      return statement
    },
  })
}

const { compressEvents } = await import("../../script/event-compress")
await compressEvents({ db: process.argv[2]!, mode: "write", offline: true, minFreeBytes: 0 })
throw new Error("Compression completed without exercising the crash point")
