import { assertRecentAuth } from './guards';
import { dbFor } from './context';
import { describe, expect, it } from 'vitest';
import { verifyIdToken } from './auth';
import { ApiError } from './errors';
import { fakePlatform, makeJwt } from './test-utils';

const now = Date.now();
const sec = Math.floor(now / 1000);
const good = (over: Record<string, unknown> = {}) =>
  makeJwt({ aud: 'demo-test', iss: 'https://securetoken.google.com/demo-test', sub: 'u1', exp: sec + 3600, auth_time: sec - 10, email: 'a@b.c', firebase: { sign_in_provider: 'password' }, ...over });
const lookupOk = (calls: string[]) => (url: string) => {
  calls.push(url);
  return { status: 200, body: JSON.stringify({ users: [{ localId: 'u1' }] }) };
};
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as ApiError).code; } return 'none'; };

describe('verifyIdToken', () => {
  it('accepts a valid token and checks account state (lookup result cached 60s per uid+auth_time)', () => {
    const calls: string[] = [];
    const p = fakePlatform(lookupOk(calls));
    const t = good();
    const v = verifyIdToken(p, t, now);
    expect(v).toMatchObject({ uid: 'u1', authTime: sec - 10, email: 'a@b.c', signInProvider: 'password' });
    verifyIdToken(p, t, now);
    expect(calls).toEqual(['http://id/v1/accounts:lookup?key=key']);
  });
  it('calls beforeLookup after claim checks and before accounts:lookup; never for invalid tokens', () => {
    const order: string[] = [];
    const p = fakePlatform((url) => { order.push('fetch'); return lookupOk([])(url); });
    verifyIdToken(p, good(), now, () => order.push('hook'));
    expect(order).toEqual(['hook', 'fetch']);
    order.length = 0;
    expect(code(() => verifyIdToken(p, good({ aud: 'x' }), now, () => order.push('hook')))).toBe('unauthenticated');
    expect(order).toEqual([]);
    // 回数制限の例外が出たら lookup は呼ばれない
    const p2 = fakePlatform(lookupOk([]));
    expect(code(() => verifyIdToken(p2, good(), now, () => { throw new ApiError('resource-exhausted', 'x'); }))).toBe('resource-exhausted');
    expect(p2.fetches()).toBe(0);
  });
  it('lookup cache: keyed by uid+auth_time, expires after 60s, bypassed after invalidation, not used for negative results', () => {
    const calls: string[] = [];
    const p = fakePlatform(lookupOk(calls), { emulator: true });
    verifyIdToken(p, good(), now);
    verifyIdToken(p, good({ auth_time: sec - 5 }), now); // 別の auth_time は別キー
    expect(calls).toHaveLength(2);
    expect(p.cache.has(`lk:u1:${sec - 10}`)).toBe(true);
    invalidateAccountCache(p, 'u1');
    verifyIdToken(p, good(), now);
    expect(calls).toHaveLength(3);
    expect(LOOKUP_CACHE_SEC).toBe(60);
    const bad = fakePlatform(() => ({ status: 400, body: '{}' }));
    expect(code(() => verifyIdToken(bad, good(), now))).toBe('unauthenticated');
    expect([...bad.cache.keys()].some((k) => k.startsWith('lk:'))).toBe(false);
    // テスト用フラグ（emulator + rateLimitDisabled）ではキャッシュしない
    const off = fakePlatform(lookupOk(calls), { rateLimitDisabled: true });
    calls.length = 0;
    verifyIdToken(off, good(), now);
    verifyIdToken(off, good(), now);
    expect(calls).toHaveLength(2);
  });
  it.each([
    ['aud', { aud: 'other' }],
    ['iss', { iss: 'https://securetoken.google.com/other' }],
    ['exp', { exp: sec - 1 }],
  ])('rejects wrong %s without calling the server', (_n, over) => {
    const calls: string[] = [];
    expect(code(() => verifyIdToken(fakePlatform(lookupOk(calls)), good(over), now))).toBe('unauthenticated');
    expect(calls).toHaveLength(0);
  });
  it('rejects malformed tokens and missing token', () => {
    const p = fakePlatform(lookupOk([]));
    expect(code(() => verifyIdToken(p, 'abc.def', now))).toBe('unauthenticated');
    expect(code(() => verifyIdToken(p, undefined, now))).toBe('unauthenticated');
    expect(code(() => verifyIdToken(p, 'aaaaaaaaaaaaaaaaaaaa.!!!.sig', now))).toBe('unauthenticated');
  });
  it('maps lookup 400 to unauthenticated, 5xx to unavailable, uid mismatch to unauthenticated', () => {
    expect(code(() => verifyIdToken(fakePlatform(() => ({ status: 400, body: '{}' })), good(), now))).toBe('unauthenticated');
    expect(code(() => verifyIdToken(fakePlatform(() => ({ status: 503, body: '' })), good(), now))).toBe('unavailable');
    expect(code(() => verifyIdToken(fakePlatform(lookupOk([])), good({ sub: 'u2' }), now))).toBe('unauthenticated');
  });
});

