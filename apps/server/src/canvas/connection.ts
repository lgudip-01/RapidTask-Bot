import { CanvasClient, type CanvasClientOptions } from '@planner/canvas';
import type { TokenStore } from '../secrets/token-store';
import type { SyncSource } from '../sync/types';

export const CANVAS_CONNECTION_KEY = 'canvas.connection';

export interface CanvasCredentials {
  /** Origin only, e.g. https://school.instructure.com */
  baseUrl: string;
  token: string;
}

/** Hostnames a Canvas address may never point at (the server would be calling itself or a LAN). */
function isPrivateHost(host: string) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith('[')
  );
}

/** Normalizes what the owner typed ("school.instructure.com/courses") to an https origin. */
export function canvasOrigin(input: string): string {
  const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (u.protocol !== 'https:') throw new Error('Canvas address must use https');
  if (isPrivateHost(u.hostname)) throw new Error('That is not a Canvas address');
  return u.origin;
}

/**
 * A Canvas connection made from Settings (instead of CANVAS_BASE_URL/CANVAS_TOKEN). The token is
 * kept in the encrypted token store, never in plain settings, and only ever sent to `baseUrl`.
 */
export class CanvasConnectionStore {
  constructor(
    private readonly store: TokenStore,
    private readonly clientOptions: Partial<CanvasClientOptions> = {},
  ) {}

  async get(): Promise<CanvasCredentials | null> {
    const raw = await this.store.get(CANVAS_CONNECTION_KEY);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as CanvasCredentials;
      return c.baseUrl && c.token ? c : null;
    } catch {
      return null;
    }
  }

  /** Checks the address and token with Canvas (GET /users/self), then saves them. */
  async connect(input: { baseUrl: string; token: string }): Promise<{ name: string }> {
    const creds = { baseUrl: canvasOrigin(input.baseUrl), token: input.token.trim() };
    const me = await new CanvasClient({ ...this.clientOptions, ...creds }).getSelf();
    await this.store.set(CANVAS_CONNECTION_KEY, JSON.stringify(creds));
    return { name: me.name };
  }

  async disconnect() {
    await this.store.delete(CANVAS_CONNECTION_KEY);
  }
}

/**
 * Keeps the scheduler's Canvas source in step with the stored connection. Serverless instances
 * start at different times, so each one re-checks before periodic work (`refresh`).
 */
export class CanvasRegistration {
  private current: string | null = null;

  constructor(
    private readonly connections: CanvasConnectionStore,
    private readonly scheduler: {
      addSource(s: SyncSource): void;
      removeSource(name: string): void;
    },
    private readonly makeSource: (c: CanvasCredentials) => SyncSource,
  ) {}

  /** Registers, replaces, or removes the Canvas source to match storage. */
  async refresh(): Promise<boolean> {
    const c = await this.connections.get();
    const id = c ? `${c.baseUrl}#${c.token.slice(-6)}` : null;
    if (id === this.current) return c !== null;
    this.scheduler.removeSource('canvas');
    if (c) this.scheduler.addSource(this.makeSource(c));
    this.current = id;
    return c !== null;
  }
}
