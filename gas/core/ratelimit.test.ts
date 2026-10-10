import { describe, expect, it } from 'vitest';
import { REQUEST_DAILY_BUDGET, TRIGGER_DAILY_BUDGET, budgetUsed, chargeBudget, metered } from './budget';
import { dispatch } from './dispatch';
import { ApiError } from './errors';
import { FAIL_LIMIT, GLOBAL_LIMIT, consume, jstDate, limitsFor, release, sweepDayCounters } from './ratelimit';
import { fakePlatform, makeJwt } from './test-utils';

const sec = Math.floor(Date.now() / 1000);
const token = makeJwt({ aud: 'demo-test', iss: 'https://securetoken.google.com/demo-test', sub: 'u1', exp: sec + 3600, auth_time: sec - 10 });
const tokenOf = (sub: string) => makeJwt({ aud: 'demo-test', iss: 'https://securetoken.google.com/demo-test', sub, exp: sec + 3600, auth_time: sec - 10 });
const call = (p: ReturnType<typeof fakePlatform>, fn: string, handlers: Record<string, any>, idToken = token) =>
  JSON.parse(dispatch(p, JSON.stringify({ fn, data: {}, idToken }), handlers));

describe('consume (fixed window)', () => {
  it('allows up to the limit then throws resource-exhausted with retryAfterSec', () => {
    const p = fakePlatform();
    const l = { bucket: 'b', limit: 3, windowSec: 60 };
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) consume(p, 'u1', l, t0);
    try {
      consume(p, 'u1', l, t0 + 1000);
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const a = e as ApiError;
      expect(a.code).toBe('resource-exhausted');
      expect(a.details).toMatchObject({ reason: 'rate-limited' });
      const r = (a.details as { retryAfterSec: number }).retryAfterSec;
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(60);
    }
  });
  it('is per uid and resets in the next window', () => {
    const p = fakePlatform();
    const l = { bucket: 'b', limit: 1, windowSec: 60 };
    const t0 = 1_700_000_000_000;
    consume(p, 'u1', l, t0);
    consume(p, 'u2', l, t0);
    expect(() => consume(p, 'u1', l, t0)).toThrow();
    consume(p, 'u1', l, t0 + 61_000);
  });
  it('windows over 6h are JST calendar days kept in script properties (one key per uid)', () => {
    const p = fakePlatform();
    const l = { bucket: 'day', limit: 2, windowSec: 86400 };
    const t0 = Date.UTC(2026, 9, 8, 14, 0, 0); // 2026-10-08 23:00 JST
    consume(p, 'u1', l, t0);
    consume(p, 'u1', { bucket: 'other', limit: 1, windowSec: 86400 }, t0);
    consume(p, 'u1', l, t0);
    try { consume(p, 'u1', l, t0); throw new Error('no'); } catch (e) {
      expect((e as ApiError).code).toBe('resource-exhausted');
      expect(((e as ApiError).details as { retryAfterSec: number }).retryAfterSec).toBe(3600); // JST 24:00 まで
    }
    expect(JSON.parse(p.props.get('rld:u1')!)).toEqual({ d: '2026-10-08', b: { day: 2, other: 1 } });
    consume(p, 'u1', l, t0 + 3600_000 + 1000); // JST 翌日 00:00:01 でリセット
    expect(JSON.parse(p.props.get('rld:u1')!).d).toBe('2026-10-09');
    expect(jstDate(t0)).toBe('2026-10-08');
  });
  it('sweepDayCounters removes stale daily records only', () => {
    const p = fakePlatform();
    const t0 = Date.UTC(2026, 9, 8, 0, 0, 0);
    consume(p, 'old', { bucket: 'b', limit: 1, windowSec: 86400 }, t0 - 2 * 86400_000);
    consume(p, 'new', { bucket: 'b', limit: 1, windowSec: 86400 }, t0);
    p.props.set('other-key', 'x');
    expect(sweepDayCounters(p, t0)).toBe(1);
    expect([...p.props.keys()].sort()).toEqual(['other-key', 'rld:new']);
  });
  it('strict limits take the script lock briefly and fail closed when it cannot be acquired', () => {
    const p = fakePlatform();
    const l = { bucket: 's', limit: 2, windowSec: 3600, strict: true };
    consume(p, 'u1', l, 1_700_000_000_000);
    expect(p.lock.acquired).toBe(1);
    expect(p.lock.held).toBe(0); // 解放済み
    p.lock.fail = true;
    try { consume(p, 'u1', l, 1_700_000_000_000); throw new Error('no'); } catch (e) {
      expect((e as ApiError).code).toBe('resource-exhausted');
      expect((e as ApiError).details).toMatchObject({ reason: 'rate-limited' });
    }
    p.lock.fail = false;
    consume(p, 'u1', l, 1_700_000_000_000); // 失敗した試行はカウントされていない
    expect(() => consume(p, 'u1', l, 1_700_000_000_000)).toThrow();
    // strict でない上限はロックを使わない
    const q = fakePlatform();
    consume(q, 'u1', { bucket: 'n', limit: 1, windowSec: 60 }, 1_700_000_000_000);
    expect(q.lock.acquired).toBe(0);
  });
  it('strict limit bucket assignment', () => {
    for (const fn of ['createFamily', 'deleteAccount', 'deleteFamily', 'sendTestNotification', 'transferOwnership', 'acceptOwnershipTransfer']) {
      expect(limitsFor(fn).some((l) => l.strict)).toBe(true);
    }
    expect(FAIL_LIMIT.strict).toBe(true);
    expect(limitsFor('createFamily')[0]).toMatchObject({ limit: 5, windowSec: 86400 });
    expect(limitsFor('registerDevice').some((l) => l.strict)).toBe(false);
  });
  it('release returns a reserved slot', () => {
    const p = fakePlatform();
    const l = { bucket: 'r', limit: 1, windowSec: 60, strict: true };
    consume(p, 'u1', l, 1_700_000_000_000);
    release(p, 'u1', l, 1_700_000_000_000);
    consume(p, 'u1', l, 1_700_000_000_000);
    expect(() => consume(p, 'u1', l, 1_700_000_000_000)).toThrow();
  });
  it('is disabled only for an emulator platform that opts out', () => {
    const p = fakePlatform(undefined, { emulator: true, rateLimitDisabled: true });
    for (let i = 0; i < 100; i++) consume(p, 'u1', GLOBAL_LIMIT, 1_700_000_000_000);
    const prod = fakePlatform(undefined, { emulator: false, rateLimitDisabled: true });
    for (let i = 0; i < 60; i++) consume(prod, 'u1', GLOBAL_LIMIT, 1_700_000_000_000);
    expect(() => consume(prod, 'u1', GLOBAL_LIMIT, 1_700_000_000_000)).toThrow();
  });
});

