import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { SessionHandoffStore } from "../../src/session/handoff-store"

const [filename, sessionID, queueID, userMessageID, requestID] = Bun.argv.slice(2)
if (!filename || !sessionID || !queueID || !userMessageID) throw new Error("Missing isolated database/action arguments")

const history = await Effect.runPromise(
  Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    if (requestID) return yield* SessionHandoffStore.receipt({ db }, sessionID, requestID)
    return yield* SessionHandoffStore.lookup({ db }, { sessionID, queueID, userMessageID })
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped),
)
console.log(JSON.stringify(history))
