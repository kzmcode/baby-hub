// uid 単位の固定窓カウンタ。
// - 通常の上限（strict でない）: CacheService の固定窓。原子的ではなく同時実行では多少超過し得る。窓は最大 6 時間。
// - strict な上限: ScriptLock（getScriptLock、tryLock 2 秒以内）で read-modify-write する。取得できなければ fail-closed（resource-exhausted）。
// - 6 時間を超える窓は「JST の暦日」窓とし、スクリプトプロパティ（uid ごとに 1 キー `rld:{uid}`）で管理する。
//   プロパティが使えない環境（プロパティ API 無し）では CacheService（最大 6 時間）に退避する。
import { ApiError } from './errors';
import type { Platform } from './platform/types';

export interface Limit { bucket: string; limit: number; windowSec: number; strict?: boolean }

export const MAX_WINDOW_SEC = 6 * 60 * 60;
export const DAY_SEC = 24 * 60 * 60;
export const LOCK_TIMEOUT_MS = 2000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_PROP_PREFIX = 'rld:';

/** 全関数合計（認証済みリクエスト全て。署名・クレーム検証の直後、accounts:lookup の前に消費する） */
export const GLOBAL_LIMIT: Limit = { bucket: 'all', limit: 60, windowSec: 60 };

// 日次（JST 暦日）。書込み系の合計と、関数別の上限
export const DAILY_WRITES: Limit = { bucket: 'dWrites', limit: 1000, windowSec: DAY_SEC };
export const DAILY_DELETE_DOC: Limit = { bucket: 'dDeleteDoc', limit: 200, windowSec: DAY_SEC };
export const DAILY_UPDATES: Limit = { bucket: 'dUpdates', limit: 500, windowSec: DAY_SEC }; // updateDoc + updateEvent 共有
export const DAILY_HANDOVER_NOTIFY: Limit = { bucket: 'dNotifyHandover', limit: 200, windowSec: DAY_SEC };
export const DAILY_SCHEDULE_SYNC: Limit = { bucket: 'dSyncSchedule', limit: 200, windowSec: DAY_SEC };

/** 関数ごとの上限（呼び出し 1 回ごとにカウント） */
export const FN_LIMITS: Record<string, Limit[]> = {
  exportFamilyData: [{ bucket: 'exportFamilyData', limit: 3, windowSec: 3600 }],
  sendTestNotification: [{ bucket: 'sendTestNotification', limit: 1, windowSec: 60, strict: true }],
  registerDevice: [{ bucket: 'registerDevice', limit: 10, windowSec: 3600 }],
  createDoseOccurrence: [{ bucket: 'createDoseOccurrence', limit: 30, windowSec: 3600 }, DAILY_WRITES],
  createFamily: [{ bucket: 'createFamily', limit: 5, windowSec: DAY_SEC, strict: true }],
  deleteFamily: [{ bucket: 'deleteFamily', limit: 5, windowSec: 3600, strict: true }],
  deleteAccount: [{ bucket: 'deleteAccount', limit: 5, windowSec: 3600, strict: true }],
  transferOwnership: [{ bucket: 'transferOwnership', limit: 10, windowSec: 3600, strict: true }],
  acceptOwnershipTransfer: [{ bucket: 'acceptOwnershipTransfer', limit: 10, windowSec: 3600, strict: true }],
  updateEvent: [DAILY_UPDATES, DAILY_WRITES],
  updateDoc: [DAILY_UPDATES, DAILY_WRITES],
  setEventStatus: [DAILY_WRITES],
  deleteDoc: [DAILY_DELETE_DOC, DAILY_WRITES],
  claimDose: [DAILY_WRITES],
  releaseDose: [DAILY_WRITES],
  completeDose: [DAILY_WRITES],
  skipDose: [DAILY_WRITES],
  notifyHandoverCreated: [DAILY_HANDOVER_NOTIFY, DAILY_WRITES],
  syncScheduleReminder: [DAILY_SCHEDULE_SYNC, DAILY_WRITES],
};

export function limitsFor(fn: string): Limit[] {
  return Object.prototype.hasOwnProperty.call(FN_LIMITS, fn) ? FN_LIMITS[fn]! : [];
}

/** 失敗時にだけカウントする（previewInvite と acceptInvite で共有）。strict: 事前に予約し、成功したら返却する */
export const FAIL_LIMIT: Limit = { bucket: 'inviteFail', limit: 10, windowSec: 3600, strict: true };
export const FAIL_COUNTED_FNS = new Set(['previewInvite', 'acceptInvite']);

