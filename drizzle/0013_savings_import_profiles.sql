CREATE TABLE `savings_import_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`header` text NOT NULL,
	`format` text NOT NULL,
	`mapping` text NOT NULL,
	`choices` text NOT NULL,
	`updated_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `savings_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `savings_import_profiles_account_unique` ON `savings_import_profiles` (`account_id`);