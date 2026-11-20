CREATE TABLE `spend_import_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`header` text NOT NULL,
	`mapping` text NOT NULL,
	`updated_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spend_import_profiles_card_unique` ON `spend_import_profiles` (`card_id`);--> statement-breakpoint
ALTER TABLE `csv_import_previews` ADD `plan` text;--> statement-breakpoint
ALTER TABLE `csv_imports` ADD `format` text;