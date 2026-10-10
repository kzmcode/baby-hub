import { sha256Bytes } from '../shared/pure';
import { ApiError } from './errors';
import type { Platform } from './platform/types';

export interface VerifiedToken {
  uid: string;
  authTime: number;
  email?: string;
  signInProvider?: string;
  exp: number;
}

export const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
/** JWKS の最大保持（CacheService の上限 6 時間） */
export const JWKS_MAX_AGE_SEC = 6 * 60 * 60;
/** 未知の kid を理由とした JWKS 再取得の最小間隔（ランダム kid による DoS 防止） */
export const JWKS_REFETCH_INTERVAL_MS = 10 * 60 * 1000;
const JWKS_KEY = 'jwks:v1';
const JWKS_LAST_FETCH_KEY = 'jwks:last';

// ---------- base64url（環境非依存の純 JS） ----------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]!] = i;

export function b64urlToBytes(s: string): number[] {
  const t = s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (t.length % 4 === 1) throw new Error('bad base64url');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of t) {
    const v = B64_INDEX[ch];
    if (v === undefined) throw new Error('bad base64url');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

function utf8Decode(bytes: number[]): string {
  let pct = '';
  for (const b of bytes) pct += '%' + b.toString(16).padStart(2, '0');
  return decodeURIComponent(pct);
}

function b64urlDecode(s: string): string {
  return utf8Decode(b64urlToBytes(s));
}

// GAS のパーサーは BigInt リテラル（0n 等）を受け付けないため BigInt() で生成する
const B0 = BigInt(0);
const B1 = BigInt(1);
const B2 = BigInt(2);
const B3 = BigInt(3);
const B8 = BigInt(8);
const B255 = BigInt(255);

function bytesToBigInt(bytes: number[]): bigint {
  let r = B0;
  for (const b of bytes) r = (r << B8) | BigInt(b);
  return r;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = B1;
  let b = base % mod;
  let e = exp;
  while (e > B0) {
    if (e & B1) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= B1;
  }
  return result;
}

// DigestInfo prefix for SHA-256 (RFC 8017 9.2 note 1)
const SHA256_DIGEST_INFO = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];

export interface RsaPublicJwk { n: string; e: string }

/** RSASSA-PKCS1-v1_5 + SHA-256 の署名検証（BigInt の modexp。期待 EM を組み立てて完全一致で比較） */
export function verifyRs256(signingInput: string, signatureB64: string, key: RsaPublicJwk): boolean {
  try {
    const nBytes = b64urlToBytes(key.n);
    while (nBytes.length > 0 && nBytes[0] === 0) nBytes.shift();
    const k = nBytes.length;
    if (k < 128 || k > 512) return false; // 1024〜4096 bit
    const n = bytesToBigInt(nBytes);
    const e = bytesToBigInt(b64urlToBytes(key.e));
    if (e < B3 || e % B2 === B0 || e.toString(2).length > 32) return false;
    const sig = b64urlToBytes(signatureB64);
    if (sig.length !== k) return false;
    const s = bytesToBigInt(sig);
    if (s >= n) return false;
    const m = modPow(s, e, n);
    const em: number[] = new Array<number>(k).fill(0);
    let mm = m;
    for (let i = k - 1; i >= 0 && mm > B0; i--) {
      em[i] = Number(mm & B255);
      mm >>= B8;
    }
    const hash = sha256Bytes(Array.from(signingInput, (c) => c.charCodeAt(0)));
    const tail = [...SHA256_DIGEST_INFO, ...hash];
    const padLen = k - 3 - tail.length;
    if (padLen < 8) return false;
    const expected = [0x00, 0x01, ...new Array<number>(padLen).fill(0xff), 0x00, ...tail];
    let diff = 0;
    for (let i = 0; i < k; i++) diff |= em[i]! ^ expected[i]!;
    return diff === 0;
  } catch {
    return false;
  }
}

// ---------- 公開鍵（JWKS）の取得とキャッシュ ----------
interface JwksRecord { exp: number; keys: Record<string, RsaPublicJwk> }

function load(platform: Platform, key: string): string | null {
  try {
    const v = platform.cacheGet(key);
    if (v) return v;
  } catch { /* キャッシュ不可 */ }
  try {
    return platform.propGet?.(key) ?? null;
  } catch {
    return null;
  }
}
function store(platform: Platform, key: string, value: string, ttlSec: number): void {
  try { platform.cachePut(key, value, ttlSec); } catch { /* ignore */ }
  try { platform.propPut?.(key, value); } catch { /* ignore */ }
}

