import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps } from '../app';
import type { InboundChannel, InboundRequest } from '../inbound/types';

/**
 * The only unauthenticated routes. Each request must carry a valid provider signature; the
 * message is acknowledged immediately and processed asynchronously by the pipeline.
 */
export function webhookRoutes({ inbound }: AppDeps) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.body(null, 413) }));

  const handle = (name: 'telegram' | 'twilio') =>
    app.post(`/${name}`, async (c) => {
      const channel: InboundChannel | undefined = inbound?.channels[name];
      if (!inbound || !channel) return c.body(null, 404);
      const req: InboundRequest = {
        url: c.req.url,
        headers: c.req.raw.headers,
        body: await c.req.text(),
      };
      if (!channel.verifyRequest(req)) {
        inbound.pipeline.logDrop('bad_signature', name);
        return c.body(null, 403);
      }
      const msg = channel.parseIncoming(req);
      if (msg) void inbound.pipeline.submit(channel, msg);
      const ack = channel.ack();
      return c.body(ack.body, 200, { 'content-type': ack.contentType });
    });

  handle('telegram');
  handle('twilio');
  return app;
}