// ---------- 署名検証（本番モード：emulator=false） ----------
import { createSign, generateKeyPairSync } from 'node:crypto';
import { JWKS_REFETCH_INTERVAL_MS, JWKS_URL, LOOKUP_CACHE_SEC, invalidateAccountCache } from './auth';

const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (k: typeof keyA, kid: string) => ({ ...(k.publicKey.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const claims = (over: Record<string, unknown> = {}) => ({ aud: 'demo-test', iss: 'https://securetoken.google.com/demo-test', sub: 'u1', exp: sec + 3600, auth_time: sec - 10, ...over });
function sign(key: typeof keyA, kid: string | undefined, payload: Record<string, unknown> = claims(), header: Record<string, unknown> = {}): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}), ...header });
  const input = `${h}.${b64(payload)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key.privateKey).toString('base64url')}`;
}
function prodPlatform(opts: { keys?: object[]; cacheControl?: string; lookup?: () => { status: number; body: string } } = {}) {
  const calls = { jwks: 0, lookup: 0 };
  let keys = opts.keys ?? [jwkOf(keyA, 'k1')];
  const p = fakePlatform((url) => {
    if (url === JWKS_URL) {
      calls.jwks++;
      return { status: 200, body: JSON.stringify({ keys }), headers: { 'cache-control': opts.cacheControl ?? 'public, max-age=3600' } };
    }
    calls.lookup++;
    return opts.lookup ? opts.lookup() : { status: 200, body: JSON.stringify({ users: [{ localId: 'u1' }] }) };
  }, { emulator: false });
  return { p, calls, setKeys: (k: object[]) => { keys = k; } };
}

