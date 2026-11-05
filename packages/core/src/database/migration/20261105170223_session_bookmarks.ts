import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261105170223_session_bookmarks",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`bookmarked\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`session_v2_bookmarked_idx\` ON \`session_v2\` (\`bookmarked\`,\`time_archived\`,\`parent_id\`,\`time_updated\`,\`id\`);`,
      )
    })
  },
}

export default migration
