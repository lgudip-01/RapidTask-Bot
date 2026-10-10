# Planner

A personal calendar, planner and to-do app for one person. It shows **Google Calendar**
(events, read-only), **Canvas LMS** (assignments, read-only) and its own **local tasks and
events** in one view, and lets you add items by **texting a Telegram bot or an SMS number**.

```
apps/web         Vite + React + Tailwind UI (Today, Week, Tasks, Suggestions, Settings)
apps/server      Hono API, sync engine, webhooks, SQLite via Drizzle
packages/shared  zod schemas + types shared by web and server
packages/canvas  read-only Canvas REST client (used by the server and the dev MCP server)
packages/mcp-canvas  local MCP server so Claude Code can query Canvas during development
docs/DECISIONS.md    why things are the way they are
```

## Run locally

Requires Node 22.12+ (`winget install OpenJS.NodeJS.LTS` on Windows).

```sh
npm install
cp .env.example .env          # fill in what you use; everything is optional locally
npm run seed -w @planner/server -- --reset    # optional: fixture data in apps/server/data/dev.db
npm run dev                   # API on :8787, UI on http://localhost:5173
```

To browse the seeded data, set `DATABASE_PATH=./data/dev.db` in `.env`. Other commands:
`npm test`, `npm run typecheck`, `npm run lint`, `npm run format`, `npm run build`,
and `npm run backup`, which exports every task to `./backups/tasks-<time>.json`.

## Integrations

Each one is optional. Settings in the UI shows what is configured, when it last synced,
and the last error.

### Google Calendar (read-only)

1. In Google Cloud Console, create a project and enable the **Google Calendar API** (nothing else).
2. Open **Google Auth Platform**, choose **Get started**, and set the audience to **External**.
   Under **Data Access**, add only the scope `…/auth/calendar.readonly`.
   Under **Audience → Test users**, add your Gmail address.
3. Under **Clients**, create a client with type **Desktop app**. Put its ID and secret in
   `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. Run `npm run auth:google -w @planner/server` and approve in the browser. The refresh
   token goes into Windows Credential Manager or macOS Keychain, or into the encrypted
   token file when `TOKEN_STORE=file`.
5. **Avoid the 7-day expiry.** While the app's publishing status is _Testing_, Google
   expires refresh tokens after 7 days. Go to **Audience → Publish app** (In
   production), click through the "unverified app" warning, and **run step 4 again**.
   With a Google Workspace account, the alternative is to set the audience to _Internal_.

Planner never writes to Google: it only sends GET requests, and the scope is read-only.
Recurring events are synced as individual instances.

### Canvas (read-only)

- **Preferred:** In Canvas, go to Account → Settings → **+ New Access Token**. Set
  `CANVAS_BASE_URL` (e.g. `https://canvas.school.edu`) and `CANVAS_TOKEN`.
- **If your school disables tokens:** In Canvas, open Calendar → **Calendar Feed** and copy
  the URL into `CANVAS_ICS_URL`. Treat that URL as a password.

The app syncs current-term courses, assignments with submission status (missing, late,
submitted), calendar events, announcement titles and, optionally, grades. Grades stay
hidden until you turn them on in Settings.

### Telegram bot (recommended: free, no carrier registration)

1. In Telegram, message **@BotFather** and send `/newbot`. Choose a display name, then a
   username ending in `bot`. BotFather replies with the token. Put it in `.env` as
   `TELEGRAM_BOT_TOKEN`. Never commit it. If it leaks, send `/revoke` to BotFather.
2. Recommended: send `/setjoingroups` and choose **Disable**, so the bot can't be added to
   groups. Send `/setprivacy` and choose **Enable**.
3. Get your numeric user ID from **@userinfobot** and set `TELEGRAM_ALLOWED_USER_ID`.
4. **Locally**, set `TELEGRAM_MODE=polling` and run `npm run dev`. This long-polls Telegram,
   so no public URL is needed.
5. **Production:** set `TELEGRAM_MODE=webhook`, `TELEGRAM_WEBHOOK_SECRET` (16–256 characters
   from `A–Z a–z 0–9 _ -`) and `PUBLIC_BASE_URL`, then run `npm run telegram -- set-webhook`.
   To switch back to polling, run `npm run telegram -- delete-webhook` first, because
   `getUpdates` returns 409 while a webhook exists. `npm run telegram -- info` shows the
   current state.

### SMS via Twilio (optional)

1. Create a Twilio account, then go to **Phone Numbers → Buy a number** and choose one
   with SMS capability.
2. **US registration is mandatory before sending.** There are two routes:
   - **Toll-free number + Toll-Free Verification:** free to submit. Until it is verified,
     sending to US numbers is blocked.
   - **Local number + A2P 10DLC:** for an individual without an EIN, use the **Sole
     Proprietor** brand and campaign. Small one-time and monthly fees apply. This route
     requires a **paid** account.
