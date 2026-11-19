import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115200739_session_handoff_retention",
  up(tx) {
    return Effect.gen(function* () {
      for (const [table, identity] of [
        [
          "session_handoff_action",
          "session_id = NEW.session_id AND queue_id = NEW.queue_id AND user_message_id = NEW.user_message_id",
        ],
        ["session_handoff_request", "request_id = NEW.request_id"],
        [
          "session_handoff_boundary",
          "(session_id = NEW.session_id AND queue_id = NEW.queue_id AND user_message_id = NEW.user_message_id AND sequence = NEW.sequence) OR request_id = NEW.request_id",
        ],
        ["session_handoff_assistant", "message_id = NEW.message_id OR position = NEW.position"],
      ]) {
        for (const operation of ["UPDATE", "DELETE"]) {
          yield* tx.run(`CREATE TRIGGER IF NOT EXISTS ${table}_retain_${operation.toLowerCase()}
            BEFORE ${operation} ON ${table} BEGIN
              SELECT RAISE(ABORT, 'immutable handoff evidence');
            END`)
        }
        // REPLACE only fires delete triggers when recursive_triggers is enabled.
        yield* tx.run(`CREATE TRIGGER IF NOT EXISTS ${table}_retain_replace
          BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${identity}) BEGIN
            SELECT RAISE(ABORT, 'immutable handoff evidence');
          END`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
