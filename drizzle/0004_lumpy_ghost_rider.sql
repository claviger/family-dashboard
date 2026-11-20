CREATE TABLE `connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`owner_user_id` integer NOT NULL,
	`credentials_enc` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_success_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_user_kind_unique` ON `connections` (`kind`,`owner_user_id`) WHERE scope = 'user';--> statement-breakpoint
CREATE TABLE `pending_revocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`owner_user_id` integer NOT NULL,
	`credentials_enc` text NOT NULL,
	`account_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_attempt_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `todoist_state` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`todoist_user_id` text NOT NULL,
	`sync_token` text,
	`inbox_project_id` text,
	`chores_project_id` text,
	`chores_project_lost` text,
	`projects` text DEFAULT '{}' NOT NULL,
	`last_sync_at` integer,
	`last_full_sync_at` integer,
	`lookups_snapshot_at` integer,
	`pending_lookups` text DEFAULT '[]' NOT NULL,
	`uuid_seed` text NOT NULL,
	`create_attempts` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todoist_state_todoist_user_unique` ON `todoist_state` (`todoist_user_id`);--> statement-breakpoint
ALTER TABLE `chore_occurrences` ADD `todo_stuck_at` integer;--> statement-breakpoint
ALTER TABLE `chore_occurrences` ADD `todo_last_error` text;--> statement-breakpoint
ALTER TABLE `chore_todo_actions` ADD `stuck_at` integer;--> statement-breakpoint
ALTER TABLE `chore_todo_actions` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `todoist_task_id` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `todoist_account_id` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `todoist_project_id` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `todoist_recurring` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `todos` ADD `todoist_due_timezone` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `todoist_move_error` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `todoist_move_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `todos` ADD `todoist_move_replays` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `todos_todoist_task_unique` ON `todos` (`owner_user_id`,`todoist_task_id`) WHERE backend = 'todoist' and deleted_at is null;