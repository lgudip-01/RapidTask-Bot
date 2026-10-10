CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`ok` integer DEFAULT false NOT NULL,
	`file` text,
	`size_bytes` integer,
	`task_count` integer,
	`event_count` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `backup_runs_started_idx` ON `backup_runs` (`started_at`);