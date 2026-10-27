import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261026220129_session_bookmarks",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`bookmarked\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
