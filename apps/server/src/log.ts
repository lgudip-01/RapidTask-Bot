/**
 * Minimal structured logger. Callers pass only non-sensitive fields:
 * never tokens, secrets, message bodies, or full URLs with query strings.
 */
type Fields = Record<string, string | number | boolean | null | undefined>;

function write(level: 'info' | 'warn' | 'error', msg: string, fields?: Fields) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'info') process.stdout.write(line + '\n');
  else process.stderr.write(line + '\n');
}

export const log = {
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};

/**
 * Turns an error into a short string that is safe to log or store: strips bearer tokens,
 * credential-like query parameters, and known token shapes (Google, Telegram).
 */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return raw
    .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
    .replace(
      /([?&](?:access_token|refresh_token|token|key|secret|code|signature|client_secret)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .replace(/\bya29\.[\w.-]+/g, '[redacted]')
    .replace(/\b1\/\/[\w.-]+/g, '[redacted]')
    .replace(/\b\d{6,}:[\w-]{30,}\b/g, '[redacted]')
    .slice(0, 500);
}
