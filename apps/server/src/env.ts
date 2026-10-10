import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8787),
    /** Interface to listen on. Loopback by default; the Docker image sets 0.0.0.0. */
    HOST: z.string().default('127.0.0.1'),
    HEALTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
    APP_TIMEZONE: z.string().default('America/New_York'),
    DATABASE_PATH: z.string().default('./data/planner.db'),

    // Nightly backups: the database is the only copy of Planner-only tasks and events.
    BACKUP_ENABLED: z.stringbool().default(true),
    BACKUP_DIR: z.string().default('./data/backups'),
    /** Local hour (APP_TIMEZONE) for the nightly backup. */
    BACKUP_HOUR: z.coerce.number().int().min(0).max(23).default(3),
    BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),

    /**
     * Future option, NOT implemented: copy events created in Planner to Google Calendar.
     * Must stay false; Google access is read-only (calendar.readonly).
     */
    WRITE_EVENTS_TO_GOOGLE: z.stringbool().default(false),

    // Token storage for OAuth refresh tokens.
    TOKEN_STORE: z.enum(['auto', 'keyring', 'file']).default('auto'),
    TOKEN_FILE_PATH: z.string().default('./data/tokens.enc.json'),
    TOKEN_ENCRYPTION_KEY: optionalString,

    // Google (Desktop OAuth client). Sync is disabled unless both are set.
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_CALENDAR_IDS: z
      .string()
      .default('primary')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    GOOGLE_SYNC_INTERVAL_MINUTES: z.coerce.number().positive().default(10),
    GOOGLE_SYNC_LOOKBACK_DAYS: z.coerce.number().int().nonnegative().default(30),

    // Canvas (read-only). REST if base URL + token are set; otherwise the iCal feed if set.
    CANVAS_BASE_URL: optionalString.pipe(z.url().optional()),
    CANVAS_TOKEN: optionalString,
    CANVAS_ICS_URL: optionalString.pipe(z.url().optional()),
    CANVAS_SYNC_INTERVAL_MINUTES: z.coerce.number().positive().default(30),
    CANVAS_LOOKBACK_DAYS: z.coerce.number().int().nonnegative().default(30),
    CANVAS_LOOKAHEAD_DAYS: z.coerce.number().int().positive().default(120),
    CANVAS_SYNC_GRADES: z.stringbool().default(true),

    // Message parser (Claude). Without a key only the deterministic fast path runs.
    ANTHROPIC_API_KEY: optionalString,
    PARSER_LLM_ENABLED: z.stringbool().default(true),
    PARSER_MODEL: z.string().default('claude-opus-5-5'),
    PARSER_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
    PARSER_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

    // Public HTTPS origin of this server (webhook registration, Twilio signature URL).
    PUBLIC_BASE_URL: optionalString.pipe(z.url().optional()),
    INBOUND_RATE_LIMIT_PER_10_MIN: z.coerce.number().int().positive().default(20),

    // Telegram bot. polling = local dev (no public URL); webhook = production.
    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_ALLOWED_USER_ID: optionalString.pipe(z.string().regex(/^\d+$/).optional()),
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_WEBHOOK_SECRET: optionalString.pipe(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,256}$/)
        .optional(),
    ),

    // Twilio SMS.
    TWILIO_ACCOUNT_SID: optionalString,
    TWILIO_AUTH_TOKEN: optionalString,
    TWILIO_FROM_NUMBER: optionalString,
    OWNER_PHONE_E164: optionalString.pipe(
      z
        .string()
        .regex(/^\+[1-9]\d{6,14}$/)
        .optional(),
    ),
    /** Override when the public URL Twilio calls differs from PUBLIC_BASE_URL + /webhooks/twilio. */
    TWILIO_WEBHOOK_URL: optionalString.pipe(z.url().optional()),

    // Access control for the web UI and /api (webhooks authenticate by signature).
    // none = local development only (refused in production).
    AUTH_MODE: z.enum(['none', 'password', 'cloudflare']).default('none'),
    AUTH_PASSWORD_HASH: optionalString,
    SESSION_SECRET: optionalString,
    SESSION_TTL_DAYS: z.coerce.number().positive().default(30),
    CF_ACCESS_TEAM_DOMAIN: optionalString,
    CF_ACCESS_AUD: optionalString,
    /** Trust Fly-Client-IP / X-Forwarded-* headers (set true only behind Fly's proxy). */
    TRUST_PROXY: z.stringbool().default(false),
    WEBHOOK_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
    /** Built web UI to serve; unset in development (Vite serves it). */
    WEB_DIST_DIR: optionalString,
  })
  .superRefine((e, ctx) => {
    const need = (key: string, ok: unknown) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [key], message: 'required' });
    };
    if (e.AUTH_MODE === 'password') {
      need('AUTH_PASSWORD_HASH', e.AUTH_PASSWORD_HASH?.startsWith('scrypt$'));
      need('SESSION_SECRET', (e.SESSION_SECRET?.length ?? 0) >= 32);
    }
    if (e.AUTH_MODE === 'cloudflare') {
      need('CF_ACCESS_TEAM_DOMAIN', e.CF_ACCESS_TEAM_DOMAIN);
      need('CF_ACCESS_AUD', e.CF_ACCESS_AUD);
    }
    // Without auth, only this machine may connect.
    if (e.AUTH_MODE === 'none' && !LOOPBACK_HOSTS.has(e.HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['HOST'],
        message: 'AUTH_MODE=none requires a loopback HOST',
      });
    }
    if (e.NODE_ENV === 'production') {
      // Never expose an unauthenticated planner on the internet.
      need('AUTH_MODE', e.AUTH_MODE !== 'none');
      need('PUBLIC_BASE_URL', e.PUBLIC_BASE_URL?.startsWith('https://'));
      if (e.TOKEN_STORE !== 'keyring') need('TOKEN_ENCRYPTION_KEY', e.TOKEN_ENCRYPTION_KEY);
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Report only which keys are invalid, never their values.
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment: ${keys}`);
  }
  return parsed.data;
}
