// 端末トークンの逆引き文書 system/deviceTokens/tokens/{sha256(token)} = { uid, deviceId, updatedAt }。
// 同じ fcmToken を複数 uid が持たないよう registerDevice で検出するための索引（collectionGroup は使わない）。
// Rules は既定拒否（サーバーのみ）。端末のクライアント削除などで古くなり得るが、登録時に実在を確認して自己修復する。
import { FieldValue, type Firestore } from '../core/firestore';
import { hashToken } from '../shared/pure';

export const tokenRefPath = (token: string): string => `system/deviceTokens/tokens/${hashToken(token)}`;

/** 逆引き文書が uid のものなら削除する（端末の無効トークン削除時など。失敗は無視） */
export function removeTokenRefIfOwned(db: Firestore, uid: string, token: string): void {
  try {
    const ref = db.doc(tokenRefPath(token));
    const s = ref.get();
    if (s.exists && s.get('uid') === uid) ref.delete();
  } catch { /* 古い索引は登録時に自己修復される */ }
}

/** アカウント削除：uid の全端末トークンの逆引き文書のうち、uid のものを削除する */
export function purgeDeviceTokenRefs(db: Firestore, uid: string): void {
  const tokens = new Set<string>();
  for (const d of db.collection(`users/${uid}/devices`).limit(100).get().docs) {
    const t = d.get('fcmToken');
    if (typeof t === 'string' && t) tokens.add(t);
  }
  if (tokens.size === 0) return;
  const refs = Array.from(tokens, (t) => db.doc(tokenRefPath(t)));
  const b = db.batch();
  let n = 0;
  refs.forEach((r, i) => {
    const s = db.getAll(r)[0]!;
    if (s.exists && s.get('uid') === uid) { b.delete(refs[i]!); n++; }
  });
  if (n > 0) b.commit();
}

/** 他 uid が同じトークンを持っていれば、その端末登録を削除する（トランザクション外で検出し、他 uid 側は短いトランザクションで削除） */
export function evictTokenFromOtherUser(db: Firestore, ownerUid: string, token: string): void {
  const col = db.collection(`users/${ownerUid}/devices`);
  db.runTransaction((tx) => {
    const lock = db.doc(`system/deviceRegistry/users/${ownerUid}`);
    tx.get(lock); // 相手の registerDevice と直列化する
    const dups = tx.get(col.where('fcmToken', '==', token)).docs;
    if (dups.length === 0) return;
    for (const d of dups) tx.delete(d.ref);
    tx.set(lock, { updatedAt: FieldValue.serverTimestamp() });
  });
}
