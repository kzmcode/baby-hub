import { FieldValue, Timestamp, type Firestore, type Transaction } from '../core/firestore';
import { hashToken } from './pure';

/**
 * 削除記録の保持期間: バックアップ保持14日 + 余裕7日。これを過ぎた記録は、それより古いバックアップが
 * 残っていないため復元の再生成防止に不要になり、清掃で削除される。
 */
export const DELETION_RETENTION_DAYS = 21;

/**
 * 削除記録 deletions/{sha256(path)}。パスと削除時刻のみを持つ（uid 等はパスの一部としてのみ現れ、他の個人情報は持たない）。
 * 家族・アカウントの削除は、家族／ユーザー単位の記録（と所属索引）だけを積み、配下の子文書単位の記録は積まない。
 */
export function recordDeletion(db: Firestore, tx: Transaction, path: string): void {
  tx.set(db.doc(`deletions/${hashToken(path)}`), { path, deletedAt: FieldValue.serverTimestamp() });
}

/** 期限切れの削除記録を、deadlineMs（時間予算）まで 500 件ずつ削除する。削除件数を返す。 */
export function purgeExpiredDeletions(db: Firestore, nowMs: number, deadlineMs: number): number {
  const cutoff = Timestamp.fromMillis(nowMs - DELETION_RETENTION_DAYS * 86400000);
  let removed = 0;
  while (Date.now() < deadlineMs) {
    const snap = db.collection('deletions').where('deletedAt', '<', cutoff).limit(500).get();
    if (snap.empty) break;
    const b = db.batch();
    for (const d of snap.docs) b.delete(d.ref);
    b.commit();
    removed += snap.size;
    if (snap.size < 500) break;
  }
  return removed;
}
