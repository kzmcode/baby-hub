// エラー文言（純粋関数）。ApiError の code / details.reason と Firebase Auth の code を日本語にする
type ErrLike = { code?: string; details?: unknown; message?: string } | null | undefined;

export function errorReason(e: unknown): string | undefined {
  const d = (e as ErrLike)?.details as { reason?: unknown } | undefined;
  return typeof d?.reason === 'string' ? d.reason : undefined;
}

/** 再認証して再試行が必要か */
export function isRecentAuthRequired(e: unknown): boolean {
  const err = e as ErrLike;
  return (err?.code === 'failed-precondition' || err?.code === 'functions/failed-precondition') && errorReason(e) === 'recent-auth-required';
}

const INVITE: Record<string, string> = {
  expired: '招待の有効期限が切れています。招待した人に新しい招待を作ってもらってください。',
  revoked: 'この招待は取り消されました。招待した人に新しい招待を作ってもらってください。',
  used: 'この招待はすでに使われています（招待は1回限りです）。新しい招待を作ってもらってください。',
  'inviter-changed': '招待した人が現在の管理者ではなくなったため、この招待は使えません。管理者に新しい招待を作ってもらってください。',
  'has-other-family': 'すでに別の家族に参加しています。参加するには、先に今の家族から退出してください。',
  'family-full': 'この家族は上限人数（2人）に達しているため参加できません。',
};
export function inviteErrorMessage(e: unknown, fallback: string): string {
  const r = errorReason(e);
  if (r && INVITE[r]) return INVITE[r];
  const code = (e as ErrLike)?.code;
  if (code === 'not-found') return '招待が見つかりません。リンクやコードをもう一度確認してください。';
  if (code === 'resource-exhausted') return '試行回数が上限に達しました。しばらくしてからお試しください。';
  return fallback;
}

export function leaveErrorMessage(e: unknown, fallback: string): string {
  const r = errorReason(e);
  if (r === 'transfer-required') return '管理者は、先に他のメンバーへ管理者を移譲してから退出してください。';
  if (r === 'delete-family-required') return 'あなたが最後のメンバーです。退出ではなく「家族データの削除」を行ってください。';
  return fallback;
}

export function deleteErrorMessage(e: unknown, fallback: string): string {
  const r = errorReason(e);
  if (r === 'confirm-mismatch') return '入力した家族名が一致しません。';
  if (r === 'owner-has-members') return '他のメンバーがいるため削除できません。先に管理者を移譲するか、メンバーを外してください。';
  if (r === 'recent-auth-required') return '本人確認が必要です。もう一度ログインして確認してください。';
  return fallback;
}

/** Firebase Auth のエラーコード → 日本語 */
export function authErrorMessage(e: unknown): string {
  const code = (e as ErrLike)?.code ?? '';
  switch (code) {
    case 'auth/invalid-email': return 'メールアドレスの形式が正しくありません。';
    case 'auth/missing-password': return 'パスワードを入力してください。';
    case 'auth/weak-password': return 'パスワードは6文字以上にしてください。';
    case 'auth/email-already-in-use': return 'このメールアドレスは登録済みです。ログインするか、Googleでログインしているか確認してください。';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials': return 'メールアドレスまたはパスワードが違います。';
    case 'auth/too-many-requests': return '試行回数が多すぎます。しばらくしてからお試しください。';
    case 'auth/network-request-failed': return '通信できません。接続を確認してください。';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request': return 'ログインがキャンセルされました。';
    case 'auth/account-exists-with-different-credential': return '同じメールアドレスで別の方法のアカウントがあります。以前使った方法でログインしてください。';
    case 'auth/user-mismatch': return '現在ログイン中のアカウントと異なります。同じアカウントで確認してください。';
    case 'auth/requires-recent-login': return '本人確認が必要です。もう一度ログインして確認してください。';
    case 'auth/operation-not-allowed': return 'このログイン方法は有効になっていません（管理者の設定が必要です）。';
    case 'auth/unauthorized-domain': return 'このドメインはログインが許可されていません（管理者の設定が必要です）。';
    default: return 'ログインに失敗しました。もう一度お試しください。';
  }
}

/** ポップアップが使えない環境で redirect にフォールバックすべきエラーか */
export function shouldFallbackToRedirect(e: unknown): boolean {
  const code = (e as ErrLike)?.code ?? '';
  return code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment' || code === 'auth/web-storage-unsupported';
}
