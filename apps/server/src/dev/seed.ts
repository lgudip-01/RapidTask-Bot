/**
 * Seeds a development database with fixture data relative to today (APP_TIMEZONE), so every UI
 * view has something to show.  npm run seed -w @planner/server -- [--db ./data/dev.db] [--reset]
 * Never point this at your real database.
 */
import { addDays, dateInZone, startOfDateInZone, zonedTimeToUtc } from '@planner/shared';
import fs from 'node:fs';
import path from 'node:path';
import { createDb } from '../db/client';
import { suggestions, syncState, tasks } from '../db/schema';
import { upsertItems } from '../sync/upsert';
import type { SyncItem } from '../sync/types';

const args = process.argv.slice(2);
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1]! : './data/dev.db';
if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed in production');
if (args.includes('--reset'))
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });

const tz = process.env.APP_TIMEZONE ?? 'America/New_York';
const db = createDb(dbPath);
const now = new Date();
const today = dateInZone(now, tz);
const day = (offset: number) => addDays(today, offset);
const at = (offset: number, hh: number, mm = 0) => {
  const [y, m, d] = day(offset).split('-').map(Number);
  return zonedTimeToUtc(tz, y!, m!, d!, hh, mm);
};
const midnight = (offset: number) => startOfDateInZone(day(offset), tz);
const updatedAt = new Date(now.getTime() - 86_400_000);

const ev = (
  externalId: string,
  title: string,
  start: Date,
  end: Date,
  extra: Partial<{
    allDay: boolean;
    location: string;
    calendarName: string;
    source: 'google_calendar' | 'canvas';
  }> = {},
): SyncItem => ({
  kind: 'event',
  data: {
    source: extra.source ?? 'google_calendar',
    externalId,
    title,
    start,
    end,
    allDay: extra.allDay ?? false,
    location: extra.location ?? null,
    calendarName: extra.calendarName ?? 'Personal',
    url: null,
    updatedAt,
  },
});

const items: SyncItem[] = [
  ev('seed/lecture-0', 'PHYS 201 Lecture', at(0, 9), at(0, 10, 15), {
    location: 'Hall B',
    calendarName: 'Classes',
  }),
  ev('seed/lunch', 'Lunch with Sam', at(0, 12, 30), at(0, 13, 30), { location: 'Cafe Luna' }),
  ev('seed/office-hours', 'Office hours', at(0, 16), at(0, 17), { calendarName: 'Classes' }),
  ev('seed/study', 'Study group', at(0, 16, 30), at(0, 18), { location: 'Library 3F' }),
  ev('seed/bday', "Mom's birthday", midnight(0), midnight(1), { allDay: true }),
  ev('seed/dentist', 'Dentist', at(1, 10), at(1, 11), { location: 'Dr. Patel' }),
  ev('seed/sync', 'Team sync', at(2, 13), at(2, 13, 45), { calendarName: 'Work' }),
  ev('seed/lecture-2', 'PHYS 201 Lecture', at(2, 9), at(2, 10, 15), {
    location: 'Hall B',
    calendarName: 'Classes',
  }),
  ev('seed/coffee', 'Coffee with Priya', at(-1, 15), at(-1, 16)),
  ev('seed/gym', 'Gym', at(3, 18), at(3, 19)),
  ev('event-501', 'PHYS 201 Midterm Review', at(4, 18), at(4, 19, 30), {
    source: 'canvas',
    calendarName: 'PHYS 201: Classical Mechanics',
    location: 'Hall B',
  }),
  ev('event-502', 'No class — Fall break', midnight(5), midnight(7), {
    source: 'canvas',
    allDay: true,
    calendarName: 'MATH 221: Calculus III',
  }),
  {
    kind: 'task',
    data: {
      source: 'canvas',
      externalId: 'assignment-1001',
      title: 'Problem Set 4',
      due: at(0, 23, 59),
      dueAllDay: false,
      status: 'todo',
      courseOrProject: 'PHYS 201: Classical Mechanics',
      pointsPossible: 20,
      submissionStatus: 'unsubmitted',
      url: 'https://canvas.example.edu/courses/101/assignments/1001',
      updatedAt,
    },
  },
  {
    kind: 'task',
    data: {
      source: 'canvas',
      externalId: 'assignment-1002',
      title: 'Lab Report 3',
      due: at(-2, 23, 59),
      dueAllDay: false,
      status: 'todo',
      courseOrProject: 'PHYS 201: Classical Mechanics',
      pointsPossible: 30,
      submissionStatus: 'missing',
      url: 'https://canvas.example.edu/courses/101/assignments/1002',
      updatedAt,
    },
  },
  {
    kind: 'task',
    data: {
      source: 'canvas',
      externalId: 'assignment-2001',
      title: 'Calc HW 6',
      due: at(2, 23, 59),
      dueAllDay: false,
      status: 'done',
      courseOrProject: 'MATH 221: Calculus III',
      pointsPossible: 10,
      submissionStatus: 'submitted',
      completedAt: updatedAt,
      url: 'https://canvas.example.edu/courses/102/assignments/2001',
      updatedAt,
    },
  },
  {
    kind: 'task',
    data: {
      source: 'canvas',
      externalId: 'assignment-2002',
      title: 'Midterm essay',
      due: at(6, 23, 59),
      dueAllDay: false,
      status: 'todo',
      courseOrProject: 'MATH 221: Calculus III',
      pointsPossible: 50,
      submissionStatus: 'unsubmitted',
      url: 'https://canvas.example.edu/courses/102/assignments/2002',
      updatedAt,
    },
  },
  {
    kind: 'task',
    data: {
      source: 'google_tasks',
      externalId: '@default/seed-landlord',
      title: 'Call landlord',
      due: midnight(0),
      dueAllDay: true,
      status: 'todo',
      updatedAt,
    },
  },
  {
    kind: 'task',
    data: {
      source: 'google_tasks',
      externalId: '@default/seed-passport',
      title: 'Renew passport',
      due: midnight(4),
      dueAllDay: true,
      status: 'todo',
      updatedAt,
    },
  },
  {
    kind: 'course',
    data: {
      source: 'canvas',
      externalId: 'course-101',
      name: 'PHYS 201: Classical Mechanics',
      courseCode: 'PHYS 201',
      termName: 'Fall 2026',
      currentScore: 91.4,
      currentGrade: 'A-',
      url: 'https://canvas.example.edu/courses/101',
    },
  },
  {
    kind: 'course',
    data: {
      source: 'canvas',
      externalId: 'course-102',
      name: 'MATH 221: Calculus III',
      courseCode: 'MATH 221',
      termName: 'Fall 2026',
      currentScore: 84,
      currentGrade: 'B',
      url: 'https://canvas.example.edu/courses/102',
    },
  },
  {
    kind: 'announcement',
    data: {
      source: 'canvas',
      externalId: 'announcement-901',
      title: 'Midterm moved to next Thursday',
      courseName: 'PHYS 201: Classical Mechanics',
      postedAt: new Date(now.getTime() - 5 * 3_600_000),
      url: null,
    },
  },
];
upsertItems(db, items, now);

