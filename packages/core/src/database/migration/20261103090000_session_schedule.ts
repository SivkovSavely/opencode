import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261103090000_session_schedule",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE session_queue ADD COLUMN origin TEXT`)
      yield* tx.run(`CREATE TABLE session_schedule (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        input TEXT NOT NULL, anchor INTEGER NOT NULL, time_created INTEGER NOT NULL,
        status TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, next INTEGER
      )`)
      yield* tx.run(`CREATE INDEX session_schedule_due_idx ON session_schedule(status, next)`)
      yield* tx.run(`CREATE INDEX session_schedule_session_idx ON session_schedule(session_id)`)
      yield* tx.run(`CREATE TABLE session_schedule_occurrence (
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES session_schedule(id) ON DELETE CASCADE,
        scheduled INTEGER NOT NULL, processed INTEGER, state TEXT NOT NULL, message_id TEXT, error TEXT
      )`)
      yield* tx.run(
        `CREATE UNIQUE INDEX session_schedule_occurrence_time_idx ON session_schedule_occurrence(schedule_id, scheduled)`,
      )
      yield* tx.run(`CREATE INDEX session_schedule_occurrence_state_idx ON session_schedule_occurrence(state)`)
    })
  },
} satisfies DatabaseMigration.Migration
