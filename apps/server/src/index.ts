import { serve } from '@hono/node-server';
import { loadEnv } from './env';
import { log, sanitizeError } from './log';
import { createRuntime } from './runtime';

// Never let a crash print an unsanitized error (which could carry a token or message text).
process.on('uncaughtException', (e) => {
  log.error('uncaught exception', { error: sanitizeError(e) });
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log.error('unhandled rejection', { error: sanitizeError(e) });
});

/** Long-running Node server (local development, or any host with a disk): in-process timers. */
const env = loadEnv();
const rt = await createRuntime(env);

await rt.scheduler.start();
void rt.backups?.start();
rt.notifier?.start();
rt.inbound?.poller?.start();
serve({ fetch: rt.app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  log.info('server listening', {
    host: info.address,
    port: info.port,
    env: env.NODE_ENV,
    sources: rt.sources.length,
  });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    rt.scheduler.stop();
    rt.backups?.stop();
    rt.notifier?.stop();
    rt.inbound?.poller?.stop();
    process.exit(0);
  });
}
