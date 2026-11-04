import { Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import path from "node:path"

const filename = process.argv[2]!
await Effect.runPromise(
  Layer.build(Database.layer({ path: filename })).pipe(
    Effect.provideService(Global.Service, Global.make({ data: path.dirname(filename) })),
    Effect.scoped,
  ),
)
