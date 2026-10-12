# Deploying Planner on Vercel

Planner runs on Vercel as two pieces:

- the **web app**, served as static files, and
- one **function** (`api/index.js`) that handles `/api/*`, `/login`, `/webhooks/*`,
  `/cron/tick` and `/health`.

The data lives in **Turso** (hosted SQLite, free plan). Periodic work (calendar sync,
reminders, the morning digest and the nightly backup) runs when `/cron/tick` is called. A
free outside pinger calls it every 5 minutes. Vercel's own cron calls it once a day as a
fallback, because the free plan only allows daily cron jobs.

You need four free accounts: GitHub (the repo is already there), Vercel, Turso and
cron-job.org.

Never paste secrets into chats, issues or commits. Generate each one in your own
terminal and paste it straight into Vercel.

## 1. Create the Vercel project

1. Go to <https://vercel.com/new>, sign in with GitHub, and import
   `lgudip-01/RapidTask-Bot`.
2. **Framework Preset:** Other. **Root Directory:** leave as the repo root. Build settings
   come from `vercel.json`, so leave those fields empty.
3. Don't deploy yet. If Vercel deploys automatically and fails, that's expected, because
   the environment isn't set up.

## 2. Add the database (Turso)

1. In the Vercel project, open **Storage → Marketplace → Turso** (or **Integrations →
   Turso**) and create a database. Pick the region closest to you.
2. Connect the database to this project. Vercel then adds `TURSO_DATABASE_URL` and
   `TURSO_AUTH_TOKEN` to the project's environment variables automatically.

Tables are created automatically on the first request.

## 3. Set environment variables

In **Project → Settings → Environment Variables**, add the following for **Production**.
Generate each random value in your own terminal (PowerShell or Git Bash, from the
`Planner` folder).

| Variable                   | Value                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | `production`                                                                                                          |
| `APP_TIMEZONE`             | e.g. `America/New_York`                                                                                               |
| `PUBLIC_BASE_URL`          | `https://<your-project>.vercel.app` (the domain Vercel shows; add it after the first deploy if you don't know it yet) |
| `AUTH_MODE`                | `password`                                                                                                            |
| `AUTH_PASSWORD_HASH`       | output of `npm run -s hash-password -w @planner/server` (it asks for the password; only the hash is printed)          |
| `SESSION_SECRET`           | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`                                      |
| `TOKEN_ENCRYPTION_KEY`     | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`                                         |
| `CRON_SECRET`              | `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`                                      |
| `TELEGRAM_BOT_TOKEN`       | the bot token from BotFather (copy it from your `.env`)                                                               |
| `TELEGRAM_ALLOWED_USER_ID` | your Telegram user ID (same as `TELEGRAM_ALLOWED_USER_ID` in your `.env`)                                             |
| `TELEGRAM_MODE`            | `webhook`                                                                                                             |
| `TELEGRAM_WEBHOOK_SECRET`  | `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`                                      |
| `GOOGLE_CLIENT_ID`         | step 6                                                                                                                |
| `GOOGLE_CLIENT_SECRET`     | step 6                                                                                                                |
| `CANVAS_BASE_URL`          | e.g. `https://yourschool.instructure.com` (optional)                                                                  |
| `CANVAS_TOKEN`             | Canvas → Account → Settings → New access token (optional)                                                             |
| `ANTHROPIC_API_KEY`        | optional: lets the bot understand free-form texts                                                                     |

Build tools (Vite, tsup) are dev dependencies. `vercel.json` installs them with
`npm install --include=dev`, so `NODE_ENV=production` doesn't break the build.

The function refuses to start without `TURSO_DATABASE_URL`, `CRON_SECRET`,
`TOKEN_ENCRYPTION_KEY` and a working login. A missing variable shows up as `503` and an
`Invalid environment: …` line naming it (never its value) in **Vercel → Logs**.

Then deploy: **Deployments → Redeploy** (or push to `main`). Any change to an
environment variable needs a redeploy before it takes effect.

**Check:** open `https://<your-project>.vercel.app/health`. It should show `{"ok":true}`.
Then open the site and log in with your password.

## 4. Point the Telegram bot at Vercel

Telegram has to know where to deliver your texts. From the `Planner` folder, using the
**same** `TELEGRAM_WEBHOOK_SECRET` you put in Vercel:

```powershell
$env:PUBLIC_BASE_URL = "https://<your-project>.vercel.app"
$env:TELEGRAM_WEBHOOK_SECRET = "<the same value as in Vercel>"
npm run telegram -w @planner/server -- set-webhook
npm run telegram -w @planner/server -- info
```

`info` should show your Vercel URL with no `last_error`. Text the bot `help` to confirm it
replies.

While the webhook is set, local `npm run dev` can't receive Telegram messages (polling is
refused). To use the bot locally again, run `npm run telegram -w @planner/server -- delete-webhook`,
and run `set-webhook` again afterwards.

