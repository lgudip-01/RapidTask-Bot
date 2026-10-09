CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`inbound_id` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`item_id` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`undone_at` integer,
	FOREIGN KEY (`inbound_id`) REFERENCES `inbound_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `captures_created_idx` ON `captures` (`created_at`);--> statement-breakpoint
CREATE TABLE `inbound_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`text_length` integer NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`via` text,
	`processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_channel_msg_uq` ON `inbound_messages` (`channel`,`provider_message_id`);