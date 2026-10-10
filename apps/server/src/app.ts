import type { HelloResponse, IntegrationStatus } from '@planner/shared';
import { serveStatic } from '@hono/node-server/serve-static';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupService } from './backup/backup';
import type { ChangeBus } from './changes';
import type { Db } from './db/client';
import type { ItemCreator } from './inbound/creator';
import type { InboundPipeline } from './inbound/pipeline';
import type { InboundChannel } from './inbound/types';
import { log, sanitizeError } from './log';
import type { MessageParser } from './parser/parser';
import { agendaRoutes } from './routes/agenda';
import { authRoutes } from './routes/auth';
import { backupRoutes } from './routes/backups';
import { canvasRoutes } from './routes/canvas';
import { captureRoutes } from './routes/capture';
import { eventRoutes } from './routes/events';
import { miscRoutes } from './routes/misc';
import { suggestionRoutes } from './routes/suggestions';
import { syncRoutes } from './routes/sync';
import { taskRoutes } from './routes/tasks';
import { webhookRoutes } from './routes/webhooks';
import {
  httpsOnly,
  ipRateLimit,
  requireAuth,
  sameOriginWrites,
  securityHeaders,
  type SecurityConfig,
} from './security/middleware';
import type { SettingsStore } from './settings';
import type { SyncScheduler } from './sync/scheduler';

export interface AppDeps {
  db: Db;
  scheduler: SyncScheduler;
  now: () => Date;
  timeZone: string;
  settings: SettingsStore;
  /** Notifies open web UIs that data changed (Server-Sent Events). */
  changes?: ChangeBus;
  backups?: BackupService;
  /** Reported to the UI; the write path is not implemented (Google is read-only). */
  writeEventsToGoogle?: boolean;
  /** Present when at least one messaging channel is configured. */
  inbound?: {
    pipeline: InboundPipeline;
    channels: Partial<Record<'telegram' | 'twilio', InboundChannel>>;
  };
  /** Natural-language quick-add and suggestion acceptance from the web UI. */
  capture?: { parser: MessageParser; creator: ItemCreator };
  integrations?: () => Promise<IntegrationStatus[]>;
  disconnectGoogle?: () => Promise<void>;
  /** Auth, headers, and rate limits. Omitted in tests and local dev (no auth). */
  security?: SecurityConfig;
  /** Built web UI to serve (production). */
  webDist?: string;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.onError((err, c) => {
    log.error('unhandled', { path: c.req.path, error: sanitizeError(err) });
    return c.json({ error: 'internal_error' }, 500);
  });

  const sec = deps.security;
  if (sec) {
    app.use('*', securityHeaders(sec.publicOrigin));
    app.use('*', httpsOnly(sec.trustProxy));
    app.use(
      '/webhooks/*',
      ipRateLimit({
        limit: sec.webhookRateLimitPerMin,
        windowMs: 60_000,
        trustProxy: sec.trustProxy,
        name: 'webhooks',
        now: sec.now,
      }),
    );
    app.use('*', sameOriginWrites(sec.publicOrigin));
    if (sec.publicOrigin)
      app.use('/api/*', cors({ origin: [sec.publicOrigin], credentials: true }));
    app.use('*', requireAuth(sec.auth, sec.now));
    app.route('/', authRoutes(sec));
  }

  // Any successful write through the API means open UIs should refresh.
  app.use('/api/*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.res.status < 400) {
      deps.changes?.emit(c.req.path.startsWith('/api/suggestions') ? 'suggestions' : 'items');
    }
  });

  /** Live "something changed" notifications for the web UI. Carries no item content. */
  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const off = deps.changes?.subscribe((e) => {
        void stream.writeSSE({ event: 'change', id: String(e.seq), data: JSON.stringify(e) });
      });
      stream.onAbort(() => off?.());
      while (!stream.aborted && !stream.closed) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(25_000);
      }
      off?.();
    }),
  );

  /** Liveness + database check for the platform health check (no auth, no details). */
  app.get('/healthz', (c) => {
    try {
      deps.db.run(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.get('/api/hello', (c) =>
    c.json<HelloResponse>({ message: 'Hello from Planner', time: deps.now().toISOString() }),
  );
  app.route('/api/agenda', agendaRoutes(deps));
  app.route('/api/tasks', taskRoutes(deps));
  app.route('/api/sync', syncRoutes(deps));
  app.route('/api/events', eventRoutes(deps));
  app.route('/api/backups', backupRoutes(deps));
  app.route('/api/suggestions', suggestionRoutes(deps));
  app.route('/api', canvasRoutes(deps));
  app.route('/api', captureRoutes(deps));
  app.route('/api', miscRoutes(deps));
  app.route('/webhooks', webhookRoutes(deps));
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  if (deps.webDist) {
    const root = path.relative(process.cwd(), deps.webDist) || '.';
    const indexHtml = fs.readFileSync(path.join(deps.webDist, 'index.html'), 'utf8');
    app.use('/assets/*', async (c, next) => {
      await next();
      // Hashed file names: safe to cache forever.
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    app.use('/*', serveStatic({ root }));
    // SPA fallback for client-side views.
    app.get('*', (c) => c.html(indexHtml, 200, { 'Cache-Control': 'no-cache' }));
  }

  return app;
}
