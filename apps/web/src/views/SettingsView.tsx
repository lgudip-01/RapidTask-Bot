import type { IntegrationStatus } from '@planner/shared';
import {
  CalendarDays,
  GraduationCap,
  MessageCircle,
  Monitor,
  Moon,
  RefreshCw,
  Smartphone,
  Sparkles,
  Sun,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Button, cx, ErrorState, Kbd, LoadingRows, Segmented, Switch } from '../components/ui';
import { applyTheme, readThemePref, type ThemePref } from '../lib/hooks';
import {
  useCourses,
  useDisconnectGoogle,
  useIntegrations,
  usePatchSettings,
  useSettings,
  useSyncNow,
} from '../lib/queries';
import { relative } from '../lib/time';

const ICONS: Record<IntegrationStatus['id'], ReactNode> = {
  google_calendar: <CalendarDays className="size-4" />,
  canvas: <GraduationCap className="size-4" />,
  telegram: <MessageCircle className="size-4" />,
  twilio: <Smartphone className="size-4" />,
  parser: <Sparkles className="size-4" />,
};

function StatusPill({ i }: { i: IntegrationStatus }) {
  const error = i.sync?.lastError;
  const [label, cls] = !i.configured
    ? ['not set up', 'bg-surface-2 text-muted']
    : error
      ? ['error', 'bg-danger-soft text-danger']
      : i.connected === false
        ? ['not connected', 'bg-warn-soft text-warn']
        : ['active', 'bg-ok-soft text-ok'];
  return (
    <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-medium', cls)}>{label}</span>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-line bg-surface p-4 shadow-card"
    >
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">{title}</h2>
      {children}
    </motion.section>
  );
}

function IntegrationRow({ i }: { i: IntegrationStatus }) {
  const sync = useSyncNow();
  const disconnect = useDisconnectGoogle();
  const canSync = i.configured && (i.id === 'google_calendar' || i.id === 'canvas');
  return (
    <li className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span className="mt-0.5 text-muted">{ICONS[i.id]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{i.label}</span>
          <StatusPill i={i} />
          {i.detail && <span className="text-xs text-faint">{i.detail}</span>}
        </div>
        {i.sync && (
          <p className="mt-0.5 text-xs text-muted">
            {i.sync.lastSyncAt ? `Last synced ${relative(i.sync.lastSyncAt)}` : 'Never synced'}
            {i.sync.nextRunAt && ` · next ${relative(i.sync.nextRunAt)}`}
          </p>
        )}
        {i.sync?.lastError && (
          <p className="mt-1 rounded-md bg-danger-soft px-2 py-1 font-mono text-[11px] text-danger">
            {i.sync.lastError}
            {i.sync.consecutiveFailures > 1 && ` (×${i.sync.consecutiveFailures})`}
          </p>
        )}
        {i.help && <p className="mt-1 text-xs text-muted">{i.help}</p>}
      </div>
      <div className="flex gap-1.5">
        {canSync && (
          <Button
            size="sm"
            variant="subtle"
            onClick={() => sync.mutate(i.id)}
            disabled={sync.isPending}
          >
            <motion.span
              animate={sync.isPending ? { rotate: 360 } : { rotate: 0 }}
              transition={sync.isPending ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : {}}
            >
              <RefreshCw className="size-3.5" />
            </motion.span>
            Sync now
          </Button>
        )}
        {i.id === 'google_calendar' && i.connected && (
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              confirm('Disconnect Google? Sync stops until you reconnect.') && disconnect.mutate()
            }
          >
            Disconnect
          </Button>
        )}
      </div>
    </li>
  );
}

