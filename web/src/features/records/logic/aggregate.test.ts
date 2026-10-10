import { describe, expect, it } from 'vitest';
import { buildSleepSessions, currentSleepState } from './sleep';
import { summarizeDay } from './aggregate';
import { buildDayRoutine } from './routine';
import { buildReflection } from './reflection';
import type { Ev } from './types';

const j = (s: string) => new Date(`${s}+09:00`);
let n = 0;
function ev(type: Ev['type'], at: string, payload: Record<string, unknown> = {}, extra: Partial<Ev> = {}): Ev {
  return { id: `e${++n}`, type, occurredAt: j(at), createdBy: 'a', caregiverUid: 'a', payload, status: 'active', revision: 1, pending: false, ...extra };
}
const ss = (id: string, t: 'sleep_start' | 'sleep_end', at: string) => ev(t, at, { sessionId: id }, { sessionId: id });

describe('sleep sessions', () => {
  it('日付跨ぎ睡眠を日ごとに分割して集計（重複しない）', () => {
    const sessions = buildSleepSessions([ss('s1', 'sleep_start', '2026-10-07T22:00:00'), ss('s1', 'sleep_end', '2026-10-08T02:00:00')]);
    const now = j('2026-10-08T12:00:00');
    const d7 = summarizeDay([], sessions, '2026-10-07', now);
    const d8 = summarizeDay([], sessions, '2026-10-08', now);
    expect(d7.sleepConfirmedSeconds).toBe(2 * 3600);
    expect(d8.sleepConfirmedSeconds).toBe(2 * 3600);
    const r8 = buildDayRoutine([], sessions, '2026-10-08', now);
    expect(r8.bands).toEqual([{ sessionId: 's1', startMin: 0, endMin: 120, kind: 'closed' }]);
  });
  it('未終了は確定と分け、現在まで', () => {
    const sessions = buildSleepSessions([ss('s1', 'sleep_start', '2026-10-08T10:00:00')]);
    const now = j('2026-10-08T11:00:00');
    const d = summarizeDay([], sessions, '2026-10-08', now);
    expect(d.sleepConfirmedSeconds).toBe(0);
    expect(d.sleepOpenSeconds).toBe(3600);
    expect(currentSleepState(sessions).kind).toBe('sleeping');
    const r = buildDayRoutine([], sessions, '2026-10-08', now);
    expect(r.bands[0]).toMatchObject({ kind: 'open', endMin: 660 });
  });
  it('複数の未終了開始は確認待ち', () => {
    const sessions = buildSleepSessions([ss('s1', 'sleep_start', '2026-10-08T10:00:00'), ss('s2', 'sleep_start', '2026-10-08T10:05:00')]);
    expect(currentSleepState(sessions).kind).toBe('unconfirmed');
    const d = summarizeDay([], sessions, '2026-10-08', j('2026-10-08T11:00:00'));
    expect(d.sleepConfirmedSeconds + d.sleepOpenSeconds).toBe(0);
    expect(d.sleepConflictCount).toBe(2);
  });
  it('終了が開始より前、同一セッション複数開始は確認待ち', () => {
    expect(buildSleepSessions([ss('s', 'sleep_start', '2026-10-08T10:00:00'), ss('s', 'sleep_end', '2026-10-08T09:00:00')])[0].state).toBe('conflict');
    expect(buildSleepSessions([ss('s', 'sleep_start', '2026-10-08T10:00:00'), ss('s', 'sleep_start', '2026-10-08T10:01:00')])[0].reason).toBe('multiple_start');
  });
  it('void は無視、起きている状態は最終起床', () => {
    const v = { ...ss('s1', 'sleep_start', '2026-10-08T10:00:00'), status: 'void' as const };
    expect(currentSleepState(buildSleepSessions([v])).kind).toBe('awake');
    const st = currentSleepState(buildSleepSessions([ss('s1', 'sleep_start', '2026-10-08T01:00:00'), ss('s1', 'sleep_end', '2026-10-08T02:00:00')]));
    expect(st).toMatchObject({ kind: 'awake', lastWake: j('2026-10-08T02:00:00') });
  });
});

