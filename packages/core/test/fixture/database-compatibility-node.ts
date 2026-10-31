import { Effect, Layer } from "effect"
import { layer } from "../../src/database/sqlite.node"

await Effect.runPromise(Effect.scoped(Layer.build(layer({ filename: process.argv[2]! }))))
