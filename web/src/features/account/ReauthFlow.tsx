import { useState, type ReactNode } from 'react';
import { EmailAuthProvider, GoogleAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup } from 'firebase/auth';
import { apiErrorMessage } from '../../lib/api';
import { useAuth } from '../../context';
import { Button, Field, Sheet, TextInput } from '../../components';
import { authErrorMessage, deleteErrorMessage, isRecentAuthRequired } from './logic/errors';

export interface FlowProps {
  open: boolean; onClose: () => void; title: string; children: ReactNode;
  /** 入力して一致が必要な確認文字列（家族名など） */
  confirmText?: string; confirmLabel?: string; actionLabel: string;
  run: () => Promise<void>;
  /** 実行ボタンの見た目（既定 danger） */
  variant?: 'danger' | 'primary';
  /** API エラーの文言変換（既定は削除系） */
  errorMessage?: (e: unknown, fallback: string) => string;
}

/** 再認証 → （確認文字列の一致）→ 実行 の共通シート */
export function DangerFlow({ open, onClose, title, children, confirmText, confirmLabel, actionLabel, run, variant = 'danger', errorMessage = deleteErrorMessage }: FlowProps) {
  const { user } = useAuth();
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hasGoogle = !!user?.providerData.some((p) => p.providerId === 'google.com');
  const hasPassword = !!user?.providerData.some((p) => p.providerId === 'password');

  async function go() {
    if (!user) return;
    setBusy(true); setError('');
    try {
      if (hasGoogle) await reauthenticateWithPopup(user, new GoogleAuthProvider());
      else if (hasPassword && user.email) await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      else throw Object.assign(new Error('unsupported'), { code: 'auth/unknown' });
    } catch (e) { setError(authErrorMessage(e)); setBusy(false); return; }
    try {
      await run();
      setBusy(false); setPassword(''); setTyped('');
    } catch (e) {
      setError(isRecentAuthRequired(e) ? '本人確認の有効時間が切れました。もう一度実行してください。' : errorMessage(e, apiErrorMessage(e)));
      setBusy(false);
    }
  }
  const matches = !confirmText || typed.trim() === confirmText;
  return (
    <Sheet open={open} onClose={onClose} title={title}
      footer={<div className="row"><Button onClick={onClose} disabled={busy}>キャンセル</Button><Button variant={variant} loading={busy} disabled={!matches || (!hasGoogle && !password)} onClick={go}>{actionLabel}</Button></div>}>
      <div className="stack">
        {children}
        {confirmText && (
          <Field label={confirmLabel ?? `確認のため「${confirmText}」と入力`}>
            {(p) => <TextInput {...p} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />}
          </Field>
        )}
        {hasGoogle
          ? <p className="small muted">実行時に Google で本人確認を行います（ポップアップ）。</p>
          : <Field label="パスワード（本人確認）">{(p) => <TextInput {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>}
        {error && <p className="acc-err" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}