describe('summarizeDay', () => {
  it('量未入力は合計から除外して件数表示、搾乳は別、母乳は量に含めない', () => {
    const evs = [
      ev('feeding', '2026-10-08T08:00:00', { method: 'formula', consumedMl: 80 }),
      ev('feeding', '2026-10-08T11:00:00', { method: 'formula' }),
      ev('feeding', '2026-10-08T12:00:00', { method: 'expressed_breast_milk', consumedMl: 40 }),
      ev('feeding', '2026-10-08T13:00:00', { method: 'breast' }),
      ev('pumping', '2026-10-08T14:00:00', { expressedMl: 100 }),
      ev('pumping', '2026-10-08T15:00:00', {}),
    ];
    const d = summarizeDay(evs, [], '2026-10-08');
    expect(d).toMatchObject({ milkMl: 120, milkUnknownCount: 1, breastCount: 1, formulaCount: 2, expressedCount: 1, pumpingCount: 2, pumpingMl: 100, pumpingUnknownCount: 1 });
  });
  it('おむつ: 両方は交換1・尿1・便1、未確認は0に変換しない', () => {
    const evs = [
      ev('diaper', '2026-10-08T08:00:00', { urine: 'yes', stool: 'yes', changed: true }),
      ev('diaper', '2026-10-08T09:00:00', { urine: 'unknown', stool: 'unknown', changed: true }),
    ];
    expect(summarizeDay(evs, [], '2026-10-08')).toMatchObject({ diaperCount: 2, urineCount: 1, stoolCount: 1, diaperUnknownCount: 1 });
  });
  it('別日と void は数えない', () => {
    const evs = [ev('vomit', '2026-10-07T23:59:00'), { ...ev('vomit', '2026-10-08T01:00:00'), status: 'void' as const }, ev('vomit', '2026-10-08T02:00:00')];
    expect(summarizeDay(evs, [], '2026-10-08').vomitCount).toBe(1);
  });
});

describe('routine markers', () => {
  it('現在以降は描かない、実施者フィルタでも帯は保持', () => {
    const sessions = buildSleepSessions([ss('s', 'sleep_start', '2026-10-08T01:00:00'), ss('s', 'sleep_end', '2026-10-08T02:00:00')]);
    const evs = [ev('vomit', '2026-10-08T05:00:00'), ev('vomit', '2026-10-08T15:00:00'), ev('bath', '2026-10-08T06:00:00', {}, { caregiverUid: 'b' })];
    const r = buildDayRoutine(evs, sessions, '2026-10-08', j('2026-10-08T12:00:00'), (e) => e.caregiverUid === 'b');
    expect(r.markers.map((m) => m.kind)).toEqual(['bath']);
    expect(r.bands.length).toBe(1);
  });
});

describe('reflection', () => {
  it('範囲外の直前の哺乳を区別し、経過分を返す', () => {
    const target = ev('vomit', '2026-10-08T15:00:00');
    const feed = ev('feeding', '2026-10-08T08:00:00', { method: 'formula', consumedMl: 60 });
    const dia = ev('diaper', '2026-10-08T14:45:00', { urine: 'yes', stool: 'no', changed: true });
    const r = buildReflection(target, [feed, dia, target], 480, 180);
    expect(r.inRange.map((e) => e.id)).toEqual([feed.id, dia.id, target.id]);
    const r2 = buildReflection(target, [feed, dia], 60, 180);
    expect(r2.inRange.map((e) => e.id)).toEqual([dia.id, target.id]);
    expect(r2.previousFeedingOutOfRange).toBe(true);
    expect(r2.minutesSincePreviousFeeding).toBe(420);
  });
});
