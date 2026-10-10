// 予定・ToDo・申し送りの純粋ロジック（Firebase 非依存）
import { addDaysStr, toDateStr, TZ } from '../../../lib/time';

type DateLike = { toDate(): Date };

export interface ScheduleLike {
  allDay: boolean;
  date?: string;
  startAt?: DateLike;
  status: 'planned' | 'done' | 'cancelled';
}

/** 予定の家族TZカレンダー日。取得不能なら null */
export function scheduleDateOf(s: ScheduleLike, tz = TZ): string | null {
  if (s.allDay) return s.date ?? null;
  if (s.startAt) return toDateStr(s.startAt.toDate(), tz);
  return s.date ?? null;
}

function startMs(s: ScheduleLike): number {
  return s.startAt ? s.startAt.toDate().getTime() : 0;
}

/** 日付昇順 → 終日が先 → 開始時刻順 */
export function compareSchedules(a: ScheduleLike, b: ScheduleLike, tz = TZ): number {
  const da = scheduleDateOf(a, tz) ?? '9999-99-99';
  const db = scheduleDateOf(b, tz) ?? '9999-99-99';
  if (da !== db) return da < db ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return startMs(a) - startMs(b);
}

export interface DayGroup<T> { date: string; items: T[] }
export interface ScheduleGroups<T> {
  /** 今日 */ today: T[];
  /** 明日 */ tomorrow: T[];
  /** 明後日以降（日別） */ later: DayGroup<T>[];
  /** 過去（新しい順の日別。UI では折りたたむ） */ past: DayGroup<T>[];
  /** 日付不明 */ undated: T[];
}

export function groupSchedules<T extends ScheduleLike>(list: T[], today: string, tz = TZ): ScheduleGroups<T> {
  const sorted = [...list].sort((a, b) => compareSchedules(a, b, tz));
  const tomorrowStr = addDaysStr(today, 1);
  const out: ScheduleGroups<T> = { today: [], tomorrow: [], later: [], past: [], undated: [] };
  const push = (arr: DayGroup<T>[], date: string, item: T) => {
    const last = arr[arr.length - 1];
    if (last && last.date === date) last.items.push(item);
    else arr.push({ date, items: [item] });
  };
  for (const s of sorted) {
    const d = scheduleDateOf(s, tz);
    if (!d) out.undated.push(s);
    else if (d === today) out.today.push(s);
    else if (d === tomorrowStr) out.tomorrow.push(s);
    else if (d > today) push(out.later, d, s);
    else push(out.past, d, s);
  }
  out.past.reverse();
  return out;
}

/** ホーム用: 今日の未完了予定（キャンセル除外） */
export function todaysSchedules<T extends ScheduleLike>(list: T[], today: string, tz = TZ): T[] {
  return list
    .filter((s) => s.status === 'planned' && scheduleDateOf(s, tz) === today)
    .sort((a, b) => compareSchedules(a, b, tz));
}

export interface TaskLike {
  status: 'todo' | 'doing' | 'done';
  dueDate?: string | null;
  assigneeUid?: string | null;
}
export type Urgency = 'overdue' | 'today' | 'soon' | 'none';

export function taskUrgency(t: TaskLike, today: string): Urgency {
  if (t.status === 'done' || !t.dueDate) return 'none';
  if (t.dueDate < today) return 'overdue';
  if (t.dueDate === today) return 'today';
  if (t.dueDate <= addDaysStr(today, 3)) return 'soon';
  return 'none';
}

/** 未完了が先、期限昇順（期限なしは後）。 */
export function compareTasks(a: TaskLike, b: TaskLike): number {
  const da = a.status === 'done' ? 1 : 0;
  const db = b.status === 'done' ? 1 : 0;
  if (da !== db) return da - db;
  const ka = a.dueDate ?? '9999-99-99';
  const kb = b.dueDate ?? '9999-99-99';
  if (ka !== kb) return ka < kb ? -1 : 1;
  return 0;
}

/** ホーム用: 期限が今日以前の未完了ToDo。本人担当→未担当の順（他者担当は除外）。16.3 */
export function homeDueTasks<T extends TaskLike>(list: T[], me: string, today: string): T[] {
  const rank = (t: T) => (t.assigneeUid === me ? 0 : 1);
  return list
    .filter((t) => t.status !== 'done' && !!t.dueDate && t.dueDate <= today && (t.assigneeUid === me || !t.assigneeUid))
    .sort((a, b) => rank(a) - rank(b) || compareTasks(a, b));
}

/** https のみ許可 */
export function isSafeHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname.length > 0;
  } catch {
    return false;
  }
}

export interface HandoverLike {
  priority: 'normal' | 'important';
  recipientUids: string[];
  status: 'open' | 'resolved';
  revision: number;
  createdBy?: string;
  expiresAt?: DateLike | null;
}
export interface AckLike { handoverRevision: number }
export type AckState = 'acked' | 'none' | 'stale';

/** 確認状態。revision が進んでいれば再確認が必要 */
export function ackState(h: { revision: number }, ack: AckLike | null | undefined): AckState {
  if (!ack) return 'none';
  return ack.handoverRevision < h.revision ? 'stale' : 'acked';
}

/** 宛先が自分か。recipientUids 空＝作成者以外の全員 */
export function isForMe(h: HandoverLike, me: string): boolean {
  if (h.recipientUids.length > 0) return h.recipientUids.includes(me);
  return h.createdBy !== me;
}

export function isExpired(h: HandoverLike, now: Date): boolean {
  return !!h.expiresAt && h.expiresAt.toDate().getTime() < now.getTime();
}

/** ホームに出す申し送り: 未解決・期限内・自分宛・未確認（または再確認要）。重要を上に、同順位は新しい順 */
export function pendingHandoversForMe<T extends HandoverLike & { createdAtMs?: number }>(
  list: T[],
  acks: Record<string, AckLike | null | undefined>,
  idOf: (h: T) => string,
  me: string,
  now: Date,
): T[] {
  return list
    .filter((h) => h.status === 'open' && !isExpired(h, now) && isForMe(h, me) && ackState(h, acks[idOf(h)]) !== 'acked')
    .sort(compareHandovers);
}

export function compareHandovers(a: HandoverLike & { createdAtMs?: number }, b: HandoverLike & { createdAtMs?: number }): number {
  const pa = a.priority === 'important' ? 0 : 1;
  const pb = b.priority === 'important' ? 0 : 1;
  if (pa !== pb) return pa - pb;
  return (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0);
}
