import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261027085712_transcript_search",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`transcript_search_state\` (
          \`id\` integer PRIMARY KEY,
          \`cursor\` text NOT NULL,
          \`ready\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`transcript_search\` (
          \`part_id\` text PRIMARY KEY,
          \`body\` text NOT NULL,
          \`truncated\` integer NOT NULL,
          CONSTRAINT \`fk_transcript_search_part_id_part_id_fk\` FOREIGN KEY (\`part_id\`) REFERENCES \`part\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
