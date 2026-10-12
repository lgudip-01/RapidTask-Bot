import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as schema from './schema';

export type Db = Awaited<ReturnType<typeof createDb>>;

// src/db/client.ts (dev, tests) and the bundled outputs sit at different depths.
function findMigrations(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../drizzle', '../drizzle', './drizzle', '../apps/server/drizzle']) {
    const dir = path.resolve(here, rel);
    if (fs.existsSync(path.join(dir, 'meta', '_journal.json'))) return dir;
  }
  const cwd = path.resolve('apps/server/drizzle');
  if (fs.existsSync(path.join(cwd, 'meta', '_journal.json'))) return cwd;
  throw new Error('drizzle migrations folder not found');
}

/** A local path becomes a file: URL; libsql:// and https:// URLs (Turso) pass through. */
export function toDbUrl(location: string): string {
  if (/^(libsql|https?|wss?):\/\//.test(location) || location.startsWith('file:')) return location;
  if (location === ':memory:') {
    // libsql swaps in-memory connections after a transaction (losing the schema), so tests get
    // a throwaway file instead.
    return pathToFileURL(path.join(os.tmpdir(), `planner-test-${randomUUID()}.db`)).href;
  }
  const abs = path.resolve(location);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return pathToFileURL(abs).href;
}

/**
 * Opens (or creates) the database and applies pending migrations. `location` is a local path
 * (development), ':memory:' (tests, a throwaway file), or a Turso URL (production).
 */
export async function createDb(location: string, authToken?: string) {
  const url = toDbUrl(location);
  const client = createClient({ url, authToken });
  if (url.startsWith('file:')) await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA foreign_keys = ON');
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: findMigrations() });
  return db;
}
