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
