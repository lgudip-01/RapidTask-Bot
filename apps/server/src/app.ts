import type {
  CanvasConnect,
  CanvasConnection,
  HelloResponse,
  IntegrationStatus,
} from '@planner/shared';
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
import { cronRoutes } from './routes/cron';
import { captureRoutes } from './routes/capture';
import { eventRoutes } from './routes/events';
import { googleRoutes, type GoogleConnectDeps } from './routes/google';
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
  /** Canvas connected from Settings (when not configured by environment variables). */
  canvas?: {
    connection: () => Promise<CanvasConnection>;
    /** Checks the token with Canvas, saves it, and starts the first sync (`firstSync`). */
    connect?: (input: CanvasConnect) => Promise<{ name: string; firstSync: Promise<unknown> }>;
    disconnect?: () => Promise<void>;
  };
  /** Browser-based "Connect Google" (present when GOOGLE_CLIENT_ID/SECRET are set). */
  google?: GoogleConnectDeps;
  /**
   * Keeps work alive after the response (Vercel `waitUntil`). Without it, work after the response
   * just runs on the long-lived process.
   */
  background?: (work: Promise<unknown>) => void;
  /** Serverless heartbeat behind a bearer secret (/cron/tick). */
  cron?: { secret: string; tick: () => Promise<unknown> };
  /**
   * Live updates over Server-Sent Events need one long-lived process. False on serverless: the
   * stream answers 204 and the web UI polls instead.
   */
  streaming?: boolean;
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
    app.use(
      '/cron/*',
      ipRateLimit({
        limit: sec.webhookRateLimitPerMin,
        windowMs: 60_000,
        trustProxy: sec.trustProxy,
        name: 'cron',
        now: sec.now,
      }),
    );
    app.use(
      '/health',
      ipRateLimit({
        limit: sec.healthRateLimitPerMin ?? 60,
        windowMs: 60_000,
        trustProxy: sec.trustProxy,
        name: 'health',
        now: sec.now,
      }),
    );
    app.use('*', sameOriginWrites(sec.publicOrigin, sec.trustedOrigins));
    if (sec.publicOrigin)
      app.use(
        '/api/*',
        cors({ origin: [sec.publicOrigin, ...(sec.trustedOrigins ?? [])], credentials: true }),
      );
    app.use('*', requireAuth(sec.auth, sec.now));
    app.route('/', authRoutes(sec));
  }

  // Any successful write through the API means open UIs should refresh.
  app.use('/api/*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.res.status < 400) {
      const p = c.req.path;
      deps.changes?.emit(
        p.startsWith('/api/suggestions')
          ? 'suggestions'
          : p.startsWith('/api/settings')
            ? 'settings'
            : p.startsWith('/api/backups')
              ? 'backup'
              : 'items',
      );
    }
  });

  /** Live "something changed" notifications for the web UI. Carries no item content. */
  app.get('/api/stream', (c) =>
    deps.streaming === false
      ? c.body(null, 204)
      : streamSSE(c, async (stream) => {
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
  app.get('/health', async (c) => {
    try {
      await deps.db.run(sql`select 1`);
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
  app.route('/api/google', googleRoutes(deps));
  app.route('/api', canvasRoutes(deps));
  app.route('/api', captureRoutes(deps));
  app.route('/api', miscRoutes(deps));
  app.route('/webhooks', webhookRoutes(deps));
  app.route('/cron', cronRoutes(deps));
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
