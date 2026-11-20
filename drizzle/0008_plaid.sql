CREATE TABLE `plaid_link_pending` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`session_hash` text NOT NULL,
	`link_token` text NOT NULL,
	`mode` text NOT NULL,
	`plaid_item_id` integer,
	`add_accounts` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plaid_item_id`) REFERENCES `plaid_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `accounts` text;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `picked_at` integer;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `backoff_until` integer;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `new_accounts_at` integer;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `disconnect_at` text;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `transactions_status` text;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `last_sync_at` integer;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `full_resync_at` integer;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `removed_reason` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `replaced_by_id` integer;--> statement-breakpoint
CREATE INDEX `transactions_replaced_by_idx` ON `transactions` (`replaced_by_id`);