function parseMaxAge(headers: Record<string, string> | undefined): number {
  const cc = headers?.['cache-control'] ?? headers?.['Cache-Control'];
  const m = cc ? /max-age=(\d+)/i.exec(cc) : null;
  const sec = m ? Number(m[1]) : JWKS_MAX_AGE_SEC;
  return Math.max(60, Math.min(JWKS_MAX_AGE_SEC, sec));
}

function parseRecord(raw: string | null): JwksRecord | undefined {
  if (!raw) return undefined;
  try {
    const r = JSON.parse(raw) as JwksRecord;
    if (r && typeof r.exp === 'number' && r.keys && typeof r.keys === 'object') return r;
  } catch { /* 壊れたキャッシュ */ }
  return undefined;
}

function getPublicKey(platform: Platform, kid: string, nowMs: number): RsaPublicJwk {
  const rec = parseRecord(load(platform, JWKS_KEY));
  const known = rec && Object.prototype.hasOwnProperty.call(rec.keys, kid) ? rec.keys[kid] : undefined;
  if (rec && known && rec.exp > nowMs) return known;

  // 取得が必要（期限切れ or 未知の kid）。10 分に 1 回まで（失敗した試行も数える）
  const last = Number(load(platform, JWKS_LAST_FETCH_KEY) ?? 0);
  if (last && nowMs - last < JWKS_REFETCH_INTERVAL_MS && nowMs >= last) {
    if (known) return known; // 期限切れでも直近の取得失敗直後は旧鍵を使う
    // 再取得枠を使い切った状態の未知 kid：鍵ローテーション直後の正規トークンの可能性があるので、
    // ログアウトさせず再試行できるよう unavailable を返す（偽造 kid でも UrlFetch は消費しない）
    throw new ApiError('unavailable', 'Authentication keys are refreshing. Please retry shortly.', { reason: 'keys-refreshing' });
  }
  store(platform, JWKS_LAST_FETCH_KEY, String(nowMs), JWKS_REFETCH_INTERVAL_MS / 1000);

  let res: { status: number; body: string; headers?: Record<string, string> };
  try {
    res = platform.fetch(JWKS_URL, { method: 'GET' });
  } catch {
    if (known) return known;
    throw new ApiError('unavailable', 'Authentication service unavailable');
  }
  if (res.status !== 200) {
    if (known) return known;
    throw new ApiError('unavailable', 'Authentication service unavailable');
  }
  const keys: Record<string, RsaPublicJwk> = {};
  try {
    const j = JSON.parse(res.body) as { keys?: { kid?: string; kty?: string; n?: string; e?: string }[] };
    for (const k of j.keys ?? []) {
      if (k.kty === 'RSA' && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string') keys[k.kid] = { n: k.n, e: k.e };
    }
  } catch { /* 下で空判定 */ }
  if (Object.keys(keys).length === 0) throw new ApiError('unavailable', 'Authentication service unavailable');
  const ttl = parseMaxAge(res.headers);
  store(platform, JWKS_KEY, JSON.stringify({ exp: nowMs + ttl * 1000, keys } satisfies JwksRecord), ttl);
  if (!Object.prototype.hasOwnProperty.call(keys, kid)) throw new ApiError('unauthenticated', 'Invalid token');
  return keys[kid]!;
}

// ---------- ペイロード検証 ----------
/** JWT のペイロードをデコードして aud/iss/exp/sub を検証する（署名検証は呼び出し側） */
export function parseAndCheckPayload(idToken: string, projectId: string, nowSec: number): Record<string, any> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new ApiError('unauthenticated', 'Invalid token');
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]!));
  } catch {
    throw new ApiError('unauthenticated', 'Invalid token');
  }
  if (!payload || typeof payload !== 'object') throw new ApiError('unauthenticated', 'Invalid token');
  if (payload.aud !== projectId) throw new ApiError('unauthenticated', 'Invalid token');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new ApiError('unauthenticated', 'Invalid token');
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSec) throw new ApiError('unauthenticated', 'Token expired');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new ApiError('unauthenticated', 'Invalid token');
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 300) throw new ApiError('unauthenticated', 'Invalid token');
  return payload;
}

function parseHeader(idToken: string): { alg: string; kid?: string } {
  try {
    const h = JSON.parse(b64urlDecode(idToken.split('.')[0]!)) as { alg?: unknown; kid?: unknown };
    if (!h || typeof h !== 'object' || typeof h.alg !== 'string') throw new Error('bad header');
    return { alg: h.alg, kid: typeof h.kid === 'string' ? h.kid : undefined };
  } catch {
    throw new ApiError('unauthenticated', 'Invalid token');
  }
}

