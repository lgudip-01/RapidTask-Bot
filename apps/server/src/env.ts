import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_TIMEZONE: z.string().default('America/New_York'),
  DATABASE_PATH: z.string().default('./data/planner.db'),

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
