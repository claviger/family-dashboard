-- Savings CSV import and hand-added accounts (docs/specs/2026-11-20-savings-csv-import-design.md, "Data changes").
-- savings_accounts is rebuilt so plaid_item_id and plaid_account_id can be null. Drizzle runs every
-- migration inside one transaction, where PRAGMA foreign_keys can't be turned off, so dropping the old
-- savings_accounts would cascade-delete every balance and flow. So its two child tables are rebuilt
-- too, pointing at the new accounts table, and the old tables are dropped children first. Each rebuilt
-- table keeps its AUTOINCREMENT counter (sqlite_sequence), as 0009 does.
CREATE TABLE `__new_savings_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text DEFAULT 'plaid' NOT NULL,
	`plaid_item_id` integer,
	`plaid_account_id` text,
	`nickname` text NOT NULL,
	`kind` text NOT NULL,
	`mask` text,
	`iso_currency_code` text,
	`hidden_at` integer,
	`removed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plaid_item_id`) REFERENCES `plaid_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "savings_accounts_source_link" CHECK((`source` = 'plaid') = (`plaid_item_id` IS NOT NULL AND `plaid_account_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_savings_accounts`("id", "source", "plaid_item_id", "plaid_account_id", "nickname", "kind", "mask", "iso_currency_code", "hidden_at", "removed_at", "created_at", "updated_at") SELECT "id", 'plaid', "plaid_item_id", "plaid_account_id", "nickname", "kind", "mask", "iso_currency_code", "hidden_at", "removed_at", "created_at", "updated_at" FROM `savings_accounts`;--> statement-breakpoint
DELETE FROM `sqlite_sequence` WHERE `name` = '__new_savings_accounts';--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT '__new_savings_accounts', `seq` FROM `sqlite_sequence` WHERE `name` = 'savings_accounts';--> statement-breakpoint
CREATE TABLE `savings_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`file_name` text,
	`file_sha256` text NOT NULL,
	`layout` text NOT NULL,
	`uploaded_by_user_id` integer NOT NULL,
	`uploaded_at` integer NOT NULL,
	`deposits_added` integer NOT NULL,
	`withdrawals_added` integer NOT NULL,
	`balances_added` integer NOT NULL,
	`skipped` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `__new_savings_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `__new_savings_balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`current_cents` integer NOT NULL,
	`available_cents` integer,
	`fetched_at` integer NOT NULL,
	`source` text DEFAULT 'plaid' NOT NULL,
	`import_id` integer,
	FOREIGN KEY (`account_id`) REFERENCES `__new_savings_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `savings_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "savings_balances_import" CHECK((`source` = 'csv') = (`import_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_savings_balances`("id", "account_id", "date", "current_cents", "available_cents", "fetched_at", "source", "import_id") SELECT "id", "account_id", "date", "current_cents", "available_cents", "fetched_at", 'plaid', NULL FROM `savings_balances`;--> statement-breakpoint
DELETE FROM `sqlite_sequence` WHERE `name` = '__new_savings_balances';--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT '__new_savings_balances', `seq` FROM `sqlite_sequence` WHERE `name` = 'savings_balances';--> statement-breakpoint
CREATE TABLE `__new_savings_flows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`source` text NOT NULL,
	`plaid_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`kind` text NOT NULL,
	`import_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `__new_savings_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `savings_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "savings_flows_amount_positive" CHECK(`amount_cents` > 0),
	CONSTRAINT "savings_flows_import" CHECK((`source` = 'csv') = (`import_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_savings_flows`("id", "account_id", "source", "plaid_id", "date", "amount_cents", "kind", "import_id", "created_at", "updated_at") SELECT "id", "account_id", "source", "plaid_id", "date", "amount_cents", "kind", NULL, "created_at", "updated_at" FROM `savings_flows`;--> statement-breakpoint
DELETE FROM `sqlite_sequence` WHERE `name` = '__new_savings_flows';--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT '__new_savings_flows', `seq` FROM `sqlite_sequence` WHERE `name` = 'savings_flows';--> statement-breakpoint
-- Children first: nothing points at the old savings_balances or savings_flows, and once they're gone
-- nothing points at the old savings_accounts, so dropping it deletes nothing else.
DROP TABLE `savings_flows`;--> statement-breakpoint
DROP TABLE `savings_balances`;--> statement-breakpoint
DROP TABLE `savings_accounts`;--> statement-breakpoint
-- Renaming rewrites the foreign keys that name __new_savings_accounts, and sqlite_sequence, to the new names.
ALTER TABLE `__new_savings_accounts` RENAME TO `savings_accounts`;--> statement-breakpoint
ALTER TABLE `__new_savings_balances` RENAME TO `savings_balances`;--> statement-breakpoint
ALTER TABLE `__new_savings_flows` RENAME TO `savings_flows`;--> statement-breakpoint
CREATE UNIQUE INDEX `savings_accounts_plaid_account_unique` ON `savings_accounts` (`plaid_account_id`);--> statement-breakpoint
CREATE INDEX `savings_accounts_item_idx` ON `savings_accounts` (`plaid_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `savings_balances_account_date_unique` ON `savings_balances` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `savings_balances_import_idx` ON `savings_balances` (`import_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `savings_flows_source_plaid_unique` ON `savings_flows` (`source`,`plaid_id`);--> statement-breakpoint
CREATE INDEX `savings_flows_account_date_idx` ON `savings_flows` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `savings_flows_import_idx` ON `savings_flows` (`import_id`);--> statement-breakpoint
CREATE INDEX `savings_imports_account_idx` ON `savings_imports` (`account_id`,`uploaded_at`);--> statement-breakpoint
CREATE TABLE `savings_import_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`file_name` text,
	`file_sha256` text NOT NULL,
	`layout` text NOT NULL,
	`plan` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `savings_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
