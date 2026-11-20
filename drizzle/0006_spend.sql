CREATE TABLE `cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nickname` text NOT NULL,
	`mask` text,
	`included` integer DEFAULT false NOT NULL,
	`usual_closing_day` integer,
	`archived_at` integer,
	`plaid_item_id` integer,
	`plaid_account_id` text,
	`plaid_name` text,
	`plaid_official_name` text,
	`plaid_type` text,
	`plaid_subtype` text,
	`iso_currency_code` text DEFAULT 'USD',
	`removed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plaid_item_id`) REFERENCES `plaid_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cards_usual_closing_day" CHECK("cards"."usual_closing_day" is null or "cards"."usual_closing_day" between 1 and 31)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cards_plaid_account_unique` ON `cards` (`plaid_account_id`) WHERE plaid_account_id is not null;--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'normal' NOT NULL,
	`sort_order` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX `categories_special_unique` ON `categories` (`kind`) WHERE kind <> 'normal';--> statement-breakpoint
CREATE TABLE `category_mappings` (
	`plaid_pfc` text PRIMARY KEY NOT NULL,
	`taxonomy_version` text NOT NULL,
	`category_id` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `csv_import_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`file_name` text,
	`file_sha256` text NOT NULL,
	`rows` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `csv_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`file_name` text,
	`file_sha256` text NOT NULL,
	`uploaded_by_user_id` integer NOT NULL,
	`uploaded_at` integer NOT NULL,
	`row_count` integer NOT NULL,
	`imported_count` integer NOT NULL,
	`skipped_count` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `csv_imports_card_idx` ON `csv_imports` (`card_id`,`uploaded_at`);--> statement-breakpoint
CREATE TABLE `plaid_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer,
	`plaid_item_id` text NOT NULL,
	`institution_id` text,
	`institution_name` text,
	`cursor` text,
	`consent_expiration_time` text,
	`last_webhook_code` text,
	`removed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plaid_items_item_unique` ON `plaid_items` (`plaid_item_id`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position` integer NOT NULL,
	`match_text` text NOT NULL,
	`match_type` text NOT NULL,
	`card_id` integer,
	`min_cents` integer,
	`max_cents` integer,
	`set_category_id` integer,
	`set_person` text,
	`set_person_user_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`set_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`set_person_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rules_person_user" CHECK((coalesce("rules"."set_person", '') = 'user') = ("rules"."set_person_user_id" is not null)),
	CONSTRAINT "rules_has_action" CHECK("rules"."set_category_id" is not null or "rules"."set_person" is not null)
);
--> statement-breakpoint
CREATE INDEX `rules_position_idx` ON `rules` (`position`);--> statement-breakpoint
CREATE TABLE `statements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`closing_date` text NOT NULL,
	`source` text NOT NULL,
	`statement_balance_cents` integer,
	`payment_due_date` text,
	`minimum_payment_cents` integer,
	`fetched_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statements_card_date_unique` ON `statements` (`card_id`,`closing_date`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`source` text NOT NULL,
	`plaid_transaction_id` text,
	`plaid_account_id` text,
	`pending` integer DEFAULT false NOT NULL,
	`pending_transaction_id` text,
	`date` text NOT NULL,
	`authorized_date` text,
	`amount_cents` integer NOT NULL,
	`iso_currency_code` text DEFAULT 'USD',
	`unofficial_currency_code` text,
	`merchant` text,
	`raw_name` text NOT NULL,
	`original_description` text,
	`csv_address` text,
	`plaid_pfc_primary` text,
	`plaid_pfc_detailed` text,
	`plaid_pfc_confidence` text,
	`plaid_pfc_version` text,
	`merchant_entity_id` text,
	`logo_url` text,
	`counterparties` text,
	`category_id` integer NOT NULL,
	`category_source` text NOT NULL,
	`person_user_id` integer,
	`person_source` text NOT NULL,
	`note` text,
	`csv_reference` text,
	`csv_import_id` integer,
	`removed_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`csv_import_id`) REFERENCES `csv_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transactions_card_date_idx` ON `transactions` (`card_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_plaid_unique` ON `transactions` (`plaid_transaction_id`) WHERE plaid_transaction_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_csv_reference_unique` ON `transactions` (`card_id`,`csv_reference`) WHERE csv_reference is not null;