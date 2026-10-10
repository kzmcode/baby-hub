// Node 実装（ローカル開発・テスト用）。同期 HTTP は子プロセスで fetch を実行して実現する。
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DriveAdapter, Platform } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const helperPath = join(here, 'node-sync-fetch-helper.mjs');

function createLocalDrive(baseDir: string): DriveAdapter {
  const base = resolve(baseDir);
  const safe = (id: string): string => {
    const p = resolve(base, id);
    if (p !== base && !p.startsWith(base + sep)) throw new Error('invalid drive id');
    return p;
  };
  return {
    ensureFolder(name) {
      mkdirSync(safe(name), { recursive: true });
      return name;
    },
    writeJson(folderId, name, json) {
      const dir = safe(folderId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), json, 'utf8');
      return `${folderId}/${name}`;
    },
    listFiles(folderId) {
      const dir = safe(folderId);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((n) => statSync(join(dir, n)).isFile())
        .map((n) => ({ id: `${folderId}/${n}`, name: n, createdAt: statSync(join(dir, n)).birthtime }));
    },
    readJson(fileId) {
      return readFileSync(safe(fileId), 'utf8');
    },
    remove(fileId) { unlinkSync(safe(fileId)); },
    trash(fileId) {
      const p = safe(fileId);
      const trashDir = join(base, '.trash');
      mkdirSync(trashDir, { recursive: true });
      renameSync(p, join(trashDir, `${Date.now()}-${fileId.replace(/[\\/]/g, '_')}`));
    },
  };
}

export function createNodePlatform(env: Record<string, string | undefined> = process.env): Platform {
  const fsHost = env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const authHost = env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
  const cache = new Map<string, { v: string; exp: number }>();
  const props = new Map<string, string>();
  let fetchCounter = 0;
  return {
    fetchCount: () => fetchCounter,
    fetch(url, init) {
      fetchCounter++;
      const out = execFileSync(process.execPath, [helperPath], {
        input: JSON.stringify({ url, method: init.method, headers: init.headers ?? {}, body: init.body }),
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
      });
      const r = JSON.parse(out) as { status: number; body: string; headers?: Record<string, string>; error?: string };
      if (r.status === 0) throw new Error(`fetch failed: ${r.error ?? 'unknown'}`);
      return { status: r.status, body: r.body, headers: r.headers };
    },
    getAccessToken: () => 'owner',
    config: {
      projectId: env.FIREBASE_PROJECT_ID || 'demo-baby-hub',
      webApiKey: env.FIREBASE_WEB_API_KEY || 'fake-api-key',
      firestoreBaseUrl: `http://${fsHost}`,
      identityBaseUrl: `http://${authHost}/identitytoolkit.googleapis.com`,
      fcmEnabled: env.FCM_ENABLED === '1',
      emulator: true,
      rateLimitDisabled: env.DISABLE_RATE_LIMIT === '1',
    },
    randomToken: (bytes) => randomBytes(bytes).toString('base64url'),
    sha256Hex: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
    cacheGet(key) {
      const e = cache.get(key);
      if (!e) return null;
      if (e.exp <= Date.now()) {
        cache.delete(key);
        return null;
      }
      return e.v;
    },
    cachePut(key, value, ttlSec) {
      cache.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
    },
    propGet: (key) => props.get(key) ?? null,
    propPut: (key, value) => void props.set(key, value),
    propRemove: (key) => void props.delete(key),
    propKeys: () => Array.from(props.keys()),
    cacheRemove: (key) => void cache.delete(key),
    log(level, msg, fields) {
      const line = JSON.stringify({ level, msg, ...(fields ?? {}) });
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    },
    drive: createLocalDrive(env.LOCAL_DRIVE_DIR || join(here, '..', '..', '.local-drive')),
  };
}

export const nodePlatform: Platform = createNodePlatform();
