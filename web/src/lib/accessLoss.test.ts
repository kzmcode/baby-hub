import { describe, expect, it } from 'vitest';
import { accessLost } from './accessLoss';

const base = { hadFamily: true, signedIn: true, familyId: 'f', myMemberStatus: 'active', errorCodes: [] as (string | undefined)[] };
describe('accessLost', () => {
  it('normal', () => expect(accessLost(base)).toBe(false));
  it('never had family', () => expect(accessLost({ ...base, hadFamily: false, familyId: null })).toBe(false));
  it('signed out is handled elsewhere', () => expect(accessLost({ ...base, signedIn: false, familyId: null })).toBe(false));
  it('family ref gone', () => expect(accessLost({ ...base, familyId: null })).toBe(true));
  it('member removed/left', () => {
    expect(accessLost({ ...base, myMemberStatus: 'removed' })).toBe(true);
    expect(accessLost({ ...base, myMemberStatus: 'left' })).toBe(true);
  });
  it('permission denied', () => expect(accessLost({ ...base, errorCodes: [undefined, 'permission-denied'] })).toBe(true));
  it('other errors ignored', () => expect(accessLost({ ...base, errorCodes: ['unavailable'] })).toBe(false));
});

import { accessLossKind, shouldWipeAfterCheck, unsyncedNotice } from './accessLoss';
describe('accessLossKind', () => {
  it('permission-denied alone needs verification', () => expect(accessLossKind({ ...base, errorCodes: ['permission-denied'] })).toBe('verify'));
  it('removed/left or family ref gone is definite', () => {
    expect(accessLossKind({ ...base, myMemberStatus: 'removed' })).toBe('definite');
    expect(accessLossKind({ ...base, familyId: null })).toBe('definite');
  });
  it('denied + removed is definite (no extra check)', () => expect(accessLossKind({ ...base, myMemberStatus: 'left', errorCodes: ['permission-denied'] })).toBe('definite'));
  it('none otherwise', () => {
    expect(accessLossKind(base)).toBe('none');
    expect(accessLossKind({ ...base, errorCodes: ['unavailable'] })).toBe('none');
    expect(accessLossKind({ ...base, hadFamily: false, errorCodes: ['permission-denied'] })).toBe('none');
    expect(accessLossKind({ ...base, signedIn: false, errorCodes: ['permission-denied'] })).toBe('none');
  });
});
describe('shouldWipeAfterCheck', () => {
  it('active member: keep', () => expect(shouldWipeAfterCheck({ kind: 'status', status: 'active' })).toBe(false));
  it('non-active: wipe', () => {
    for (const status of ['removed', 'left', undefined]) expect(shouldWipeAfterCheck({ kind: 'status', status })).toBe(true);
  });
  it('missing doc: wipe', () => expect(shouldWipeAfterCheck({ kind: 'missing' })).toBe(true));
  it('check failed (network etc.): keep', () => expect(shouldWipeAfterCheck({ kind: 'error' })).toBe(false));
});
describe('unsyncedNotice', () => {
  it('count', () => expect(unsyncedNotice(3, true)).toBe('未同期の記録 3 件は保存されません。'));
  it('pending without count', () => expect(unsyncedNotice(null, true)).toContain('未同期の記録'));
  it('count 0 but pending flag', () => expect(unsyncedNotice(0, true)).toContain('未同期の記録'));
  it('nothing pending', () => expect(unsyncedNotice(0, false)).toBeNull());
});
