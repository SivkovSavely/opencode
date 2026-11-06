import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261106021221_transcript_search",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`transcript_document\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`source\` text NOT NULL,
          \`part_id\` text,
          \`category\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`body\` text NOT NULL,
          \`truncated\` integer NOT NULL,
          \`tool_name\` text,
          \`tool_status\` text,
          CONSTRAINT \`fk_transcript_document_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`transcript_state\` (
          \`id\` integer PRIMARY KEY,
          \`cursor\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`ready\` integer NOT NULL,
          \`generation\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`transcript_document_message_idx\` ON \`transcript_document\` (\`message_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`transcript_document_time_idx\` ON \`transcript_document\` (\`time_created\`,\`message_id\`,\`id\`);`,
      )
    })
  },
}

export default migration
