import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028141816_runtime_retirement_guards",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TRIGGER session_retired_insert BEFORE INSERT ON session
        WHEN EXISTS (SELECT 1 FROM runtime_retirement WHERE session_id IN (NEW.id, NEW.parent_id))
        BEGIN SELECT RAISE(ABORT, 'Session root is retired'); END`)
      yield* tx.run(`CREATE TRIGGER session_retired_reparent BEFORE UPDATE OF id, parent_id ON session
        WHEN (NEW.id IS NOT OLD.id OR NEW.parent_id IS NOT OLD.parent_id)
          AND EXISTS (SELECT 1 FROM runtime_retirement WHERE session_id IN (NEW.id, NEW.parent_id, OLD.id))
        BEGIN SELECT RAISE(ABORT, 'Session root is retired'); END`)
      // IGNORE preserves compare-and-set semantics (RETURNING no row), including recovery claims.
      for (const operation of ["INSERT", "UPDATE"]) {
        yield* tx.run(`CREATE TRIGGER runtime_retired_${operation.toLowerCase()} BEFORE ${operation} ON runtime_execution
          WHEN ${operation === "INSERT" ? "1" : "(NEW.desired_active = 1 OR NEW.session_id IS NOT OLD.session_id OR NEW.parent_session_id IS NOT OLD.parent_session_id)"}
          AND EXISTS (
            SELECT 1 FROM runtime_retirement WHERE session_id IN (
              NEW.session_id, NEW.parent_session_id${operation === "UPDATE" ? ", OLD.session_id" : ""}
            )
          )
          BEGIN SELECT RAISE(IGNORE); END`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
