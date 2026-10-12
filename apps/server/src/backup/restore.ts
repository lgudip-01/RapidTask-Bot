import fs from 'node:fs';
import { verifySnapshot } from './backup';

export interface RestoreResult {
  restoredFrom: string;
  /** Where the replaced database was moved (null if there was none). */
  previous: string | null;
  tasks: number;
  events: number;
}

/**
 * Replaces the database with a verified snapshot. The current database (and its WAL/SHM files)
 * is moved aside, never deleted. The server must be stopped while this runs.
 */
export async function restoreSnapshot(opts: {
  snapshot: string;
  dbPath: string;
  now?: Date;
}): Promise<RestoreResult> {
  const counts = await verifySnapshot(opts.snapshot); // throws on a missing or corrupt snapshot
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  let previous: string | null = null;
  if (fs.existsSync(opts.dbPath)) {
    previous = `${opts.dbPath}.pre-restore-${stamp}`;
    fs.renameSync(opts.dbPath, previous);
  }
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(opts.dbPath + ext)) {
      fs.renameSync(opts.dbPath + ext, `${previous ?? opts.dbPath + '.stale'}${ext}`);
    }
  }
  fs.copyFileSync(opts.snapshot, opts.dbPath);
  return { restoredFrom: opts.snapshot, previous, ...counts };
}
