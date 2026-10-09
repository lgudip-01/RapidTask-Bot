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

## 008 — Google Calendar integration (2026-10-09)

- **Raw REST via `fetch`, not `googleapis`.** Four endpoints (list/insert/patch/delete) don't
  justify a very large dependency; an injectable `fetch` makes recorded-fixture tests trivial.
- **OAuth:** Desktop client, loopback redirect on `127.0.0.1:<ephemeral>`, PKCE (S256) + `state`,
  `access_type=offline&prompt=consent`. Scopes: `calendar.events` + `tasks` (not full `calendar`;
  `tasks` is requested now so inbound capture won't need a second consent). Only the refresh
  token is persisted; access tokens live in memory and are refreshed 60 s early; one retry on 401.
- **Token storage:** OS keyring via `@napi-rs/keyring` (Windows Credential Manager on the dev box;
  the original brief said macOS Keychain, but the machine is Windows). Fallback: AES-256-GCM file
  keyed by `TOKEN_ENCRYPTION_KEY`, entry name bound as AAD, written 0600 atomically. Servers use
  the file store.
- **Sync:** `singleEvents=true` (recurring events arrive as instances, each its own row).
  `externalId = "<calendarId>/<eventId>"`. Cursor = JSON `{calendarId: syncToken}`. Initial
  listing uses `timeMin = now − GOOGLE_SYNC_LOOKBACK_DAYS`; incremental requests send only the
  sync token. Any missing token or a 410 Gone → re-list all calendars as a `fullResync` batch.
  Cancelled entries → deletes. `workingLocation` entries are skipped.
- **Times:** stored UTC; date-times without an offset are read in the event's/calendar's zone;
  all-day dates are anchored at midnight `APP_TIMEZONE` (America/New_York). UI renders in that zone.
- **Writes:** `POST/PATCH/DELETE /api/calendar/events` require `"confirm": true`; otherwise 400
  `confirmation_required` with a preview and no upstream call. Results are upserted immediately;
  the next incremental sync returns the same event and is a no-op.
- Known limit: recurring series with no end are expanded by Google from `timeMin` forward; very
  dense infinite series could make the first sync large.

## 009 — Google Calendar MCP server for development (2026-10-09)

- Chosen: `@cocal/google-calendar-mcp` 2.7.0 (github.com/nspady/google-calendar-mcp, MIT,
  ~1.2k stars, published 2026-09-28). Alternatives were less active forks or less complete.
- Audit of the published npm tarball (what actually runs), not just the repo: no install scripts;
  outbound traffic only to Google (`googleapis` client + a hard-coded `www.googleapis.com/batch`
  fetch); no telemetry, no `eval`/`new Function`/`child_process` (except `open` for the auth URL);
  token file written mode 0600; nothing logs tokens. Caveats: requests the full `calendar` scope;
  its OAuth callback server binds all interfaces briefly during auth; deps are semver ranges.
- Installed into `~/.mcp-servers/google-calendar-mcp` with an exact version and a lockfile
  (`--ignore-scripts`), registered at **local** scope (not committed), and restricted with
  `ENABLED_TOOLS` to read-only tools so Claude Code cannot modify the real calendar.

## 010 — Backend calls Canvas REST directly, not through an MCP server (2026-10-09)

**Recommendation: direct REST from the backend.** MCP is only for Claude Code during development.

- MCP is a protocol for exposing tools to an LLM client. The sync job is a deterministic,
  scheduled, non-LLM process: it needs typed pagination, throttling, retries, and recorded-fixture
  tests. An MCP hop adds a second process, a JSON-RPC layer, and failure modes with no benefit.
- Security: one code path holds the token (header-only, pinned to the Canvas origin, GET-only).
  Routing through MCP would add another component that touches the token and an LLM-oriented
  surface to the production backend.
- Reuse without coupling: both the server and the dev MCP server import the same
  `@planner/canvas` client (`packages/canvas`), so there is no duplicated API logic.
- `packages/mcp-canvas` exposes `list_courses`, `list_assignments`, `get_assignment` (all
  `readOnlyHint`), returns assignment descriptions only as stripped plain text under
  `description_untrusted`, and is registered at local scope with
  `node --env-file-if-exists=<repo>/.env packages/mcp-canvas/dist/index.js`, so the token lives
  only in `.env`.

## 011 — Canvas sync (2026-10-09)

- Read-only by construction: the client has no non-GET method. Requests send
  `Accept: application/json+canvas-string-ids`; `Link` URLs are followed opaquely but only on the
  configured origin; `X-Rate-Limit-Remaining < 100` pauses 2 s; 403 "Rate Limit Exceeded" retries
  with backoff (×3).
- Current term = not concluded/restricted/unpublished, and the term window or the course's own
  date window contains now (undated "Default Term" courses count as current).
- Every run is a full listing (`fullResync`): Canvas has no change tokens and a term is small.
- Assignments with a due date → tasks (`courseOrProject` = course name, `pointsPossible`,
  `submissionStatus` = excused > missing > late > graded > submitted > unsubmitted; done for
  everything except missing/unsubmitted). Local check-offs survive (`statusSetLocally`).
- Calendar events → events (descriptions dropped). Announcements → `announcements` table, titles
  only. Course grades → `courses` table; `GET /api/courses` omits them unless `includeGrades=true`.
- Fallback when tokens are disabled: the personal calendar feed (`CANVAS_ICS_URL`, a secret URL).
  Assignments → tasks with the same `assignment-<id>` ids (status unknown → todo).

## 012 — Message parser (2026-10-09)

- **Output contract:** `ParsedMessageSchema` (packages/shared) with kinds `event | task |
  needs_clarification | off_topic`. `off_topic` was added beyond the original brief so irrelevant or
  instruction-like messages are rejected explicitly instead of being forced into a task. Every
  model response is re-validated with zod (strict, cross-field rules); anything else is rejected.
- **Wall-clock, not UTC, from the model:** the model returns local `YYYY-MM-DD` /
  `YYYY-MM-DDTHH:mm`; the server converts with `zonedTimeToUtc` (DST gaps resolve forward,
  overlaps to the first occurrence). The user turn includes a 21-day date table so the model looks
  dates up instead of computing weekday arithmetic.
- **Fast path first:** chrono-node on the local wall clock (as a zone-free instant) for obvious
  one-liners; it declines on anything ambiguous (recurrence, `?`, week/month phrases, bare hours
  without am/pm, today's weekday name, leftover date words in the title).
- **Claude call:** `claude-opus-5-5` (env `PARSER_MODEL`), structured outputs via
  `output_config.format` (JSON schema), effort `low` by default (short, latency-sensitive
  extraction; raise via `PARSER_EFFORT`), static system prompt with `cache_control` (it may be below
  the minimum cacheable size; harmless), 20 s timeout, 2 SDK retries. `fallbacks: "default"` (beta
  `server-side-fallback-2026-07-01`) is on so a false-positive safety decline retries on another
  model instead of failing the message. Refusal/truncation/non-JSON → error outcomes.
- **Untrusted text:** wrapped in `<message>` with our delimiter tags stripped from it; the system
  prompt says it is data. Even a fully hijacked model can only emit the schema, and the pipeline
  only ever creates one item (or asks one ≤160-char question to the owner).
- **Clarification:** a pending question is held per sender **in memory only** for 10 minutes
  (raw text is never persisted); the next message is sent with that context; max 2 rounds; low
  confidence (< 0.5) is treated as needing clarification.
- **Validation guards:** dates must fall between yesterday and +2 years; inverted ends are repaired
  (all-day → +1 day exclusive; "11pm–1am" → next day; otherwise +60 min).
