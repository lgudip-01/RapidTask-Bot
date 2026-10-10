-- Google Tasks is no longer an integration: Planner is the single home for tasks you create.
-- Convert any rows that came from (or were written to) Google Tasks into Planner-only tasks.
-- externalId becomes the row id so (source, external_id) stays unique.
UPDATE `tasks`
SET `source` = 'local', `external_id` = `id`, `status_set_locally` = 0, `url` = NULL
WHERE `source` = 'google_tasks';
--> statement-breakpoint
UPDATE `captures`
SET `source` = 'local', `external_id` = `item_id`
WHERE `source` = 'google_tasks';
