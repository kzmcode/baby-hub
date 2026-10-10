import { describe, expect, it } from 'vitest';
import { fromValue, toValue } from './codec';
import { FieldValue } from './field-value';
import { Timestamp } from './timestamp';

const root = 'projects/p/databases/(default)/documents';
const mk = (p: string) => ({ _isDocRef: true, path: p });
const rt = (v: unknown) => fromValue(toValue(v, root), root, mk);

describe('codec', () => {
  it('round-trips primitives, nested maps and arrays', () => {
    const v = { a: null, b: true, c: 'あ', d: 12, e: 1.5, f: [1, 'x', { g: [] }], h: { i: { j: 'k' } }, empty: {} };
    expect(rt(v)).toEqual(v);
  });
  it('encodes integers as integerValue string and fractions as doubleValue', () => {
    expect(toValue(5, root)).toEqual({ integerValue: '5' });
    expect(toValue(5.5, root)).toEqual({ doubleValue: 5.5 });
    expect(toValue(NaN, root)).toEqual({ doubleValue: 'NaN' });
    expect(rt(-Infinity)).toBe(-Infinity);
  });
  it('round-trips Timestamp with nanoseconds and Date', () => {
    const t = new Timestamp(1700000000, 123456789);
    expect(toValue(t, root)).toEqual({ timestampValue: '2023-11-14T22:13:20.123456789Z' });
    const back = rt(t) as Timestamp;
    expect(back).toBeInstanceOf(Timestamp);
    expect(back.isEqual(t)).toBe(true);
    expect((rt(new Date('2024-01-02T03:04:05.678Z')) as Timestamp).toMillis()).toBe(Date.parse('2024-01-02T03:04:05.678Z'));
  });
  it('parses timestamps without fraction and with offsets', () => {
    expect(Timestamp.fromISO('2024-01-01T00:00:00Z').toMillis()).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(Timestamp.fromISO('2024-01-01T09:00:00+09:00').toMillis()).toBe(Date.parse('2024-01-01T00:00:00Z'));
  });
  it('Timestamp comparison and JSON', () => {
    const a = Timestamp.fromMillis(1000), b = Timestamp.fromMillis(2000);
    expect(a < b).toBe(true);
    expect(JSON.stringify({ t: a })).toBe('{"t":"1970-01-01T00:00:01.000Z"}');
  });
  it('round-trips document references', () => {
    expect(toValue(mk('a/b') as never, root)).toEqual({ referenceValue: `${root}/a/b` });
    expect(rt(mk('a/b'))).toEqual({ _isDocRef: true, path: 'a/b' });
  });
  it('skips undefined properties but rejects undefined in arrays and sentinels', () => {
    expect(toValue({ a: undefined, b: 1 }, root)).toEqual({ mapValue: { fields: { b: { integerValue: '1' } } } });
    expect(() => toValue([undefined], root)).toThrow();
    expect(() => toValue({ a: FieldValue.serverTimestamp() }, root)).toThrow();
  });
});
