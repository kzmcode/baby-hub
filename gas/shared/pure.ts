// GAS / Node 両対応の純粋関数群（node:crypto・async 不使用）
export const FAMILY_TZ = 'Asia/Tokyo';

// ---------- SHA-256（純 JS・同期。UTF-8 エンコード） ----------
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function sha256Hex(s: string): string {
  return sha256Bytes(utf8Bytes(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** バイト列の SHA-256（純 JS・同期）。署名検証（core/auth.ts）で使う */
export function sha256Bytes(input: ArrayLike<number>): number[] {
  const bytes = Array.from(input);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) | 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const out: number[] = [];
  for (const x of h) out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  return out;
}

// ---------- 招待トークン ----------
// トークン生成は Platform.randomToken(32) を使う（ここでは持たない）
export function hashToken(token: string): string {
  return sha256Hex(token);
}
export function isPlausibleToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(token);
}

// ---------- 再認証 ----------
export function isRecentAuth(authTimeSec: unknown, nowMs: number, maxSec = 300): boolean {
  return typeof authTimeSec === 'number' && nowMs / 1000 - authTimeSec <= maxSec && authTimeSec <= nowMs / 1000 + 60;
}

// ---------- 静穏時間（Asia/Tokyo） ----------
export function parseHm(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function minutesOfDay(d: Date, tz: string = FAMILY_TZ): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export interface QuietHours { enabled: boolean; start: string; end: string }

export function isInQuietHours(now: Date, q: QuietHours | undefined | null, tz: string = FAMILY_TZ): boolean {
  if (!q || !q.enabled) return false;
  const s = parseHm(q.start);
  const e = parseHm(q.end);
  if (s === null || e === null || s === e) return false;
  const t = minutesOfDay(now, tz);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** 静穏時間中の now から、静穏終了時刻（分単位）の Date を返す。静穏でなければ now。 */
export function nextQuietEnd(now: Date, q: QuietHours, tz: string = FAMILY_TZ): Date {
  if (!isInQuietHours(now, q, tz)) return now;
  const e = parseHm(q.end) as number;
  const t = minutesOfDay(now, tz);
  const delta = (e - t + 1440) % 1440;
  const floored = Math.floor(now.getTime() / 60000) * 60000;
  return new Date(floored + delta * 60000);
}

// ---------- 通知 ----------
export const MAX_ATTEMPTS = 3;
export const REMINDER_LEAD_MS = 60 * 60 * 1000;

export function jobId(parts: (string | number)[]): string {
  return sha256Hex(parts.join('|')).slice(0, 40);
}

export function reminderDueMs(startMs: number): number {
  return startMs - REMINDER_LEAD_MS;
}

export const NOTIFY_TEXT = {
  handoverImportant: '重要な申し送りがあります',
  handoverNormal: '確認したい申し送りがあります',
  scheduleReminder: '近づいている予定があります',
  test: 'テスト通知です',
  ownerTransfer: '管理者の移譲が提案されています',
} as const;

export const DEFAULT_SETTINGS = {
  theme: 'system',
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  notify: { handoverImportant: true, handoverNormal: false, scheduleReminder: true, taskDue: true, dose: true },
  homeItems: [
    { key: 'status', visible: true },
    { key: 'quickRecord', visible: true },
    { key: 'todayRhythm', visible: true },
    { key: 'recent', visible: true },
    { key: 'handovers', visible: true },
    { key: 'todayPlans', visible: true },
    { key: 'shopping', visible: true },
  ],
  quickRecordTypes: ['diaper', 'feeding', 'vomit', 'sleep', 'bath', 'other'],
} as const;

export function isInvalidTokenError(code: string | undefined): boolean {
  return code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token';
}
