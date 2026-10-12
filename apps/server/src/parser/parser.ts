import { ParsedMessageSchema } from '@planner/shared';
import { log, sanitizeError } from '../log';
import { ExtractorOutputError, ExtractorRefusalError, type LlmExtractor } from './claude-extractor';
import { tryFastParse } from './fast-path';
import { OutOfRangeError, resolveParsed, type ResolvedCapture } from './resolve';

export const MAX_MESSAGE_CHARS = 500;
export const CLARIFICATION_TTL_MS = 10 * 60_000;
const MAX_CLARIFICATION_ROUNDS = 2;
const MIN_CONFIDENCE = 0.5;
const LOW_CONFIDENCE_QUESTION = "I'm not sure I got that. What should I add, and when?";

export type ParseOutcome =
  | { type: 'capture'; item: ResolvedCapture; confidence: number; via: 'fast' | 'llm' }
  | { type: 'clarify'; question: string; proposedTitle: string | null; confidence: number }
  | { type: 'off_topic' }
  | {
      type: 'error';
      reason:
        | 'too_long'
        | 'llm_disabled'
        | 'unavailable'
        | 'refused'
        | 'invalid_output'
        | 'out_of_range'
        | 'unresolved';
    };

interface Pending {
  /** Raw text kept in memory only, for at most CLARIFICATION_TTL_MS. Never persisted. */
  earlierText: string;
  question: string;
  rounds: number;
  expiresAt: number;
}

export interface MessageParserOptions {
  llm: LlmExtractor | null;
  /** Runtime switch (the "AI triage" setting). Defaults to on. */
  llmEnabled?: () => boolean | Promise<boolean>;
  timeZone: string;
  now: () => Date;
}

/**
 * Text → validated capture. Obvious messages take the deterministic fast path; the rest go to
 * the model, whose output must pass ParsedMessageSchema. A clarifying question is held per
 * sender for 10 minutes, and the next message from that sender is read as the answer.
 */
export class MessageParser {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: MessageParserOptions) {}

  hasPending(sender: string) {
    return this.getPending(sender) !== null;
  }

  clearPending(sender: string) {
    this.pending.delete(sender);
  }

  private getPending(sender: string): Pending | null {
    const p = this.pending.get(sender);
    if (!p) return null;
    if (p.expiresAt <= this.opts.now().getTime()) {
      this.pending.delete(sender);
      return null;
    }
    return p;
  }

  async parse(
    sender: string,
    rawText: string,
    opts: { allowLlm?: boolean } = {},
  ): Promise<ParseOutcome> {
    const text = rawText.trim();
    if (!text) return { type: 'off_topic' };
    if (text.length > MAX_MESSAGE_CHARS) return { type: 'error', reason: 'too_long' };
    const now = this.opts.now();
    const pending = this.getPending(sender);

    if (!pending) {
      const fast = tryFastParse(text, now, this.opts.timeZone);
      if (fast) return this.toCapture(fast, 'fast', now);
    }
    const llm =
      this.opts.llm && opts.allowLlm !== false && ((await this.opts.llmEnabled?.()) ?? true)
        ? this.opts.llm
        : null;
    if (!llm) return { type: 'error', reason: 'llm_disabled' };

    let raw: unknown;
    try {
      raw = await llm.extract({
        text,
        now,
        timeZone: this.opts.timeZone,
        clarification: pending
          ? { earlierText: pending.earlierText, question: pending.question }
          : undefined,
      });
    } catch (e) {
      if (e instanceof ExtractorRefusalError) return { type: 'error', reason: 'refused' };
      if (e instanceof ExtractorOutputError) return { type: 'error', reason: 'invalid_output' };
      log.warn('parser llm call failed', { error: sanitizeError(e) });
      return { type: 'error', reason: 'unavailable' };
    }

    const parsed = ParsedMessageSchema.safeParse(raw);
    if (!parsed.success) {
      // Field paths only; never the content.
      log.warn('parser output rejected', {
        issues: parsed.error.issues.map((i) => i.path.join('.') || i.message).join(','),
      });
      return { type: 'error', reason: 'invalid_output' };
    }
    const p = parsed.data;

    if (p.kind === 'off_topic') {
      this.pending.delete(sender);
      return { type: 'off_topic' };
    }
    if (p.kind === 'needs_clarification' || p.confidence < MIN_CONFIDENCE) {
      const rounds = (pending?.rounds ?? 0) + 1;
      if (rounds > MAX_CLARIFICATION_ROUNDS) {
        this.pending.delete(sender);
        return { type: 'error', reason: 'unresolved' };
      }
      const question =
        (p.kind === 'needs_clarification' && p.clarifyingQuestion) || LOW_CONFIDENCE_QUESTION;
      this.pending.set(sender, {
        earlierText: pending ? `${pending.earlierText}\n${text}` : text,
        question,
        rounds,
        expiresAt: now.getTime() + CLARIFICATION_TTL_MS,
      });
      return { type: 'clarify', question, proposedTitle: p.title, confidence: p.confidence };
    }

    this.pending.delete(sender);
    return this.toCapture(p, 'llm', now);
  }

  private toCapture(
    p: Parameters<typeof resolveParsed>[0],
    via: 'fast' | 'llm',
    now: Date,
  ): ParseOutcome {
    try {
      return {
        type: 'capture',
        item: resolveParsed(p, this.opts.timeZone, now),
        confidence: p.confidence,
        via,
      };
    } catch (e) {
      if (e instanceof OutOfRangeError) return { type: 'error', reason: 'out_of_range' };
      throw e;
    }
  }
}
