import { waitUntil } from '@vercel/functions';
import { loadEnv } from './env';
import { log, sanitizeError } from './log';
import { createRuntime, type Runtime } from './runtime';

/**
 * Vercel function entry (bundled to dist/vercel.js; `api/index.js` re-exports it). One runtime per
 * warm instance, built on the first request. No timers or polling here: Telegram arrives by
 * webhook and periodic work runs from /cron/tick.
 */
let runtime: Promise<Runtime> | null = null;

function getRuntime() {
  runtime ??= createRuntime(loadEnv(), { background: (work) => waitUntil(work) }).catch((e) => {
    runtime = null; // retry on the next request
    log.error('startup failed', { error: sanitizeError(e) });
    throw e;
  });
  return runtime;
}

async function handle(request: Request): Promise<Response> {
  try {
    return await (await getRuntime()).app.fetch(request);
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
