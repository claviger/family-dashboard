CREATE TABLE `calendar_cache` (
	`calendar_id` text NOT NULL,
	`time_zone` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`fetch_started_at` integer NOT NULL,
	`fetch_generation` integer DEFAULT 0 NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`events` text NOT NULL,
	PRIMARY KEY(`calendar_id`, `time_zone`, `window_start`, `window_end`)
);
--> statement-breakpoint
CREATE INDEX `calendar_cache_fetched_idx` ON `calendar_cache` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `calendar_link_pending` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`session_hash` text NOT NULL,
	`credentials_enc` text NOT NULL,
	`account_id` text,
	`account` text,
	`calendars` text NOT NULL,
	`source_connection_id` integer,
	`source_fingerprint` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `pending_revocations` ADD `account_email` text;--> statement-breakpoint
ALTER TABLE `pending_revocations` ADD `gave_up_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_family_calendar_unique` ON `connections` (`kind`) WHERE scope = 'family' and kind = 'google_calendar';