describe('dispatch rate limits', () => {
  const mk = () => fakePlatform((url) => (url.includes('accounts:lookup') ? { status: 200, body: JSON.stringify({ users: [{ localId: 'u1' }] }) } : { status: 500, body: '' }));
  it('limits all functions to 60 calls per minute per uid', () => {
    const p = mk();
    const h = { ping: () => 1 };
    let last: any;
    for (let i = 0; i < 61; i++) last = call(p, 'ping', h);
    expect(last.ok).toBe(false);
    expect(last.error).toMatchObject({ code: 'resource-exhausted', details: { reason: 'rate-limited' } });
    expect(typeof last.error.details.retryAfterSec).toBe('number');
  });
  it('applies per-function limits (sendTestNotification 1/min)', () => {
    const p = mk();
    const h = { sendTestNotification: () => ({ sent: 0 }) };
    expect(call(p, 'sendTestNotification', h).ok).toBe(true);
    expect(call(p, 'sendTestNotification', h).error.code).toBe('resource-exhausted');
  });
  it('counts previewInvite/acceptInvite only on failure (10/hour, shared)', () => {
    const p = mk();
    let fail = true;
    const h = {
      previewInvite: () => { if (fail) throw new ApiError('not-found', 'x'); return 1; },
      acceptInvite: () => { if (fail) throw new ApiError('not-found', 'x'); return 1; },
    };
    // 成功は何回でもカウントされない（全体 60/分 の範囲内）
    fail = false;
    for (let i = 0; i < 20; i++) expect(call(p, 'previewInvite', h).ok).toBe(true);
    fail = true;
    for (let i = 0; i < 5; i++) expect(call(p, 'previewInvite', h).error.code).toBe('not-found');
    for (let i = 0; i < 5; i++) expect(call(p, 'acceptInvite', h).error.code).toBe('not-found');
    // 失敗 10 回に達したら以降は（成功する状況でも）拒否
    fail = false;
    const r = call(p, 'acceptInvite', h);
    expect(r.error).toMatchObject({ code: 'resource-exhausted', details: { reason: 'rate-limited' } });
    expect(FAIL_LIMIT.limit).toBe(10);
  });
  it('does not count unauthenticated or unknown-fn requests against a uid', () => {
    const p = mk();
    for (let i = 0; i < 100; i++) call(p, 'nope', {}, tokenOf('u1'));
    expect(call(p, 'ping', { ping: () => 1 }).ok).toBe(true);
  });
});

