// 端末清掃の「やり残し」管理（純粋関数）。clearLocalData の各ステップが失敗したら
// localStorage `ch.pendingWipe` に対象を残し、次回起動時（Firestore 利用前）に削除する。
/** 信頼端末フラグの localStorage キー（Firestore 初期化前に参照するため localStorage） */
export const TRUSTED_KEY = 'ch.trustedDevice';
/** 清掃やり残しフラグ */
export const PENDING_WIPE_KEY = 'ch.pendingWipe';
/** アプリ独自の localStorage / IndexedDB キーはこの接頭辞に統一（clearLocalData が清掃する） */
export const LOCAL_PREFIX = 'ch.';
/** Firestore SDK の IndexedDB 名の接頭辞 */
export const FIRESTORE_IDB_PREFIX = 'firestore/';

export type WipeTarget = 'firestore' | 'app';
const TARGETS: WipeTarget[] = ['firestore', 'app'];

/** clearLocalData の localStorage 削除から除外するキー（端末設定・やり残しフラグ） */
export function isPreservedKey(k: string): boolean {
  return k === TRUSTED_KEY || k === PENDING_WIPE_KEY;
}

export function parsePendingWipe(raw: string | null | undefined): WipeTarget[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? TARGETS.filter((t) => v.includes(t)) : [];
  } catch {
    return [];
  }
}
export function serializePendingWipe(t: WipeTarget[]): string | null {
  const u = TARGETS.filter((x) => t.includes(x));
  return u.length ? JSON.stringify(u) : null;
}
/** 既存フラグに失敗ステップを足し、成功したステップを外した新しいフラグ */
export function nextPendingWipe(current: WipeTarget[], failed: WipeTarget[], succeeded: WipeTarget[]): WipeTarget[] {
  return TARGETS.filter((t) => failed.includes(t) || (current.includes(t) && !succeeded.includes(t)));
}
/** 削除対象の IndexedDB 名を選ぶ */
export function idbNamesFor(target: WipeTarget, names: (string | undefined)[]): string[] {
  const prefix = target === 'firestore' ? FIRESTORE_IDB_PREFIX : LOCAL_PREFIX;
  return names.filter((n): n is string => !!n && n.startsWith(prefix));
}
