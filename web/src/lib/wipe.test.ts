import { describe, expect, it } from 'vitest';
import { idbNamesFor, isPreservedKey, nextPendingWipe, parsePendingWipe, serializePendingWipe } from './wipe';

describe('pendingWipe', () => {
  it('preserves device settings and flag from clearLocalData', () => {
    expect(isPreservedKey('ch.trustedDevice')).toBe(true);
    expect(isPreservedKey('ch.pendingWipe')).toBe(true);
    expect(isPreservedKey('ch.deviceId')).toBe(false);
  });
  it('parses safely', () => {
    expect(parsePendingWipe(null)).toEqual([]);
    expect(parsePendingWipe('not json')).toEqual([]);
    expect(parsePendingWipe('["firestore","x"]')).toEqual(['firestore']);
  });
  it('serializes', () => {
    expect(serializePendingWipe([])).toBeNull();
    expect(serializePendingWipe(['app', 'firestore'])).toBe('["firestore","app"]');
  });
  it('next flag keeps failures, drops successes', () => {
    expect(nextPendingWipe([], ['firestore'], ['app'])).toEqual(['firestore']);
    expect(nextPendingWipe(['firestore', 'app'], [], ['firestore'])).toEqual(['app']);
    expect(nextPendingWipe(['firestore'], [], ['firestore', 'app'])).toEqual([]);
  });
  it('selects idb names', () => {
    const n = ['firestore/[DEFAULT]/p/main', 'ch.cache', 'firebaseLocalStorageDb', undefined];
    expect(idbNamesFor('firestore', n)).toEqual(['firestore/[DEFAULT]/p/main']);
    expect(idbNamesFor('app', n)).toEqual(['ch.cache']);
  });
});
