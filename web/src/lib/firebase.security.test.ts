import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  setPersistence: vi.fn(async () => undefined),
  terminate: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  initializeFirestore: vi.fn(() => ({})),
  persistentLocalCache: vi.fn(() => 'persistent'),
  memoryLocalCache: vi.fn(() => 'memory'),
}));
vi.mock('firebase/app', () => ({ initializeApp: () => ({}) }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({}), setPersistence: mocks.setPersistence, browserLocalPersistence: 'local', browserSessionPersistence: 'session', connectAuthEmulator: vi.fn() }));
vi.mock('firebase/firestore', () => ({ clearIndexedDbPersistence: mocks.clear, terminate: mocks.terminate, initializeFirestore: mocks.initializeFirestore, memoryLocalCache: mocks.memoryLocalCache, persistentLocalCache: mocks.persistentLocalCache, persistentMultipleTabManager: vi.fn(), connectFirestoreEmulator: vi.fn() }));
vi.mock('firebase/messaging', () => ({ getMessaging: vi.fn(), getToken: vi.fn(), isSupported: vi.fn() }));
function storage(): Storage {
  const values: Record<string, string> = {};
  return new Proxy(values, { get: (target, key) => {
    if (key === 'getItem') return (k: string) => target[k] ?? null;
    if (key === 'setItem') return (k: string, v: string) => { target[k] = String(v); };
    if (key === 'removeItem') return (k: string) => { delete target[k]; };
    return target[key as string];
  } }) as unknown as Storage;
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.setPersistence.mockResolvedValue(undefined); mocks.clear.mockResolvedValue(undefined); mocks.terminate.mockResolvedValue(undefined);
  vi.stubGlobal('localStorage', storage()); vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('window', { addEventListener: vi.fn(), location: { reload: vi.fn() } });
  vi.stubGlobal('indexedDB', { databases: async () => [] });
});
afterEach(() => vi.unstubAllGlobals());
describe('shared-device authentication and cleanup', () => {
  it('migrates existing auth to session storage before subscriptions start and removes old Firestore cache', async () => {
    const f = await import('./firebase');
    await Promise.all([f.authPersistenceReady, f.pendingWipeDone]);
    expect(mocks.setPersistence).toHaveBeenCalledWith(f.auth, 'session');
    expect(mocks.memoryLocalCache).toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledWith(f.db);
  });
  it('uses persistent auth and data only with explicit trust', async () => {
    localStorage.setItem('ch.trustedDevice', '1');
    const f = await import('./firebase'); await f.authPersistenceReady;
    expect(mocks.setPersistence).toHaveBeenCalledWith(f.auth, 'local');
    expect(mocks.persistentLocalCache).toHaveBeenCalled();
    await f.enableTrustedDeviceCache(false);
    await f.clearLocalData();
    expect(mocks.setPersistence).toHaveBeenLastCalledWith(f.auth, 'session');
    expect(localStorage.getItem('ch.trustedDevice')).toBeNull();
    expect(mocks.terminate).toHaveBeenCalledWith(f.db);
    expect(mocks.clear).toHaveBeenCalledWith(f.db);
  });
  it('reports failed cleanup and blocks startup instead of reusing a trusted cache', async () => {
    localStorage.setItem('ch.trustedDevice', '1');
    localStorage.setItem('ch.pendingWipe', '["firestore"]');
    mocks.clear.mockRejectedValue(new Error('another tab'));
    const f = await import('./firebase');
    await expect(f.pendingWipeDone).rejects.toThrow('他のタブ');
    expect(mocks.memoryLocalCache).toHaveBeenCalled();
    expect(mocks.persistentLocalCache).not.toHaveBeenCalled();
    await expect(f.clearLocalData()).rejects.toThrow('他のタブ');
    expect(localStorage.getItem('ch.pendingWipe')).toContain('firestore');
  });
  it('cache cleanup preserves Firebase session credentials and unrelated session data', async () => {
    sessionStorage.setItem('firebase:authUser:test', 'session'); sessionStorage.setItem('ch.private', 'health');
    const f = await import('./firebase'); await f.pendingWipeDone; await f.clearLocalData();
    expect(sessionStorage.getItem('firebase:authUser:test')).toBe('session');
    expect(sessionStorage.getItem('ch.private')).toBeNull();
  });
});
