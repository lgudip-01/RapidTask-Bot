import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadEnv } from './env';
import { log } from './log';

const env = loadEnv();
const app = createApp();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info('server listening', { port: info.port, env: env.NODE_ENV });
});