3. **On a trial account,** you can only text **verified** recipient numbers (yours), and
   only through a **verified toll-free number**. Messages get a trial prefix. In the
   meantime, Telegram works without any of this.
4. Under **Messaging → A message comes in**, set the webhook to
   `https://<your-app>/webhooks/twilio` (HTTP POST). Set `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` and `OWNER_PHONE_E164` (e.g. `+15555550123`).
   The signature check uses `PUBLIC_BASE_URL` + `/webhooks/twilio`. Set
   `TWILIO_WEBHOOK_URL` if the URL configured in Twilio differs.

### Message parsing (Claude)

Simple messages like "dentist tues 3pm" are parsed locally at no cost. For anything else,
set `ANTHROPIC_API_KEY` and Claude (`PARSER_MODEL`, default `claude-opus-5-5`) extracts a
structured item. If nothing usable comes out, the bot asks one clarifying question.
Commands: `TODAY`, `DONE <n>`, `UNDO`, `HELP`. The **AI triage** switch in Settings
turns model calls off.

## Deploy (Fly.io)

**Why Fly.io:** It offers real persistent volumes for the SQLite file and a small
always-on VM (around $3–5/month) that keeps the in-process sync scheduler running. It
also provides managed TLS, health checks, `fly secrets`, and S3-compatible storage
(Tigris) for Litestream backups. Render only has persistent disks on paid instances, and
Railway's volumes are less mature. A single-writer SQLite app wants exactly one
long-lived machine with one disk, which is what Fly gives you.

```sh
fly launch --no-deploy --copy-config     # then set app/region names in fly.toml
fly volumes create planner_data --size 1 --region ewr
fly storage create                       # Tigris bucket; sets AWS_* secrets
fly secrets set LITESTREAM_REPLICA_URL='s3://<bucket>/planner.db?endpoint=fly.storage.tigris.dev&region=auto'
fly secrets set SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
fly secrets set AUTH_PASSWORD_HASH="$(npm run -s hash-password -w @planner/server)"   # prompts, hidden
fly secrets set TOKEN_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
fly secrets set TELEGRAM_BOT_TOKEN=… TELEGRAM_ALLOWED_USER_ID=… TELEGRAM_WEBHOOK_SECRET=…
# plus whichever of GOOGLE_*, CANVAS_*, ANTHROPIC_API_KEY, TWILIO_* you use
fly deploy
npm run telegram -- set-webhook          # with PUBLIC_BASE_URL set locally to the Fly URL
```

**Google on the server:** the OAuth flow runs on your machine. Run it once into an
encrypted file using the _same_ `TOKEN_ENCRYPTION_KEY` as the server, then upload the file:

```sh
TOKEN_STORE=file TOKEN_FILE_PATH=./tokens.enc.json TOKEN_ENCRYPTION_KEY=<same as Fly> npm run auth:google -w @planner/server
fly sftp shell   # put apps/server/tokens.enc.json /data/tokens.enc.json
```

**Backups:** Litestream continuously replicates the database to Tigris, and a fresh volume
restores from it on boot. To export tasks only, run
`fly ssh console -C "node /app/apps/server/dist/backup.js --stdout" > tasks.json`.

**Access control:** with `AUTH_MODE=password`, a single-user login page protects the UI
and `/api/*`. With `AUTH_MODE=cloudflare`, the app sits behind Cloudflare Access; set
`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`, and the app verifies the Access JWT. Only
`/webhooks/*` and `/healthz` are public. The server **refuses to start in production**
without auth and an `https` `PUBLIC_BASE_URL`.

### Secrets

