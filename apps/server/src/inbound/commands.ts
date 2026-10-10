export type Command =
  { type: 'undo' } | { type: 'today' } | { type: 'help' } | { type: 'done'; n: number };

/** Exact-match commands only; anything else is a capture attempt. */
export function parseCommand(text: string): Command | null {
  const t = text
    .trim()
    .replace(/[.!]+$/, '')
    .replace(/^\/(\w+)(@\w+)?/, '$1') // "/done@PlannerBot 2" → "done 2"
    .toUpperCase();
  if (t === 'UNDO') return { type: 'undo' };
  if (t === 'TODAY') return { type: 'today' };
  if (t === 'HELP' || t === 'COMMANDS' || t === 'START') return { type: 'help' };
  const done = /^DONE\s+#?(\d{1,3})$/.exec(t);
  if (done) return { type: 'done', n: Number(done[1]) };
  return null;
}

export const HELP_TEXT = [
  'I add tasks and events to your Planner from your texts.',
  '• "dentist tues 3pm" → event',
  '• "essay due fri" → task',
  'Commands: /today (agenda), /done <n> (check off), /undo (remove last), /help',
].join('\n');

export const OFF_TOPIC_TEXT = 'I can only add tasks and events. Send HELP for examples.';
