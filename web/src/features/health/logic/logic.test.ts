import { describe, expect, it } from 'vitest';
import { gramsToKgText, kgToGrams, validateCelsius, validateGrowth } from './units';
import { lastDoseMap, lastDoseOf } from './dose';
import { dateRange, growthSeries, lastNDays, summarizeByDay, type LogEvent } from './summary';

const dateOf = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (s: string) => new Date(`${s}T00:00:00Z`);
const ev = (type: string, at: string, payload: Record<string, unknown> = {}): LogEvent => ({ id: at + type, type, occurredAt: new Date(at), payload });

describe('units', () => {
  it('kg to g', () => {
    expect(kgToGrams('3.456')).toBe(3456);
    expect(kgToGrams('0.1+')).toBeNull();
    expect(kgToGrams('')).toBeNull();
    expect(kgToGrams(-1)).toBeNull();
    expect(gramsToKgText(3450)).toBe('3.45');
    expect(gramsToKgText(4000)).toBe('4');
  });
  it('validation', () => {
    expect(validateCelsius(36.5)).toBeNull();
    expect(validateCelsius(29.9)).not.toBeNull();
    expect(validateCelsius(null)).not.toBeNull();
    expect(validateGrowth(null, null)).not.toBeNull();
    expect(validateGrowth(50, null)).toBeNull();
    expect(validateGrowth(null, 100)).not.toBeNull();
    expect(validateGrowth(160, null)).not.toBeNull();
  });
});

describe('dose', () => {
  const list = [
    { id: '1', occurredAt: new Date('2026-01-01T01:00:00Z'), medicationId: 'a' },
    { id: '2', occurredAt: new Date('2026-01-01T05:00:00Z'), medicationId: 'a' },
    { id: '3', occurredAt: new Date('2026-01-01T03:00:00Z'), medicationId: 'b' },
  ];
  it('last dose', () => {
    expect(lastDoseOf('a', list)?.id).toBe('2');
    expect(lastDoseOf('c', list)).toBeNull();
    expect(lastDoseMap(list).get('b')?.id).toBe('3');
  });
});

describe('summary', () => {
  it('range', () => {
    expect(lastNDays('2026-01-10', 3)).toEqual({ from: '2026-01-08', to: '2026-01-10' });
    expect(dateRange('2026-01-30', '2026-02-01')).toEqual(['2026-01-30', '2026-01-31', '2026-02-01']);
    expect(dateRange('2026-02-01', '2026-01-01')).toEqual([]);
  });
  it('aggregates and excludes unknown ml', () => {
    const dates = ['2026-01-01', '2026-01-02'];
    const r = summarizeByDay(
      [
        ev('feeding', '2026-01-01T01:00:00Z', { consumedMl: 100 }),
        ev('feeding', '2026-01-01T04:00:00Z', {}),
        ev('diaper', '2026-01-01T05:00:00Z', { urine: 'yes', stool: 'no' }),
        ev('vomit', '2026-01-02T05:00:00Z'),
        ev('temperature', '2026-01-02T06:00:00Z', { celsius: 37.5 }),
        ev('sleep_start', '2026-01-01T22:00:00Z', { sessionId: 's' }),
        ev('sleep_end', '2026-01-02T02:00:00Z', { sessionId: 's' }),
        ev('sleep_start', '2026-01-02T10:00:00Z', { sessionId: 't' }),
      ],
      dates, dateOf, dayStart,
    );
    expect(r[0].feedingCount).toBe(2);
    expect(r[0].feedingMl).toBe(100);
    expect(r[0].feedingMlUnknownCount).toBe(1);
    expect(r[0].urineCount).toBe(1);
    expect(r[0].stoolCount).toBe(0);
    expect(r[0].sleepSeconds).toBe(2 * 3600);
    expect(r[1].sleepSeconds).toBe(2 * 3600);
    expect(r[1].sleepOpen).toBe(true);
    expect(r[1].vomitCount).toBe(1);
    expect(r[1].temperatures).toEqual([37.5]);
  });
  it('growth series', () => {
    const s = growthSeries([
      { occurredAt: new Date('2026-02-01'), payload: { weightGrams: 4000 } },
      { occurredAt: new Date('2026-01-01'), payload: { weightGrams: 3000, heightCm: 50 } },
    ], 'weightGrams');
    expect(s.map((p) => p.v)).toEqual([3000, 4000]);
    expect(growthSeries([{ occurredAt: new Date(), payload: {} }], 'heightCm')).toEqual([]);
  });
});
