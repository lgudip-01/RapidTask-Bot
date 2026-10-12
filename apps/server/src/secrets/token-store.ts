import { eq } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client';
import { secrets } from '../db/schema';

/** Stores small secrets (OAuth refresh tokens). Values are never logged. */
export interface TokenStore {
  readonly kind: 'keyring' | 'file' | 'db' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SERVICE = 'planner';

/** OS credential store: Windows Credential Manager, macOS Keychain, Linux Secret Service. */
export class KeyringTokenStore implements TokenStore {
  readonly kind = 'keyring';

  private async entry(key: string) {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(SERVICE, key);
  }

  async get(key: string) {
    return (await (await this.entry(key)).getPassword()) ?? null;
  }

  async set(key: string, value: string) {
    await (await this.entry(key)).setPassword(value);
  }

  async delete(key: string) {
    await (await this.entry(key)).deletePassword();
  }
}

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
}

function parseKey(base64Key: string) {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64');
  return key;
}

/** AES-256-GCM with the entry name bound as associated data. */
function seal(key: Buffer, name: string, value: string): EncryptedEntry {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(name));
  const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return {
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function open(key: Buffer, name: string, e: EncryptedEntry): string {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAAD(Buffer.from(name));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
}

/**
 * AES-256-GCM encrypted JSON file, for hosts without an OS keyring (servers, containers).
 * The 32-byte key comes from the environment; the entry name is bound as associated data.
 */
export class EncryptedFileTokenStore implements TokenStore {
  readonly kind = 'file';
  private readonly key: Buffer;

  constructor(
    private readonly file: string,
    base64Key: string,
  ) {
    this.key = parseKey(base64Key);
  }

  private async readAll(): Promise<Record<string, EncryptedEntry>> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')).entries ?? {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }

  private async writeAll(entries: Record<string, EncryptedEntry>) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ v: 1, entries }), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async get(key: string) {
    const e = (await this.readAll())[key];
    return e ? open(this.key, key, e) : null;
  }

  async set(key: string, value: string) {
    const all = await this.readAll();
    all[key] = seal(this.key, key, value);
    await this.writeAll(all);
  }

  async delete(key: string) {
    const all = await this.readAll();
    if (key in all) {
      delete all[key];
      await this.writeAll(all);
    }
  }
}

/**
 * Encrypted rows in the app database, for serverless hosts (no disk, no keyring). Same AES-256-GCM
 * scheme as the file store; the database only ever holds ciphertext.
 */
export class DbTokenStore implements TokenStore {
  readonly kind = 'db';
  private readonly key: Buffer;

  constructor(
    private readonly db: Db,
    base64Key: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.key = parseKey(base64Key);
  }

  async get(key: string) {
    const row = await this.db.select().from(secrets).where(eq(secrets.key, key)).get();
    return row ? open(this.key, key, JSON.parse(row.value) as EncryptedEntry) : null;
  }

  async set(key: string, value: string) {
    const sealed = JSON.stringify(seal(this.key, key, value));
    await this.db
      .insert(secrets)
      .values({ key, value: sealed, updatedAt: this.now() })
      .onConflictDoUpdate({ target: secrets.key, set: { value: sealed, updatedAt: this.now() } })
      .run();
  }

  async delete(key: string) {
    await this.db.delete(secrets).where(eq(secrets.key, key)).run();
  }
}

export class MemoryTokenStore implements TokenStore {
  readonly kind = 'memory';
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

export interface TokenStoreConfig {
  TOKEN_STORE: 'auto' | 'keyring' | 'file' | 'db';
  TOKEN_FILE_PATH: string;
  TOKEN_ENCRYPTION_KEY?: string;
}

/**
 * `auto`: OS keyring if it works here, else the encrypted file (requires TOKEN_ENCRYPTION_KEY).
 * `db`: encrypted rows in the app database (serverless; requires `db` and TOKEN_ENCRYPTION_KEY).
 */
export async function createTokenStore(cfg: TokenStoreConfig, db?: Db): Promise<TokenStore> {
  if (cfg.TOKEN_STORE === 'db') {
    if (!db || !cfg.TOKEN_ENCRYPTION_KEY) {
      throw new Error('TOKEN_ENCRYPTION_KEY is required for the database token store');
    }
    return new DbTokenStore(db, cfg.TOKEN_ENCRYPTION_KEY);
  }
  const file = () => {
    if (!cfg.TOKEN_ENCRYPTION_KEY) {
      throw new Error('TOKEN_ENCRYPTION_KEY is required for the encrypted file token store');
    }
    return new EncryptedFileTokenStore(cfg.TOKEN_FILE_PATH, cfg.TOKEN_ENCRYPTION_KEY);
  };
  if (cfg.TOKEN_STORE === 'file') return file();
  const keyring = new KeyringTokenStore();
  if (cfg.TOKEN_STORE === 'keyring') return keyring;
  try {
    await keyring.get('__probe__');
    return keyring;
  } catch {
    return file();
  }
}
