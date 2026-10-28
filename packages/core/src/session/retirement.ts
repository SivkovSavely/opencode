export * as SessionRetirement from "./retirement"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { SessionSchema } from "./schema"

// Serialize the boundary check with the retirement transaction, without holding a DB lock over external work.
export const isRetired = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  db.transaction(
    (tx) => tx.get(sql`SELECT session_id FROM runtime_retirement WHERE session_id = ${sessionID}`),
    { behavior: "immediate" },
  ).pipe(Effect.orDie, Effect.map((row) => row !== undefined))

export const guard = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  isRetired(db, sessionID).pipe(Effect.flatMap((retired) => (retired ? Effect.interrupt : Effect.void)))
