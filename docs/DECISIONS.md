# Architecture decisions

Newest at the bottom. Each entry: context → decision → consequences.

## 001 — Monorepo layout (2026-10-09)

- npm workspaces: `apps/web`, `apps/server`, `packages/shared`.
- `packages/shared` is consumed as TypeScript source (no build step). Vite compiles it for the web;
  `tsup` bundles it into the server output (`noExternal: @planner/*`); `tsx` runs it in dev.
- One root Vitest config with `projects`, one root flat ESLint config, Prettier for formatting.

## 002 — Database: SQLite via Drizzle (2026-10-09)

- Single user, small host: SQLite file on a persistent volume, backed up with Litestream.
- Driver `better-sqlite3` (synchronous, fast, transactions are simple). Migrations via
  `drizzle-kit generate`, applied at startup.

## 003 — Authentication is a separate, pre-deploy milestone (2026-10-09)

- No `/api/*` route is authenticated yet. Before any deployment, the web UI and `/api/*` must sit
  behind Cloudflare Access or a single-user login; only `/webhooks/*` stays public.

## 004 — Toolchain versions (2026-10-09)

- Node ≥ 22.12, Vite 8, Vitest 5, React 19, Tailwind 4, ESLint 10, zod 4.
- TypeScript pinned to `~6.0`: typescript-eslint 8 does not support TypeScript 7 (native port) yet.
- `vite` is also a root devDependency so Vitest and the web app resolve the same copy.

## 005 — Time storage (2026-10-09)

- All timestamps are stored as UTC epoch milliseconds (`integer`, Drizzle `timestamp_ms`), and
  cross the API as ISO 8601 strings.
- All-day items are converted to instants at midnight in `APP_TIMEZONE` (default
  `America/New_York`) when they are ingested. Event `end` is exclusive, matching Google.
- `tasks.dueAllDay` marks date-only deadlines (Google Tasks due dates have no time; Canvas dues do).

## 006 — Sync engine (2026-10-09)

- `SyncSource { name, intervalMs, owns, fetchSince(cursor) → { items, nextCursor, fullResync? } }`.
  Items are upserts or deletes keyed by `(source, externalId)`; `id` and `createdAt` never change.
- One SQLite transaction per batch stores items, deletes, and the new cursor together, so the cursor
  only advances if the data landed.
- A `fullResync` batch deletes owned rows that are missing from it (used after Google's 410 Gone).
- Sync can never write `source = 'local'`.
- Scheduler: one `setTimeout` chain per source (no overlapping runs; manual runs get 409 while one
  is in flight). Failures back off `min(interval × 2^failures, 1h)` with +10% jitter;
  `nextRunAt` is persisted so backoff survives restarts. Errors are sanitized before storing/logging.

## 007 — Local edits to synced tasks (2026-10-09)

- Synced tasks allow local edits to `status` and `sortOrder` only. Changing status sets
  `statusSetLocally`, and sync then never overwrites `status`/`completedAt` (lets you tick off a
  read-only Canvas assignment). Other fields → 403. Synced tasks cannot be deleted locally.
- Google Tasks write-back is a later milestone; until then the same local-override rule applies.
