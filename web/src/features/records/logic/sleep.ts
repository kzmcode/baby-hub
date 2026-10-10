import type { Ev } from './types';

export type SleepState = 'closed' | 'open' | 'conflict';

export interface SleepSession {
  sessionId: string;
  start?: Date;
  end?: Date;
  startEventId?: string;
  endEventId?: string;
  startCaregiver?: string | null;
  endCaregiver?: string | null;
  state: SleepState;
  /** 確認待ちの理由 */
  reason?: 'multiple_start' | 'multiple_end' | 'end_before_start' | 'orphan_end' | 'multiple_open';
}

/**
 * sleep_start / sleep_end を sessionId で対応づけてセッションを組み立てる。
 * 終了時刻を推測で埋めない。複数開始・複数終了・終了<開始・開始なしの終了は 'conflict'（確認待ち）。
 * 未終了のセッションが複数あれば、それらも 'conflict'。
 */
export function buildSleepSessions(events: Ev[]): SleepSession[] {
  const map = new Map<string, { starts: Ev[]; ends: Ev[] }>();
  for (const e of events) {
    if (e.status !== 'active') continue;
    if (e.type !== 'sleep_start' && e.type !== 'sleep_end') continue;
    const sid = e.sessionId;
    if (!sid) continue;
    let g = map.get(sid);
    if (!g) map.set(sid, (g = { starts: [], ends: [] }));
    (e.type === 'sleep_start' ? g.starts : g.ends).push(e);
  }
  const out: SleepSession[] = [];
  for (const [sessionId, g] of map) {
    const s = g.starts.slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0];
    const en = g.ends.slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0];
    const base: SleepSession = {
      sessionId,
      start: s?.occurredAt,
      end: en?.occurredAt,
      startEventId: s?.id,
      endEventId: en?.id,
      startCaregiver: s?.caregiverUid,
      endCaregiver: en?.caregiverUid,
      state: 'closed',
    };
    if (g.starts.length > 1) out.push({ ...base, state: 'conflict', reason: 'multiple_start' });
    else if (g.ends.length > 1) out.push({ ...base, state: 'conflict', reason: 'multiple_end' });
    else if (!s) out.push({ ...base, state: 'conflict', reason: 'orphan_end' });
    else if (en && en.occurredAt.getTime() < s.occurredAt.getTime())
      out.push({ ...base, state: 'conflict', reason: 'end_before_start' });
    else if (!en) out.push({ ...base, state: 'open' });
    else out.push(base);
  }
  const open = out.filter((x) => x.state === 'open');
  if (open.length > 1) for (const o of open) { o.state = 'conflict'; o.reason = 'multiple_open'; }
  return out.sort((a, b) => (a.start ?? a.end!).getTime() - (b.start ?? b.end!).getTime());
}

export type CurrentSleep =
  | { kind: 'sleeping'; since: Date; session: SleepSession }
  | { kind: 'awake'; lastWake: Date | null }
  | { kind: 'unconfirmed'; sessions: SleepSession[] };

/** ホーム用の現在状態 */
export function currentSleepState(sessions: SleepSession[]): CurrentSleep {
  const conflicts = sessions.filter((s) => s.state === 'conflict');
  if (conflicts.length > 0) return { kind: 'unconfirmed', sessions: conflicts };
  const open = sessions.find((s) => s.state === 'open');
  if (open) return { kind: 'sleeping', since: open.start!, session: open };
  const closed = sessions.filter((s) => s.state === 'closed' && s.end);
  const last = closed.reduce<Date | null>((m, s) => (!m || s.end!.getTime() > m.getTime() ? s.end! : m), null);
  return { kind: 'awake', lastWake: last };
}

export const SLEEP_REASON_TEXT: Record<NonNullable<SleepSession['reason']>, string> = {
  multiple_start: '開始が複数あります',
  multiple_end: '終了が複数あります',
  end_before_start: '終了が開始より前になっています',
  orphan_end: '対応する開始がありません',
  multiple_open: '終了していない睡眠が複数あります',
};
