import { describe, expect, it } from 'vitest';
import { addDaysStr, dayRange, formatAge, formatDuration, formatElapsed, formatTime, isInQuietHours, todayStr } from './time';

describe('time', () => {
  it('dayRange は Asia/Tokyo の 0:00 境界（UTC 15:00）', () => {
    const { start, end } = dayRange('2026-03-10');
    expect(start.toISOString()).toBe('2026-03-09T15:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-10T15:00:00.000Z');
  });
  it('todayStr は UTC 日付ではなく JST 日付', () => {
    expect(todayStr(new Date('2026-03-09T16:00:00Z'))).toBe('2026-03-10');
  });
  it('addDaysStr は月跨ぎ', () => {
    expect(addDaysStr('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysStr('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('formatTime', () => {
    expect(formatTime(new Date('2026-03-09T16:05:00Z'))).toBe('01:05');
  });
  it('formatElapsed', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    expect(formatElapsed(new Date(now.getTime() - 135 * 60000), now)).toBe('2時間15分前');
    expect(formatElapsed(new Date(now.getTime() - 120 * 60000), now)).toBe('2時間前');
    expect(formatElapsed(new Date(now.getTime() - 30 * 1000), now)).toBe('たった今');
    expect(formatElapsed(new Date(now.getTime() - 15 * 60000), now)).toBe('15分前');
  });
  it('formatDuration', () => {
    expect(formatDuration(4800)).toBe('1時間20分');
    expect(formatDuration(2700)).toBe('45分');
  });
  it('formatAge', () => {
    const now = new Date('2026-03-10T03:00:00Z');
    expect(formatAge('2026-03-01', now)).toBe('生後9日');
    expect(formatAge('2025-12-10', now)).toBe('3か月');
    expect(formatAge(null, now)).toBeNull();
  });
  it('isInQuietHours は日跨ぎ対応', () => {
    expect(isInQuietHours(new Date('2026-03-10T14:00:00Z'), '22:00', '07:00')).toBe(true); // 23:00 JST
    expect(isInQuietHours(new Date('2026-03-10T03:00:00Z'), '22:00', '07:00')).toBe(false); // 12:00 JST
  });
});
