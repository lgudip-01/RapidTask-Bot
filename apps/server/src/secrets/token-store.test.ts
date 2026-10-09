import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTokenStore, EncryptedFileTokenStore } from './token-store';

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-tokens-'));
  return path.join(dir, 'tokens.enc.json');
}
const key = () => randomBytes(32).toString('base64');

describe('EncryptedFileTokenStore', () => {
  it('round-trips values and never writes plaintext', async () => {
    const file = await tmpFile();
    const store = new EncryptedFileTokenStore(file, key());
    await store.set('google.refresh_token', '1//plaintext-refresh-token');
    expect(await store.get('google.refresh_token')).toBe('1//plaintext-refresh-token');
    expect(await fs.readFile(file, 'utf8')).not.toContain('plaintext-refresh-token');
    await store.delete('google.refresh_token');
    expect(await store.get('google.refresh_token')).toBeNull();
  });

  it('rejects a wrong key, tampered data, and entries moved to another name', async () => {
    const file = await tmpFile();
    const k = key();
    await new EncryptedFileTokenStore(file, k).set('a', 'secret-a');

    await expect(new EncryptedFileTokenStore(file, key()).get('a')).rejects.toThrow();

    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    doc.entries.b = doc.entries.a; // copy ciphertext under a different name (AAD mismatch)
    const data = Buffer.from(doc.entries.a.data, 'base64');
    data[0]! ^= 0xff;
    doc.entries.a = { ...doc.entries.a, data: data.toString('base64') };
    await fs.writeFile(file, JSON.stringify(doc));

    const store = new EncryptedFileTokenStore(file, k);
    await expect(store.get('a')).rejects.toThrow();
    await expect(store.get('b')).rejects.toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => new EncryptedFileTokenStore('x', Buffer.alloc(16).toString('base64'))).toThrow(
      /32 bytes/,
    );
  });

  it('file mode requires TOKEN_ENCRYPTION_KEY', async () => {
    await expect(
      createTokenStore({ TOKEN_STORE: 'file', TOKEN_FILE_PATH: await tmpFile() }),
    ).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});
