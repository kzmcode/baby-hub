// 退出・除外・家族削除を検知する判定（純粋関数）。検知したら端末キャッシュを消して /setup へ戻す
export interface AccessState {
  /** これまでにこのセッションで有効な家族を見たことがあるか */
  hadFamily: boolean;
  /** ログイン中か（ログアウト中の遷移は signOut 側が清掃するので対象外） */
  signedIn: boolean;
  familyId: string | null;
  /** members/{自分のuid} の status（未取得は undefined） */
  myMemberStatus?: string | null;
  /** 家族購読（family / members / children）のエラーコード */
  errorCodes: (string | undefined)[];
}
export function accessLost(s: AccessState): boolean {
  if (!s.signedIn || !s.hadFamily) return false;
  if (!s.familyId) return true;
  if (s.myMemberStatus && s.myMemberStatus !== 'active') return true;
  return s.errorCodes.includes('permission-denied');
}

/**
 * 退出・除外の「確定度」。
 * - 'definite': members/{自分} の status や familyRefs の消失など、サーバー由来のデータから確定できる
 * - 'verify'  : 購読の permission-denied だけ。一時的なエラー（トークン更新中・ルール反映遅延など）の可能性があるので、
 *               サーバーに members/{自分} を確認してから消去する
 * - 'none'    : 異常なし
 */
export type AccessLossKind = 'none' | 'definite' | 'verify';
export function accessLossKind(s: AccessState): AccessLossKind {
  if (!s.signedIn || !s.hadFamily) return 'none';
  if (!s.familyId) return 'definite';
  if (s.myMemberStatus && s.myMemberStatus !== 'active') return 'definite';
  return s.errorCodes.includes('permission-denied') ? 'verify' : 'none';
}

/** サーバーで確認した自分の members ドキュメントの状態 */
export type MemberCheck = { kind: 'missing' } | { kind: 'status'; status: string | undefined } | { kind: 'error' };
/** 消去してよいのは「ドキュメントが無い」または「status が active でない」と確定したときだけ。確認失敗では消さない */
export function shouldWipeAfterCheck(c: MemberCheck): boolean {
  if (c.kind === 'error') return false;
  if (c.kind === 'missing') return true;
  return c.status !== 'active';
}

/** 消去前に出す通知文。未同期の書込みが無ければ null */
export function unsyncedNotice(pendingCount: number | null, hasPendingWrites: boolean): string | null {
  if (pendingCount !== null && pendingCount > 0) return `未同期の記録 ${pendingCount} 件は保存されません。`;
  if (hasPendingWrites) return '未同期の記録は保存されません。';
  return null;
}
