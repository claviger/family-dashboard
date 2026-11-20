CREATE TABLE `todos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_user_id` integer NOT NULL,
	`backend` text DEFAULT 'internal' NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`due_date` text,
	`due_time` text,
	`completed_at` integer,
	`created_by_user_id` integer,
	`chore_occurrence_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "todos_due_time_needs_date" CHECK("todos"."due_time" is null or "todos"."due_date" is not null)
);
--> statement-breakpoint
CREATE INDEX `todos_owner_idx` ON `todos` (`owner_user_id`,`completed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `todos_chore_occurrence_unique` ON `todos` (`chore_occurrence_id`) WHERE deleted_at is null;--> statement-breakpoint
CREATE TABLE `user_prefs` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`todo_summary_view` text DEFAULT 'overdue_today_undated' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
