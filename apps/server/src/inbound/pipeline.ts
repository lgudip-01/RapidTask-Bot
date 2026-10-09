import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import { captures, inboundMessages, suggestions, tasks } from '../db/schema';
import { log, sanitizeError } from '../log';
import type { MessageParser, ParseOutcome } from '../parser/parser';
import { HELP_TEXT, OFF_TOPIC_TEXT, parseCommand, type Command } from './commands';
import type { ItemCreator } from './creator';
import { confirmationText, plain } from './format';
import { LogThrottle, SlidingWindowLimiter } from './rate-limit';
import { buildTodayList } from './today';
import type { InboundChannel, IncomingMessage } from './types';

const UNDO_WINDOW_MS = 24 * 60 * 60_000;
const TODAY_SNAPSHOT_MS = 30 * 60_000;

const ERROR_REPLIES: Record<Extract<ParseOutcome, { type: 'error' }>['reason'], string> = {
  too_long: 'That message is too long. Send one task or event at a time.',
  llm_disabled: 'I couldn\'t find a date in that. Try something like "dentist tues 3pm".',
  unavailable: "I couldn't process that right now. Please try again in a minute.",
  refused: "Sorry, I couldn't read that one. Try rephrasing it as a task or event.",
  invalid_output: "Sorry, I couldn't read that one. Try rephrasing it as a task or event.",
  out_of_range: 'That date looks off (more than two years out, or in the past). Try again?',
  unresolved: 'I still couldn\'t pin that down. Try "title + day + time".',
};

export interface InboundPipelineOptions {
  db: Db;
  parser: MessageParser;
  creator: ItemCreator;
  timeZone: string;
  now: () => Date;
  /** Messages per sender per window. */
  rateLimit?: { limit: number; windowMs: number };
}

/**
 * Processes verified provider messages: allowlist → dedupe → rate limit → command or capture →
 * reply. Messages from one sender are handled in order. Never stores message text.
 */
export class InboundPipeline {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly limiter: SlidingWindowLimiter;
  private readonly drops: LogThrottle;
  private readonly todaySnapshots = new Map<string, { taskIds: string[]; at: number }>();
  private readonly pendingSuggestion = new Map<string, string>();

  constructor(private readonly o: InboundPipelineOptions) {
    const now = () => o.now().getTime();
    this.limiter = new SlidingWindowLimiter(
      o.rateLimit?.limit ?? 20,
      o.rateLimit?.windowMs ?? 10 * 60_000,
      now,
    );
    this.drops = new LogThrottle(60_000, now);
  }

  /** Logs a dropped request at most once a minute per reason (no content, no sender). */
  logDrop(reason: string, channel: string) {
    const suppressed = this.drops.hit(`${channel}:${reason}`);
    if (suppressed !== null)
      log.warn('inbound dropped', { channel, reason, suppressedSinceLast: suppressed });
  }

