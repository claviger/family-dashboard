PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chore_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chore_id` integer NOT NULL,
	`title_snapshot` text NOT NULL,
	`due_date` text,
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
	`todo_stuck_at` integer,
	`todo_last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chore_id`) REFERENCES `chores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credited_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chore_occurrences_closed_at" CHECK(("__new_chore_occurrences"."state" = 'open') = ("__new_chore_occurrences"."completed_at" is null))
);
--> statement-breakpoint
INSERT INTO `__new_chore_occurrences`("id", "chore_id", "title_snapshot", "due_date", "assignee_user_id", "assignment_source", "state", "completed_at", "actor_user_id", "credited_user_id", "todo_id", "todo_sync_status", "todo_attempts", "todo_retry_at", "todo_stuck_at", "todo_last_error", "created_at", "updated_at") SELECT "id", "chore_id", "title_snapshot", "due_date", "assignee_user_id", "assignment_source", "state", "completed_at", "actor_user_id", "credited_user_id", "todo_id", "todo_sync_status", "todo_attempts", "todo_retry_at", "todo_stuck_at", "todo_last_error", "created_at", "updated_at" FROM `chore_occurrences`;--> statement-breakpoint
-- Keep the AUTOINCREMENT counter through the rebuild, so a hard-deleted occurrence's id is never reused
-- (to-dos point at occurrences by id, with no foreign key). The copy only advanced it to max(id).
DELETE FROM `sqlite_sequence` WHERE `name` = '__new_chore_occurrences';--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT '__new_chore_occurrences', `seq` FROM `sqlite_sequence` WHERE `name` = 'chore_occurrences';--> statement-breakpoint
DROP TABLE `chore_occurrences`;--> statement-breakpoint
ALTER TABLE `__new_chore_occurrences` RENAME TO `chore_occurrences`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chore_occurrences_chore_due_unique` ON `chore_occurrences` (`chore_id`,`due_date`);--> statement-breakpoint
CREATE INDEX `chore_occurrences_state_idx` ON `chore_occurrences` (`state`,`due_date`);--> statement-breakpoint
CREATE INDEX `chore_occurrences_completed_idx` ON `chore_occurrences` (`completed_at`);--> statement-breakpoint
-- The chore board (docs/specs/2026-11-18-chore-board-design.md, "Data changes"): who has a chore lives on the chore now.
ALTER TABLE `chores` RENAME COLUMN `default_assignee_user_id` TO `assignee_user_id`;--> statement-breakpoint
-- Open occurrences that nobody had are deleted. They have no to-dos, and unassigned chores have no occurrences now.
DELETE FROM `chore_occurrences` WHERE `state` = 'open' AND `assignee_user_id` IS NULL;--> statement-breakpoint
-- A chore with an open occurrence belongs to whoever has that occurrence.
UPDATE `chores` SET `assignee_user_id` = (
  SELECT `o`.`assignee_user_id` FROM `chore_occurrences` `o`
  WHERE `o`.`chore_id` = `chores`.`id` AND `o`.`state` = 'open'
  ORDER BY `o`.`id` DESC LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM `chore_occurrences` `o` WHERE `o`.`chore_id` = `chores`.`id` AND `o`.`state` = 'open');--> statement-breakpoint
-- Otherwise the old default assignee carries over, except onto an archived chore (archiving clears
-- it) or to a deactivated person (their chores go back to the board).
UPDATE `chores` SET `assignee_user_id` = NULL
WHERE NOT EXISTS (SELECT 1 FROM `chore_occurrences` `o` WHERE `o`.`chore_id` = `chores`.`id` AND `o`.`state` = 'open')
  AND (`status` = 'archived' OR `assignee_user_id` IN (SELECT `id` FROM `users` WHERE `active` = 0));
