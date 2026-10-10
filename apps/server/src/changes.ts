import { EventEmitter } from 'node:events';

export type ChangeTopic = 'items' | 'suggestions' | 'sync' | 'backup' | 'settings';
export interface ChangeEvent {
  seq: number;
  topic: ChangeTopic;
  at: string;
}

/**
 * In-process notification that data changed (a text was captured, a sync landed, something was
 * edited). The web UI listens over Server-Sent Events and refreshes. Carries no content.
 */
export class ChangeBus {
  private readonly em = new EventEmitter();
  private seq = 0;

  constructor() {
    this.em.setMaxListeners(100);
  }

  emit(topic: ChangeTopic) {
    this.em.emit('change', { seq: ++this.seq, topic, at: new Date().toISOString() });
  }

  subscribe(fn: (e: ChangeEvent) => void): () => void {
    this.em.on('change', fn);
    return () => this.em.off('change', fn);
  }
}
