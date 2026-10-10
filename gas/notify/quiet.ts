// 静穏時間・通知定数・ジョブID・文言（functions/src/pure.ts からの移植。外部依存なし）
// 家族のタイムゾーンは Asia/Tokyo 固定（DST なし）。Intl に依存せず UTC+9 で計算する。

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
export const REMINDER_LEAD_MS = 60 * 60 * 1000;
export const LEASE_MS = 4 * 60 * 1000;
export const RETRY_DELAY_MS = 5 * 60 * 1000;

export interface QuietHours { enabled: boolean; start: string; end: string }

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: true, start: '22:00', end: '07:00' };
export const DEFAULT_NOTIFY = { handoverImportant: true, handoverNormal: false, scheduleReminder: true, taskDue: true, dose: true };

export function parseHm(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** JST の 0:00 からの経過分 */
export function minutesOfDayJst(d: Date): number {
  const ms = d.getTime() + JST_OFFSET_MS;
  return Math.floor((((ms % 86400000) + 86400000) % 86400000) / 60000);
}

export function isInQuietHours(now: Date, q: QuietHours | undefined | null): boolean {
  if (!q || !q.enabled) return false;
  const s = parseHm(q.start);
  const e = parseHm(q.end);
  if (s === null || e === null || s === e) return false;
  const t = minutesOfDayJst(now);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** 静穏時間中の now から静穏終了時刻（分単位）を返す。静穏でなければ now。 */
export function nextQuietEnd(now: Date, q: QuietHours): Date {
  if (!isInQuietHours(now, q)) return now;
  const e = parseHm(q.end) as number;
  const t = minutesOfDayJst(now);
  const delta = (e - t + 1440) % 1440;
  const floored = Math.floor(now.getTime() / 60000) * 60000;
  return new Date(floored + delta * 60000);
}

export const NOTIFY_TEXT = {
  handoverImportant: '重要な申し送りがあります',
  handoverNormal: '確認したい申し送りがあります',
  scheduleReminder: '近づいている予定があります',
  test: 'テスト通知です',
  ownerTransfer: '管理者の移譲が提案されています',
} as const;
export const NOTIFY_TITLE = 'Baby hub';

export function reminderDueMs(startMs: number): number {
  return startMs - REMINDER_LEAD_MS;
}

// ---------- 決定的ジョブID（Firestore のドキュメントID として安全な文字のみ） ----------
function safe(s: string | number): string {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '-');
}
export function handoverJobId(handoverId: string, revision: number, uid: string): string {
  return `handover_${safe(handoverId)}_r${revision}_${safe(uid)}`;
}
export function scheduleJobId(scheduleId: string, dueMs: number, uid: string): string {
  return `schedule_${safe(scheduleId)}_${dueMs}_${safe(uid)}`;
}

export type JobKind = 'handover' | 'scheduleReminder' | 'ownerTransfer';

export function textFor(type: JobKind, priority: 'normal' | 'important'): string {
  if (type === 'ownerTransfer') return NOTIFY_TEXT.ownerTransfer;
  if (type === 'scheduleReminder') return NOTIFY_TEXT.scheduleReminder;
  return priority === 'important' ? NOTIFY_TEXT.handoverImportant : NOTIFY_TEXT.handoverNormal;
}

export function urlFor(type: JobKind, relatedId: string): string {
  if (type === 'ownerTransfer') return '/more/family';
  return type === 'scheduleReminder' ? `/plans/schedules/${relatedId}` : `/plans/handovers/${relatedId}`;
}

export type Decision =
  | { status: 'send' }
  | { status: 'skipped'; note: string }
  | { status: 'defer'; until: Date };

/** 本人設定と静穏時間から送信可否を決める（important は静穏時間の対象外＝functions 版と同じ）。 */
export function decideDelivery(
  job: { type: JobKind; priority: 'normal' | 'important'; startMs?: number },
  settings: { notify?: Partial<typeof DEFAULT_NOTIFY>; quietHours?: QuietHours } | undefined,
  now: Date,
): Decision {
  // 管理者移譲の提案は設定・静穏時間に関わらず通知する（セキュリティ上の通知）
  if (job.type === 'ownerTransfer') return { status: 'send' };
  const notify = { ...DEFAULT_NOTIFY, ...(settings?.notify ?? {}) };
  const enabled = job.type === 'scheduleReminder' ? notify.scheduleReminder : job.priority === 'important' ? notify.handoverImportant : notify.handoverNormal;
  if (!enabled) return { status: 'skipped', note: 'user-disabled' };
  const quiet = settings?.quietHours ?? DEFAULT_QUIET_HOURS;
  if (job.priority !== 'important' && isInQuietHours(now, quiet)) {
    const until = nextQuietEnd(now, quiet);
    if (job.type === 'scheduleReminder' && job.startMs !== undefined && until.getTime() >= job.startMs) return { status: 'skipped', note: 'quiet-hours' };
    return { status: 'defer', until };
  }
  return { status: 'send' };
}
