export type Command =
  { type: 'undo' } | { type: 'today' } | { type: 'help' } | { type: 'done'; n: number };

/** Exact-match commands only; anything else is a capture attempt. */
export function parseCommand(text: string): Command | null {
  const t = text
    .trim()
    .replace(/[.!]+$/, '')
    .toUpperCase();
  if (t === 'UNDO') return { type: 'undo' };
  if (t === 'TODAY') return { type: 'today' };
  if (t === 'HELP' || t === 'COMMANDS') return { type: 'help' };
  const done = /^DONE\s+#?(\d{1,3})$/.exec(t);
  if (done) return { type: 'done', n: Number(done[1]) };
  return null;
}

export const HELP_TEXT = [
  'I add tasks and events from your texts.',
  '• "dentist tues 3pm" → calendar',
  '• "essay due fri" → task',
  'Commands: TODAY (agenda), DONE <n> (check off), UNDO (remove last), HELP',
].join('\n');

export const OFF_TOPIC_TEXT = 'I can only add tasks and events. Send HELP for examples.';
