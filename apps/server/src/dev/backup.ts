/**
 * Exports every task (all sources) to JSON.
 *   npm run backup                       → ./backups/tasks-<timestamp>.json (from DATABASE_PATH)
 *   npm run backup -- --stdout           → print instead of writing a file
 *   fly ssh console -C "node /app/apps/server/dist/backup.js --stdout" > tasks.json
 */
import { asc } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, type Db } from '../db/client';
import { toTaskJson } from '../db/mappers';
import { tasks } from '../db/schema';

export function exportTasks(db: Db, now = new Date()) {
  const rows = db.select().from(tasks).orderBy(asc(tasks.source), asc(tasks.createdAt)).all();
  return {
    version: 1,
    exportedAt: now.toISOString(),
    count: rows.length,
    tasks: rows.map(toTaskJson),
  };
}

const isMain = process.argv[1] && /backup\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const dbPath = args.includes('--db')
    ? args[args.indexOf('--db') + 1]!
    : (process.env.DATABASE_PATH ?? './data/planner.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${path.resolve(dbPath)}`);
    process.exit(1);
  }
  const data = exportTasks(createDb(dbPath));
  const json = JSON.stringify(data, null, 2);
  if (args.includes('--stdout')) {
    process.stdout.write(json + '\n');
  } else {
    const dir = args.includes('--out') ? args[args.indexOf('--out') + 1]! : './backups';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `tasks-${data.exportedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, json + '\n', { mode: 0o600 });
    console.warn(`Wrote ${data.count} tasks to ${path.resolve(file)}`);
  }
}
