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
