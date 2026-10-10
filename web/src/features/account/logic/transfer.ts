// 管理者移譲（2段階）の表示状態（純粋関数）
export interface PendingTransferLike { toUid: string; proposedBy: string; expiresAt: { toMillis(): number } | null }

export type TransferView =
  | { kind: 'none' }
  | { kind: 'proposer' | 'recipient' | 'other'; toUid: string; proposedBy: string; expiresAtMs: number; expired: boolean };

export function transferView(p: PendingTransferLike | null | undefined, uid: string | null | undefined, nowMs: number): TransferView {
  if (!p || !uid) return { kind: 'none' };
  const expiresAtMs = p.expiresAt ? p.expiresAt.toMillis() : 0;
  const kind = p.toUid === uid ? 'recipient' : p.proposedBy === uid ? 'proposer' : 'other';
  return { kind, toUid: p.toUid, proposedBy: p.proposedBy, expiresAtMs, expired: expiresAtMs <= nowMs };
}

export function transferErrorMessage(e: unknown, fallback: string): string {
  const r = (e as { details?: { reason?: unknown } } | null)?.details?.reason;
  if (r === 'transfer-expired') return '移譲の提案の有効期限が切れています。必要なら管理者がもう一度提案してください。';
  if (r === 'no-pending-transfer') return '移譲の提案はすでに取り消されたか、完了しています。画面を更新して確認してください。';
  if (r === 'recent-auth-required') return '本人確認が必要です。もう一度ログインして確認してください。';
  return fallback;
}
