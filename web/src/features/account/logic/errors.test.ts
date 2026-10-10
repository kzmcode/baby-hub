import { describe, expect, it } from 'vitest';
import { authErrorMessage, inviteErrorMessage, isRecentAuthRequired, leaveErrorMessage, shouldFallbackToRedirect } from './errors';

describe('errors', () => {
  it('detects recent auth', () => {
    expect(isRecentAuthRequired({ code: 'failed-precondition', details: { reason: 'recent-auth-required' } })).toBe(true);
    expect(isRecentAuthRequired({ code: 'failed-precondition', details: { reason: 'x' } })).toBe(false);
  });
  it('maps invite reasons', () => {
    expect(inviteErrorMessage({ code: 'failed-precondition', details: { reason: 'expired' } }, 'f')).toContain('有効期限');
    expect(inviteErrorMessage({ code: 'x' }, 'f')).toBe('f');
  });
  it('maps leave', () => {
    expect(leaveErrorMessage({ details: { reason: 'transfer-required' } }, 'f')).toContain('移譲');
  });
  it('maps auth + fallback', () => {
    expect(authErrorMessage({ code: 'auth/invalid-credential' })).toContain('違います');
    expect(shouldFallbackToRedirect({ code: 'auth/popup-blocked' })).toBe(true);
    expect(shouldFallbackToRedirect({ code: 'auth/popup-closed-by-user' })).toBe(false);
  });
});