  /** Queue a verified message. Never throws; resolves when this message is done. */
  submit(channel: InboundChannel, msg: IncomingMessage): Promise<void> {
    const key = `${channel.name}:${msg.senderId}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev
      .then(() => this.handle(channel, msg))
      .catch((e) =>
        log.error('inbound handling failed', { channel: channel.name, error: sanitizeError(e) }),
      );
    this.chains.set(key, run);
    this.inflight.add(run);
    void run.finally(() => {
      this.inflight.delete(run);
      if (this.chains.get(key) === run) this.chains.delete(key);
    });
    return run;
  }

  /** Resolves when every queued message has been handled (tests, shutdown). */
  async idle() {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private async handle(channel: InboundChannel, msg: IncomingMessage) {
    if (!channel.isAllowed(msg)) {
      this.logDrop('not_allowlisted', channel.name);
      return;
    }

    // Dedupe: providers retry deliveries with the same id.
    const inboundId = randomUUID();
    const inserted = this.o.db
      .insert(inboundMessages)
      .values({
        id: inboundId,
        channel: channel.name,
        providerMessageId: msg.messageId,
        receivedAt: msg.receivedAt,
        textLength: msg.text.length,
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) {
      this.logDrop('duplicate', channel.name);
      return;
    }

    const sender = `${channel.name}:${msg.senderId}`;
    const finish = (outcome: string, via: string | null = null) =>
      this.o.db
        .update(inboundMessages)
        .set({ outcome, via, processedAt: this.o.now() })
        .where(eq(inboundMessages.id, inboundId))
        .run();
    const reply = async (text: string) => {
      try {
        await channel.reply(msg.senderId, text);
      } catch (e) {
        log.warn('inbound reply failed', { channel: channel.name, error: sanitizeError(e) });
      }
    };

    if (!this.limiter.allow(sender)) {
      finish('rate_limited');
      this.logDrop('rate_limited', channel.name);
      return;
    }

    const command = parseCommand(msg.text);
    if (command) {
      this.o.parser.clearPending(sender);
      const text = await this.runCommand(command, sender);
      finish(`command_${command.type}`);
      await reply(text);
      return;
    }

    const out = await this.o.parser.parse(sender, msg.text);
    switch (out.type) {
      case 'capture': {
        const created = await this.o.creator.create(out.item);
        const now = this.o.now();
        this.o.db
          .insert(captures)
          .values({
            id: randomUUID(),
            inboundId,
            kind: created.kind,
            source: created.source,
            itemId: created.itemId,
            externalId: created.externalId,
            title: created.title,
            createdAt: now,
          })
          .run();
        this.resolveSuggestion(sender, 'accepted');
        finish(`created_${created.kind}`, out.via);
        await reply(confirmationText(out.item, this.o.timeZone, created.fallbackNote));
        return;
      }
      case 'clarify': {
        if (out.proposedTitle && !this.pendingSuggestion.has(sender)) {
          const id = randomUUID();
          this.o.db
            .insert(suggestions)
            .values({
              id,
              sourceMessageRef: `${channel.name}:${msg.messageId}`,
              proposedTitle: plain(out.proposedTitle),
              confidence: out.confidence,
              createdAt: this.o.now(),
            })
            .run();
          this.pendingSuggestion.set(sender, id);
        }
        finish('clarify', 'llm');
        await reply(plain(out.question));
        return;
      }
      case 'off_topic':
        this.pendingSuggestion.delete(sender);
        finish('off_topic');
        await reply(OFF_TOPIC_TEXT);
        return;
      case 'error':
        this.pendingSuggestion.delete(sender);
        finish(`error_${out.reason}`);
        await reply(ERROR_REPLIES[out.reason]);
        return;
    }
  }

  private resolveSuggestion(sender: string, status: 'accepted' | 'dismissed') {
    const id = this.pendingSuggestion.get(sender);
    if (!id) return;
    this.o.db.update(suggestions).set({ status }).where(eq(suggestions.id, id)).run();
    this.pendingSuggestion.delete(sender);
  }

  private async runCommand(c: Command, sender: string): Promise<string> {
    const { db, now, timeZone } = this.o;
    switch (c.type) {
      case 'help':
        return HELP_TEXT;
      case 'today': {
        const list = buildTodayList(db, now(), timeZone);
        this.todaySnapshots.set(sender, { taskIds: list.taskIds, at: now().getTime() });
        return list.text;
      }
      case 'undo': {
        const since = new Date(now().getTime() - UNDO_WINDOW_MS);
        const last = db
          .select()
          .from(captures)
          .where(and(isNull(captures.undoneAt), gt(captures.createdAt, since)))
          .orderBy(desc(captures.createdAt))
          .get();
        if (!last) return 'Nothing to undo.';
        await this.o.creator.remove(last);
        db.update(captures).set({ undoneAt: now() }).where(eq(captures.id, last.id)).run();
        return `Removed: ${last.title}`;
      }
      case 'done': {
        const snap = this.todaySnapshots.get(sender);
        const ids =
          snap && now().getTime() - snap.at < TODAY_SNAPSHOT_MS
            ? snap.taskIds
            : buildTodayList(db, now(), timeZone).taskIds;
        const id = ids[c.n - 1];
        if (!id) return `There's no task ${c.n} on today's list. Send TODAY to see it.`;
        const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
        if (!task) return 'That task no longer exists. Send TODAY for a fresh list.';
        if (task.status === 'done') return `Already done: ${task.title}`;
        await this.o.creator.complete(task);
        return `Done: ${task.title} ✓`;
      }
    }
  }
}
