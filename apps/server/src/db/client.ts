import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

// src/db/client.ts (dev, tests) and dist/index.js (bundled) sit at different depths.
function findMigrations(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../drizzle', '../drizzle']) {
    const dir = path.resolve(here, rel);
    if (fs.existsSync(path.join(dir, 'meta', '_journal.json'))) return dir;
  }
  throw new Error('drizzle migrations folder not found');
}

/** Opens (or creates) the database and applies pending migrations. Use ':memory:' in tests. */
export function createDb(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: findMigrations() });
  return db;
}
