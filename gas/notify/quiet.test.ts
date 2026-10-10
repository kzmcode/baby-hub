import { describe, expect, it } from 'vitest';
import {
  NOTIFY_TEXT, decideDelivery, handoverJobId, isInQuietHours, minutesOfDayJst, nextQuietEnd, reminderDueMs, scheduleJobId, textFor, urlFor,
} from './quiet';
import { classifyFcmError, linkFor } from './fcm';

const q = { enabled: true, start: '22:00', end: '07:00' };
// JST 時刻から Date を作る
const jst = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h - 9, mi));

describe('静穏時間', () => {
  it('JST の分を計算する', () => {
    expect(minutesOfDayJst(jst(2026, 10, 8, 23, 30))).toBe(23 * 60 + 30);
    expect(minutesOfDayJst(jst(2026, 10, 8, 0, 5))).toBe(5);
  });
  it('日跨ぎ判定', () => {
    expect(isInQuietHours(jst(2026, 10, 8, 22, 0), q)).toBe(true);
    expect(isInQuietHours(jst(2026, 10, 8, 3, 0), q)).toBe(true);
    expect(isInQuietHours(jst(2026, 10, 8, 6, 59), q)).toBe(true);
    expect(isInQuietHours(jst(2026, 10, 8, 7, 0), q)).toBe(false);
    expect(isInQuietHours(jst(2026, 10, 8, 21, 59), q)).toBe(false);
  });
  it('同日内・無効・不正値', () => {
    expect(isInQuietHours(jst(2026, 10, 8, 13, 0), { enabled: true, start: '12:00', end: '14:00' })).toBe(true);
    expect(isInQuietHours(jst(2026, 10, 8, 15, 0), { enabled: true, start: '12:00', end: '14:00' })).toBe(false);
    expect(isInQuietHours(jst(2026, 10, 8, 23, 0), { ...q, enabled: false })).toBe(false);
    expect(isInQuietHours(jst(2026, 10, 8, 23, 0), { enabled: true, start: 'x', end: '07:00' })).toBe(false);
    expect(isInQuietHours(jst(2026, 10, 8, 23, 0), { enabled: true, start: '07:00', end: '07:00' })).toBe(false);
  });
});

describe('延期時刻', () => {
  it('夜間は翌朝7時（JST）', () => {
    expect(nextQuietEnd(jst(2026, 10, 8, 23, 10), q).toISOString()).toBe(jst(2026, 10, 9, 7, 0).toISOString());
  });
  it('早朝は当日7時', () => {
    expect(nextQuietEnd(jst(2026, 10, 9, 3, 20), q).toISOString()).toBe(jst(2026, 10, 9, 7, 0).toISOString());
  });
  it('静穏でなければ now', () => {
    const n = jst(2026, 10, 9, 12, 0);
    expect(nextQuietEnd(n, q)).toBe(n);
  });
});

describe('配信判定', () => {
  const night = jst(2026, 10, 8, 23, 0);
  it('important は静穏時間でも送る', () => {
    expect(decideDelivery({ type: 'handover', priority: 'important' }, undefined, night)).toEqual({ status: 'send' });
  });
  it('normal は初期設定OFF → skipped', () => {
    expect(decideDelivery({ type: 'handover', priority: 'normal' }, undefined, jst(2026, 10, 8, 12))).toEqual({ status: 'skipped', note: 'user-disabled' });
  });
  it('normal を ON にし静穏時間中なら延期', () => {
    const d = decideDelivery({ type: 'handover', priority: 'normal' }, { notify: { handoverNormal: true } }, night);
    expect(d).toEqual({ status: 'defer', until: jst(2026, 10, 9, 7, 0) });
  });
  it('予定リマインダは静穏終了が開始以降なら skipped、前なら延期', () => {
    const start = jst(2026, 10, 9, 6, 30).getTime();
    expect(decideDelivery({ type: 'scheduleReminder', priority: 'normal', startMs: start }, undefined, night)).toEqual({ status: 'skipped', note: 'quiet-hours' });
    const start2 = jst(2026, 10, 9, 9, 0).getTime();
    expect(decideDelivery({ type: 'scheduleReminder', priority: 'normal', startMs: start2 }, undefined, night).status).toBe('defer');
  });
  it('予定通知OFFなら skipped', () => {
    expect(decideDelivery({ type: 'scheduleReminder', priority: 'normal', startMs: 1 }, { notify: { scheduleReminder: false } }, jst(2026, 10, 8, 12))).toEqual({ status: 'skipped', note: 'user-disabled' });
  });
});

describe('ジョブID', () => {
  it('決定的で形式が仕様どおり', () => {
    expect(handoverJobId('h1', 1, 'u1')).toBe('handover_h1_r1_u1');
    expect(handoverJobId('h1', 1, 'u1')).toBe(handoverJobId('h1', 1, 'u1'));
    expect(handoverJobId('h1', 2, 'u1')).not.toBe(handoverJobId('h1', 1, 'u1'));
    expect(scheduleJobId('s1', 1000, 'u2')).toBe('schedule_s1_1000_u2');
  });
  it('Firestore ID で使えない文字を含めない', () => {
    expect(handoverJobId('a/b', 1, 'c.d')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('予定リマインダは開始60分前', () => {
    expect(reminderDueMs(3600_000 * 5)).toBe(3600_000 * 4);
  });
});

describe('文言', () => {
  it('定型文のみで個人情報を含まない', () => {
    const texts = [textFor('handover', 'important'), textFor('handover', 'normal'), textFor('scheduleReminder', 'normal'), NOTIFY_TEXT.test];
    for (const t of texts) {
      expect(Object.values(NOTIFY_TEXT)).toContain(t);
      expect(t).not.toMatch(/[A-Za-z0-9]{6,}/); // ID・トークン類を含まない
    }
  });
  it('URL は関連IDのパスのみ', () => {
    expect(urlFor('handover', 'h1')).toBe('/plans/handovers/h1');
    expect(urlFor('scheduleReminder', 's1')).toBe('/plans/schedules/s1');
  });
});

describe('FCM', () => {
  it('UNREGISTERED / INVALID_ARGUMENT は無効トークン', () => {
    const b1 = JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } });
    expect(classifyFcmError(404, b1)).toMatchObject({ invalidToken: true, retryable: false, code: 'UNREGISTERED' });
    const b2 = JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } });
    expect(classifyFcmError(400, b2).invalidToken).toBe(true);
  });
  it('5xx は再試行可、権限エラーも再試行扱い', () => {
    expect(classifyFcmError(503, '{}')).toMatchObject({ invalidToken: false, retryable: true });
    expect(classifyFcmError(403, 'x').retryable).toBe(true);
  });
  it('link は https の絶対 URL', () => {
    const p = { config: { projectId: 'demo' } } as never;
    expect(linkFor(p, '/plans/handovers/h1')).toBe('https://demo.web.app/plans/handovers/h1');
    expect(linkFor(p, undefined)).toBeUndefined();
  });
});

describe('ownerTransfer notification', () => {
  it('uses the fixed text and the family screen, ignoring settings and quiet hours', async () => {
    const q = await import('./quiet');
    expect(q.textFor('ownerTransfer', 'important')).toBe('管理者の移譲が提案されています');
    expect(q.urlFor('ownerTransfer', 'f1')).toBe('/more/family');
    const night = new Date('2026-01-01T15:30:00Z'); // JST 0:30
    expect(q.decideDelivery({ type: 'ownerTransfer', priority: 'important' }, { notify: { handoverImportant: false } }, night)).toEqual({ status: 'send' });
  });
});
