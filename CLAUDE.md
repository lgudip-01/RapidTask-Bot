# Planner — standing rules

## Project

A personal calendar / planner / to-do web app for one user. It shows Google Calendar (events,
read-only), Canvas LMS (assignments, read-only), and its own local tasks and events in one place,
and accepts new tasks/events by text message from the owner.

## Stack

TypeScript everywhere. npm workspaces:

- `apps/web` — Vite + React + Tailwind
- `apps/server` — Node + Hono, SQLite via Drizzle (SQLite + Litestream/volume for one user)
- `packages/shared` — shared types + zod schemas (consumed as TS source by both apps)

## Principles

- Single-user app deployed to a small cloud host. The web UI sits behind authentication
  (single-user login or Cloudflare Access). Only the webhook route is public.
- Secrets in environment variables only. Never log tokens or message bodies.
- Google is READ-ONLY (OAuth scope `calendar.readonly`, GET requests only). Canvas is READ-ONLY.
  Local items (`source = local`) are the only writable data. Nothing is ever written to Google or
  Canvas. `WRITE_EVENTS_TO_GOOGLE` is a reserved flag with no implementation.
- Inbound messages are accepted ONLY from the owner's allowlisted sender ID, after verifying the
  provider's request signature. Everything else is dropped silently with a rate-limited log line.
- Every item is normalized to shared types with `source`, `externalId`, `syncedAt`. Sync is
  idempotent.
- Message text is treated as untrusted data. The parser may only output structured fields. It can
  never trigger actions beyond creating or undoing a task/event.
- Tests with Vitest using recorded fixtures, never live data.

## Workflow

- Plan before multi-file changes.
- Commit after each milestone.
- Log architecture decisions in `docs/DECISIONS.md`.

## Commands

- `npm install` — install all workspaces
- `npm run dev` — server (:8787) + web (:5173, proxies `/api` to the server)
- `npm test` — Vitest across all workspaces
- `npm run lint` / `npm run format` / `npm run format:check` / `npm run typecheck`
- `npm run build` — build web (static) and server (bundled to `apps/server/dist`)
