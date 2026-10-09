import { CaptureRequestSchema, type ParsePreview } from '@planner/shared';
import { Hono } from 'hono';
import type { AppDeps } from '../app';
import { describeWhen } from '../inbound/format';
import { badRequest, readJson } from '../http';
import type { ParseOutcome } from '../parser/parser';

const ERROR_MESSAGES: Record<string, string> = {
  too_long: 'Too long — one task or event at a time.',
  llm_disabled: 'Add a date or time, e.g. "physics lab report fri 5pm".',
  unavailable: 'The parser is unavailable right now.',
  refused: "Couldn't read that. Try rephrasing.",
  invalid_output: "Couldn't read that. Try rephrasing.",
  out_of_range: 'That date looks off.',
  unresolved: "Couldn't pin that down. Try title + day + time.",
};

export function toPreview(o: ParseOutcome, timeZone: string): ParsePreview {
  switch (o.type) {
    case 'capture': {
      const i = o.item;
      const summary = describeWhen(i, timeZone);
      return i.kind === 'event'
        ? {
            type: 'capture',
            kind: 'event',
            title: i.title,
            start: i.start.toISOString(),
            end: i.end.toISOString(),
            due: null,
            allDay: i.allDay,
            via: o.via,
            summary,
          }
        : {
            type: 'capture',
            kind: 'task',
            title: i.title,
            start: null,
            end: null,
            due: i.due?.toISOString() ?? null,
            allDay: i.dueAllDay,
            via: o.via,
            summary,
          };
    }
    case 'clarify':
      return { type: 'clarify', question: o.question };
    case 'off_topic':
      return { type: 'off_topic' };
    case 'error':
      return {
        type: 'error',
        reason: o.reason,
        message: ERROR_MESSAGES[o.reason] ?? 'Could not parse.',
      };
  }
}

/** Natural-language quick-add for the web UI, using the same parser as inbound messages. */
export function captureRoutes({ capture, timeZone }: AppDeps) {
  const app = new Hono();
  const unavailable = { error: 'capture_not_configured' } as const;

  /** Side-effect-free preview while typing. `llm: false` keeps it free and instant. */
  app.post('/parse', async (c) => {
    if (!capture) return c.json(unavailable, 503);
    const body = CaptureRequestSchema.safeParse(await readJson(c));
    if (!body.success) return badRequest(c, body.error);
    const sender = 'web-preview';
    const out = await capture.parser.parse(sender, body.data.text, {
      allowLlm: body.data.llm ?? false,
    });
    capture.parser.clearPending(sender);
    return c.json<{ preview: ParsePreview }>({ preview: toPreview(out, timeZone) });
  });

  /** Parse and create. A clarifying question is held like an inbound one (answer with another POST). */
  app.post('/capture', async (c) => {
    if (!capture) return c.json(unavailable, 503);
    const body = CaptureRequestSchema.safeParse(await readJson(c));
    if (!body.success) return badRequest(c, body.error);
    const out = await capture.parser.parse('web', body.data.text);
    const preview = toPreview(out, timeZone);
    if (out.type !== 'capture') return c.json({ preview, created: null }, 422);
    const created = await capture.creator.create(out.item);
    return c.json({ preview, created }, 201);
  });

  return app;
}
