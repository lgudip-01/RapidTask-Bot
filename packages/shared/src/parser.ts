import { z } from 'zod';

/**
 * What the message parser may output, and nothing else. Times are *local wall-clock* strings in
 * the owner's time zone ("YYYY-MM-DD" for dates, "YYYY-MM-DDTHH:mm" for times); the server converts
 * them to UTC. Message text is untrusted, so this schema is the only channel from parser to app.
 */
export const PARSED_KINDS = ['event', 'task', 'needs_clarification', 'off_topic'] as const;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function isRealDate(y: number, m: number, d: number) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const LocalDateSchema = z
  .string()
  .regex(LOCAL_DATE)
  .refine((s) => {
    const m = LOCAL_DATE.exec(s);
    return !!m && isRealDate(+m[1]!, +m[2]!, +m[3]!);
  }, 'not a real calendar date');

export const LocalDateTimeSchema = z
  .string()
  .regex(LOCAL_DATE_TIME)
  .refine((s) => {
    const m = LOCAL_DATE_TIME.exec(s);
    return !!m && isRealDate(+m[1]!, +m[2]!, +m[3]!) && +m[4]! < 24 && +m[5]! < 60;
  }, 'not a real date-time');

const When = z.union([LocalDateSchema, LocalDateTimeSchema]);
const isDateOnly = (s: string) => s.length === 10;

export const ParsedMessageSchema = z
  .object({
    kind: z.enum(PARSED_KINDS),
    title: z.string().trim().min(1).max(200).nullable(),
    start: When.nullable(),
    end: When.nullable(),
    due: When.nullable(),
    allDay: z.boolean(),
    notes: z.string().trim().max(500).nullable(),
    confidence: z.number().min(0).max(1),
    clarifyingQuestion: z.string().trim().min(1).max(160).nullable(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    switch (p.kind) {
      case 'event':
        if (!p.title || !p.start || !p.end) issue('event needs title, start, end');
        if (p.due !== null) issue('event has no due');
        if (p.start && p.end && isDateOnly(p.start) !== isDateOnly(p.end)) issue('start/end mixed');
        if (p.start && isDateOnly(p.start) !== p.allDay) issue('allDay must match start format');
        break;
      case 'task':
        if (!p.title) issue('task needs title');
        if (p.start !== null || p.end !== null) issue('task has no start/end');
        if (p.due && isDateOnly(p.due) !== p.allDay) issue('allDay must match due format');
        break;
      case 'needs_clarification':
        if (!p.clarifyingQuestion) issue('clarification needs a question');
        break;
      case 'off_topic':
        if (p.title || p.start || p.end || p.due || p.clarifyingQuestion) {
          issue('off_topic carries no fields');
        }
        break;
    }
    if (p.kind !== 'needs_clarification' && p.clarifyingQuestion !== null) {
      issue('only needs_clarification may ask a question');
    }
  });
export type ParsedMessage = z.infer<typeof ParsedMessageSchema>;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

/** JSON Schema sent as the structured-output format. zod re-validates every response. */
export const PARSED_MESSAGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'title',
    'start',
    'end',
    'due',
    'allDay',
    'notes',
    'confidence',
    'clarifyingQuestion',
  ],
  properties: {
    kind: { type: 'string', enum: [...PARSED_KINDS] },
    title: nullable({ type: 'string' }),
    start: nullable({ type: 'string', description: 'YYYY-MM-DD or YYYY-MM-DDTHH:mm, local' }),
    end: nullable({ type: 'string', description: 'YYYY-MM-DD (exclusive) or YYYY-MM-DDTHH:mm' }),
    due: nullable({ type: 'string', description: 'YYYY-MM-DD or YYYY-MM-DDTHH:mm, local' }),
    allDay: { type: 'boolean' },
    notes: nullable({ type: 'string' }),
    confidence: { type: 'number' },
    clarifyingQuestion: nullable({ type: 'string' }),
  },
} as const;
