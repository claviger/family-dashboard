ALTER TABLE `transactions` ADD `deleted_reason` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `duplicate_of_id` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `duplicate_carry` text;--> statement-breakpoint
CREATE INDEX `transactions_duplicate_of_idx` ON `transactions` (`duplicate_of_id`);