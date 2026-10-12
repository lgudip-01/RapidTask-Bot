import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '@planner/shared';
import type { Db } from './db/client';
import { settings } from './db/schema';

/** Typed key/value settings stored as JSON rows; unknown or invalid values fall back to defaults. */
export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
  ) {}

  async get(): Promise<Settings> {
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of await this.db.select().from(settings).all()) {
      try {
        merged[row.key] = JSON.parse(row.value);
      } catch {
        // ignore corrupt rows
      }
    }
    const parsed = SettingsSchema.safeParse(merged);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async patch(p: Partial<Settings>): Promise<Settings> {
    const at = this.now();
    for (const [key, value] of Object.entries(p)) {
      if (value === undefined) continue;
      await this.db
        .insert(settings)
        .values({ key, value: JSON.stringify(value), updatedAt: at })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: JSON.stringify(value), updatedAt: at },
        })
        .run();
    }
    return this.get();
  }
}
