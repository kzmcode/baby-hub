// 日次 UrlFetch 予算（JST 日付で区切る。スクリプトプロパティに `日付:回数` を 1 キーずつ保持するので古いキーは溜まらない）。
// 非原子的（ロックしない）なので同時実行では多少少なく数える。GAS の UrlFetch は 20,000 回/日（無料アカウント）。
// リクエスト（doPost）とトリガー（通知ディスパッチ・バックアップ）で枠を分け、リクエストが使い切ってもトリガー分を残す。
import { ApiError } from './errors';
import { jstDate } from './ratelimit';
import type { Platform } from './platform/types';

export const REQUEST_DAILY_BUDGET = 15000;
export const TRIGGER_DAILY_BUDGET = 5000;
export type BudgetKind = 'req' | 'trigger';
const limitOf = (k: BudgetKind) => (k === 'req' ? REQUEST_DAILY_BUDGET : TRIGGER_DAILY_BUDGET);
const key = (k: BudgetKind) => `ub:${k}`;

function disabled(platform: Platform): boolean {
  return platform.config.emulator === true && platform.config.rateLimitDisabled === true;
}

export function budgetUsed(platform: Platform, kind: BudgetKind, nowMs: number): number {
  let raw: string | null = null;
  try { raw = platform.propGet ? platform.propGet(key(kind)) : platform.cacheGet(key(kind)); } catch { /* 読めなければ 0 */ }
  if (!raw) return 0;
  const [d, n] = raw.split(':');
  return d === jstDate(nowMs) ? Number(n) || 0 : 0;
}

/** リクエスト枠を使い切っていれば unavailable（reason 'daily-budget'）。トリガー枠は別なので影響しない */
export function assertRequestBudget(platform: Platform, nowMs: number): void {
  if (disabled(platform)) return;
  if (budgetUsed(platform, 'req', nowMs) >= REQUEST_DAILY_BUDGET) {
    platform.log('warn', 'daily UrlFetch budget exhausted', { kind: 'req' });
    throw new ApiError('unavailable', 'Service is temporarily unavailable. Please try again tomorrow.', { reason: 'daily-budget' });
  }
}

export function chargeBudget(platform: Platform, kind: BudgetKind, n: number, nowMs: number): void {
  if (disabled(platform) || n <= 0) return;
  const total = budgetUsed(platform, kind, nowMs) + n;
  const raw = `${jstDate(nowMs)}:${total}`;
  try {
    if (platform.propPut) platform.propPut(key(kind), raw);
    else platform.cachePut(key(kind), raw, 6 * 60 * 60);
  } catch { /* ignore */ }
  if (total > limitOf(kind) && total - n <= limitOf(kind)) platform.log('warn', 'daily UrlFetch budget exceeded', { kind, limit: limitOf(kind) });
}

/** fn の間に行った fetch の回数を kind の枠に計上する（トリガー用） */
export function metered<T>(platform: Platform, kind: BudgetKind, fn: () => T): T {
  const before = platform.fetchCount?.() ?? 0;
  try {
    return fn();
  } finally {
    chargeBudget(platform, kind, (platform.fetchCount?.() ?? 0) - before, Date.now());
  }
}