describe('verifyIdToken signature (production mode)', () => {
  it('accepts a correctly signed token and only then calls accounts:lookup', () => {
    const { p, calls } = prodPlatform();
    expect(verifyIdToken(p, sign(keyA, 'k1'), now)).toMatchObject({ uid: 'u1', authTime: sec - 10 });
    expect(calls).toEqual({ jwks: 1, lookup: 1 });
  });
  it('rejects a token signed with a different key (same kid) without calling lookup', () => {
    const { p, calls } = prodPlatform();
    expect(code(() => verifyIdToken(p, sign(keyB, 'k1'), now))).toBe('unauthenticated');
    expect(calls.lookup).toBe(0);
  });
  it('rejects a tampered payload', () => {
    const { p, calls } = prodPlatform();
    const [h, , s] = sign(keyA, 'k1').split('.');
    const forged = `${h}.${b64(claims({ sub: 'victim' }))}.${s}`;
    expect(code(() => verifyIdToken(p, forged, now))).toBe('unauthenticated');
    expect(calls.lookup).toBe(0);
  });
  it('rejects a truncated / garbage / wrong-length signature', () => {
    const { p } = prodPlatform();
    const t = sign(keyA, 'k1');
    expect(code(() => verifyIdToken(p, t.slice(0, -10), now))).toBe('unauthenticated');
    const [h, pl] = t.split('.');
    expect(code(() => verifyIdToken(p, `${h}.${pl}.AAAA`, now))).toBe('unauthenticated');
    expect(code(() => verifyIdToken(p, `${h}.${pl}.`.padEnd(40, 'A'), now))).toBe('unauthenticated');
  });
  it('rejects alg none / HS256 / missing kid', () => {
    const { p, calls } = prodPlatform();
    expect(code(() => verifyIdToken(p, makeJwt(claims()), now))).toBe('unauthenticated');
    expect(code(() => verifyIdToken(p, sign(keyA, 'k1', claims(), { alg: 'HS256' }), now))).toBe('unauthenticated');
    expect(code(() => verifyIdToken(p, sign(keyA, 'k1', claims(), { alg: 'none' }), now))).toBe('unauthenticated');
    expect(code(() => verifyIdToken(p, sign(keyA, undefined), now))).toBe('unauthenticated');
    expect(calls.lookup).toBe(0);
  });
  it('fetches JWKS once and reuses it from the cache', () => {
    const { p, calls } = prodPlatform();
    verifyIdToken(p, sign(keyA, 'k1'), now);
    verifyIdToken(p, sign(keyA, 'k1', claims({ auth_time: sec - 5 })), now + 1000);
    expect(calls.jwks).toBe(1);
  });
  it('honours Cache-Control max-age (capped at 6h) and refetches after expiry', () => {
    const { p, calls } = prodPlatform({ cacheControl: 'public, max-age=120' });
    verifyIdToken(p, sign(keyA, 'k1'), now);
    // 期限切れ後、かつ 10 分経過後は再取得
    verifyIdToken(p, sign(keyA, 'k1', claims({ exp: sec + 99999 })), now + JWKS_REFETCH_INTERVAL_MS + 1000);
    expect(calls.jwks).toBe(2);
    const big = prodPlatform({ cacheControl: 'max-age=999999999' });
    verifyIdToken(big.p, sign(keyA, 'k1'), now);
    expect(JSON.parse(big.p.cache.get('jwks:v1')!).exp - now).toBeLessThanOrEqual(6 * 3600 * 1000);
  });
  it('unknown kid triggers at most one JWKS refetch per 10 minutes', () => {
    const { p, calls, setKeys } = prodPlatform();
    verifyIdToken(p, sign(keyA, 'k1'), now); // 1 回目の取得
    expect(code(() => verifyIdToken(p, sign(keyA, 'random1'), now + 1000))).toBe('unavailable'); // 直近取得から 10 分未満 → 取得しない（再試行を促す）
    expect(code(() => verifyIdToken(p, sign(keyA, 'random2'), now + 2000))).toBe('unavailable');
    try { verifyIdToken(p, sign(keyA, 'random3'), now + 3000); } catch (e) { expect((e as ApiError).details).toEqual({ reason: 'keys-refreshing' }); }
    expect(calls.jwks).toBe(1);
    // 10 分後に新しい鍵が公開されていれば取得して通る（鍵ローテーション）
    setKeys([jwkOf(keyA, 'k1'), jwkOf(keyB, 'k2')]);
    expect(verifyIdToken(p, sign(keyB, 'k2'), now + JWKS_REFETCH_INTERVAL_MS + 1000).uid).toBe('u1');
    expect(calls.jwks).toBe(2);
    // さらに未知の kid を連打しても 10 分以内は再取得しない
    // （この時点では取得済み・鍵が無いので未知 kid は unavailable。取得後の未知 kid は偽造として unauthenticated）
    for (let i = 0; i < 5; i++) expect(code(() => verifyIdToken(p, sign(keyA, `x${i}`), now + JWKS_REFETCH_INTERVAL_MS + 2000 + i))).toBe('unavailable');
    expect(calls.jwks).toBe(2);
  });
  it('falls back to the persistent store when the cache is empty', () => {
    const { p, calls } = prodPlatform();
    verifyIdToken(p, sign(keyA, 'k1'), now);
    p.cache.clear();
    verifyIdToken(p, sign(keyA, 'k1', claims({ auth_time: sec - 3 })), now + 1000);
    expect(calls.jwks).toBe(1);
  });
  it('JWKS fetch failure with no known key is unavailable', () => {
    const p = fakePlatform(() => ({ status: 500, body: '' }), { emulator: false });
    expect(code(() => verifyIdToken(p, sign(keyA, 'k1'), now))).toBe('unavailable');
  });
  it('reuses a positive lookup only for the same uid+auth_time, and not after invalidation', () => {
    const { p, calls } = prodPlatform();
    verifyIdToken(p, sign(keyA, 'k1'), now);
    verifyIdToken(p, sign(keyA, 'k1'), now + 1000);
    expect(calls.lookup).toBe(1);
    verifyIdToken(p, sign(keyA, 'k1', claims({ auth_time: sec - 1 })), now + 1000); // 別 auth_time
    expect(calls.lookup).toBe(2);
    invalidateAccountCache(p, 'u1');
    verifyIdToken(p, sign(keyA, 'k1'), now + 2000);
    expect(calls.lookup).toBe(3);
  });
  it('a disabled / revoked user (lookup failure) is rejected', () => {
    const { p } = prodPlatform({ lookup: () => ({ status: 400, body: '{}' }) });
    expect(code(() => verifyIdToken(p, sign(keyA, 'k1'), now))).toBe('unauthenticated');
  });
  it('emulator mode skips signature verification', () => {
    const calls: string[] = [];
    expect(verifyIdToken(fakePlatform(lookupOk(calls)), makeJwt(claims()), now).uid).toBe('u1');
    expect(calls).toHaveLength(1);
  });
});

describe('token revocation boundary', () => {
  it('rejects a previously accepted signed token immediately after validSince advances', () => {
    let since = sec - 100;
    const { p, calls } = prodPlatform({ lookup: () => ({ status: 200, body: JSON.stringify({ users: [{ localId: 'u1', validSince: String(since) }] }) }) });
    const token = sign(keyA, 'k1', claims({ auth_time: sec - 10, iat: sec }));
    expect(verifyIdToken(p, token, now).uid).toBe('u1');
    since = sec - 5;
    p.cache.clear(); // キャッシュ失効後（最大 60 秒の反映遅延を過ぎた状態）は即時に失効が反映される
    expect(code(() => verifyIdToken(p, token, now + 1))).toBe('unauthenticated');
    expect(calls.lookup).toBe(2);
    expect(verifyIdToken(p, sign(keyA, 'k1', claims({ auth_time: since })), now).uid).toBe('u1');
  });
});

it('requires recent authentication even for a valid, unrevoked signed session', () => {
  const { p } = prodPlatform({ lookup: () => ({ status: 200, body: JSON.stringify({ users: [{ localId: 'u1', validSince: String(sec - 7200) }] }) }) });
  const verified = verifyIdToken(p, sign(keyA, 'k1', claims({ auth_time: sec - 3600 })), now);
  expect(verified.uid).toBe('u1');
  expect(code(() => assertRecentAuth({ ...verified, platform: p, db: dbFor(p), now: () => new Date(now) }))).toBe('failed-precondition');
});