| Secret                                        | Used for                                    | Notes                                                               |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `SESSION_SECRET`                              | signing login sessions                      | ≥32 random chars; rotating it signs you out everywhere              |
| `AUTH_PASSWORD_HASH`                          | single-user login                           | scrypt hash from `npm run hash-password`; never the password itself |
| `TOKEN_ENCRYPTION_KEY`                        | encrypts OAuth refresh tokens on the volume | 32 random bytes, base64                                             |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`   | Google OAuth                                | Desktop client                                                      |
| `CANVAS_TOKEN`                                | Canvas REST (read-only use)                 | or `CANVAS_ICS_URL` (also secret)                                   |
| `ANTHROPIC_API_KEY`                           | message parser                              | optional                                                            |
| `TELEGRAM_BOT_TOKEN`                          | Telegram Bot API                            | revoke with BotFather `/revoke`                                     |
| `TELEGRAM_WEBHOOK_SECRET`                     | verifies Telegram webhook calls             | random, 16–256 chars                                                |
| `TWILIO_AUTH_TOKEN`                           | verifies Twilio signatures, sends replies   | plus `TWILIO_ACCOUNT_SID`                                           |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Litestream → Tigris                         | set by `fly storage create`                                         |

Non-secret config (`PUBLIC_BASE_URL`, `APP_TIMEZONE`, `TELEGRAM_ALLOWED_USER_ID`,
`OWNER_PHONE_E164`, …) lives in `fly.toml [env]` or as secrets. `.env.example` lists
every variable.

## Threat model

**Assets:** your schedule and tasks, the OAuth refresh token (read-only
Calendar access), the Canvas token (read access to your coursework and grades), the bot and Twilio
credentials, and the Anthropic key (spend).

**Trust boundaries:** the internet → Fly proxy (TLS) → app. Webhooks are public but signed;
everything else requires a session. External content (texts, Canvas descriptions, event
text) is untrusted data.

| Scenario                                                                    | What stops it                                                                                                                                                                                                                                                                            | Residual risk                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Someone spoofs your phone number** (caller-ID spoofing to the SMS number) | Requests need a valid `X-Twilio-Signature`, so only Twilio can call the webhook. The sender must equal `OWNER_PHONE_E164`.                                                                                                                                                               | SMS sender IDs can be spoofed at the carrier level, so Twilio might deliver a spoofed "from you" text. The worst case is a junk task or event, or an UNDO/DONE: the bot can only create one item, undo the last one, check one off, or read today's titles. Telegram identifies you by account, not number, so prefer it. Turning off AI triage limits spend. |
| **The webhook URL leaks**                                                   | Telegram requests need the secret-token header and Twilio requests need the HMAC signature. Bad signatures get 403 and a throttled log line. Requests are rate limited per IP (60/min), bodies are capped at 64 KB, and provider message IDs are deduplicated, which also stops replays. | Signed requests from the real provider are still accepted, and the sender allowlist filters those. A flood of invalid requests costs little CPU.                                                                                                                                                                                                              |
| **The Telegram bot token is stolen**                                        | The token alone can't make our webhook accept a message, since that needs the webhook secret.                                                                                                                                                                                            | An attacker could call `setWebhook` to redirect your updates (and read your texts to the bot) or send messages as the bot. Revoke with `/revoke`, rotate both secrets, and run `set-webhook` again.                                                                                                                                                           |
| **The Google refresh token is stolen**                                      | It is encrypted at rest (AES-256-GCM, key in Fly secrets) and never logged. The scope is limited to `calendar.events` and `tasks`.                                                                                                                                                       | With the file and the key, someone could read and write your events and tasks. Revoke at myaccount.google.com → Security → Third-party access, or with `npm run auth:google -- --logout`.                                                                                                                                                                     |
| **The Canvas token is stolen**                                              | It is never logged, is sent only as a header to the configured origin, and pagination links to other hosts are refused.                                                                                                                                                                  | Canvas tokens aren't scope-limited, so someone with the token could also _write_ as you. Expire it in Canvas → Settings. The iCal fallback leaks less.                                                                                                                                                                                                        |
| **The session cookie or password is stolen**                                | The cookie is HttpOnly, Secure and SameSite=Lax. Writes are checked for same origin. The CSP blocks script injection. Login is limited to 5 attempts per 15 minutes per IP.                                                                                                              | Sessions last 30 days. Rotate `SESSION_SECRET` to sign out everywhere, or use Cloudflare Access with MFA instead of a password.                                                                                                                                                                                                                               |
| **Prompt injection via a message or Canvas text**                           | The parser can only output a strict zod schema, and the pipeline can only create one item or ask one ≤160-character question. Canvas descriptions are never stored, and the dev MCP server labels them `description_untrusted`.                                                          | A crafted text could produce an odd task title. That's visible and undoable.                                                                                                                                                                                                                                                                                  |
| **Logs leak secrets or content**                                            | Logs carry only explicit fields, and errors go through a redactor (bearer, basic, `sk-ant-…`, Google and Telegram token shapes, credential query parameters). Message text is never logged or stored, only its length.                                                                   | Third-party library stack traces in unexpected crashes are caught by process-level handlers and sanitized.                                                                                                                                                                                                                                                    |
| **Fly account compromise**                                                  | Use 2FA on Fly, Google, Canvas, Twilio, Telegram and Anthropic.                                                                                                                                                                                                                          | Everything above, since the account holds the secrets.                                                                                                                                                                                                                                                                                                        |

## Development notes

- Tests use recorded fixtures only, never live services (`npm test`).
- The Claude Code MCP servers registered at local scope are `google-calendar` (read-only
  tools) and `canvas` (`packages/mcp-canvas`, read-only).
  Build the latter with `npm run build -w @planner/mcp-canvas`.
