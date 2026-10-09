CREATE TABLE `announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`course_name` text,
	`posted_at` integer NOT NULL,
	`url` text,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcements_source_ext_uq` ON `announcements` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `announcements_posted_idx` ON `announcements` (`posted_at`);--> statement-breakpoint
CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`course_code` text,
	`term_name` text,
	`current_score` real,
	`current_grade` text,
	`url` text,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `courses_source_ext_uq` ON `courses` (`source`,`external_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `points_possible` real;--> statement-breakpoint
ALTER TABLE `tasks` ADD `submission_status` text;