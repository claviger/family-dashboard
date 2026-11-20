ALTER TABLE `job_errors` ADD `first_occurred_at` integer;--> statement-breakpoint
-- Hand-added: keep only each job's latest error, so the unique index below can be created. The
-- kept row's own time is the best "first seen" there is for it.
DELETE FROM `job_errors` WHERE `id` NOT IN (SELECT MAX(`id`) FROM `job_errors` GROUP BY `job`);--> statement-breakpoint
UPDATE `job_errors` SET `first_occurred_at` = `occurred_at`;--> statement-breakpoint
CREATE UNIQUE INDEX `job_errors_job_unique` ON `job_errors` (`job`);
