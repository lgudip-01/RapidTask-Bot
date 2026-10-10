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
- `tasks.dueAllDay` marks date-only deadlines (e.g. "rent due Friday"); Canvas dues have a time.

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
- Revised 2026-10-10 (see 016): Google and Canvas are read-only; only `source = local` items are
  fully editable.

## 008 — Google Calendar integration (2026-10-09)

- **Raw REST via `fetch`, not `googleapis`.** One endpoint (`events.list`, GET) doesn't justify a
  very large dependency; an injectable `fetch` makes recorded-fixture tests trivial.
- **OAuth:** Desktop client, loopback redirect on `127.0.0.1:<ephemeral>`, PKCE (S256) + `state`,
  `access_type=offline&prompt=consent`. Scope: `calendar.readonly` only (revised 2026-10-10, see
  016). Only the refresh
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
- **No writes** (revised 2026-10-10, see 016): the client has a single private `get()`; the old
  confirmed write endpoints were deleted.
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

## 013 — Inbound capture (2026-10-09)

- `InboundChannel { name, verifyRequest, parseIncoming, isAllowed, reply, ack }` with Telegram and
  Twilio adapters. Webhooks verify, acknowledge immediately (Telegram: 200; Twilio: empty TwiML),
  and process asynchronously, so slow model calls never trigger provider retries.
- **Telegram:** `X-Telegram-Bot-Api-Secret-Token` compared in constant time; private chats from the
  allowlisted numeric user id only. `TELEGRAM_MODE=polling` (getUpdates long-poll, local dev, no
  public URL) or `webhook` (production). getUpdates returns 409 while a webhook is registered —
  `npm run telegram -- delete-webhook` before switching back.
- **Twilio:** `X-Twilio-Signature` (HMAC-SHA1 over the configured public URL + sorted params,
  verified against Twilio's published vector), `AccountSid` must match, sender must equal
  `OWNER_PHONE_E164`. Replies via the REST API.
- **Pipeline:** allowlist → dedupe (unique `(channel, providerMessageId)`; also defeats replays,
  since neither provider signs a timestamp) → per-sender sliding-window limit (20/10 min) →
  commands (`UNDO`, `TODAY`, `DONE <n>`, `HELP`, exact match) → parser → create → reply with title,
  date, and "Reply UNDO to remove". Messages per sender are processed in order.
- **Storage:** `inbound_messages` (dedupe + audit: channel, id, time, text length, outcome, parse
  route) and `captures` (item reference + title for UNDO). Message text is never persisted.
  Unresolved clarifications become `suggestions` (model-proposed title only).
- **Destinations** (revised 2026-10-10, see 016): every texted item becomes a local task or
  local event in Planner. Nothing is sent to Google.
- Drops (bad signature, non-allowlisted sender, duplicate, rate limit) log one line per reason per
  minute with a suppressed count, never the content or sender.

## 014 — Web UI (2026-10-09)

- Views: Today (timeline + overdue + suggestions tray), Week (hand-built 7-column grid; no calendar
  library — overlap layout is ~40 lines and theming a library would cost more), Tasks (list with
  drag-to-reorder via `@dnd-kit`, board with drag between status columns), Suggestions inbox,
  Settings (sources, allowlist, AI triage, grades toggle, theme).
- Data: TanStack Query with optimistic updates (check-off, reorder, status, suggestions, settings)
  that roll back on error. Every API response is zod-validated with the shared schemas.
- Motion: `motion` (Framer Motion) for view transitions, shared-layout nav/segmented highlights,
  staggered lists, check-mark drawing, week slide, toasts; `MotionConfig reducedMotion="user"`.
- Theming: colors are CSS variables (light/dark) mapped into Tailwind v4 `@theme inline`; sources
  have a color plus a text label, so color is never the only cue.
- Quick add uses the server parser: `POST /api/parse` (fast path only, free) for the live preview,
  `POST /api/capture` (AI if enabled) on Enter. The "AI triage" setting gates model calls at
  runtime for both the web and inbound messages.
- Rendering time zone: `VITE_APP_TIMEZONE` (default America/New_York), independent of the browser.
- Settings are stored server-side (`settings` table); the theme preference is per-browser.

## 015 — Deployment and hardening (2026-10-09)

- **Fly.io**: one always-on `shared-cpu-1x` machine + a 1 GB volume for SQLite; Litestream
  replicates continuously to Tigris and restores on a fresh volume. In-process scheduler (no
  external cron) because the machine never sleeps. Container starts as root only to `chown` the
  volume, then drops to `node` via `setpriv`.
- **Access**: `AUTH_MODE=password` (scrypt N=2^15 hash, HMAC-signed stateless session cookie,
  HttpOnly/Secure/SameSite=Lax, 5 logins/15 min/IP) or `cloudflare` (verify the Access JWT with
  `jose` against the team JWKS). Public: `/webhooks/*` (signed, 60 req/min/IP), `/healthz`.
  Production refuses to boot without auth, an https `PUBLIC_BASE_URL`, and a token-encryption key.
- **Headers**: strict CSP (`script-src 'self'`; `style-src 'unsafe-inline'` only because Motion
  animates via style attributes), HSTS, `X-Frame-Options: DENY`, nosniff, `Referrer-Policy:
same-origin` (not `no-referrer`: that makes browsers send `Origin: null` on our own form posts,
  which a real-browser test caught). CORS allows only the deployment origin; writes require a
  matching Origin or `Sec-Fetch-Site: same-origin`.
- **Logging audit**: every log call passes explicit non-sensitive fields; errors go through
  `sanitizeError` (now also Basic auth, `sk-ant-…`, scrypt hashes); CLIs sanitize; process-level
  `uncaughtException`/`unhandledRejection` handlers log sanitized messages only.
- **Backups**: `npm run backup` (tasks → JSON); same script bundled as `dist/backup.js` for
  `fly ssh console`.

## 016 — Google and Canvas are read-only; Planner is the only writable store (2026-10-10)

- The Google Tasks integration was removed. Sources are now `google_calendar`, `canvas`, and
  `local`. The only database that ever held Google Tasks rows was the dev seed database, so no
  data migration was kept (`npm run seed -- --reset` rebuilds it).
- The Google OAuth scope is `calendar.readonly` only. `GoogleCalendarClient` has one private `get()`
  and `listEvents()`. The confirmed write endpoints were deleted. Guard tests
  (`security/readonly-guards.test.ts`) fail the build if:
  - the scope changes;
  - any other file calls the Calendar API;
  - the client gains a non-GET call or a write method;
  - Canvas code sets an HTTP method.
- Every texted item becomes a local task or local event. Synced Canvas tasks still accept a local
  `status`/`sortOrder` override (check-off), which is stored only in Planner.
- After revoking the old grant, re-authorize with `npm run auth:google`; see
  `docs/SETUP-GOOGLE.md`.

## 017 — WRITE_EVENTS_TO_GOOGLE is reserved, not implemented (2026-10-10)

- `WRITE_EVENTS_TO_GOOGLE` (default `false`) names a possible future option: copy events
  created in Planner (texted or added in the UI) to Google Calendar. It is **not implemented**.
  Nothing reads it except a startup warning when it is `true` and the read-only switch in Settings.
- Building it would need:
  - the `calendar.events` scope (a new consent);
  - a write client with explicit confirmation;
  - mapping local events to Google event ids so edits and deletes follow;
  - a decision about which copy wins on conflict.
    Until then, the read-only guard tests forbid any such code.
