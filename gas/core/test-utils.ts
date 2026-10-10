// テスト用ヘルパ（本番バンドルには含まれない）
import { createHash } from 'node:crypto';
import type { Platform } from './platform/types';

export type FetchFn = Platform['fetch'];

export function fakePlatform(
  fetch: FetchFn = () => ({ status: 500, body: '' }),
  config: Partial<Platform['config']> = {},
): Platform & { logs: { level: string; msg: string; fields?: unknown }[]; cache: Map<string, string>; props: Map<string, string>; lock: { fail: boolean; held: number; acquired: number }; fetches: () => number } {
  const cache = new Map<string, string>();
  const props = new Map<string, string>();
  const logs: { level: string; msg: string; fields?: unknown }[] = [];
  const lock = { fail: false, held: 0, acquired: 0 };
  let fetched = 0;
  return {
    fetch: (url, init) => { fetched++; return fetch(url, init); },
    fetchCount: () => fetched,
    fetches: () => fetched,
    lock,
    tryScriptLock: () => {
      if (lock.fail || lock.held > 0) return null;
      lock.held++;
      lock.acquired++;
      return () => { lock.held--; };
    },
    propRemove: (k) => void props.delete(k),
    propKeys: () => Array.from(props.keys()),
    cacheRemove: (k) => void cache.delete(k),
    getAccessToken: () => 'tok',
    config: {
      projectId: 'demo-test', webApiKey: 'key', firestoreBaseUrl: 'http://fs', identityBaseUrl: 'http://id', fcmEnabled: false, emulator: true, ...config,
    },
    randomToken: (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256)).toString('base64url'),
    sha256Hex: (s) => createHash('sha256').update(s).digest('hex'),
    cacheGet: (k) => cache.get(k) ?? null,
    cachePut: (k, v) => void cache.set(k, v),
    propGet: (k) => props.get(k) ?? null,
    propPut: (k, v) => void props.set(k, v),
    log: (level, msg, fields) => void logs.push({ level, msg, fields }),
    logs,
    cache,
    props,
  };
}

export function makeJwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none', typ: 'JWT' })}.${b(payload)}.sig`;
}
