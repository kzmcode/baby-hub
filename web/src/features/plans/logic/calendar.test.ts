import { describe, expect, it } from 'vitest';
import { calendarDays, isCalendarDate, shiftCalendarMonth } from './calendar';
import { compareSchedules, scheduleDateOf } from './plans';

describe('calendar dates', () => {
  it('accepts real dates only, including leap days', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    for (const date of [null, '', '2026-2-01', '2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01']) {
      expect(isCalendarDate(date)).toBe(false);
    }
  });
  it('moves across year boundaries without overflowing long months', () => {
    expect(shiftCalendarMonth('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftCalendarMonth('2026-01-31', -1)).toBe('2025-12-01');
    expect(shiftCalendarMonth('2028-01-31', 1)).toBe('2028-02-01');
  });
  it('lays out six full weeks when needed, including both adjacent months', () => {
    const days = calendarDays('2026-05-15');
    expect(days).toHaveLength(42);
    expect(days[0]).toBe('2026-04-26');
    expect(days[41]).toBe('2026-06-06');
    expect(new Set(days).size).toBe(42);
  });
  it('supports February with four weeks and leap years', () => {
    const days = calendarDays('2026-02-15');
    expect(days).toHaveLength(28);
    expect(days[0]).toBe('2026-02-01');
    expect(days.at(-1)).toBe('2026-02-28');
    expect(calendarDays('2028-02-01')).toContain('2028-02-29');
  });
  it('uses the family day for timed schedules, with all-day schedules first', () => {
    const timed = { allDay: false, status: 'planned' as const, startAt: { toDate: () => new Date('2026-10-09T16:00:00Z') } };
    const allDay = { allDay: true, status: 'planned' as const, date: '2026-10-10' };
    expect(scheduleDateOf(timed)).toBe('2026-10-10');
    expect([timed, allDay].sort(compareSchedules)).toEqual([allDay, timed]);
  });
});
