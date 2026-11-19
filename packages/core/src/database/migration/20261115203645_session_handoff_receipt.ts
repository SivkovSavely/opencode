import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115203645_session_handoff_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_handoff_receipt\` (
          \`request_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_handoff_receipt_pk\` PRIMARY KEY(\`request_id\`, \`revision\`),
          CONSTRAINT \`fk_session_handoff_receipt_request_id_session_handoff_request_request_id_fk\` FOREIGN KEY (\`request_id\`) REFERENCES \`session_handoff_request\`(\`request_id\`)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
