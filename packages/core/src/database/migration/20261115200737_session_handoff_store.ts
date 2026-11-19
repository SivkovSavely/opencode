import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115200737_session_handoff_store",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_handoff_action\` (
          \`session_id\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_handoff_action_pk\` PRIMARY KEY(\`session_id\`, \`queue_id\`, \`user_message_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_assistant\` (
          \`position\` integer PRIMARY KEY AUTOINCREMENT,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_handoff_assistant_session_id_queue_id_user_message_id_session_handoff_action_session_id_queue_id_user_message_id_fk\` FOREIGN KEY (\`session_id\`,\`queue_id\`,\`user_message_id\`) REFERENCES \`session_handoff_action\`(\`session_id\`,\`queue_id\`,\`user_message_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_boundary\` (
          \`session_id\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`request_id\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_handoff_boundary_pk\` PRIMARY KEY(\`session_id\`, \`queue_id\`, \`user_message_id\`, \`sequence\`),
          CONSTRAINT \`fk_session_handoff_boundary_request_id_session_handoff_request_request_id_fk\` FOREIGN KEY (\`request_id\`) REFERENCES \`session_handoff_request\`(\`request_id\`),
          CONSTRAINT \`fk_session_handoff_boundary_session_id_queue_id_user_message_id_session_handoff_action_session_id_queue_id_user_message_id_fk\` FOREIGN KEY (\`session_id\`,\`queue_id\`,\`user_message_id\`) REFERENCES \`session_handoff_action\`(\`session_id\`,\`queue_id\`,\`user_message_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_request\` (
          \`request_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`identity\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_handoff_request_session_id_queue_id_user_message_id_session_handoff_action_session_id_queue_id_user_message_id_fk\` FOREIGN KEY (\`session_id\`,\`queue_id\`,\`user_message_id\`) REFERENCES \`session_handoff_action\`(\`session_id\`,\`queue_id\`,\`user_message_id\`)
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_handoff_assistant_message_idx\` ON \`session_handoff_assistant\` (\`message_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_handoff_boundary_request_idx\` ON \`session_handoff_boundary\` (\`request_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
