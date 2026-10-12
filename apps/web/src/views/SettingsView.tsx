import type { BackupStatusDto, IntegrationStatus } from '@planner/shared';
import {
  CalendarDays,
  DatabaseBackup,
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
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Button, cx, ErrorState, Kbd, LoadingRows, Segmented, Switch } from '../components/ui';
import { applyTheme, readThemePref, type ThemePref } from '../lib/hooks';
import {
  useBackups,
  useCanvasConnection,
  useConnectCanvas,
  useCourses,
  useDisconnectCanvas,
  useDisconnectGoogle,
  useIntegrations,
  usePatchSettings,
  useRunBackup,
  useSettings,
  useSyncNow,
} from '../lib/queries';
import { fmtDay, fmtTime, relative } from '../lib/time';
import { toast } from '../lib/toast';

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

/** A small time field under a switch; saves on every complete change. */
function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mt-2 flex items-center gap-2 text-xs text-muted">
      {label}
      <input
        type="time"
        key={value}
        defaultValue={value}
        onChange={(e) => /^\d\d:\d\d$/.test(e.target.value) && onChange(e.target.value)}
        className="rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink"
      />
    </label>
  );
}

const BACKUP_HEALTH: Record<BackupStatusDto['health'], [string, string]> = {
  ok: ['healthy', 'bg-ok-soft text-ok'],
  never: ['no backup yet', 'bg-warn-soft text-warn'],
  stale: ['older than 48 h', 'bg-danger-soft text-danger'],
  failed: ['last backup failed', 'bg-danger-soft text-danger'],
};

const kb = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

