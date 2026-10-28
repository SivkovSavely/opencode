import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { Database } from "../../src/database/database"
import { ManagedCommand } from "../../src/managed-command"

const filename = process.argv[2]!
const ready = process.argv[3]!
const opened = process.argv[4]!
await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const permit = yield* ManagedCommand.admit(database, "root", "worker")
    writeFileSync(ready, JSON.stringify(permit))
    yield* Effect.promise(() => Bun.stdin.text())
    const authorized = yield* ManagedCommand.authorize(database, permit, () => writeFileSync(opened, "opened"))
    console.log(JSON.stringify({ authorized }))
  }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
)
