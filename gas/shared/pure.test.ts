import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  isInQuietHours, nextQuietEnd, parseHm, hashToken, sha256Hex, isPlausibleToken, isRecentAuth, jobId, reminderDueMs, minutesOfDay,
} from './pure';

const q = { enabled: true, start: '22:00', end: '07:00' };
const jst = (s: string) => new Date(`2026-10-08T${s}:00+09:00`);

describe('quiet hours (Asia/Tokyo)', () => {
  it('minutesOfDay uses JST', () => {
    expect(minutesOfDay(new Date('2026-10-08T00:00:00Z'))).toBe(9 * 60);
  });
  it('wrap-around window', () => {
    expect(isInQuietHours(jst('21:59'), q)).toBe(false);
    expect(isInQuietHours(jst('22:00'), q)).toBe(true);
    expect(isInQuietHours(jst('03:00'), q)).toBe(true);
    expect(isInQuietHours(jst('06:59'), q)).toBe(true);
    expect(isInQuietHours(jst('07:00'), q)).toBe(false);
    expect(isInQuietHours(jst('12:00'), q)).toBe(false);
  });
  it('same-day window and disabled/invalid', () => {
    const day = { enabled: true, start: '13:00', end: '15:00' };
    expect(isInQuietHours(jst('14:00'), day)).toBe(true);
    expect(isInQuietHours(jst('15:00'), day)).toBe(false);
    expect(isInQuietHours(jst('23:00'), { ...q, enabled: false })).toBe(false);
    expect(isInQuietHours(jst('23:00'), { enabled: true, start: 'xx', end: '07:00' })).toBe(false);
    expect(isInQuietHours(jst('23:00'), { enabled: true, start: '07:00', end: '07:00' })).toBe(false);
    expect(isInQuietHours(jst('23:00'), undefined)).toBe(false);
  });
  it('nextQuietEnd', () => {
    expect(nextQuietEnd(jst('23:30'), q).toISOString()).toBe('2026-10-08T22:00:00.000Z'.replace('22:00', '22:00')); // 翌日 07:00 JST
    expect(nextQuietEnd(jst('03:15'), q).getTime()).toBe(jst('07:00').getTime());
    const noon = jst('12:00');
    expect(nextQuietEnd(noon, q).getTime()).toBe(noon.getTime());
  });
  it('parseHm', () => {
    expect(parseHm('07:00')).toBe(420);
    expect(parseHm('24:00')).toBeNull();
    expect(parseHm('7')).toBeNull();
  });
});

describe('sha256Hex (pure JS)', () => {
  it('matches node:crypto incl. multibyte and block boundaries', () => {
    for (const s of ['', 'abc', 'あいう🍼', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x|y|'.repeat(100)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });
});

describe('token / auth / jobs', () => {
  it('token is 256bit base64url and hash is stable', () => {
    const t = randomBytes(32).toString('base64url');
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isPlausibleToken(t)).toBe(true);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(isPlausibleToken('short')).toBe(false);
  });
  it('recent auth within 5 min', () => {
    const now = Date.now();
    expect(isRecentAuth(now / 1000 - 100, now)).toBe(true);
    expect(isRecentAuth(now / 1000 - 301, now)).toBe(false);
    expect(isRecentAuth(undefined, now)).toBe(false);
  });
  it('jobId deterministic', () => {
    expect(jobId(['a', 1, 'u'])).toBe(jobId(['a', 1, 'u']));
    expect(jobId(['a', 1, 'u'])).not.toBe(jobId(['a', 2, 'u']));
    expect(reminderDueMs(3_600_000)).toBe(0);
  });
});

describe('sha256Bytes', () => {
  it('matches node:crypto for arbitrary bytes', async () => {
    const { sha256Bytes } = await import('./pure');
    const bytes = Array.from({ length: 300 }, (_, i) => (i * 7) & 255);
    expect(sha256Bytes(bytes)).toEqual(Array.from(createHash('sha256').update(Buffer.from(bytes)).digest()));
  });
});