/** accounts:lookup の正結果のキャッシュ（uid + auth_time、60 秒）。失効・無効化の反映は最大この秒数遅れる */
export const LOOKUP_CACHE_SEC = 60;
const lookupKey = (uid: string, authTime: number) => `lk:${uid}:${authTime}`;
const lookupTombstone = (uid: string) => `lkdel:${uid}`;

function lookupCacheEnabled(platform: Platform): boolean {
  return !(platform.config.emulator === true && platform.config.rateLimitDisabled === true);
}
function lookupCached(platform: Platform, uid: string, authTime: number): boolean {
  if (!lookupCacheEnabled(platform)) return false;
  try {
    return platform.cacheGet(lookupKey(uid, authTime)) === '1' && !platform.cacheGet(lookupTombstone(uid));
  } catch {
    return false;
  }
}

/** deleteAccount 成功後に、その uid の lookup キャッシュ（全 auth_time 分）を無効化する */
export function invalidateAccountCache(platform: Platform, uid: string): void {
  try { platform.cachePut(lookupTombstone(uid), '1', LOOKUP_CACHE_SEC * 2); } catch { /* ignore */ }
}

/**
 * ID トークンを検証する。署名・クレームの検証後、accounts:lookup（UrlFetch）の前に beforeLookup(v) を呼ぶ
 * （正規トークンの連打による UrlFetch 枯渇を防ぐため、呼び出し側で uid 単位の回数制限・予算を消費する）。
 */
export function verifyIdToken(platform: Platform, idToken: unknown, nowMs: number = Date.now(), beforeLookup?: (v: VerifiedToken) => void): VerifiedToken {
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 8192) throw new ApiError('unauthenticated', 'Sign-in required');
  const { projectId, webApiKey, identityBaseUrl, emulator } = platform.config;
  const nowSec = Math.floor(nowMs / 1000);
  const payload = parseAndCheckPayload(idToken, projectId, nowSec);

  // 署名検証（エミュレータのトークンは無署名のため省略）。署名が正しい場合のみ後段（UrlFetch）へ進む
  if (!emulator) {
    const header = parseHeader(idToken);
    if (header.alg !== 'RS256' || !header.kid) throw new ApiError('unauthenticated', 'Invalid token');
    const [h, p, sig] = idToken.split('.') as [string, string, string];
    const key = getPublicKey(platform, header.kid, nowMs);
    if (!verifyRs256(`${h}.${p}`, sig, key)) throw new ApiError('unauthenticated', 'Invalid token');
  }

  const v: VerifiedToken = {
    uid: payload.sub,
    authTime: typeof payload.auth_time === 'number' ? payload.auth_time : 0,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    signInProvider: typeof payload.firebase?.sign_in_provider === 'string' ? payload.firebase.sign_in_provider : undefined,
    exp: payload.exp,
  };

  if (beforeLookup) beforeLookup(v);
  if (lookupCached(platform, v.uid, v.authTime)) return v;

  const res = platform.fetch(`${identityBaseUrl}/v1/accounts:lookup?key=${encodeURIComponent(webApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${platform.getAccessToken()}`, 'x-goog-user-project': projectId },
    body: JSON.stringify({ localId: [v.uid], targetProjectId: projectId }),
  });
  if (res.status >= 500 || res.status === 429) throw new ApiError('unavailable', 'Authentication service unavailable');
  if (res.status !== 200) throw new ApiError('unauthenticated', 'Invalid token');
  let user: { localId?: string; disabled?: boolean; validSince?: string } | undefined;
  try {
    user = (JSON.parse(res.body) as { users?: { localId?: string; disabled?: boolean; validSince?: string }[] }).users?.[0];
  } catch { /* fallthrough */ }
  if (!user?.localId || user.disabled || user.localId !== payload.sub) throw new ApiError('unauthenticated', 'Invalid token');

  const validSince = Number(user.validSince ?? 0);
  if (!Number.isFinite(validSince) || validSince < 0 || !Number.isFinite(v.authTime) || v.authTime <= 0 || v.authTime > nowSec + 60 || v.authTime < validSince) {
    throw new ApiError('unauthenticated', 'Token revoked');
  }
  if (lookupCacheEnabled(platform)) {
    try { platform.cachePut(lookupKey(v.uid, v.authTime), '1', LOOKUP_CACHE_SEC); } catch { /* ignore */ }
  }
  return v;
}
