CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_kind_key_uq` ON `notifications` (`kind`,`key`);--> statement-breakpoint
CREATE INDEX `notifications_sent_idx` ON `notifications` (`sent_at`);