describe('dispatch: UrlFetch protection', () => {
  const lookups = (p: ReturnType<typeof fakePlatform>) => p.fetches();
  const mk = () => fakePlatform((url) => (url.includes('accounts:lookup') ? { status: 200, body: JSON.stringify({ users: [{ localId: 'u1' }] }) } : { status: 500, body: '' }));

  it('consumes the global bucket before accounts:lookup, so a valid token cannot exhaust UrlFetch', () => {
    const p = mk();
    const h = { ping: () => 1 };
    for (let i = 0; i < 200; i++) call(p, 'ping', h);
    expect(lookups(p)).toBeLessThanOrEqual(60);
    // 制限超過のリクエストは lookup を呼ばない
    const before = lookups(p);
    expect(call(p, 'ping', h).error.code).toBe('resource-exhausted');
    expect(lookups(p)).toBe(before);
  });
  it('lookup results are cached 60s per uid+auth_time', () => {
    const p = mk();
    for (let i = 0; i < 30; i++) call(p, 'ping', { ping: () => 1 });
    expect(lookups(p)).toBe(1);
  });
  it('daily budget: requests are refused with unavailable/daily-budget while the trigger budget stays separate', () => {
    const p = mk();
    const h = { ping: () => 1 };
    expect(call(p, 'ping', h).ok).toBe(true);
    chargeBudget(p, 'req', REQUEST_DAILY_BUDGET, Date.now());
    const r = call(p, 'ping', h);
    expect(r.error).toMatchObject({ code: 'unavailable', details: { reason: 'daily-budget' } });
    expect(budgetUsed(p, 'trigger', Date.now())).toBe(0);
    expect(REQUEST_DAILY_BUDGET).toBe(15000);
    expect(TRIGGER_DAILY_BUDGET).toBe(5000);
  });
  it('requests are charged their fetch count; triggers use metered() on their own counter', () => {
    const p = mk();
    call(p, 'ping', { ping: (ctx: { platform: { fetch: (u: string, i: object) => unknown } }) => { ctx.platform.fetch('http://x', { method: 'GET' }); return 1; } });
    expect(budgetUsed(p, 'req', Date.now())).toBe(2); // lookup + handler 内の fetch
    metered(p, 'trigger', () => { p.fetch('http://x', { method: 'GET' }); p.fetch('http://x', { method: 'GET' }); });
    expect(budgetUsed(p, 'trigger', Date.now())).toBe(2);
    expect(budgetUsed(p, 'req', Date.now())).toBe(2);
  });
  it('budget resets on the next JST day', () => {
    const p = mk();
    const t0 = Date.UTC(2026, 9, 8, 14, 59, 0);
    chargeBudget(p, 'req', 5, t0);
    expect(budgetUsed(p, 'req', t0)).toBe(5);
    expect(budgetUsed(p, 'req', t0 + 120_000)).toBe(0);
  });
  it('daily write limits: deleteDoc 200/day, updates 500/day, writes 1000/day, notify/sync 200/day', () => {
    const lim = (fn: string) => limitsFor(fn).map((l) => `${l.bucket}:${l.limit}`);
    expect(lim('deleteDoc')).toEqual(['dDeleteDoc:200', 'dWrites:1000']);
    expect(lim('updateDoc')).toEqual(['dUpdates:500', 'dWrites:1000']);
    expect(lim('updateEvent')).toEqual(['dUpdates:500', 'dWrites:1000']);
    expect(lim('notifyHandoverCreated')).toEqual(['dNotifyHandover:200', 'dWrites:1000']);
    expect(lim('syncScheduleReminder')).toEqual(['dSyncSchedule:200', 'dWrites:1000']);
    const p = mk();
    // 全体 60/分に当たらないよう uid を分けず、deleteDoc の日次を直接消費して確認
    for (let i = 0; i < 200; i++) consume(p, 'u1', limitsFor('deleteDoc')[0]!, Date.now());
    const r = call(p, 'deleteDoc', { deleteDoc: () => 1 });
    expect(r.error).toMatchObject({ code: 'resource-exhausted', details: { reason: 'rate-limited' } });
    expect(r.error.details.retryAfterSec).toBeGreaterThan(0);
  });
  it('invite failure slot is reserved up front (strict) and refunded on success', () => {
    const p = mk();
    const h = { acceptInvite: () => 1 };
    for (let i = 0; i < 30; i++) expect(call(p, 'acceptInvite', h).ok).toBe(true);
  });
});
