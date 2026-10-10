import { beforeEach, describe, expect, it, vi } from 'vitest';

const getIdToken = vi.fn();
vi.mock('./firebase', () => ({ auth: { currentUser: null } }));

import { api, ApiError, apiErrorMessage, toApiError } from './api';
import { auth } from './firebase';

const reply = (body: unknown) => ({ json: async () => body }) as Response;
const fetchMock = vi.fn();
const setUser = (u: unknown) => { (auth as unknown as { currentUser: unknown }).currentUser = u; };

beforeEach(() => {
  fetchMock.mockReset();
  getIdToken.mockReset().mockResolvedValue('tok');
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_GAS_ENDPOINT', 'http://gas.test/exec');
  setUser({ getIdToken: (f: boolean) => getIdToken(f) });
});

const recent = { ok: false, error: { code: 'failed-precondition', message: 'm', details: { reason: 'recent-auth-required' } } };

describe('api.call', () => {
  it('POSTs text/plain JSON and returns result', async () => {
    fetchMock.mockResolvedValue(reply({ ok: true, result: { ok: true } }));
    await expect(api.revokeInvite({ familyId: 'f', inviteId: 'i' })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gas.test/exec');
    expect(init.headers['Content-Type']).toBe('text/plain;charset=utf-8');
    expect(JSON.parse(init.body)).toEqual({ fn: 'revokeInvite', data: { familyId: 'f', inviteId: 'i' }, idToken: 'tok' });
    expect(init.redirect).toBe('follow');
  });

  it('converts ok:false to ApiError with details/conflict', async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, error: { code: 'aborted', message: 'x', details: { currentRevision: 3, current: {} } } }));
    const e = await api.deleteFamily({ familyId: 'f', confirmName: 'n' }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('aborted');
    expect(e.conflict?.currentRevision).toBe(3);
  });

  it('maps network failure and non-JSON to unavailable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fail'));
    expect((await api.deleteAccount().catch((x) => x)).code).toBe('unavailable');
    fetchMock.mockResolvedValue({ json: async () => { throw new SyntaxError('bad'); } });
    expect((await api.deleteAccount().catch((x) => x)).code).toBe('unavailable');
  });

  it('unauthenticated when signed out', async () => {
    setUser(null);
    expect((await api.deleteAccount().catch((x) => x)).code).toBe('unauthenticated');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors clearly when endpoint is unset', async () => {
    vi.stubEnv('VITE_GAS_ENDPOINT', '');
    const e = await api.deleteAccount().catch((x) => x);
    expect(e.code).toBe('unavailable');
    expect(e.message).toContain('VITE_GAS_ENDPOINT');
  });

  it('retries once with a fresh token on recent-auth-required', async () => {
    fetchMock.mockResolvedValueOnce(reply(recent)).mockResolvedValueOnce(reply({ ok: true, result: { ok: true } }));
    await expect(api.deleteAccount()).resolves.toEqual({ ok: true });
    expect(getIdToken.mock.calls.map((c) => c[0])).toEqual([false, true]);
  });

  it('does not retry more than once', async () => {
    fetchMock.mockResolvedValue(reply(recent));
    const e = await api.deleteAccount().catch((x) => x);
    expect(e.code).toBe('failed-precondition');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('apiErrorMessage rate limit', () => {
  const rl = (d: unknown) => new ApiError('resource-exhausted', 'x', d);
  it('shows wait seconds', () => {
    expect(apiErrorMessage(rl({ reason: 'rate-limited', retryAfterSec: 12.2 }))).toBe('操作が多すぎます。13秒ほど待ってからもう一度お試しください。');
  });
  it('falls back without seconds', () => {
    expect(apiErrorMessage(rl({ reason: 'rate-limited' }))).toContain('しばらく待って');
  });
  it('other resource-exhausted keeps generic message', () => {
    expect(apiErrorMessage(rl(undefined))).toBe('回数の上限に達しました。しばらくしてからお試しください。');
  });
});

describe('reason messages', () => {
  const m = (code: string, reason: string) => apiErrorMessage({ code, message: 'x', details: { reason } });
  it('maps GAS reasons', () => {
    expect(m('unavailable', 'daily-budget')).toBe('本日の利用上限に達しました。時間をおいてお試しください。');
    expect(m('unavailable', 'keys-refreshing')).toBe('認証情報を更新中です。少し待ってから再試行してください。');
    expect(m('failed-precondition', 'auth-delete-failed')).toBe('アカウント削除の途中で失敗しました。再ログインしてもう一度削除してください。');
  });
  it('auth-delete-failed is mapped regardless of code (GAS returns internal)', () => {
    expect(m('internal', 'auth-delete-failed')).toBe('アカウント削除の途中で失敗しました。再ログインしてもう一度削除してください。');
  });
  it('unavailable with daily-budget/keys-refreshing is not an auth/retry trigger', () => {
    const e = toApiError({ code: 'unavailable', message: 'x', details: { reason: 'daily-budget' } });
    expect(e.code).toBe('unavailable');
    expect(e.isConflict).toBe(false);
  });
  it('keeps default for other reasons', () => {
    expect(m('unavailable', 'other')).toBe('通信できません。接続を確認してください。');
  });
});
