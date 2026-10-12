import { z } from 'zod';

export const BackupHealthSchema = z.enum(['ok', 'never', 'stale', 'failed']);

/** GET /api/backups → status (shown in Settings → Backups). */
export const BackupStatusSchema = z.object({
  health: BackupHealthSchema,
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastFile: z.string().nullable(),
  lastSizeBytes: z.number().nullable(),
  nextScheduledAt: z.string().nullable(),
  running: z.boolean(),
  enabled: z.boolean(),
  keep: z.number(),
  /** file = snapshots on the server's disk; telegram = the nightly export is sent to the owner. */
  target: z.enum(['file', 'telegram']).default('file'),
});
export type BackupStatusDto = z.infer<typeof BackupStatusSchema>;

export const BackupRunSchema = z.object({
  id: z.string(),
  reason: z.enum(['scheduled', 'manual', 'catch-up']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  ok: z.boolean(),
  file: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  taskCount: z.number().nullable(),
  eventCount: z.number().nullable(),
  error: z.string().nullable(),
});
export type BackupRunDto = z.infer<typeof BackupRunSchema>;

export const BackupsResponseSchema = z.object({
  status: BackupStatusSchema,
  recent: z.array(BackupRunSchema),
});