function BackupsCard() {
  const q = useBackups();
  const run = useRunBackup();
  const s = q.data?.status;
  const recent = q.data?.recent ?? [];
  return (
    <Card title="Backups">
      {q.isLoading && <LoadingRows rows={2} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {s && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            <span className="mt-0.5 text-muted">
              <DatabaseBackup className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Last backup</span>
                <span
                  className={cx(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    BACKUP_HEALTH[s.health][1],
                  )}
                >
                  {BACKUP_HEALTH[s.health][0]}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted" data-testid="last-backup">
                {s.lastSuccessAt
                  ? `${relative(s.lastSuccessAt)} (${fmtDay(s.lastSuccessAt)}, ${fmtTime(s.lastSuccessAt)})${s.lastSizeBytes != null ? ` · ${kb(s.lastSizeBytes)}` : ''}`
                  : 'Never'}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {s.enabled && s.nextScheduledAt
                  ? `Next nightly backup: ${fmtDay(s.nextScheduledAt)}, ${fmtTime(s.nextScheduledAt)} · ${s.target === 'telegram' ? 'sent to you on Telegram' : `keeps the newest ${s.keep}`}`
                  : 'Nightly backups are off (BACKUP_ENABLED=false).'}
              </p>
              {s.health === 'failed' && s.lastError && (
                <p className="mt-1 rounded-md bg-danger-soft px-2 py-1 font-mono text-[11px] text-danger">
                  {s.lastError}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="subtle"
              onClick={() => run.mutate()}
              disabled={run.isPending || s.running}
            >
              {run.isPending || s.running ? 'Backing up…' : 'Back up now'}
            </Button>
          </div>
          {recent.length > 0 && (
            <ul
              className="space-y-1 border-t border-line pt-2 text-xs text-muted"
              aria-label="Recent backups"
            >
              {recent.slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <span className={r.ok ? 'text-ok' : 'text-danger'}>{r.ok ? '✓' : '✗'}</span>
                  <span>
                    {fmtDay(r.startedAt)}, {fmtTime(r.startedAt)}
                  </span>
                  <span className="text-faint">{r.reason}</span>
                  {r.ok && r.taskCount != null && (
                    <span className="text-faint">
                      {r.taskCount} tasks · {r.eventCount} events
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">
            {s.target === 'telegram' ? (
              <>
                Backups hold everything that lives only in Planner. Each one arrives as a JSON file
                in your Telegram chat with the bot (see docs/DEPLOY-VERCEL.md to restore).
              </>
            ) : (
              <>
                Backups hold everything that lives only in Planner. To restore one, stop the server
                and run <code className="rounded bg-surface-2 px-1">npm run restore -- --list</code>{' '}
                (see docs/MANUAL-STEPS.md).
              </>
            )}
          </p>
        </div>
      )}
    </Card>
  );
}

const field =
  'mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint';
const labelCls = 'block text-xs font-medium text-muted';

/** Canvas address + personal access token. The server checks them with Canvas before saving. */
function CanvasConnectForm({ onDone }: { onDone: () => void }) {
  const connect = useConnectCanvas();
  const [mode, setMode] = useState<'feed' | 'token'>('feed');
  const [feedUrl, setFeedUrl] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const host = baseUrl
    .trim()
    .replace(/^https?:\/\//, '')
    .split('/')[0];
  const tokenPage = host && host.includes('.') ? `https://${host}/profile/settings` : null;
  return (
    <form
      className="mt-1 w-full space-y-3 rounded-xl border border-line bg-surface-2 p-3"
      aria-label="Connect Canvas"
      onSubmit={(e) => {
        e.preventDefault();
        connect.mutate(mode === 'feed' ? { feedUrl } : { baseUrl, token }, { onSuccess: onDone });
      }}
    >
      <Segmented
        id="canvas-connect-mode"
        label="How to connect"
        value={mode}
        onChange={(m) => {
          setMode(m);
          connect.reset();
        }}
        options={[
          { value: 'feed', label: 'Calendar feed' },
          { value: 'token', label: 'Access token' },
        ]}
      />
      {mode === 'feed' ? (
        <>
          <label className={labelCls}>
            Calendar feed link
            <input
              className={field}
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              placeholder="https://yourschool.instructure.com/feeds/calendars/user_….ics"
              autoComplete="off"
              inputMode="url"
              required
              autoFocus
            />
          </label>
          <p className="text-xs text-muted">
            In Canvas, open <span className="text-ink">Calendar</span>, click{' '}
            <span className="text-ink">Calendar Feed</span> (bottom right), and copy the link. You
            get assignments and course events. Treat the link like a password.
          </p>
        </>
      ) : (
        <>
          <label className={labelCls}>
            Canvas address
            <input
              className={field}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="yourschool.instructure.com"
              autoComplete="url"
              inputMode="url"
              required
              autoFocus
            />
          </label>
          <label className={labelCls}>
            Access token
            <input
              className={field}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste the token from Canvas"
              autoComplete="off"
              required
            />
          </label>
          <p className="text-xs text-muted">
            In Canvas, open{' '}
            {tokenPage ? (
              <a
                className="text-accent-ink underline"
                href={tokenPage}
                target="_blank"
                rel="noreferrer"
              >
                Account → Settings
              </a>
            ) : (
              <span className="text-ink">Account → Settings</span>
            )}
            , choose <span className="text-ink">+ New Access Token</span>, name it “Planner”, and
            copy the token. Adds grades and announcements to what the feed gives you.
          </p>
        </>
      )}
      <p className="text-xs text-faint">
        Planner only reads from Canvas and keeps these details encrypted.
      </p>
      {connect.error && (
        <p role="alert" className="rounded-md bg-danger-soft px-2 py-1 text-xs text-danger">
          {connect.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={connect.isPending}>
          {connect.isPending ? 'Checking with Canvas…' : 'Connect'}
        </Button>
      </div>
    </form>
  );
}

function IntegrationRow({ i }: { i: IntegrationStatus }) {
  const sync = useSyncNow();
  const disconnect = useDisconnectGoogle();
  const isCanvas = i.id === 'canvas';
  const canvasConn = useCanvasConnection();
  const disconnectCanvas = useDisconnectCanvas();
  const [connecting, setConnecting] = useState(false);
  const canConnectCanvas = isCanvas && !i.configured && canvasConn.data?.canConnect === true;
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
        {canConnectCanvas && !connecting && (
          <Button size="sm" variant="primary" onClick={() => setConnecting(true)}>
            Connect Canvas
          </Button>
        )}
        {isCanvas && i.managed === 'app' && (
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              confirm('Disconnect Canvas? Sync stops until you connect again.') &&
              disconnectCanvas.mutate()
            }
          >
            Disconnect
          </Button>
        )}
        {i.id === 'google_calendar' && i.configured && i.connected === false && (
          <Button
            size="sm"
            onClick={() => {
              // Full-page navigation: the server redirects to Google and back to Settings.
              window.location.href = '/api/google/connect';
            }}
          >
            Connect Google
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
      {connecting && <CanvasConnectForm onDone={() => setConnecting(false)} />}
    </li>
  );
}

const GOOGLE_RESULT: Record<string, [ok: boolean, text: string]> = {
  connected: [true, 'Google Calendar connected. Syncing now…'],
  denied: [false, 'Google access was not granted.'],
  expired: [false, 'That sign-in link expired. Try Connect Google again.'],
  failed: [false, 'Could not finish connecting Google. Try again.'],
};

/** After the Google redirect (#/settings?google=…): say how it went, then tidy the URL. */
function useGoogleConnectResult() {
  useEffect(() => {
    const q = window.location.hash.split('?')[1];
    const result = q ? new URLSearchParams(q).get('google') : null;
    const entry = result ? GOOGLE_RESULT[result] : undefined;
    if (!entry) return;
    if (entry[0]) toast.success(entry[1]);
    else toast.error(entry[1]);
    window.history.replaceState(null, '', '#/settings');
  }, []);
}

export function SettingsView() {
  useGoogleConnectResult();
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
          Connect Google and Canvas with the buttons above. Both are read-only: Planner never
          changes anything in your calendar or courses.
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

      <Card title="Notifications (Telegram)">
        {integrations.data && !inbound.find((i) => i.id === 'telegram')?.configured && (
          <p className="mb-3 rounded-md bg-warn-soft px-2 py-1 text-xs text-warn">
            Telegram isn’t set up, so nothing is sent. See docs/SETUP-TELEGRAM.md.
          </p>
        )}
        {settings.data && (
          <div className="space-y-4">
            <div>
              <Switch
                label="Daily digest"
                description="Today’s events and tasks, every morning."
                checked={settings.data.digestEnabled}
                onChange={(v) => patch.mutate({ digestEnabled: v })}
              />
              {settings.data.digestEnabled && (
                <TimeField
                  label="Send at"
                  value={settings.data.digestTime}
                  onChange={(v) => patch.mutate({ digestTime: v })}
                />
              )}
            </div>
            <div>
              <Switch
                label="Deadline reminders"
                description="The evening before a Canvas assignment or one of your tasks is due."
                checked={settings.data.deadlineReminders}
                onChange={(v) => patch.mutate({ deadlineReminders: v })}
              />
              {settings.data.deadlineReminders && (
                <TimeField
                  label="Send at"
                  value={settings.data.deadlineReminderTime}
                  onChange={(v) => patch.mutate({ deadlineReminderTime: v })}
                />
              )}
            </div>
            <div>
              <Switch
                label="Event reminders"
                description="Before each timed event, from Google Calendar or Planner."
                checked={settings.data.eventReminders}
                onChange={(v) => patch.mutate({ eventReminders: v })}
              />
              {settings.data.eventReminders && (
                <label className="mt-2 flex items-center gap-2 text-xs text-muted">
                  Remind me
                  <select
                    value={settings.data.eventReminderMinutes}
                    onChange={(e) => patch.mutate({ eventReminderMinutes: Number(e.target.value) })}
                    className="rounded-md border border-line bg-surface-2 px-2 py-1 text-sm text-ink"
                  >
                    {[15, 30, 60, 120].map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`} before
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="text-xs text-muted">
              Health alerts are always on: Google access revoked, Canvas token failing or about to
              expire, a sync failing repeatedly, and backups failing or older than 48 hours. Each is
              sent at most once a day.
            </p>
          </div>
        )}
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

      <BackupsCard />

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
