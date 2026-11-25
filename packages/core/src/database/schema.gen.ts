import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`historical_fence_evidence\` (
          \`root_session_id\` text PRIMARY KEY,
          \`evidence_hash\` text NOT NULL UNIQUE,
          \`payload\` text NOT NULL,
          \`observed_payload\` text NOT NULL,
          \`signer\` text NOT NULL,
          \`signature\` text NOT NULL,
          \`issuer\` text NOT NULL,
          \`nonce\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`historical_fence_identity\` (
          \`singleton\` integer PRIMARY KEY,
          \`database_id\` text NOT NULL UNIQUE,
          CONSTRAINT "historical_fence_identity_singleton" CHECK("singleton" = 1)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`historical_fence_prune\` (
          \`root_session_id\` text PRIMARY KEY,
          \`payload\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`managed_command_coverage\` (
          \`root_session_id\` text PRIMARY KEY,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`managed_command\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`root_session_id\` text NOT NULL,
          \`owner_instance\` text NOT NULL,
          \`execution_generation\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`managed_session_member\` (
          \`session_id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`root_session_id\` text NOT NULL,
          \`owner_instance\` text NOT NULL,
          \`parent_fence\` integer NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`permission_policy\` text DEFAULT '[]' NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`runtime_execution\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`owner_lineage\` text NOT NULL,
          \`owner_instance\` text NOT NULL,
          \`owner_host\` text,
          \`owner_machine_id\` text,
          \`owner_boot_id\` text,
          \`owner_pid_namespace\` text,
          \`owner_pid\` integer,
          \`owner_start_time\` text,
          \`fence\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`desired_active\` integer NOT NULL,
          \`retry_at\` integer,
          \`parent_session_id\` text,
          \`parent_message_id\` text,
          \`parent_call_id\` text,
          \`parent_mode\` text,
          \`parent_notification_state\` text,
          \`recovery_attempts\` integer DEFAULT 0 NOT NULL,
          \`recovery_preparation_attempts\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_runtime_execution_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`runtime_retirement_member\` (
          \`root_session_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          CONSTRAINT \`runtime_retirement_member_pk\` PRIMARY KEY(\`root_session_id\`, \`session_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`runtime_retirement\` (
          \`session_id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_control_request\` (
          \`id\` text PRIMARY KEY,
          \`owner_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`submission\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`scopes\` text NOT NULL,
          \`agent\` text,
          \`auto\` integer NOT NULL,
          \`cancellation\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_control_request_owner_id_session_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_control_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_cooperative_pause\` (
          \`session_id\` text PRIMARY KEY,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`state\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_attempt\` (
          \`position\` integer PRIMARY KEY AUTOINCREMENT,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`data\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_compaction\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`reservation\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`parent_user_message_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`epoch_sequence\` integer NOT NULL,
          \`data\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_context\` (
          \`identity\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`retired_reason\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_control\` (
          \`session_id\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`reservation\` text NOT NULL,
          \`state\` text NOT NULL,
          \`pending_request_id\` text,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_handoff_control_pk\` PRIMARY KEY(\`session_id\`, \`queue_id\`, \`user_message_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_notification\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`reservation\` text,
          \`classification\` text NOT NULL,
          \`user_message_id\` text,
          \`after_message_id\` text,
          \`data\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_recovery_queue_block\` (
          \`session_id\` text NOT NULL,
          \`recovery_request_id\` text NOT NULL,
          \`root_session_id\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`reservation\` text NOT NULL,
          \`recovery_revision\` integer NOT NULL,
          \`owner_lineage\` text NOT NULL,
          \`owner_instance\` text NOT NULL,
          \`recovery_fence\` integer NOT NULL,
          \`queue_revision\` integer NOT NULL,
          \`input_proof\` text NOT NULL,
          \`state\` text NOT NULL,
          \`reason\` text,
          \`internal_user_id\` text,
          CONSTRAINT \`session_handoff_recovery_queue_block_pk\` PRIMARY KEY(\`session_id\`, \`recovery_request_id\`),
          CONSTRAINT \`fk_session_handoff_recovery_queue_block_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_handoff_recovery_queue_block_recovery_request_id_session_handoff_request_request_id_fk\` FOREIGN KEY (\`recovery_request_id\`) REFERENCES \`session_handoff_request\`(\`request_id\`),
          CONSTRAINT \`fk_session_handoff_recovery_queue_block_root_session_id_queue_id_user_message_id_session_handoff_action_session_id_queue_id_user_message_id_fk\` FOREIGN KEY (\`root_session_id\`,\`queue_id\`,\`user_message_id\`) REFERENCES \`session_handoff_action\`(\`session_id\`,\`queue_id\`,\`user_message_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_recovery_child\` (
          \`session_id\` text PRIMARY KEY,
          \`recovery_revision\` integer DEFAULT 0 NOT NULL,
          \`link\` text NOT NULL,
          \`input_digest\` text NOT NULL,
          \`prior_fence\` integer NOT NULL,
          \`recovery_fence\` integer NOT NULL,
          CONSTRAINT \`fk_session_handoff_recovery_child_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_recovery_history\` (
          \`session_id\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_handoff_recovery_history_pk\` PRIMARY KEY(\`session_id\`, \`queue_id\`, \`user_message_id\`, \`revision\`),
          CONSTRAINT \`fk_session_handoff_recovery_history_session_id_queue_id_user_message_id_session_handoff_action_session_id_queue_id_user_message_id_fk\` FOREIGN KEY (\`session_id\`,\`queue_id\`,\`user_message_id\`) REFERENCES \`session_handoff_action\`(\`session_id\`,\`queue_id\`,\`user_message_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_recovery_hold\` (
          \`root_session_id\` text NOT NULL,
          \`reservation\` text NOT NULL,
          \`session_id\` text NOT NULL,
          CONSTRAINT \`session_handoff_recovery_hold_pk\` PRIMARY KEY(\`root_session_id\`, \`reservation\`, \`session_id\`),
          CONSTRAINT \`fk_session_handoff_recovery_hold_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_handoff_root\` (
          \`session_id\` text NOT NULL,
          \`reservation\` text NOT NULL,
          \`state\` text NOT NULL,
          \`queue_id\` text,
          \`user_message_id\` text,
          \`source\` text,
          \`enrolled_request_id\` text,
          CONSTRAINT \`session_handoff_root_pk\` PRIMARY KEY(\`session_id\`, \`reservation\`),
          CONSTRAINT \`fk_session_handoff_root_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
        CREATE TABLE \`session_handoff_receipt\` (
          \`request_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_handoff_receipt_pk\` PRIMARY KEY(\`request_id\`, \`revision\`),
          CONSTRAINT \`fk_session_handoff_receipt_request_id_session_handoff_request_request_id_fk\` FOREIGN KEY (\`request_id\`) REFERENCES \`session_handoff_request\`(\`request_id\`)
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
      yield* tx.run(`
        CREATE TABLE \`session_queue_import\` (
          \`session_id\` text PRIMARY KEY,
          \`hidden\` text NOT NULL,
          CONSTRAINT \`fk_session_queue_import_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_queue_state\` (
          \`session_id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`paused\` integer DEFAULT false NOT NULL,
          \`blocked\` integer DEFAULT false NOT NULL,
          CONSTRAINT \`fk_session_queue_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_queue\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`state\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`payload\` text NOT NULL,
          \`submission\` text NOT NULL,
          \`origin\` text,
          \`message_id\` text,
          \`owner\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_queue_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_schedule_occurrence\` (
          \`id\` text PRIMARY KEY,
          \`schedule_id\` text NOT NULL,
          \`scheduled\` integer NOT NULL,
          \`processed\` integer,
          \`state\` text NOT NULL,
          \`message_id\` text,
          \`error\` text,
          CONSTRAINT \`fk_session_schedule_occurrence_schedule_id_session_schedule_id_fk\` FOREIGN KEY (\`schedule_id\`) REFERENCES \`session_schedule\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_schedule\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`input\` text NOT NULL,
          \`anchor\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`definition_order\` integer DEFAULT 0 NOT NULL,
          \`status\` text NOT NULL,
          \`completed\` integer DEFAULT 0 NOT NULL,
          \`next\` integer,
          CONSTRAINT \`fk_session_schedule_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`session_watch_delivery\` (
          \`id\` text PRIMARY KEY,
          \`watch_id\` text NOT NULL,
          \`event_id\` text NOT NULL,
          \`execution_id\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`destination_id\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`state\` text NOT NULL,
          \`queue_id\` text NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_watch_delivery_watch_id_session_watch_id_fk\` FOREIGN KEY (\`watch_id\`) REFERENCES \`session_watch\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_watch_delivery_destination_id_session_id_fk\` FOREIGN KEY (\`destination_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_watch_event\` (
          \`id\` text PRIMARY KEY,
          \`execution_id\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`outcome\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_watch_event_execution_id_session_watch_execution_id_fk\` FOREIGN KEY (\`execution_id\`) REFERENCES \`session_watch_execution\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_watch_execution\` (
          \`sequence\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL UNIQUE,
          \`session_id\` text NOT NULL,
          \`owner_lineage\` text NOT NULL,
          \`owner_instance\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`result\` text,
          \`message_id\` text,
          \`summary\` text DEFAULT '' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_watch_execution_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_watch\` (
          \`id\` text PRIMARY KEY,
          \`owner_id\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`destination_id\` text NOT NULL,
          \`scopes\` text NOT NULL,
          \`submission\` text NOT NULL,
          \`events\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`status\` text NOT NULL,
          \`execution_id\` text,
          \`after_sequence\` integer NOT NULL,
          \`accepted\` integer DEFAULT 0 NOT NULL,
          \`maximum\` integer NOT NULL,
          \`agent\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_watch_owner_id_session_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_watch_source_id_session_id_fk\` FOREIGN KEY (\`source_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_watch_destination_id_session_id_fk\` FOREIGN KEY (\`destination_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`bookmarked\` integer DEFAULT false NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`historical_fence_nonce_idx\` ON \`historical_fence_evidence\` (\`signer\`,\`nonce\`);`,
      )
      yield* tx.run(`CREATE INDEX \`managed_command_root_idx\` ON \`managed_command\` (\`root_session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`managed_session_member_root_idx\` ON \`managed_session_member\` (\`root_session_id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`runtime_execution_session_idx\` ON \`runtime_execution\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`runtime_execution_owner_state_idx\` ON \`runtime_execution\` (\`owner_lineage\`,\`state\`);`,
      )
      yield* tx.run(`CREATE INDEX \`runtime_execution_parent_idx\` ON \`runtime_execution\` (\`parent_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`runtime_retirement_root_idx\` ON \`runtime_retirement\` (\`root_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_control_request_owner_idx\` ON \`session_control_request\` (\`owner_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_handoff_attempt_message_idx\` ON \`session_handoff_attempt\` (\`message_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_handoff_notification_action_idx\` ON \`session_handoff_notification\` (\`session_id\`,\`reservation\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_handoff_recovery_queue_owned_idx\` ON \`session_handoff_recovery_queue_block\` (\`session_id\`) WHERE "session_handoff_recovery_queue_block"."state"='owned';`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_handoff_recovery_hold_session_idx\` ON \`session_handoff_recovery_hold\` (\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_handoff_root_session_idx\` ON \`session_handoff_root\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_handoff_assistant_message_idx\` ON \`session_handoff_assistant\` (\`message_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_handoff_boundary_request_idx\` ON \`session_handoff_boundary\` (\`request_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_queue_session_state_delivery_position_idx\` ON \`session_queue\` (\`session_id\`,\`state\`,\`delivery\`,\`position\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_schedule_occurrence_time_idx\` ON \`session_schedule_occurrence\` (\`schedule_id\`,\`scheduled\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_schedule_occurrence_state_idx\` ON \`session_schedule_occurrence\` (\`state\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_schedule_due_idx\` ON \`session_schedule\` (\`status\`,\`next\`);`)
      yield* tx.run(`CREATE INDEX \`session_schedule_session_idx\` ON \`session_schedule\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_watch_delivery_event_idx\` ON \`session_watch_delivery\` (\`watch_id\`,\`event_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_watch_delivery_pending_idx\` ON \`session_watch_delivery\` (\`state\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_watch_execution_session_idx\` ON \`session_watch_execution\` (\`session_id\`,\`sequence\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_watch_source_status_idx\` ON \`session_watch\` (\`source_id\`,\`status\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
