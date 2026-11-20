CREATE TABLE `chore_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chore_id` integer NOT NULL,
	`title_snapshot` text NOT NULL,
	`due_date` text NOT NULL,
	`assignee_user_id` integer,
	`assignment_source` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`completed_at` integer,
	`actor_user_id` integer,
	`credited_user_id` integer,
	`todo_id` integer,
	`todo_sync_status` text NOT NULL,
	`todo_attempts` integer DEFAULT 0 NOT NULL,
	`todo_retry_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chore_id`) REFERENCES `chores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credited_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chore_occurrences_closed_at" CHECK(("chore_occurrences"."state" = 'open') = ("chore_occurrences"."completed_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chore_occurrences_chore_due_unique` ON `chore_occurrences` (`chore_id`,`due_date`);--> statement-breakpoint
CREATE INDEX `chore_occurrences_state_idx` ON `chore_occurrences` (`state`,`due_date`);--> statement-breakpoint
CREATE INDEX `chore_occurrences_completed_idx` ON `chore_occurrences` (`completed_at`);--> statement-breakpoint
CREATE TABLE `chore_todo_actions` (
	`todo_id` integer PRIMARY KEY NOT NULL,
	`owner_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`even_if_completed` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`default_assignee_user_id` integer,
	`schedule_type` text NOT NULL,
	`schedule` text NOT NULL,
	`start_date` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`default_assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