const local = (
  id: string,
  title: string,
  due: Date | null,
  status: 'todo' | 'doing' | 'done',
  sortOrder: number,
  dueAllDay = true,
) => ({
  id,
  source: 'local' as const,
  externalId: id,
  title,
  due,
  dueAllDay,
  status,
  sortOrder,
  createdAt: updatedAt,
  updatedAt,
  syncedAt: updatedAt,
  completedAt: status === 'done' ? updatedAt : null,
});
db.insert(tasks)
  .values([
    local('seed-local-1', 'Pay rent', midnight(-3), 'todo', 1),
    local('seed-local-2', 'Water plants', midnight(1), 'todo', 2),
    local('seed-local-3', 'Finish slides', at(3, 17), 'doing', 3, false),
    local('seed-local-4', 'Buy shelf', null, 'todo', 4),
    local('seed-local-5', 'Order textbook', midnight(-1), 'done', 5),
  ])
  .onConflictDoNothing()
  .run();

db.insert(suggestions)
  .values([
    {
      id: 'seed-s1',
      sourceMessageRef: 'telegram:seed-1',
      proposedTitle: 'Coffee with Priya',
      proposedDue: at(5, 15),
      confidence: 0.62,
      createdAt: new Date(now.getTime() - 3_600_000),
    },
    {
      id: 'seed-s2',
      sourceMessageRef: 'telegram:seed-2',
      proposedTitle: 'Meeting with advisor',
      proposedDue: null,
      confidence: 0.55,
      createdAt: new Date(now.getTime() - 7_200_000),
    },
    {
      id: 'seed-s3',
      sourceMessageRef: 'twilio:seed-3',
      proposedTitle: 'Gym',
      proposedDue: null,
      confidence: 0.48,
      createdAt: new Date(now.getTime() - 86_400_000),
    },
  ])
  .onConflictDoNothing()
  .run();

db.insert(syncState)
  .values([
    {
      source: 'google_calendar',
      cursor: '{"primary":"seed"}',
      lastSyncAt: new Date(now.getTime() - 3 * 60_000),
      lastError: null,
      consecutiveFailures: 0,
      nextRunAt: new Date(now.getTime() + 7 * 60_000),
    },
    {
      source: 'canvas',
      cursor: null,
      lastSyncAt: new Date(now.getTime() - 3 * 3_600_000),
      lastError: 'CanvasApiError: Canvas GET /api/v1/courses 401',
      consecutiveFailures: 2,
      nextRunAt: new Date(now.getTime() + 20 * 60_000),
    },
  ])
  .onConflictDoNothing()
  .run();

console.warn(`Seeded ${path.resolve(dbPath)} for ${today} (${tz}).`);
