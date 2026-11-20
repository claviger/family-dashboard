CREATE TABLE `savings_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plaid_item_id` integer NOT NULL,
	`plaid_account_id` text NOT NULL,
	`nickname` text NOT NULL,
	`kind` text NOT NULL,
	`mask` text,
	`iso_currency_code` text,
	`hidden_at` integer,
	`removed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plaid_item_id`) REFERENCES `plaid_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `savings_accounts_plaid_account_unique` ON `savings_accounts` (`plaid_account_id`);--> statement-breakpoint
CREATE INDEX `savings_accounts_item_idx` ON `savings_accounts` (`plaid_item_id`);--> statement-breakpoint
CREATE TABLE `savings_balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`current_cents` integer NOT NULL,
	`available_cents` integer,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `savings_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `savings_balances_account_date_unique` ON `savings_balances` (`account_id`,`date`);--> statement-breakpoint
CREATE TABLE `savings_flows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`source` text NOT NULL,
	`plaid_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `savings_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "savings_flows_amount_positive" CHECK("savings_flows"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `savings_flows_source_plaid_unique` ON `savings_flows` (`source`,`plaid_id`);--> statement-breakpoint
CREATE INDEX `savings_flows_account_date_idx` ON `savings_flows` (`account_id`,`date`);--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `purpose` text DEFAULT 'spend' NOT NULL;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `investments_status` text;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `investments_error_code` text;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `investments_through` text;--> statement-breakpoint
ALTER TABLE `plaid_link_pending` ADD `purpose` text DEFAULT 'spend' NOT NULL;