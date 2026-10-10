/**
 * Runs one backup now (same as the nightly job): snapshot + JSON export into BACKUP_DIR.
 *   npm run backup
 *   npm run backup -- --stdout      print the JSON export instead (e.g. over `fly ssh console`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDb } from '../db/client';
import { loadEnv } from '../env';
import { sanitizeError } from '../log';
import { BackupService, exportData } from './backup';

const env = loadEnv();
if (!fs.existsSync(env.DATABASE_PATH)) {
  console.error(`No database at ${path.resolve(env.DATABASE_PATH)}`);
  process.exit(1);
}
const db = createDb(env.DATABASE_PATH);

if (process.argv.includes('--stdout')) {
  process.stdout.write(JSON.stringify(exportData(db), null, 2) + '\n');
} else {
  const service = new BackupService(db, {
    dir: env.BACKUP_DIR,
    keep: env.BACKUP_KEEP,
    hour: env.BACKUP_HOUR,
    timeZone: env.APP_TIMEZONE,
    enabled: true,
  });
  const run = await service.runNow('manual');
  if (!run.ok) {
    console.error(`Backup failed: ${sanitizeError(run.error)}`);
    process.exit(1);
  }
  console.warn(
    `Backup written: ${path.resolve(env.BACKUP_DIR, run.file!)} (${run.taskCount} tasks, ${run.eventCount} events, ${run.sizeBytes} bytes)`,
  );
}
