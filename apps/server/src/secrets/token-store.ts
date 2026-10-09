import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Stores small secrets (OAuth refresh tokens). Values are never logged. */
export interface TokenStore {
  readonly kind: 'keyring' | 'file' | 'memory';
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
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64');
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
    if (!e) return null;
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'base64'));
    d.setAAD(Buffer.from(key));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
  }

  async set(key: string, value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(key));
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    const all = await this.readAll();
    all[key] = {
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
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
  TOKEN_STORE: 'auto' | 'keyring' | 'file';
  TOKEN_FILE_PATH: string;
  TOKEN_ENCRYPTION_KEY?: string;
}

/** `auto`: OS keyring if it works here, else the encrypted file (requires TOKEN_ENCRYPTION_KEY). */
export async function createTokenStore(cfg: TokenStoreConfig): Promise<TokenStore> {
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
