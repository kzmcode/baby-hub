// アカウント削除ロック（system/accountDeletion/users/{uid}）の後始末。
// Auth ユーザー削除が失敗するとロックを残す（本人が再ログイン→再度アカウント削除で完了させる）。
// 放置されたロックは 7 日経過後に dispatch トリガーが Auth ユーザーの存在を確認し、存在しなければ削除する（存在すれば残す）。
import { Timestamp, type Firestore } from '../core/firestore';
import type { Platform } from '../core/platform/types';

export const STALE_LOCK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 20;

/** accounts:lookup で Auth ユーザーの存在を確認する。true=存在 / false=存在しない / null=判定不能 */
export function authUserExists(platform: Platform, uid: string): boolean | null {
  const { projectId, identityBaseUrl, webApiKey } = platform.config;
  try {
    const res = platform.fetch(`${identityBaseUrl}/v1/accounts:lookup?key=${encodeURIComponent(webApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${platform.getAccessToken()}`, 'x-goog-user-project': projectId },
      body: JSON.stringify({ localId: [uid], targetProjectId: projectId }),
    });
    if (res.status === 200) {
      const users = (JSON.parse(res.body) as { users?: { localId?: string }[] }).users;
      return Array.isArray(users) && users.some((u) => u.localId === uid);
    }
    if (res.status === 400 && res.body.includes('USER_NOT_FOUND')) return false;
  } catch { /* 判定不能 */ }
  return null;
}

export function sweepStaleDeletionLocks(db: Firestore, platform: Platform, nowMs: number): number {
  const cutoff = Timestamp.fromMillis(nowMs - STALE_LOCK_MS);
  const col = db.collection('system/accountDeletion/users');
  // createdAt が無い旧形式のロックは startedAt で判定する
  const docs = [...col.where('createdAt', '<=', cutoff).limit(MAX_PER_RUN).get().docs, ...col.where('startedAt', '<=', cutoff).limit(MAX_PER_RUN).get().docs];
  const seen = new Set<string>();
  let removed = 0;
  for (const d of docs) {
    if (seen.has(d.id) || seen.size >= MAX_PER_RUN) continue;
    seen.add(d.id);
    if (authUserExists(platform, d.id) !== false) continue; // 存在する／判定不能なら残す
    db.doc(`system/deviceRegistry/users/${d.id}`).delete();
    d.ref.delete();
    removed++;
  }
  if (seen.size > 0) platform.log('info', 'stale deletion locks', { checked: seen.size, removed });
  return removed;
}
