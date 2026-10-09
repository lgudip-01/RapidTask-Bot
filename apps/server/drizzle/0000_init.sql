CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`location` text,
	`description` text,
	`calendar_name` text,
	`url` text,
	`updated_at` integer NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_source_ext_uq` ON `calendar_events` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `events_range_idx` ON `calendar_events` (`start`,`end`);--> statement-breakpoint
CREATE TABLE `suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_message_ref` text NOT NULL,
	`proposed_title` text NOT NULL,
	`proposed_due` integer,
	`confidence` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`source` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`last_sync_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`due` integer,
	`due_all_day` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`status_set_locally` integer DEFAULT false NOT NULL,
	`priority` text,
	`course_or_project` text,
	`url` text,
	`sort_order` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_source_ext_uq` ON `tasks` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `tasks_due_idx` ON `tasks` (`due`);