export function jstDate(nowMs: number): string {
  return new Date(nowMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}
function secondsToJstMidnight(nowMs: number): number {
  const t = nowMs + JST_OFFSET_MS;
  return Math.max(1, Math.ceil(((Math.floor(t / (DAY_SEC * 1000)) + 1) * DAY_SEC * 1000 - t) / 1000));
}

interface Slot { count: number; retryAfterSec: number; put(n: number): void }
type DayRecord = { d: string; b: Record<string, number> };

function readDayRecord(platform: Platform, uid: string, date: string): DayRecord {
  const key = DAY_PROP_PREFIX + uid;
  let raw: string | null = null;
  try { raw = platform.propGet ? platform.propGet(key) : platform.cacheGet(key); } catch { /* 読めなければ空 */ }
  if (raw) {
    try {
      const r = JSON.parse(raw) as DayRecord;
      if (r && r.d === date && r.b && typeof r.b === 'object') return r;
    } catch { /* 壊れていれば作り直す */ }
  }
  return { d: date, b: {} };
}

function slot(platform: Platform, uid: string, l: Limit, nowMs: number): Slot {
  if (l.windowSec > MAX_WINDOW_SEC) {
    const date = jstDate(nowMs);
    const rec = readDayRecord(platform, uid, date);
    return {
      count: Number(rec.b[l.bucket]) || 0,
      retryAfterSec: secondsToJstMidnight(nowMs),
      put(n) {
        // 他のバケットを巻き込まないよう、書込み直前に読み直す
        const cur = readDayRecord(platform, uid, date);
        cur.b[l.bucket] = Math.max(0, n);
        const raw = JSON.stringify(cur);
        try {
          if (platform.propPut) platform.propPut(DAY_PROP_PREFIX + uid, raw);
          else platform.cachePut(DAY_PROP_PREFIX + uid, raw, MAX_WINDOW_SEC);
        } catch { /* ignore */ }
      },
    };
  }
  const windowSec = l.windowSec;
  const index = Math.floor(nowMs / 1000 / windowSec);
  const key = `rl:${l.bucket}:${uid}:${index}`;
  let count = 0;
  try {
    const raw = platform.cacheGet(key);
    count = raw ? Number(raw) || 0 : 0;
  } catch { /* キャッシュ不可なら制限しない */ }
  return {
    count,
    retryAfterSec: Math.max(1, (index + 1) * windowSec - Math.floor(nowMs / 1000)),
    put(n) { try { platform.cachePut(key, String(Math.max(0, n)), windowSec + 5); } catch { /* ignore */ } },
  };
}

export function rateLimited(retryAfterSec: number): ApiError {
  return new ApiError('resource-exhausted', 'Too many requests. Please try again later.', { reason: 'rate-limited', retryAfterSec });
}

function disabled(platform: Platform): boolean {
  return platform.config.emulator === true && platform.config.rateLimitDisabled === true;
}

/** strict な上限は ScriptLock を短時間だけ取って実行する。取得できなければ fail-closed */
function withLimitLock<T>(platform: Platform, l: Limit, fn: () => T): T {
  if (!l.strict || !platform.tryScriptLock) return fn();
  const release = platform.tryScriptLock(LOCK_TIMEOUT_MS);
  if (!release) {
    platform.log('warn', 'rate limit lock unavailable', { bucket: l.bucket });
    throw rateLimited(3);
  }
  try { return fn(); } finally { release(); }
}

/** 上限に達していれば例外。達していなければ 1 加算 */
export function consume(platform: Platform, uid: string, l: Limit, nowMs: number): void {
  if (disabled(platform)) return;
  withLimitLock(platform, l, () => {
    const s = slot(platform, uid, l, nowMs);
    if (s.count >= l.limit) throw rateLimited(s.retryAfterSec);
    s.put(s.count + 1);
  });
}

/** 上限に達していれば例外（加算しない） */
export function check(platform: Platform, uid: string, l: Limit, nowMs: number): void {
  if (disabled(platform)) return;
  const s = slot(platform, uid, l, nowMs);
  if (s.count >= l.limit) throw rateLimited(s.retryAfterSec);
}

/** 加算のみ */
export function increment(platform: Platform, uid: string, l: Limit, nowMs: number): void {
  if (disabled(platform)) return;
  withLimitLock(platform, l, () => {
    const s = slot(platform, uid, l, nowMs);
    s.put(s.count + 1);
  });
}

/** consume の取消し（予約した枠の返却。ロックが取れなくても例外にしない） */
export function release(platform: Platform, uid: string, l: Limit, nowMs: number): void {
  if (disabled(platform)) return;
  try {
    withLimitLock(platform, l, () => {
      const s = slot(platform, uid, l, nowMs);
      s.put(s.count - 1);
    });
  } catch { /* 返却できなければ枠を消費したままにする（安全側） */ }
}

/** 前日以前の日次カウンタ（プロパティ）を削除する。1 日 1 回、トリガーから呼ぶ */
export function sweepDayCounters(platform: Platform, nowMs: number): number {
  if (!platform.propKeys || !platform.propRemove || !platform.propGet) return 0;
  const today = jstDate(nowMs);
  let removed = 0;
  for (const k of platform.propKeys()) {
    if (!k.startsWith(DAY_PROP_PREFIX)) continue;
    let stale = true;
    try { stale = (JSON.parse(platform.propGet(k) ?? '{}') as { d?: string }).d !== today; } catch { /* 壊れていれば削除 */ }
    if (stale) { platform.propRemove(k); removed++; }
  }
  return removed;
}
