// Google Apps Script 実装。GAS のグローバル（UrlFetchApp 等）はここでのみ参照する。
import { createDriveRestAdapter } from './drive-rest';
import type { Platform, PlatformConfig } from './types';

function bytesToB64Url(bytes: number[]): string {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function sha256Bytes(s: string): number[] {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
}

let cachedConfig: PlatformConfig | undefined;
function loadConfig(): PlatformConfig {
  if (cachedConfig) return cachedConfig;
  const props = PropertiesService.getScriptProperties();
  const projectId = props.getProperty('FIREBASE_PROJECT_ID');
  const webApiKey = props.getProperty('FIREBASE_WEB_API_KEY');
  if (!projectId || !webApiKey) throw new Error('Script properties FIREBASE_PROJECT_ID / FIREBASE_WEB_API_KEY are not set');
  cachedConfig = {
    projectId,
    webApiKey,
    firestoreBaseUrl: 'https://firestore.googleapis.com',
    identityBaseUrl: 'https://identitytoolkit.googleapis.com',
    fcmEnabled: true,
    emulator: false,
  };
  return cachedConfig;
}

let fetchCounter = 0;

export const gasPlatform: Platform = {
  fetchCount: () => fetchCounter,
  fetch(url, init) {
    fetchCounter++;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
      method: init.method.toLowerCase() as GoogleAppsScript.URL_Fetch.HttpMethod,
      muteHttpExceptions: true,
      followRedirects: true,
    };
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'content-type') {
        options.contentType = headers[k];
        delete headers[k];
      }
    }
    options.headers = headers;
    if (init.body !== undefined) options.payload = init.body;
    const res = UrlFetchApp.fetch(url, options);
    const resHeaders: Record<string, string> = {};
    try {
      for (const [k, v] of Object.entries(res.getHeaders() as Record<string, unknown>)) resHeaders[k.toLowerCase()] = String(v);
    } catch { /* ヘッダ取得不可でも本文は返す */ }
    return { status: res.getResponseCode(), body: res.getContentText(), headers: resHeaders };
  },
  getAccessToken() {
    return ScriptApp.getOAuthToken();
  },
  get config() {
    return loadConfig();
  },
  randomToken(bytes) {
    const out: number[] = [];
    while (out.length < bytes) {
      // UUID v4(122bit) を 4 つ + 時刻を SHA-256 で混ぜて 32 バイト/ブロック
      const seed = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + Date.now();
      out.push(...sha256Bytes(seed));
    }
    return bytesToB64Url(out.slice(0, bytes));
  },
  sha256Hex(s) {
    return sha256Bytes(s).map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  },
  cacheGet(key) {
    return CacheService.getScriptCache().get(key);
  },
  cachePut(key, value, ttlSec) {
    CacheService.getScriptCache().put(key, value, Math.max(1, Math.min(21600, Math.floor(ttlSec))));
  },
  propGet(key) {
    return PropertiesService.getScriptProperties().getProperty(key);
  },
  propPut(key, value) {
    PropertiesService.getScriptProperties().setProperty(key, value);
  },
  propRemove(key) {
    PropertiesService.getScriptProperties().deleteProperty(key);
  },
  propKeys() {
    return PropertiesService.getScriptProperties().getKeys();
  },
  cacheRemove(key) {
    CacheService.getScriptCache().remove(key);
  },
  tryScriptLock(timeoutMs) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(timeoutMs)) return null;
    return () => {
      try { lock.releaseLock(); } catch { /* ignore */ }
    };
  },
  log(level, msg, fields) {
    const line = JSON.stringify({ msg, ...(fields ?? {}) });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  },
};

// Drive REST API v3（スコープ drive.file）。gasPlatform.fetch / getAccessToken を使う
gasPlatform.drive = createDriveRestAdapter({
  fetch: (url, init) => gasPlatform.fetch(url, init),
  getAccessToken: () => gasPlatform.getAccessToken(),
  userProject: () => loadConfig().projectId,
});
