import { afterEach, describe, expect, it, vi } from 'vitest';
import { WIPE_TIMEOUT_MS, canEnableNotifications, needsRegistrationCleanup, raceWithTimeout } from './startup';
import { assertNoEmulatorsInProduction } from './buildCheck';

afterEach(() => vi.useRealTimers());

describe('canEnableNotifications', () => {
  it('信頼端末のみ有効', () => {
    expect(canEnableNotifications(true)).toBe(true);
    expect(canEnableNotifications(false)).toBe(false);
  });
});

describe('needsRegistrationCleanup', () => {
  it('共有端末で登録が残っているときだけ解除', () => {
    expect(needsRegistrationCleanup(false, true, false)).toBe(true);
    expect(needsRegistrationCleanup(false, false, true)).toBe(true);
    expect(needsRegistrationCleanup(false, false, false)).toBe(false);
    expect(needsRegistrationCleanup(true, true, true)).toBe(false);
  });
});

describe('raceWithTimeout', () => {
  it('止まった処理は 15 秒で失敗扱い', async () => {
    vi.useFakeTimers();
    const r = raceWithTimeout(new Promise<void>(() => undefined), WIPE_TIMEOUT_MS, 'timeout-msg');
    const assertion = expect(r).rejects.toThrow('timeout-msg');
    await vi.advanceTimersByTimeAsync(WIPE_TIMEOUT_MS);
    await assertion;
  });
  it('間に合えば結果を返す', async () => {
    await expect(raceWithTimeout(Promise.resolve(1), 1000, 'x')).resolves.toBe(1);
  });
});

describe('assertNoEmulatorsInProduction', () => {
  it('production + true は失敗', () => {
    expect(() => assertNoEmulatorsInProduction('production', { VITE_USE_EMULATORS: 'true' })).toThrow();
  });
  it('それ以外は通る', () => {
    expect(() => assertNoEmulatorsInProduction('production', { VITE_USE_EMULATORS: 'false' })).not.toThrow();
    expect(() => assertNoEmulatorsInProduction('production', {})).not.toThrow();
    expect(() => assertNoEmulatorsInProduction('development', { VITE_USE_EMULATORS: 'true' })).not.toThrow();
  });
});
