/**
 * Restores the database from a backup snapshot. STOP THE SERVER FIRST.
 *   npm run restore -- --list
 *   npm run restore -- --from ./data/backups/planner-20261009-070000.db --yes
 * The current database is moved aside as <db>.pre-restore-<time>, never deleted.
 *
 * From a JSON export (e.g. a nightly Telegram backup) into the configured database, local file or
 * Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN). Existing rows are kept; safe to repeat:
 *   npm run restore -- --json ./planner-20261009-070000.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDb } from '../db/client';
import { loadEnv } from '../env';
import { sanitizeError } from '../log';
import { verifySnapshot } from './backup';
import { importData } from './import';
import { restoreSnapshot } from './restore';

const env = loadEnv();
const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

try {
  const json = arg('--json');
  if (json) {
    const db = await createDb(env.TURSO_DATABASE_URL ?? env.DATABASE_PATH, env.TURSO_AUTH_TOKEN);
    const r = await importData(db, JSON.parse(fs.readFileSync(json, 'utf8')));
    console.warn(
      `Imported ${r.tasks} tasks and ${r.events} Planner events (${r.skipped} tasks already present).`,
    );
  } else if (args.includes('--list')) {
    const files = fs.existsSync(env.BACKUP_DIR)
      ? fs
          .readdirSync(env.BACKUP_DIR)
          .filter((f) => f.endsWith('.db'))
          .sort()
          .reverse()
      : [];
    if (!files.length) console.warn(`No snapshots in ${path.resolve(env.BACKUP_DIR)}`);
    for (const f of files) {
      const c = await verifySnapshot(path.join(env.BACKUP_DIR, f));
      console.warn(`${f}  ${c.tasks} tasks, ${c.events} events`);
    }
  } else {
    const from = arg('--from');
    if (!from)
      throw new Error(
        'Usage: npm run restore -- --from <snapshot.db> --yes   (or --list, or --json <export.json>)',
      );
    const snapshot =
      path.isAbsolute(from) || fs.existsSync(from) ? from : path.join(env.BACKUP_DIR, from);
    const counts = await verifySnapshot(snapshot);
    if (!args.includes('--yes')) {
      console.warn(`Snapshot OK: ${counts.tasks} tasks, ${counts.events} events.`);
      console.warn(
        `This replaces ${path.resolve(env.DATABASE_PATH)}. Stop the server, then re-run with --yes.`,
      );
      process.exit(2);
    }
    const r = await restoreSnapshot({ snapshot, dbPath: env.DATABASE_PATH });
    console.warn(
      `Restored ${r.tasks} tasks and ${r.events} events from ${path.basename(snapshot)}.`,
    );
    if (r.previous) console.warn(`Previous database kept at ${r.previous}`);
  }
} catch (e) {
  console.error(`restore failed: ${sanitizeError(e)}`);
  process.exit(1);
}
