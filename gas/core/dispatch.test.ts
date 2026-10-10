import { describe, expect, it } from 'vitest';
import { dispatch, MAX_BODY_BYTES } from './dispatch';
import { ApiError } from './errors';
import { Timestamp } from './firestore';
import { assertRecentAuth } from './guards';
import { fakePlatform, makeJwt } from './test-utils';

const sec = Math.floor(Date.now() / 1000);
const token = makeJwt({ aud: 'demo-test', iss: 'https://securetoken.google.com/demo-test', sub: 'u1', exp: sec + 3600, auth_time: sec - 1000 });
const platform = () => fakePlatform(() => ({ status: 200, body: JSON.stringify({ users: [{ localId: 'u1' }] }) }));
const call = (p: ReturnType<typeof platform>, body: unknown, handlers = {}) => JSON.parse(dispatch(p, typeof body === 'string' ? body : JSON.stringify(body), handlers));

describe('dispatch', () => {
  it('returns ok:true with result, and null for undefined', () => {
    const h = { ping: (ctx: { uid: string }) => ({ uid: ctx.uid }), nothing: () => undefined };
    expect(call(platform(), { fn: 'ping', data: {}, idToken: token }, h)).toEqual({ ok: true, result: { uid: 'u1' } });
    expect(call(platform(), { fn: 'nothing', idToken: token }, h)).toEqual({ ok: true, result: null });
  });
  it('unknown fn (including prototype keys) is not-found', () => {
    expect(call(platform(), { fn: 'nope', idToken: token }).error.code).toBe('not-found');
    expect(call(platform(), { fn: 'toString', idToken: token }).error.code).toBe('not-found');
  });
  it('missing/invalid token is unauthenticated', () => {
    expect(call(platform(), { fn: 'ping' }, { ping: () => 1 }).error.code).toBe('unauthenticated');
  });
  it('rejects malformed, empty and oversize bodies', () => {
    expect(call(platform(), '{bad').error.code).toBe('invalid-argument');
    expect(call(platform(), '').error.code).toBe('invalid-argument');
    expect(call(platform(), JSON.stringify({ fn: 'x', data: 'a'.repeat(MAX_BODY_BYTES) })).error.message).toMatch(/large/);
  });
  it('passes ApiError code/message/details through, serializing Timestamps', () => {
    const h = { f: () => { throw new ApiError('aborted', 'Revision mismatch', { currentRevision: 3, current: { at: Timestamp.fromMillis(0) } }); } };
    expect(call(platform(), { fn: 'f', idToken: token }, h)).toEqual({
      ok: false,
      error: { code: 'aborted', message: 'Revision mismatch', details: { currentRevision: 3, current: { at: '1970-01-01T00:00:00.000Z' } } },
    });
  });
  it('hides unexpected exception details and logs only an id', () => {
    const p = platform();
    const h = { f: () => { throw new Error('secret child name Taro'); } };
    const r = call(p, { fn: 'f', idToken: token }, h);
    expect(r.error.code).toBe('internal');
    expect(JSON.stringify(r)).not.toContain('Taro');
    expect(JSON.stringify(p.logs)).not.toContain('Taro');
  });
  it('assertRecentAuth uses ctx.authTime', () => {
    const h = { f: (ctx: never) => assertRecentAuth(ctx, 300) };
    const r = call(platform(), { fn: 'f', idToken: token }, h);
    expect(r.error).toMatchObject({ code: 'failed-precondition', details: { reason: 'recent-auth-required' } });
  });
});
