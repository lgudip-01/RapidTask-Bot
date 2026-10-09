/** A raw webhook request, as received (body unparsed, for signature checks). */
export interface InboundRequest {
  /** The public URL the provider called (needed for Twilio's signature). */
  url: string;
  headers: Headers;
  body: string;
}

export interface IncomingMessage {
  senderId: string;
  text: string;
  receivedAt: Date;
  /** Provider's id for this delivery; retries reuse it (dedupe key). */
  messageId: string;
}

/**
 * One messaging provider. `verifyRequest` must be checked before `parseIncoming`; `isAllowed`
 * enforces the owner allowlist; `reply` sends plain text back to a sender.
 */
export interface InboundChannel {
  readonly name: 'telegram' | 'twilio';
  verifyRequest(req: InboundRequest): boolean;
  /** Null for updates we ignore (non-text, edits, service messages). */
  parseIncoming(req: InboundRequest): IncomingMessage | null;
  isAllowed(msg: IncomingMessage): boolean;
  reply(senderId: string, text: string): Promise<void>;
  /** The HTTP response the provider expects as an immediate acknowledgement. */
  ack(): { body: string; contentType: string };
}