## 5. Schedule the heartbeat (cron-job.org)

1. Sign up at <https://cron-job.org> (free).
2. **Create cronjob:**
   - URL: `https://<your-project>.vercel.app/cron/tick`
   - Schedule: every 5 minutes
   - **Advanced → Headers:** add `Authorization` with the value `Bearer <your CRON_SECRET>`
3. Save, then use **Test run**. The response should be `200` with something like
   `{"sync":{...},"notifications":true,"backup":"not_due"}`.

Reminders are accurate to about 5 minutes. Vercel's daily cron (`vercel.json`) also calls
the same endpoint as a fallback.

## 6. Connect Google Calendar (read-only)

1. In Google Cloud Console, enable the **Google Calendar API**. Under **Google Auth Platform**,
   set the audience to External, add the scope `…/auth/calendar.readonly`, and add yourself
   as a test user.
2. **Clients → Create client → Web application.** Under **Authorized redirect URIs**, add:
   - `https://<your-project>.vercel.app/api/google/callback`
   - `http://localhost:5173/api/google/callback` (for local development)
3. Put the client ID and secret into Vercel (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and
   your local `.env`, then redeploy.
4. **Audience → Publish app**, so Google doesn't expire the connection after 7 days.
5. In Planner, open **Settings → Sources → Connect Google** and approve. Planner syncs
   right away and every 10 minutes after that (on the next heartbeat).

## 7. Backups and restoring

Every night (03:00 in `APP_TIMEZONE`) the bot sends you a file like
`planner-20261012-070000.json` containing all your tasks and Planner events. Settings →
Backups shows the last one and has **Back up now**. If a backup fails or goes stale, the
bot alerts you.

To restore a backup into the Turso database (or into a new one), save the file from
Telegram and run, with the Turso values from Vercel:

```powershell
$env:TURSO_DATABASE_URL = "<from Vercel>"
$env:TURSO_AUTH_TOKEN = "<from Vercel>"
npm run restore -w @planner/server -- --json .\planner-20261012-070000.json
```

Existing items are kept, so it's safe to run more than once. Google and Canvas items come
back on their own with the next sync.

## Limits compared with an always-on server

- **Live updates** become a refresh every 15 seconds ("Auto-refresh" in the header instead
  of "Live").
- **Follow-up answers to the bot:** when the bot asks a clarifying question, it remembers
  your earlier text only in memory, on purpose, so message text is never stored. On
  Vercel your answer usually reaches the same warm instance. If it doesn't, the answer is
  treated as a new message.
- **Rate limits** on the login and webhook routes are per instance, which is still fine
  for one user.

## Troubleshooting

- **`/health` returns 404:** the rewrites in `vercel.json` didn't apply. Check that the
  project's Root Directory is the repo root, and that `api/index.js` exists in the
  deployment's **Source** tab.
- **`503 {"error":"unavailable"}`:** the server couldn't start. Look for
  `startup failed` / `Invalid environment` in Vercel → Logs.
- **The bot doesn't reply:** run `npm run telegram -w @planner/server -- info` and check
  for errors. Make sure `TELEGRAM_MODE=webhook` and that the secret matches exactly.