export function SettingsView() {
  const integrations = useIntegrations();
  const settings = useSettings();
  const patch = usePatchSettings();
  const showGrades = settings.data?.showGrades ?? false;
  const courses = useCourses(showGrades);
  const [theme, setTheme] = useState<ThemePref>(readThemePref);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });

  const sources =
    integrations.data?.filter((i) => ['google_calendar', 'canvas'].includes(i.id)) ?? [];
  const inbound =
    integrations.data?.filter((i) => ['telegram', 'twilio', 'parser'].includes(i.id)) ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card title="Sources">
        {integrations.isLoading && <LoadingRows rows={3} />}
        {integrations.error && (
          <ErrorState error={integrations.error} onRetry={() => integrations.refetch()} />
        )}
        <ul className="divide-y divide-line">
          {sources.map((i) => (
            <IntegrationRow key={i.id} i={i} />
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Connecting a source happens on your machine: run{' '}
          <code className="rounded bg-surface-2 px-1">npm run auth:google -w @planner/server</code>{' '}
          for Google, and put Canvas details in{' '}
          <code className="rounded bg-surface-2 px-1">.env</code>.
        </p>
      </Card>

      <Card title="Text capture (allowlist)">
        <ul className="divide-y divide-line">
          {inbound.map((i) => (
            <IntegrationRow key={i.id} i={i} />
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Only the allowlisted Telegram user and phone number above can add items. Everything else
          is dropped.
        </p>
      </Card>

      <Card title="Behavior">
        {settings.error && <ErrorState error={settings.error} onRetry={() => settings.refetch()} />}
        <div className="space-y-4">
          <Switch
            label="AI triage"
            description="Use Claude for messages the built-in parser can't read. Off: only simple “title + date” messages are accepted."
            checked={settings.data?.aiTriage ?? true}
            onChange={(v) => patch.mutate({ aiTriage: v })}
          />
          <Switch
            label="Copy texted events to Google Calendar"
            description={
              <>
                Off, and not available yet. Planner only <b>reads</b> your Google Calendar: events
                you text or add here are saved in Planner only. Writing them to Google is a possible
                future option (<code>WRITE_EVENTS_TO_GOOGLE</code>) that has not been built.
                {me.data?.writeEventsToGoogle && (
                  <span className="mt-1 block text-warn">
                    The server has WRITE_EVENTS_TO_GOOGLE=true, which is ignored.
                  </span>
                )}
              </>
            }
            checked={false}
            disabled
            onChange={() => {}}
          />
          <Switch
            label="Show Canvas grades"
            description="Current grade per course. Hidden by default."
            checked={showGrades}
            onChange={(v) => patch.mutate({ showGrades: v })}
          />
          {showGrades && (
            <motion.ul
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="overflow-hidden rounded-xl border border-line"
            >
              {courses.data?.length === 0 && (
                <li className="px-3 py-2 text-xs text-muted">No courses synced yet.</li>
              )}
              {courses.data?.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between border-b border-line px-3 py-2 last:border-0"
                >
                  <span className="text-sm">{c.name}</span>
                  <span className="text-sm tabular-nums">
                    <b>{c.currentGrade ?? '—'}</b>{' '}
                    <span className="text-xs text-muted">
                      {c.currentScore != null ? `${c.currentScore.toFixed(1)}%` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </motion.ul>
          )}
        </div>
      </Card>

      <Card title="Appearance">
        <Segmented
          id="theme"
          label="Theme"
          value={theme}
          onChange={(v) => {
            setTheme(v);
            applyTheme(v);
          }}
          options={[
            {
              value: 'system',
              label: (
                <>
                  <Monitor className="size-3.5" /> System
                </>
              ),
            },
            {
              value: 'light',
              label: (
                <>
                  <Sun className="size-3.5" /> Light
                </>
              ),
            },
            {
              value: 'dark',
              label: (
                <>
                  <Moon className="size-3.5" /> Dark
                </>
              ),
            },
          ]}
        />
      </Card>

      {me.data?.authMode === 'password' && (
        <Card title="Account">
          <form method="post" action="/auth/logout" className="flex items-center justify-between">
            <span className="text-sm text-muted">Signed in on this browser.</span>
            <Button type="submit" size="sm" variant="subtle">
              Sign out
            </Button>
          </form>
        </Card>
      )}

      <Card title="Keyboard shortcuts">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {[
            ['n', 'New task or event'],
            ['t', 'Go to Today'],
            ['/', 'Search'],
            ['← →', 'Previous / next week (Week view)'],
            ['Esc', 'Close dialogs'],
          ].map(([k, d]) => (
            <div key={k} className="contents">
              <dt>
                <Kbd>{k}</Kbd>
              </dt>
              <dd className="text-muted">{d}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
